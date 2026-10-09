import { describe, expect, it } from "vitest";
import { buildDeepLink, parseLinkParams } from "../src/domain/links.ts";

describe("link contract", () => {
  it("builds the deep link with cty_src, cty_ref and ctyc", () => {
    expect(buildDeepLink({ kind: "campaign", ref: "cmp_123", clickId: "clk_abc" })).toBe(
      "conty://open?cty_src=campaign&cty_ref=cmp_123&ctyc=clk_abc",
    );
  });

  it("round-trips through parse", () => {
    const link = buildDeepLink({ kind: "referral", ref: "ana_silva", clickId: "clk_1" });
    expect(parseLinkParams(link)).toEqual({ kind: "referral", ref: "ana_silva", clickId: "clk_1" });
  });

  it("accepts a link with only the click id", () => {
    expect(parseLinkParams("https://conty.app/app?ctyc=clk_9")).toEqual({
      kind: null,
      ref: null,
      clickId: "clk_9",
    });
  });

  it("returns null without attribution params or for garbage", () => {
    expect(parseLinkParams("conty://open?utm=1")).toBeNull();
    expect(parseLinkParams("not a url")).toBeNull();
  });

  it("drops an unknown kind and an invalid ref instead of trusting them", () => {
    expect(parseLinkParams("conty://open?cty_src=ads&cty_ref=a%20b&ctyc=clk_1")).toEqual({
      kind: null,
      ref: null,
      clickId: "clk_1",
    });
  });
});
