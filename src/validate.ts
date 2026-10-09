import { AppError } from "./errors.ts";
import { isLinkKind, REF_PATTERN, type LinkKind } from "./domain/links.ts";

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export type Body = Record<string, unknown>;

export async function readBody(req: Request, allowEmpty = false): Promise<Body> {
  const text = await req.text();
  if (allowEmpty && text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "O corpo precisa ser um JSON válido.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(400, "invalid_json", "O corpo precisa ser um objeto JSON.");
  }
  return parsed as Body;
}

export function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw new AppError(422, "invalid_field", `${field} deve ter de 1 a 80 caracteres entre A-Z, a-z, 0-9, _ e -.`);
  }
  return value;
}

export function optionalId(value: unknown, field: string): string | undefined {
  return value === undefined || value === null ? undefined : id(value, field);
}

export function kind(value: unknown): LinkKind {
  if (!isLinkKind(value)) throw new AppError(422, "invalid_field", "kind deve ser referral, campaign ou community.");
  return value;
}

export function ref(value: unknown): string {
  if (typeof value !== "string" || !REF_PATTERN.test(value)) {
    throw new AppError(422, "invalid_field", "ref deve ter de 1 a 64 caracteres entre A-Z, a-z, 0-9, _ e -.");
  }
  return value;
}

/** ISO 8601 with an explicit offset; returns epoch milliseconds. */
export function optionalInstant(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === "string" && isRealInstant(value) ? Date.parse(value) : NaN;
  if (Number.isNaN(ms)) {
    throw new AppError(422, "invalid_field", `${field} deve ser um instante ISO 8601 com fuso, ex.: 2026-03-10T12:00:00Z.`);
  }
  return ms;
}

export function requiredInstant(value: unknown, field: string): number {
  const ms = optionalInstant(value, field);
  if (ms === undefined) throw new AppError(422, "invalid_field", `${field} é obrigatório.`);
  return ms;
}

// Date.parse rolls 2026-02-31 over to March; reject it instead of moving the instant.
function isRealInstant(value: string): boolean {
  const m = INSTANT_PATTERN.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = m.slice(1).map((part) => Number(part ?? 0));
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day &&
    hour < 24 && minute < 60 && second < 60 && offsetHour < 24 && offsetMinute < 60
  );
}
