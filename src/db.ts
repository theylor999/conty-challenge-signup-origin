import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { LinkKind } from "./domain/links.ts";

// Times are epoch milliseconds. Uniqueness is enforced here, not only in code:
// click_id per install, first open per install, one signup per user, and one
// signup per install that consumed it.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS links (
  code TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('referral','campaign','community')),
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  click_id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES links(code),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  clicked_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS installs (
  install_id TEXT PRIMARY KEY,
  first_opened_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS touches (
  touch_id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL REFERENCES installs(install_id),
  dedup_key TEXT NOT NULL,
  click_id TEXT,
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  at INTEGER NOT NULL,
  at_source TEXT NOT NULL CHECK (at_source IN ('click','opened_at')),
  opened_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  duplicate_reports INTEGER NOT NULL DEFAULT 0,
  UNIQUE (install_id, dedup_key),
  UNIQUE (install_id, click_id)
);

CREATE TABLE IF NOT EXISTS signups (
  user_id TEXT PRIMARY KEY,
  install_id TEXT,
  signed_up_at INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,
  attributed_install_id TEXT UNIQUE,
  decision_json TEXT NOT NULL
);
`;

export interface LinkRow {
  code: string;
  kind: LinkKind;
  ref: string;
  created_at: number;
}

export interface ClickRow {
  click_id: string;
  code: string;
  kind: LinkKind;
  ref: string;
  clicked_at: number;
  user_agent: string | null;
}

export interface InstallRow {
  install_id: string;
  first_opened_at: number;
  recorded_at: number;
}

export interface TouchRow {
  touch_id: string;
  install_id: string;
  dedup_key: string;
  click_id: string | null;
  kind: LinkKind;
  ref: string;
  at: number;
  at_source: "click" | "opened_at";
  opened_at: number;
  received_at: number;
  duplicate_reports: number;
}

export interface SignupRow {
  user_id: string;
  install_id: string | null;
  signed_up_at: number;
  decided_at: number;
  attributed_install_id: string | null;
  decision_json: string;
}

export class Db {
  constructor(private readonly sqlite: DatabaseSync) {}

  /** Runs fn atomically. node:sqlite is synchronous, so fn must not await. */
  transaction<T>(fn: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  insertLink(row: LinkRow): boolean {
    return this.run(
      "INSERT INTO links (code, kind, ref, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
      row.code, row.kind, row.ref, row.created_at,
    );
  }

  getLink(code: string): LinkRow | undefined {
    return this.get<LinkRow>("SELECT * FROM links WHERE code = ?", code);
  }

  insertClick(row: ClickRow): void {
    this.run(
      "INSERT INTO clicks (click_id, code, kind, ref, clicked_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
      row.click_id, row.code, row.kind, row.ref, row.clicked_at, row.user_agent,
    );
  }

  getClick(clickId: string): ClickRow | undefined {
    return this.get<ClickRow>("SELECT * FROM clicks WHERE click_id = ?", clickId);
  }

  /** True when this call recorded the first open; false when one already existed. */
  insertInstall(row: InstallRow): boolean {
    return this.run(
      "INSERT INTO installs (install_id, first_opened_at, recorded_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      row.install_id, row.first_opened_at, row.recorded_at,
    );
  }

  getInstall(installId: string): InstallRow | undefined {
    return this.get<InstallRow>("SELECT * FROM installs WHERE install_id = ?", installId);
  }

  /** True when the touch is new; false when the same touch already exists for the install. */
  insertTouch(row: Omit<TouchRow, "duplicate_reports">): boolean {
    return this.run(
      `INSERT INTO touches (touch_id, install_id, dedup_key, click_id, kind, ref, at, at_source, opened_at, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      row.touch_id, row.install_id, row.dedup_key, row.click_id, row.kind, row.ref,
      row.at, row.at_source, row.opened_at, row.received_at,
    );
  }

  getTouchByKey(installId: string, dedupKey: string): TouchRow | undefined {
    return this.get<TouchRow>(
      "SELECT * FROM touches WHERE install_id = ? AND dedup_key = ?",
      installId, dedupKey,
    );
  }

  countDuplicateReport(touchId: string): void {
    this.run("UPDATE touches SET duplicate_reports = duplicate_reports + 1 WHERE touch_id = ?", touchId);
  }

  listTouches(installId: string): TouchRow[] {
    return this.sqlite
      .prepare("SELECT * FROM touches WHERE install_id = ? ORDER BY at, touch_id")
      .all(installId) as unknown as TouchRow[];
  }

  getSignup(userId: string): SignupRow | undefined {
    return this.get<SignupRow>("SELECT * FROM signups WHERE user_id = ?", userId);
  }

  installHasSignup(installId: string): boolean {
    return this.get("SELECT 1 AS found FROM signups WHERE install_id = ? LIMIT 1", installId) !== undefined;
  }

  installConsumed(installId: string): boolean {
    return this.get("SELECT 1 AS found FROM signups WHERE attributed_install_id = ?", installId) !== undefined;
  }

  insertSignup(row: SignupRow): boolean {
    return this.run(
      `INSERT INTO signups (user_id, install_id, signed_up_at, decided_at, attributed_install_id, decision_json)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING`,
      row.user_id, row.install_id, row.signed_up_at, row.decided_at, row.attributed_install_id, row.decision_json,
    );
  }

  close(): void {
    this.sqlite.close();
  }

  private run(sql: string, ...params: (string | number | null)[]): boolean {
    return this.sqlite.prepare(sql).run(...params).changes > 0;
  }

  private get<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.sqlite.prepare(sql).get(...params) as T | undefined;
  }
}

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const sqlite = new DatabaseSync(path);
  sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  sqlite.exec(SCHEMA);
  return new Db(sqlite);
}
