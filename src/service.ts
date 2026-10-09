import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "./clock.ts";
import type { AppConfig } from "./config.ts";
import type { Db, TouchRow } from "./db.ts";
import { decideAttribution, type TouchFact } from "./domain/attribution.ts";
import { buildDeepLink, buildLinkParams, type LinkKind } from "./domain/links.ts";
import { AppError } from "./errors.ts";
import { decisionToWire, iso, type SignupDecision } from "./wire.ts";

export interface ServiceDeps {
  db: Db;
  clock: Clock;
  config: AppConfig;
  /** Random URL-safe token; injectable so tests get predictable ids. */
  token?: (bytes: number) => string;
}

export interface TouchInput {
  installId: string;
  clickId?: string;
  kind?: LinkKind;
  ref?: string;
  openedAt?: number;
}

export interface SignupInput {
  userId: string;
  installId?: string;
  signedUpAt?: number;
}

export class AttributionService {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly config: AppConfig;
  private readonly token: (bytes: number) => string;

  constructor({ db, clock, config, token = defaultToken }: ServiceDeps) {
    this.db = db;
    this.clock = clock;
    this.config = config;
    this.token = token;
  }

  private rejectFuture(at: number, field: string): void {
    if (at > this.clock.now() + this.config.maxClockSkewMs) {
      throw new AppError(422, "timestamp_in_future", `${field} está no futuro (tolerância de ${this.config.maxClockSkewMs / 1000}s).`);
    }
  }

  createLink(input: { kind: LinkKind; ref: string; code?: string }) {
    const code = input.code ?? this.token(5);
    const created = this.db.insertLink({ code, kind: input.kind, ref: input.ref, created_at: this.clock.now() });
    const link = this.db.getLink(code)!;
    if (!created && (link.kind !== input.kind || link.ref !== input.ref)) {
      throw new AppError(409, "code_taken", `O código ${code} já existe para outro link.`);
    }
    return {
      created,
      link: {
        code,
        kind: link.kind,
        ref: link.ref,
        short_url: `${this.config.publicBaseUrl}/i/${code}`,
        deep_link: buildDeepLink({ kind: link.kind, ref: link.ref }),
      },
    };
  }

  /** Logs a click and returns where to send the browser. A click is not a touch until the app reports it. */
  registerClick(code: string, userAgent: string | null): string {
    const link = this.db.getLink(code);
    if (!link) throw new AppError(404, "link_not_found", `Link ${code} não existe.`);
    const clickId = `clk_${this.token(9)}`;
    this.db.insertClick({
      click_id: clickId,
      code,
      kind: link.kind,
      ref: link.ref,
      clicked_at: this.clock.now(),
      user_agent: userAgent,
    });
    const params = buildLinkParams({ kind: link.kind, ref: link.ref, clickId });
    return `${this.config.redirectBaseUrl}?${params.toString()}`;
  }

  /** Idempotent: a second call returns the stored first_opened_at and never moves it. */
  firstOpen(installId: string, openedAt?: number) {
    const at = openedAt ?? this.clock.now();
    this.rejectFuture(at, "opened_at");
    const created = this.db.insertInstall({ install_id: installId, first_opened_at: at, recorded_at: this.clock.now() });
    const install = this.db.getInstall(installId)!;
    return { created, install_id: installId, first_opened_at: iso(install.first_opened_at) };
  }

  recordTouch(input: TouchInput) {
    if (!this.db.getInstall(input.installId)) {
      throw new AppError(409, "first_open_required", "Registre a primeira abertura (POST /installs/:install_id/first-open) antes dos toques.");
    }
    const now = this.clock.now();
    const openedAt = input.openedAt ?? now;
    this.rejectFuture(openedAt, "opened_at");

    const resolved = resolveTouch(this.db, input, openedAt);
    const touchId = `tch_${sha256(`${input.installId}|${resolved.dedupKey}`).slice(0, 16)}`;

    const duplicate = this.db.transaction(() => {
      const inserted = this.db.insertTouch({
        touch_id: touchId,
        install_id: input.installId,
        dedup_key: resolved.dedupKey,
        click_id: input.clickId ?? null,
        kind: resolved.kind,
        ref: resolved.ref,
        at: resolved.at,
        at_source: resolved.atSource,
        opened_at: openedAt,
        received_at: now,
      });
      if (!inserted) this.db.countDuplicateReport(touchId);
      return !inserted;
    });

    const stored = this.db.getTouchByKey(input.installId, resolved.dedupKey)!;
    return {
      duplicate,
      touch_id: stored.touch_id,
      kind: stored.kind,
      ref: stored.ref,
      at: iso(stored.at),
      at_source: stored.at_source,
      // True when this install already signed up: the touch is stored, the decision stays as it was.
      signup_frozen: this.db.installHasSignup(input.installId),
    };
  }

  /** Freezes the attribution for this user. Same user again: same stored decision. */
  signup(input: SignupInput): { created: boolean; body: SignupDecision } {
    return this.db.transaction(() => {
      const existing = this.db.getSignup(input.userId);
      if (existing) {
        const sameInstall = input.installId === undefined || input.installId === existing.install_id;
        const sameTime = input.signedUpAt === undefined || input.signedUpAt === existing.signed_up_at;
        if (!sameInstall || !sameTime) {
          throw new AppError(409, "signup_conflict", "Este user_id já tem cadastro com install_id ou signed_up_at diferente; a decisão congelada não muda.");
        }
        return { created: false, body: JSON.parse(existing.decision_json) as SignupDecision };
      }

      const now = this.clock.now();
      const signedUpAt = input.signedUpAt ?? now;
      this.rejectFuture(signedUpAt, "signed_up_at");

      const install = input.installId ? this.db.getInstall(input.installId) : undefined;
      const installAlreadyUsed = install ? this.db.installConsumed(install.install_id) : false;
      const touches = install ? this.db.listTouches(install.install_id).map(toFact) : [];

      const decision = decideAttribution({
        signedUpAt,
        firstOpenedAt: install?.first_opened_at ?? null,
        installAlreadyUsed,
        touches,
        config: this.config.attribution,
      });
      const body = decisionToWire(decision, {
        userId: input.userId,
        installId: input.installId ?? null,
        signedUpAt,
        decidedAt: now,
      });
      this.db.insertSignup({
        user_id: input.userId,
        install_id: input.installId ?? null,
        signed_up_at: signedUpAt,
        decided_at: now,
        attributed_install_id: install && !installAlreadyUsed ? install.install_id : null,
        decision_json: JSON.stringify(body),
      });
      return { created: true, body };
    });
  }

  getAttribution(userId: string): SignupDecision {
    const row = this.db.getSignup(userId);
    if (!row) throw new AppError(404, "signup_not_found", `Cadastro de ${userId} não existe.`);
    return JSON.parse(row.decision_json) as SignupDecision;
  }
}

interface ResolvedTouch {
  kind: LinkKind;
  ref: string;
  at: number;
  atSource: "click" | "opened_at";
  dedupKey: string;
}

/**
 * With a click_id the server's own click record is the truth: kind, ref and time
 * come from it, and the app can only confirm them. Without a click_id (a pasted
 * deep link) the app's opened_at is the only clock we have.
 */
function resolveTouch(db: Db, input: TouchInput, openedAt: number): ResolvedTouch {
  if (input.clickId) {
    const click = db.getClick(input.clickId);
    if (!click) throw new AppError(422, "unknown_click", `click_id ${input.clickId} não foi emitido por este servidor.`);
    if ((input.kind && input.kind !== click.kind) || (input.ref && input.ref !== click.ref)) {
      throw new AppError(422, "click_mismatch", "kind/ref não batem com o clique registrado.");
    }
    return { kind: click.kind, ref: click.ref, at: click.clicked_at, atSource: "click", dedupKey: `click:${click.click_id}` };
  }
  if (!input.kind || !input.ref) {
    throw new AppError(422, "invalid_touch", "Sem click_id, kind e ref são obrigatórios.");
  }
  // Same link opened at the same instant is a retry of one report; a different instant is a new open.
  const dedupKey = `link:${sha256(`${input.kind}|${input.ref}|${openedAt}`).slice(0, 16)}`;
  return { kind: input.kind, ref: input.ref, at: openedAt, atSource: "opened_at", dedupKey };
}

function toFact(row: TouchRow): TouchFact {
  return {
    id: row.touch_id,
    clickId: row.click_id,
    kind: row.kind,
    ref: row.ref,
    at: row.at,
    atSource: row.at_source,
    tieKey: row.click_id ?? row.dedup_key,
    duplicateReports: row.duplicate_reports,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
