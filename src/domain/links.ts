export const LINK_KINDS = ["referral", "campaign", "community"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

// Tie-break order when two touches carry the same timestamp: a referral is a
// person vouching for Conty, a campaign is paid media, a community is broad reach.
export const KIND_PRIORITY: Record<LinkKind, number> = {
  referral: 3,
  campaign: 2,
  community: 1,
};

export const REF_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isLinkKind(value: unknown): value is LinkKind {
  return typeof value === "string" && (LINK_KINDS as readonly string[]).includes(value);
}

/** Query parameter names that travel in links and deep links. */
export const PARAM = { kind: "cty_src", ref: "cty_ref", click: "ctyc" } as const;

export interface LinkParams {
  kind: LinkKind;
  ref: string;
  clickId?: string;
}

export function buildLinkParams({ kind, ref, clickId }: LinkParams): URLSearchParams {
  const params = new URLSearchParams();
  params.set(PARAM.kind, kind);
  params.set(PARAM.ref, ref);
  if (clickId) params.set(PARAM.click, clickId);
  return params;
}

export function buildDeepLink(link: LinkParams): string {
  return `conty://open?${buildLinkParams(link).toString()}`;
}

export interface ParsedLink {
  kind: LinkKind | null;
  ref: string | null;
  clickId: string | null;
}

/**
 * What the app reads from a link it was opened with. Returns null when the link
 * carries no attribution parameter at all. A link with only `ctyc` is valid:
 * the server knows kind and ref for that click.
 */
export function parseLinkParams(input: string | URL): ParsedLink | null {
  const url = typeof input === "string" ? safeUrl(input) : input;
  if (!url) return null;
  const kind = url.searchParams.get(PARAM.kind);
  const ref = url.searchParams.get(PARAM.ref);
  const clickId = url.searchParams.get(PARAM.click);
  if (!kind && !ref && !clickId) return null;
  return {
    kind: isLinkKind(kind) ? kind : null,
    ref: ref !== null && REF_PATTERN.test(ref) ? ref : null,
    clickId: clickId && clickId.length > 0 ? clickId : null,
  };
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
