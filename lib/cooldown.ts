export const DEFAULT_429_COOLDOWN_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_TRANSIENT_COOLDOWN_MS = 10 * 60 * 1000;
export const DEFAULT_5XX_COOLDOWN_MS = 10 * 60 * 1000;
// Must stay below DEFAULT_TRANSIENT_COOLDOWN_MS: expired entries are pruned on
// read, so a probe window longer than the cooldown could never fire and the
// source model would only be retried once the entry aged out anyway.
export const DEFAULT_RECOVERY_PROBE_MS = 5 * 60 * 1000;

export interface CooldownOptions {
  /** Set for a 429/529 that carries no quota wording; see `lib/transient.ts`. */
  transient?: boolean;
  transientCooldownMs?: number;
}

export function cooldownMsFor(
  ruleCooldownMs: number | undefined,
  status: number,
  headers: Record<string, string>,
  options: CooldownOptions = {},
  nowMs = Date.now(),
): number {
  const headerMs = cooldownMsFromHeaders(headers, nowMs);
  if (headerMs !== undefined) return headerMs;
  if (ruleCooldownMs !== undefined) return ruleCooldownMs;
  if (status === 429 || status === 529) {
    return options.transient ? options.transientCooldownMs ?? DEFAULT_TRANSIENT_COOLDOWN_MS : DEFAULT_429_COOLDOWN_MS;
  }
  return DEFAULT_5XX_COOLDOWN_MS;
}

export function cooldownMsFromHeaders(headers: Record<string, string>, nowMs = Date.now()): number | undefined {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const retryAfter = parseRetryAfter(normalized["retry-after"], nowMs);
  if (canSerializeExpiry(retryAfter, nowMs)) return retryAfter;

  for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "ratelimit-reset", "x-rate-limit-reset"]) {
    const parsed = parseResetHeader(normalized[name], nowMs);
    if (canSerializeExpiry(parsed, nowMs)) return parsed;
  }
  return undefined;
}

// Check the same absolute timestamp that the extension will serialize.
function canSerializeExpiry(delayMs: number | undefined, nowMs: number): delayMs is number {
  return delayMs !== undefined && Number.isFinite(new Date(nowMs + delayMs).getTime());
}

function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (dateMs > nowMs) return dateMs - nowMs;
  return undefined;
}

function parseResetHeader(value: string | undefined, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric <= 1_000_000_000) return Math.ceil(numeric * 1000);
    const resetMs = numeric > 1_000_000_000_000 ? numeric : numeric * 1000;
    const remainingMs = resetMs - nowMs;
    return remainingMs > 0 ? remainingMs : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (dateMs > nowMs) return dateMs - nowMs;
  return undefined;
}

/** Human-readable remaining time for status lines. */
export function remainingLabel(until: string, nowMs = Date.now()): string {
  const remaining = Date.parse(until) - nowMs;
  if (!Number.isFinite(remaining) || remaining <= 0) return "expired";
  const minutes = Math.ceil(remaining / 60000);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`} left`;
  return `${Math.floor(hours / 24)}d left`;
}
