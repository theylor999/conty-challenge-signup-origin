import { createApp } from "../src/app.ts";
import type { Clock } from "../src/clock.ts";
import { DEFAULTS, type AppConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { DAY_MS, HOUR_MS } from "../src/domain/time.ts";
import { AttributionService } from "../src/service.ts";

export const T0 = Date.parse("2026-03-10T12:00:00.000Z");
export const iso = (ms: number) => new Date(ms).toISOString();
export { DAY_MS, HOUR_MS };

export class FakeClock implements Clock {
  constructor(private current = T0) {}
  now() {
    return this.current;
  }
  set(ms: number) {
    this.current = ms;
  }
  advance(ms: number) {
    this.current += ms;
  }
}

export function setup(config: AppConfig = DEFAULTS) {
  const clock = new FakeClock();
  const db = openDb(":memory:");
  let n = 0;
  // Zero-padded counter: click ids sort in creation order, which the tie-break tests rely on.
  const token = () => String(++n).padStart(6, "0");
  const app = createApp(new AttributionService({ db, clock, config, token }));

  async function call(method: string, path: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null };
  }

  return {
    clock,
    db,
    call,
    link: (kind: string, ref: string, code?: string) => call("POST", "/links", { kind, ref, code }),
    /** Clicks a short link at the current clock time and returns the click_id from the redirect. */
    async click(code: string): Promise<string> {
      const res = await app.request(`/i/${code}`);
      const location = new URL(res.headers.get("location")!);
      return location.searchParams.get("ctyc")!;
    },
    /** Like the app: the first open time is always sent, here the current clock time unless given. */
    firstOpen: (installId: string, openedAt?: string) =>
      call("POST", `/installs/${installId}/first-open`, { opened_at: openedAt ?? iso(clock.now()) }),
    /** Like the app: opened_at is always sent, here the current clock time unless given. */
    touch: (body: Record<string, unknown>) =>
      call("POST", "/touches", { opened_at: iso(clock.now()), ...body }),
    /** Like the backend: signed_up_at is always sent, here the current clock time unless given. */
    signup: (body: Record<string, unknown>) =>
      call("POST", "/signups", { signed_up_at: iso(clock.now()), ...body }),
    attribution: (userId: string) => call("GET", `/signups/${userId}/attribution`),
  };
}

export type Harness = ReturnType<typeof setup>;

export const INSTALL = "install-0001";

/** Standard fixture: a campaign link and a referral link, install opened at T0. */
export async function withLinks() {
  const h = setup();
  await h.link("campaign", "cmp_123", "camp1");
  await h.link("referral", "ana_silva", "refana");
  await h.link("community", "discord_br", "comm1");
  await h.firstOpen(INSTALL);
  return h;
}
