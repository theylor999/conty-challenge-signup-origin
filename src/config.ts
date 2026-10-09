import { DAY_MS, HOUR_MS } from "./domain/time.ts";
import { DEFAULT_CONFIG, type AttributionConfig } from "./domain/attribution.ts";

export interface AppConfig {
  attribution: AttributionConfig;
  /** How far a client timestamp may be ahead of the server clock. */
  maxClockSkewMs: number;
  /** Public host of the short links, used to build `short_url`. */
  publicBaseUrl: string;
  /** Where GET /i/:code redirects (landing that sends to the store or opens the app). */
  redirectBaseUrl: string;
}

export const DEFAULTS: AppConfig = {
  attribution: DEFAULT_CONFIG,
  maxClockSkewMs: 5 * 60 * 1000,
  publicBaseUrl: "https://conty.app",
  redirectBaseUrl: "https://conty.app/app",
};

export function configFromEnv(env: NodeJS.ProcessEnv): AppConfig {
  const windowDays = positive(env.ATTRIBUTION_WINDOW_DAYS, "ATTRIBUTION_WINDOW_DAYS");
  const lookbackHours = positive(env.PRE_INSTALL_LOOKBACK_HOURS, "PRE_INSTALL_LOOKBACK_HOURS");
  return {
    ...DEFAULTS,
    attribution: {
      windowMs: windowDays === undefined ? DEFAULTS.attribution.windowMs : windowDays * DAY_MS,
      preInstallLookbackMs:
        lookbackHours === undefined ? DEFAULTS.attribution.preInstallLookbackMs : lookbackHours * HOUR_MS,
    },
    publicBaseUrl: env.PUBLIC_BASE_URL ?? DEFAULTS.publicBaseUrl,
    redirectBaseUrl: env.REDIRECT_BASE_URL ?? DEFAULTS.redirectBaseUrl,
  };
}

function positive(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
