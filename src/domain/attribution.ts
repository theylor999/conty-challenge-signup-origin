import { KIND_PRIORITY, type LinkKind } from "./links.ts";
import * as why from "./reasons.ts";
import { DAY_MS } from "./time.ts";

export const RULE_VERSION = "last-touch-v1";

export interface AttributionConfig {
  /** How long after the first open a signup can still be attributed. */
  windowMs: number;
  /** How long before the first open the click that caused the install may be. */
  preInstallLookbackMs: number;
}

export const DEFAULT_CONFIG: AttributionConfig = {
  windowMs: 7 * DAY_MS,
  preInstallLookbackMs: 1 * DAY_MS,
};

export interface AttributionWindow {
  firstOpenedAt: number;
  startsAt: number;
  endsAt: number;
}

/**
 *   startsAt            firstOpenedAt                         endsAt
 *      |<-- lookback -------->|<------------ window ------------->|
 *      |   touch can count    |   touch and signup can count     |
 *
 * Both ends are inclusive.
 */
export function attributionWindow(
  firstOpenedAt: number,
  config: AttributionConfig,
): AttributionWindow {
  return {
    firstOpenedAt,
    startsAt: firstOpenedAt - config.preInstallLookbackMs,
    endsAt: firstOpenedAt + config.windowMs,
  };
}

export type TouchStatus = "eligible" | "after_signup" | "outside_window" | "signup_after_window";

/**
 * A touch is eligible iff startsAt <= at <= min(signedUpAt, endsAt), the app
 * opened the link at or before the signup (openedAt <= signedUpAt), and the
 * signup itself happened inside the window (signedUpAt <= endsAt).
 * Checks run in this order so the reported reason is the most basic one.
 */
export function classifyTouch(
  touch: Pick<TouchFact, "at" | "openedAt">,
  window: AttributionWindow,
  signedUpAt: number,
): TouchStatus {
  if (touch.at > signedUpAt || touch.openedAt > signedUpAt) return "after_signup";
  if (touch.at < window.startsAt || touch.at > window.endsAt) return "outside_window";
  if (signedUpAt > window.endsAt) return "signup_after_window";
  return "eligible";
}

export interface TouchFact {
  id: string;
  clickId: string | null;
  kind: LinkKind;
  ref: string;
  /** Moment of the touch: server click time when known, else the app's opened_at. */
  at: number;
  atSource: "click" | "opened_at";
  /** When the app says it opened the link: the earliest report for this touch, never before the install's first open. */
  openedAt: number;
  /** Stable unique id per touch inside an install; last resort of the tie-break. */
  tieKey: string;
  /** Extra reports of the same click received after the first one. */
  duplicateReports: number;
}

export type TouchOutcome =
  | "won"
  | "lost_to_later_touch"
  | "lost_tie_break"
  | "after_signup"
  | "outside_window"
  | "signup_after_window"
  | "duplicate_click"
  | "install_already_used";

export interface TouchVerdict {
  /** Null on a duplicate_click entry: it describes extra reports, not a touch of its own. */
  touchId: string | null;
  duplicateOf: string | null;
  clickId: string | null;
  kind: LinkKind;
  ref: string;
  at: number;
  atSource: TouchFact["atSource"];
  openedAt: number;
  outcome: TouchOutcome;
  reason: string;
  ignoredReports: number;
}

export type OrganicReasonCode =
  | "no_first_open"
  | "install_already_used"
  | "no_touches"
  | "window_expired"
  | "no_eligible_touch";

export type Origin =
  | { kind: LinkKind; ref: string; touchId: string; reason: string }
  | { kind: "organic"; reasonCode: OrganicReasonCode; reason: string };

export interface Decision {
  origin: Origin;
  window: AttributionWindow | null;
  touches: TouchVerdict[];
  ruleVersion: string;
  config: AttributionConfig;
}

export interface DecisionInput {
  signedUpAt: number;
  /** Null when the install is unknown or the app never reported its first open. */
  firstOpenedAt: number | null;
  /** Another user already consumed this install at signup. */
  installAlreadyUsed: boolean;
  touches: TouchFact[];
  config: AttributionConfig;
}

/**
 * Last-touch: the latest eligible touch wins. Same timestamp: higher kind
 * priority wins, then the smaller tieKey. Total order, so the result never
 * depends on input order.
 */
export function compareRank(a: TouchFact, b: TouchFact): number {
  if (a.at !== b.at) return b.at - a.at;
  const byKind = KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind];
  if (byKind !== 0) return byKind;
  return a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0;
}

export function decideAttribution(input: DecisionInput): Decision {
  const { config, signedUpAt } = input;
  const base = { ruleVersion: RULE_VERSION, config };

  if (input.firstOpenedAt === null) {
    return { ...base, window: null, touches: [], origin: organic("no_first_open", why.noFirstOpen()) };
  }

  const window = attributionWindow(input.firstOpenedAt, config);
  const status = new Map(input.touches.map((t) => [t.id, classifyTouch(t, window, signedUpAt)]));
  const ranked = input.installAlreadyUsed
    ? []
    : input.touches.filter((t) => status.get(t.id) === "eligible").sort(compareRank);
  const winner = ranked[0];

  const outcomes = new Map<string, { outcome: TouchOutcome; reason: string }>();
  for (const t of input.touches) {
    const s = status.get(t.id)!;
    if (input.installAlreadyUsed) outcomes.set(t.id, { outcome: "install_already_used", reason: why.touchOfUsedInstall() });
    else if (s === "after_signup") outcomes.set(t.id, { outcome: s, reason: why.afterSignup(t, signedUpAt) });
    else if (s === "outside_window") outcomes.set(t.id, { outcome: s, reason: why.outsideWindow(t.at, window, config) });
    else if (s === "signup_after_window") outcomes.set(t.id, { outcome: s, reason: why.signupAfterWindow(signedUpAt, window, config) });
  }
  for (const t of ranked) {
    if (t === winner) {
      const tied = ranked.filter((o) => o !== t && o.at === t.at).length;
      outcomes.set(t.id, { outcome: "won", reason: why.won(t, tied) });
    } else if (t.at === winner!.at) {
      outcomes.set(t.id, { outcome: "lost_tie_break", reason: why.lostTieBreak(t, winner!) });
    } else {
      outcomes.set(t.id, { outcome: "lost_to_later_touch", reason: why.lostToLater(winner!) });
    }
  }

  // Oldest first, so the list reads as a timeline; on equal timestamps the better rank comes last.
  const timeline = [...input.touches].sort((a, b) => a.at - b.at || compareRank(b, a));
  const touches: TouchVerdict[] = [];
  for (const t of timeline) {
    const { outcome, reason } = outcomes.get(t.id)!;
    const verdict = { clickId: t.clickId, kind: t.kind, ref: t.ref, at: t.at, atSource: t.atSource, openedAt: t.openedAt };
    touches.push({ ...verdict, touchId: t.id, duplicateOf: null, outcome, reason, ignoredReports: 0 });
    if (t.duplicateReports > 0) {
      touches.push({
        ...verdict,
        touchId: null,
        duplicateOf: t.id,
        outcome: "duplicate_click",
        reason: why.duplicateClick(t),
        ignoredReports: t.duplicateReports,
      });
    }
  }

  const decided = { ...base, window, touches };
  if (winner) {
    return { ...decided, origin: { kind: winner.kind, ref: winner.ref, touchId: winner.id, reason: outcomes.get(winner.id)!.reason } };
  }
  if (input.installAlreadyUsed) {
    return { ...decided, origin: organic("install_already_used", why.installAlreadyUsed()) };
  }
  // Expiry comes first: a late signup is organic whether or not touches exist.
  if (signedUpAt > window.endsAt) {
    return { ...decided, origin: organic("window_expired", why.windowExpired(signedUpAt, window, config)) };
  }
  if (input.touches.length === 0) {
    return { ...decided, origin: organic("no_touches", why.noTouches()) };
  }
  return { ...decided, origin: organic("no_eligible_touch", why.noEligibleTouch(input.touches.length)) };
}

function organic(reasonCode: OrganicReasonCode, reason: string): Origin {
  return { kind: "organic", reasonCode, reason };
}
