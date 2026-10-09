import type { Decision, OrganicReasonCode, TouchOutcome, TouchVerdict } from "./domain/attribution.ts";
import type { LinkKind } from "./domain/links.ts";

export const iso = (ms: number) => new Date(ms).toISOString();

export interface SignupFacts {
  userId: string;
  installId: string | null;
  signedUpAt: number;
  decidedAt: number;
}

export interface TouchWire {
  touch_id: string | null;
  duplicate_of: string | null;
  click_id: string | null;
  kind: string;
  ref: string;
  at: string;
  at_source: "click" | "opened_at";
  outcome: TouchOutcome;
  reason: string;
  ignored_reports: number;
}

export interface SignupDecision {
  user_id: string;
  install_id: string | null;
  signed_up_at: string;
  decided_at: string;
  origin:
    | { kind: "organic"; reason_code: OrganicReasonCode; reason: string }
    | { kind: LinkKind; ref: string; touch_id: string; reason: string };
  window: { first_opened_at: string; starts_at: string; ends_at: string } | null;
  touches: TouchWire[];
  rule_version: string;
  rule_config: { window_seconds: number; pre_install_lookback_seconds: number };
}

/** The JSON stored at signup and returned verbatim by both the POST and the audit GET. */
export function decisionToWire(decision: Decision, facts: SignupFacts): SignupDecision {
  const { origin, window, config } = decision;
  return {
    user_id: facts.userId,
    install_id: facts.installId,
    signed_up_at: iso(facts.signedUpAt),
    decided_at: iso(facts.decidedAt),
    origin:
      origin.kind === "organic"
        ? { kind: "organic", reason_code: origin.reasonCode, reason: origin.reason }
        : { kind: origin.kind, ref: origin.ref, touch_id: origin.touchId, reason: origin.reason },
    window: window && {
      first_opened_at: iso(window.firstOpenedAt),
      starts_at: iso(window.startsAt),
      ends_at: iso(window.endsAt),
    },
    touches: decision.touches.map(touchToWire),
    rule_version: decision.ruleVersion,
    rule_config: {
      window_seconds: config.windowMs / 1000,
      pre_install_lookback_seconds: config.preInstallLookbackMs / 1000,
    },
  };
}

function touchToWire(t: TouchVerdict): TouchWire {
  return {
    touch_id: t.touchId,
    duplicate_of: t.duplicateOf,
    click_id: t.clickId,
    kind: t.kind,
    ref: t.ref,
    at: iso(t.at),
    at_source: t.atSource,
    outcome: t.outcome,
    reason: t.reason,
    ignored_reports: t.ignoredReports,
  };
}
