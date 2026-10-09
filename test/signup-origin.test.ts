import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config.ts";
import { DAY_MS, HOUR_MS, INSTALL, T0, iso, setup, withLinks } from "./helpers.ts";

const outcomesByClick = (touches: { click_id: string | null; outcome: string }[]) =>
  Object.fromEntries(touches.filter((t) => t.outcome !== "duplicate_click").map((t) => [t.click_id, t.outcome]));

describe("two different links before signup", () => {
  it("the later link wins (last-touch) and the earlier one is explained", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const campaignClick = await h.click("camp1");
    h.clock.set(T0 + 2 * HOUR_MS);
    const referralClick = await h.click("refana");
    h.clock.set(T0 + 3 * HOUR_MS);
    await h.touch({ install_id: INSTALL, click_id: campaignClick });
    await h.touch({ install_id: INSTALL, click_id: referralClick });

    const res = await h.signup({ user_id: "u1", install_id: INSTALL });

    expect(res.status).toBe(201);
    expect(res.json.origin).toMatchObject({ kind: "referral", ref: "ana_silva" });
    expect(outcomesByClick(res.json.touches)).toEqual({
      [campaignClick]: "lost_to_later_touch",
      [referralClick]: "won",
    });
    expect(res.json.window).toEqual({
      first_opened_at: iso(T0),
      starts_at: iso(T0 - DAY_MS),
      ends_at: iso(T0 + 7 * DAY_MS),
    });
    expect(res.json.rule_version).toBe("last-touch-v1");
  });

  it("order of arrival does not matter, only the touch time", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const first = await h.click("refana");
    h.clock.set(T0 + 2 * HOUR_MS);
    const second = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: second });
    await h.touch({ install_id: INSTALL, click_id: first });
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "campaign", ref: "cmp_123" });
  });
});

describe("timestamp tie", () => {
  it("same instant: referral beats campaign, with lost_tie_break on the loser", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const campaignClick = await h.click("camp1");
    const referralClick = await h.click("refana");
    await h.touch({ install_id: INSTALL, click_id: referralClick });
    await h.touch({ install_id: INSTALL, click_id: campaignClick });

    const res = await h.signup({ user_id: "u1", install_id: INSTALL });

    expect(res.json.origin).toMatchObject({ kind: "referral", ref: "ana_silva" });
    expect(outcomesByClick(res.json.touches)).toEqual({
      [campaignClick]: "lost_tie_break",
      [referralClick]: "won",
    });
    const loser = res.json.touches.find((t: { click_id: string }) => t.click_id === campaignClick);
    expect(loser.reason).toContain("prioridade de tipo");
  });

  it("same instant and same kind: smaller click_id wins", async () => {
    const h = await withLinks();
    await h.link("campaign", "cmp_999", "camp2");
    h.clock.set(T0 + HOUR_MS);
    const a = await h.click("camp1");
    const b = await h.click("camp2");
    await h.touch({ install_id: INSTALL, click_id: b });
    await h.touch({ install_id: INSTALL, click_id: a });
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(a < b).toBe(true);
    expect(res.json.origin).toMatchObject({ ref: "cmp_123" });
    expect(outcomesByClick(res.json.touches)).toEqual({ [a]: "won", [b]: "lost_tie_break" });
  });

  it("pasted deep links (no click_id) tie on opened_at the same way", async () => {
    const h = await withLinks();
    const openedAt = iso(T0 + HOUR_MS);
    h.clock.set(T0 + 2 * HOUR_MS);
    await h.touch({ install_id: INSTALL, kind: "community", ref: "discord_br", opened_at: openedAt });
    await h.touch({ install_id: INSTALL, kind: "campaign", ref: "cmp_123", opened_at: openedAt });
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "campaign" });
    expect(res.json.touches.map((t: { outcome: string }) => t.outcome).sort()).toEqual(["lost_tie_break", "won"]);
  });
});

describe("same click twice", () => {
  it("creates one touch, answers duplicate:true and is shown once in the audit", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const clickId = await h.click("refana");

    const first = await h.touch({ install_id: INSTALL, click_id: clickId });
    const again = await h.touch({ install_id: INSTALL, click_id: clickId, opened_at: iso(T0 + HOUR_MS) });
    const third = await h.touch({ install_id: INSTALL, click_id: clickId });

    expect(first.status).toBe(201);
    expect(first.json.duplicate).toBe(false);
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ duplicate: true, touch_id: first.json.touch_id });
    expect(third.json.touch_id).toBe(first.json.touch_id);

    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    const real = res.json.touches.filter((t: { outcome: string }) => t.outcome !== "duplicate_click");
    expect(real).toHaveLength(1);
    expect(real[0].outcome).toBe("won");
    const dup = res.json.touches.find((t: { outcome: string }) => t.outcome === "duplicate_click");
    expect(dup).toMatchObject({ duplicate_of: first.json.touch_id, ignored_reports: 2 });
    expect(res.json.origin.touch_id).toBe(first.json.touch_id);
  });

  it("the same click on two different installs is allowed (one touch per install)", async () => {
    const h = await withLinks();
    await h.firstOpen("install-0002");
    const clickId = await h.click("camp1");
    expect((await h.touch({ install_id: INSTALL, click_id: clickId })).status).toBe(201);
    expect((await h.touch({ install_id: "install-0002", click_id: clickId })).status).toBe(201);
  });

  it("a pasted link reported twice with the same opened_at is one touch; a later open is a new touch", async () => {
    const h = await withLinks();
    const body = { install_id: INSTALL, kind: "campaign", ref: "cmp_123", opened_at: iso(T0 + HOUR_MS) };
    h.clock.set(T0 + 3 * HOUR_MS);
    const a = await h.touch(body);
    const b = await h.touch(body);
    const c = await h.touch({ ...body, opened_at: iso(T0 + 2 * HOUR_MS) });
    expect(b.json).toMatchObject({ duplicate: true, touch_id: a.json.touch_id });
    expect(c.json.duplicate).toBe(false);
    expect(c.json.touch_id).not.toBe(a.json.touch_id);
  });

  it("two physical clicks on the same link are two touches with the same origin", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const c1 = await h.click("camp1");
    h.clock.set(T0 + 2 * HOUR_MS);
    const c2 = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: c1 });
    await h.touch({ install_id: INSTALL, click_id: c2 });
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "campaign", ref: "cmp_123" });
    expect(outcomesByClick(res.json.touches)).toEqual({ [c1]: "lost_to_later_touch", [c2]: "won" });
  });
});

describe("touch and signup order", () => {
  it("a touch that happened after signup is stored but does not change the decision", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const before = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: before });
    h.clock.set(T0 + 2 * HOUR_MS);
    const signup = await h.signup({ user_id: "u1", install_id: INSTALL });

    h.clock.set(T0 + 3 * HOUR_MS);
    const late = await h.click("refana");
    const lateTouch = await h.touch({ install_id: INSTALL, click_id: late });

    expect(lateTouch.status).toBe(201);
    expect(lateTouch.json.signup_frozen).toBe(true);
    const audit = await h.attribution("u1");
    expect(audit.json).toEqual(signup.json);
    expect(audit.json.origin).toMatchObject({ kind: "campaign" });
    const replay = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(replay.status).toBe(200);
    expect(replay.json).toEqual(signup.json);
  });

  it("a touch reported before signup but dated after it is marked after_signup", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const early = await h.click("camp1");
    h.clock.set(T0 + 3 * HOUR_MS);
    const late = await h.click("refana");
    await h.touch({ install_id: INSTALL, click_id: early });
    await h.touch({ install_id: INSTALL, click_id: late });

    const res = await h.signup({ user_id: "u1", install_id: INSTALL, signed_up_at: iso(T0 + 2 * HOUR_MS) });

    expect(res.json.origin).toMatchObject({ kind: "campaign" });
    expect(outcomesByClick(res.json.touches)).toEqual({ [early]: "won", [late]: "after_signup" });
  });

  it("a touch at the exact signup instant still counts", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const clickId = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: clickId });
    const res = await h.signup({ user_id: "u1", install_id: INSTALL, signed_up_at: iso(T0 + HOUR_MS) });
    expect(res.json.origin).toMatchObject({ kind: "campaign" });
  });
});

describe("window", () => {
  it("click older than the pre-install lookback is outside the window", async () => {
    const h = await withLinks();
    h.clock.set(T0 - DAY_MS - 1);
    const old = await h.click("camp1");
    h.clock.set(T0 + HOUR_MS);
    await h.touch({ install_id: INSTALL, click_id: old });
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "organic", reason_code: "no_eligible_touch" });
    expect(res.json.touches[0]).toMatchObject({ outcome: "outside_window" });
    expect(res.json.touches[0].reason).toContain("anterior ao início da janela");
  });

  it("click exactly at the lookback limit (first open - 24h) counts", async () => {
    const h = await withLinks();
    h.clock.set(T0 - DAY_MS);
    const click = await h.click("camp1");
    h.clock.set(T0 + HOUR_MS);
    await h.touch({ install_id: INSTALL, click_id: click });
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "campaign" });
  });

  it("click after the window end is outside it, and the late signup is organic window_expired", async () => {
    const h = await withLinks();
    h.clock.set(T0 + 7 * DAY_MS + 1);
    const late = await h.click("refana");
    await h.touch({ install_id: INSTALL, click_id: late });
    h.clock.set(T0 + 8 * DAY_MS);
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "organic", reason_code: "window_expired" });
    expect(res.json.touches[0].outcome).toBe("outside_window");
  });

  it("signup after the window end ignores even a click inside it", async () => {
    const h = await withLinks();
    h.clock.set(T0 + DAY_MS);
    const click = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: click });
    h.clock.set(T0 + 7 * DAY_MS + 1);
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "organic", reason_code: "window_expired" });
    expect(res.json.touches[0]).toMatchObject({ outcome: "signup_after_window" });
  });

  it("signup exactly at the window end is still inside", async () => {
    const h = await withLinks();
    h.clock.set(T0 + DAY_MS);
    const click = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: click });
    h.clock.set(T0 + 7 * DAY_MS);
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "campaign" });
  });

  it("the window length comes from config", async () => {
    const h = setup({ ...DEFAULTS, attribution: { windowMs: 2 * DAY_MS, preInstallLookbackMs: HOUR_MS } });
    await h.link("campaign", "cmp_123", "camp1");
    await h.firstOpen(INSTALL);
    h.clock.set(T0 + HOUR_MS);
    const click = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: click });
    h.clock.set(T0 + 3 * DAY_MS);
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.window.ends_at).toBe(iso(T0 + 2 * DAY_MS));
    expect(res.json.rule_config).toEqual({ window_seconds: 2 * 86400, pre_install_lookback_seconds: 3600 });
    expect(res.json.origin).toMatchObject({ reason_code: "window_expired" });
  });

  it("first-open called twice does not move the window", async () => {
    const h = await withLinks();
    h.clock.set(T0 + 3 * DAY_MS);
    const again = await h.firstOpen(INSTALL, iso(T0 + 3 * DAY_MS));
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ created: false, first_opened_at: iso(T0) });

    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.window.first_opened_at).toBe(iso(T0));
    expect(res.json.window.ends_at).toBe(iso(T0 + 7 * DAY_MS));
  });
});

describe("organic with a recorded reason", () => {
  it("no touches at all", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const res = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(res.json.origin).toMatchObject({ kind: "organic", reason_code: "no_touches" });
    expect(res.json.origin.reason).toMatch(/orgânica/);
    expect(res.json.touches).toEqual([]);
    expect(res.json.window).not.toBeNull();
  });

  it("no first open: unknown install_id", async () => {
    const h = setup();
    const res = await h.signup({ user_id: "u1", install_id: "never-opened" });
    expect(res.json.origin).toMatchObject({ kind: "organic", reason_code: "no_first_open" });
    expect(res.json.window).toBeNull();
  });

  it("no first open: signup without install_id", async () => {
    const h = setup();
    const res = await h.signup({ user_id: "u1" });
    expect(res.json.origin).toMatchObject({ kind: "organic", reason_code: "no_first_open" });
    expect(res.json.install_id).toBeNull();
    expect((await h.attribution("u1")).json).toEqual(res.json);
  });

  it("a second user on the same install is organic install_already_used", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const click = await h.click("camp1");
    await h.touch({ install_id: INSTALL, click_id: click });
    const first = await h.signup({ user_id: "u1", install_id: INSTALL });
    const second = await h.signup({ user_id: "u2", install_id: INSTALL });
    expect(first.json.origin).toMatchObject({ kind: "campaign" });
    expect(second.json.origin).toMatchObject({ kind: "organic", reason_code: "install_already_used" });
  });
});

describe("signup freeze and audit", () => {
  it("audit GET returns exactly what the signup returned", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const c1 = await h.click("camp1");
    const c2 = await h.click("refana");
    await h.touch({ install_id: INSTALL, click_id: c1 });
    await h.touch({ install_id: INSTALL, click_id: c2 });
    await h.touch({ install_id: INSTALL, click_id: c2 });
    const signup = await h.signup({ user_id: "u1", install_id: INSTALL });
    h.clock.advance(5 * DAY_MS);
    const audit = await h.attribution("u1");
    expect(audit.status).toBe(200);
    expect(audit.json).toEqual(signup.json);
    for (const t of audit.json.touches) expect(t.reason).toBeTruthy();
    expect(audit.json.decided_at).toBe(iso(T0 + HOUR_MS));
  });

  it("repeating the signup returns the same decision, even with a later clock", async () => {
    const h = await withLinks();
    const first = await h.signup({ user_id: "u1", install_id: INSTALL });
    h.clock.advance(30 * DAY_MS);
    const second = await h.signup({ user_id: "u1", install_id: INSTALL });
    expect(second.status).toBe(200);
    expect(second.json).toEqual(first.json);
  });

  it("same user_id with another install_id is a conflict and changes nothing", async () => {
    const h = await withLinks();
    const first = await h.signup({ user_id: "u1", install_id: INSTALL });
    const other = await h.signup({ user_id: "u1", install_id: "install-0002" });
    expect(other.status).toBe(409);
    expect(other.json.error.code).toBe("signup_conflict");
    expect((await h.attribution("u1")).json).toEqual(first.json);
  });

  it("audit for an unknown user is 404", async () => {
    const h = setup();
    expect((await h.attribution("ghost")).status).toBe(404);
  });
});

describe("links, clicks and input validation", () => {
  it("creates campaign and referral links with example URLs", async () => {
    const h = setup();
    const campaign = await h.link("campaign", "cmp_123", "verao26");
    expect(campaign.status).toBe(201);
    expect(campaign.json).toEqual({
      code: "verao26",
      kind: "campaign",
      ref: "cmp_123",
      short_url: "https://conty.app/i/verao26",
      deep_link: "conty://open?cty_src=campaign&cty_ref=cmp_123",
    });
    expect((await h.link("campaign", "cmp_123", "verao26")).status).toBe(200);
    const clash = await h.link("referral", "ana", "verao26");
    expect(clash.status).toBe(409);
  });

  it("GET /i/:code logs a click and redirects carrying ctyc", async () => {
    const h = await withLinks();
    const res = await h.call("GET", "/i/refana");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("cty_src")).toBe("referral");
    expect(location.searchParams.get("cty_ref")).toBe("ana_silva");
    expect(location.searchParams.get("ctyc")).toMatch(/^clk_/);
    expect((await h.call("GET", "/i/nope")).status).toBe(404);
  });

  it("each GET creates a new click_id", async () => {
    const h = await withLinks();
    expect(await h.click("camp1")).not.toBe(await h.click("camp1"));
  });

  it("a touch before first-open is rejected", async () => {
    const h = setup();
    await h.link("campaign", "cmp_123", "camp1");
    const click = await h.click("camp1");
    const res = await h.touch({ install_id: "install-0001", click_id: click });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("first_open_required");
  });

  it("rejects an unknown click_id, a mismatching kind/ref and a missing kind without click_id", async () => {
    const h = await withLinks();
    const click = await h.click("camp1");
    expect((await h.touch({ install_id: INSTALL, click_id: "clk_forged" })).json.error.code).toBe("unknown_click");
    expect((await h.touch({ install_id: INSTALL, click_id: click, kind: "referral", ref: "cmp_123" })).json.error.code).toBe("click_mismatch");
    expect((await h.touch({ install_id: INSTALL })).status).toBe(422);
  });

  it("kind and ref of a click come from the server record", async () => {
    const h = await withLinks();
    const click = await h.click("camp1");
    const res = await h.touch({ install_id: INSTALL, click_id: click });
    expect(res.json).toMatchObject({ kind: "campaign", ref: "cmp_123", at_source: "click" });
  });

  it("rejects timestamps in the future and malformed instants", async () => {
    const h = await withLinks();
    const future = iso(T0 + HOUR_MS);
    expect((await h.touch({ install_id: INSTALL, kind: "campaign", ref: "x", opened_at: future })).json.error.code).toBe("timestamp_in_future");
    expect((await h.signup({ user_id: "u1", install_id: INSTALL, signed_up_at: future })).status).toBe(422);
    expect((await h.signup({ user_id: "u1", install_id: INSTALL, signed_up_at: "yesterday" })).status).toBe(422);
    expect((await h.call("POST", "/signups", "not-an-object")).status).toBe(400);
  });
});

describe("storage constraints", () => {
  it("the database itself refuses a second touch for the same click and a second consumer of an install", async () => {
    const h = await withLinks();
    h.clock.set(T0 + HOUR_MS);
    const click = await h.click("camp1");
    const row = {
      touch_id: "t1", install_id: INSTALL, dedup_key: "k1", click_id: click, kind: "campaign" as const,
      ref: "cmp_123", at: T0, at_source: "click" as const, opened_at: T0, received_at: T0,
    };
    expect(h.db.insertTouch(row)).toBe(true);
    expect(h.db.insertTouch({ ...row, touch_id: "t2", dedup_key: "k2" })).toBe(false);

    const signup = { install_id: INSTALL, signed_up_at: T0, decided_at: T0, attributed_install_id: INSTALL, decision_json: "{}" };
    expect(h.db.insertSignup({ ...signup, user_id: "a" })).toBe(true);
    expect(() => h.db.insertSignup({ ...signup, user_id: "b" })).toThrow(/UNIQUE/);
  });
});
