import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  attributionWindow,
  classifyTouch,
  decideAttribution,
  type Decision,
  type TouchFact,
} from "../src/domain/attribution.ts";
import { DAY_MS, HOUR_MS } from "../src/domain/time.ts";

const F = Date.parse("2026-03-10T12:00:00.000Z");
const window = attributionWindow(F, DEFAULT_CONFIG);

function touch(id: string, over: Partial<TouchFact> = {}): TouchFact {
  return {
    id,
    clickId: id,
    kind: "campaign",
    ref: "cmp_1",
    at: F + HOUR_MS,
    atSource: "click",
    tieKey: id,
    duplicateReports: 0,
    ...over,
    openedAt: over.openedAt ?? over.at ?? F + HOUR_MS,
  };
}

function decide(touches: TouchFact[], signedUpAt = F + 2 * DAY_MS, firstOpenedAt: number | null = F) {
  return decideAttribution({
    signedUpAt,
    firstOpenedAt,
    installAlreadyUsed: false,
    touches,
    config: DEFAULT_CONFIG,
  });
}

const classify = (at: number, signedUpAt: number, openedAt = at) =>
  classifyTouch({ at, openedAt }, window, signedUpAt);

const outcomes = (d: Decision) =>
  Object.fromEntries(d.touches.map((t) => [t.touchId, t.outcome]));

describe("attributionWindow / classifyTouch", () => {
  it("window is [first_open - 24h, first_open + 7d], inclusive", () => {
    expect(window.startsAt).toBe(F - DAY_MS);
    expect(window.endsAt).toBe(F + 7 * DAY_MS);
    const signup = F + 7 * DAY_MS;
    expect(classify(window.startsAt, signup)).toBe("eligible");
    expect(classify(window.startsAt - 1, signup)).toBe("outside_window");
    expect(classify(window.endsAt, signup)).toBe("eligible");
    expect(classify(window.endsAt + 1, signup + 2)).toBe("outside_window");
  });

  it("a touch at the exact signup instant counts; 1 ms later does not", () => {
    const signup = F + HOUR_MS;
    expect(classify(signup, signup)).toBe("eligible");
    expect(classify(signup + 1, signup)).toBe("after_signup");
  });

  it("after_signup wins over outside_window", () => {
    expect(classify(window.endsAt + DAY_MS, F + DAY_MS)).toBe("after_signup");
  });

  it("a click before the signup does not count if the app opened the link after it", () => {
    expect(classify(F + HOUR_MS, F + 2 * HOUR_MS, F + 3 * HOUR_MS)).toBe("after_signup");
    expect(classify(F + HOUR_MS, F + 2 * HOUR_MS, F + 2 * HOUR_MS)).toBe("eligible");
  });

  it("a signup after the window end invalidates in-window touches", () => {
    expect(classify(F + HOUR_MS, window.endsAt + 1)).toBe("signup_after_window");
  });
});

describe("decideAttribution", () => {
  it("last eligible touch wins; earlier ones lose to the later touch", () => {
    const a = touch("clk_a", { kind: "campaign", ref: "cmp_1", at: F + HOUR_MS });
    const b = touch("clk_b", { kind: "referral", ref: "ana", at: F + 2 * HOUR_MS });
    const d = decide([b, a]);
    expect(d.origin).toMatchObject({ kind: "referral", ref: "ana", touchId: "clk_b" });
    expect(outcomes(d)).toEqual({ clk_a: "lost_to_later_touch", clk_b: "won" });
  });

  it("is last-touch even when the older touch has higher kind priority", () => {
    const a = touch("clk_a", { kind: "referral", ref: "ana", at: F + HOUR_MS });
    const b = touch("clk_b", { kind: "community", ref: "disc", at: F + 2 * HOUR_MS });
    expect(decide([a, b]).origin).toMatchObject({ kind: "community" });
  });

  it("timestamp tie: referral beats campaign beats community, whatever the input order", () => {
    const at = F + HOUR_MS;
    const referral = touch("clk_z", { kind: "referral", ref: "ana", at });
    const campaign = touch("clk_a", { kind: "campaign", ref: "cmp_1", at });
    const community = touch("clk_b", { kind: "community", ref: "disc", at });
    for (const order of [
      [referral, campaign, community],
      [community, campaign, referral],
      [campaign, community, referral],
    ]) {
      const d = decide(order);
      expect(d.origin).toMatchObject({ kind: "referral", touchId: "clk_z" });
      expect(outcomes(d)).toEqual({ clk_z: "won", clk_a: "lost_tie_break", clk_b: "lost_tie_break" });
    }
  });

  it("timestamp tie with the same kind: smaller tieKey wins", () => {
    const at = F + HOUR_MS;
    const d1 = decide([touch("clk_2", { at, ref: "cmp_2" }), touch("clk_1", { at, ref: "cmp_1" })]);
    expect(d1.origin).toMatchObject({ ref: "cmp_1", touchId: "clk_1" });
    expect(outcomes(d1)).toEqual({ clk_1: "won", clk_2: "lost_tie_break" });
  });

  it("an earlier touch behind a tie loses to the later touch, not on tie-break", () => {
    const early = touch("clk_e", { at: F + HOUR_MS });
    const tieA = touch("clk_a", { at: F + 2 * HOUR_MS, kind: "referral", ref: "ana" });
    const tieB = touch("clk_b", { at: F + 2 * HOUR_MS });
    expect(outcomes(decide([early, tieA, tieB]))).toEqual({
      clk_e: "lost_to_later_touch",
      clk_a: "won",
      clk_b: "lost_tie_break",
    });
  });

  it("touch after signup and touch outside the window never win", () => {
    const signup = F + 2 * DAY_MS;
    const tooOld = touch("clk_old", { at: F - DAY_MS - 1 });
    const tooLate = touch("clk_late", { at: signup + 1 });
    const ok = touch("clk_ok", { at: F + HOUR_MS, kind: "community", ref: "disc" });
    const d = decide([tooOld, tooLate, ok], signup);
    expect(d.origin).toMatchObject({ touchId: "clk_ok" });
    expect(outcomes(d)).toEqual({ clk_old: "outside_window", clk_late: "after_signup", clk_ok: "won" });
  });

  it("pre-install click inside the lookback counts", () => {
    const click = touch("clk_pre", { at: F - 2 * HOUR_MS });
    expect(decide([click]).origin).toMatchObject({ touchId: "clk_pre" });
  });

  it("signup with no touches is organic with a reason", () => {
    expect(decide([]).origin).toMatchObject({ kind: "organic", reasonCode: "no_touches" });
  });

  it("only ineligible touches: organic no_eligible_touch", () => {
    const d = decide([touch("clk_old", { at: F - 3 * DAY_MS })]);
    expect(d.origin).toMatchObject({ kind: "organic", reasonCode: "no_eligible_touch" });
  });

  it("signup after the window end: organic window_expired, touches explained", () => {
    const d = decide([touch("clk_a")], F + 8 * DAY_MS);
    expect(d.origin).toMatchObject({ kind: "organic", reasonCode: "window_expired" });
    expect(outcomes(d)).toEqual({ clk_a: "signup_after_window" });
  });

  it("signup exactly at the window end is still inside", () => {
    const d = decide([touch("clk_a")], F + 7 * DAY_MS);
    expect(d.origin).toMatchObject({ touchId: "clk_a" });
  });

  it("signup after the window end with no touches is window_expired, not no_touches", () => {
    expect(decide([], F + 8 * DAY_MS).origin).toMatchObject({ kind: "organic", reasonCode: "window_expired" });
  });

  it("opened after signup: the touch is after_signup even though the click was earlier", () => {
    const d = decide([touch("clk_a", { at: F + HOUR_MS, openedAt: F + 3 * HOUR_MS })], F + 2 * HOUR_MS);
    expect(d.origin).toMatchObject({ kind: "organic", reasonCode: "no_eligible_touch" });
    expect(d.touches[0]).toMatchObject({ outcome: "after_signup" });
    expect(d.touches[0].reason).toMatch(/o app só abriu o link/);
  });

  it("mixed tie, same kind: server click (clk_) sorts before a pasted link, in any arrival order", () => {
    const at = F + HOUR_MS;
    const click = touch("tch_1", { at, tieKey: "clk_000009" });
    const pasted = touch("tch_2", { at, clickId: null, atSource: "opened_at", tieKey: "link:00ab" });
    expect(decide([pasted, click]).origin).toMatchObject({ touchId: "tch_1" });
    expect(decide([click, pasted]).origin).toMatchObject({ touchId: "tch_1" });
  });

  it("no first open: organic no_first_open, no window", () => {
    const d = decide([], F, null);
    expect(d.window).toBeNull();
    expect(d.origin).toMatchObject({ kind: "organic", reasonCode: "no_first_open" });
  });

  it("install already used by another signup: organic install_already_used", () => {
    const d = decideAttribution({
      signedUpAt: F + HOUR_MS,
      firstOpenedAt: F,
      installAlreadyUsed: true,
      touches: [touch("clk_a")],
      config: DEFAULT_CONFIG,
    });
    expect(d.origin).toMatchObject({ kind: "organic", reasonCode: "install_already_used" });
    expect(d.window).not.toBeNull();
    expect(d.touches).toHaveLength(1);
    expect(d.touches[0]).toMatchObject({ outcome: "install_already_used" });
    expect(d.touches[0].reason).toMatch(/outro usuário/);
  });

  it("repeated reports of one click appear as one duplicate_click entry and one touch", () => {
    const d = decide([touch("clk_a", { duplicateReports: 3 })]);
    expect(d.touches.map((t) => t.outcome)).toEqual(["won", "duplicate_click"]);
    expect(d.touches[1]).toMatchObject({ touchId: null, duplicateOf: "clk_a", ignoredReports: 3 });
  });

  it("every touch has a pt-BR reason", () => {
    const d = decide([
      touch("clk_a", { at: F + HOUR_MS }),
      touch("clk_b", { at: F + 2 * HOUR_MS }),
      touch("clk_c", { at: F + 3 * DAY_MS }),
    ], F + 2 * DAY_MS);
    for (const t of d.touches) expect(t.reason.length).toBeGreaterThan(10);
    expect(d.touches.find((t) => t.touchId === "clk_c")!.reason).toMatch(/posterior ao cadastro/);
  });
});
