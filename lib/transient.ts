/**
 * Separates a momentary rate limit from an exhausted quota inside the same 429.
 *
 * Both arrive as 429, but they mean different things:
 * - transient: momentary overload or per-minute throttling, for example zai's
 *   "该模型当前访问量过大", "The service may be temporarily overloaded",
 *   "Rate limit exceeded", or a bare "429 Too Many Requests". The model is
 *   usable again within minutes, so a long persistent cooldown hides a healthy
 *   model for days and forces every new session onto the fallback.
 * - quota: the subscription window is spent, for example
 *   "429 Usage limit reached for 5 hour. Your limit will reset at ...",
 *   "insufficient_quota", or "out of budget". Only this kind earns the long
 *   default cooldown.
 *
 * A 429 without recognizable wording counts as transient: there is no evidence
 * the quota is gone, and an unverifiable lock is the worse failure mode.
 * `Retry-After` and `x-ratelimit-reset*` headers still override the resulting
 * cooldown in either direction.
 */

const QUOTA_429_PATTERNS: RegExp[] = [
  /usage[\s_-]?limit/i,
  /insufficient[_\s-]?(?:quota|balance|credit)/i,
  /available balance/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /out of (?:budget|credits)/i,
  /\bbilling\b/i,
  /额度|余额|配额|欠费/,
  // Chinese quota wording that does not use the words above, for example
  // "429 用量已达上限" or "429 今日调用次数已用完". A pure load complaint such
  // as "访问量过大" or "请求量超出限制" stays transient: it names traffic, not
  // a spent allowance, and treating it as quota would restore the 72h lock.
  /(?:用量|次数|调用量|额度|配额|余额).*(?:上限|用完|耗尽|限制|不足)/,
];

/** Statuses that report both throttling and quota exhaustion. */
const SHARED_QUOTA_STATUSES = new Set([429, 529]);

export function isQuotaExhaustion(message: string | undefined): boolean {
  if (!message) return false;
  return QUOTA_429_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * True when a 429/529 is a capacity or throttling signal rather than a spent
 * quota, so the persistent cooldown should use `transientCooldownMs`.
 */
export function isTransientRateLimit(status: number, message: string | undefined): boolean {
  if (!SHARED_QUOTA_STATUSES.has(status)) return false;
  return !isQuotaExhaustion(message);
}
