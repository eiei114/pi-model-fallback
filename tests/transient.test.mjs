import assert from "node:assert/strict";
import test from "node:test";

const { isQuotaExhaustion, isTransientRateLimit } = await import("../lib/transient.ts");

test("zai overload 429 phrasing counts as transient", () => {
  assert.equal(isTransientRateLimit(429, "429 该模型当前访问量过大，请您稍后再试"), true);
  assert.equal(isTransientRateLimit(429, "429 The service may be temporarily overloaded, please try again later"), true);
  assert.equal(isTransientRateLimit(429, "429 Rate limit exceeded"), true);
  assert.equal(isTransientRateLimit(429, "429 Too Many Requests"), true);
});

test("a bare 429 without wording counts as transient", () => {
  assert.equal(isTransientRateLimit(429, "429"), true);
  assert.equal(isTransientRateLimit(429, undefined), true);
});

test("exhausted subscription windows and balance errors stay long-lived", () => {
  for (const message of [
    "429 Usage limit reached for 5 hour. Your limit will reset at 2026-11-12 23:00:00",
    "429 insufficient_quota",
    "429 quota exceeded",
    "429 You are out of budget for this month",
    "429 Available balance is too low",
    "429 billing hard limit reached",
    "429 账户余额不足",
    "429 配额已用尽",
  ]) {
    assert.equal(isQuotaExhaustion(message), true, message);
    assert.equal(isTransientRateLimit(429, message), false, message);
  }
});

test("statuses that do not share rate limiting and quota stay out of the transient bucket", () => {
  assert.equal(isTransientRateLimit(500, "429 overloaded"), false);
  assert.equal(isTransientRateLimit(402, "429 usage limit reached"), false);
  assert.equal(isTransientRateLimit(529, "Attempted to access streaming response content, but was not produced"), true);
});

test("Chinese allowance wording counts as quota while load wording stays transient", () => {
  for (const message of ["429 用量已达上限，请稍后再试", "429 今日调用次数已用完", "429 调用量超出限制"]) {
    assert.equal(isQuotaExhaustion(message), true, message);
  }
  for (const message of ["429 该模型当前访问量过大，请您稍后再试", "429 请求量超出限制"]) {
    assert.equal(isTransientRateLimit(429, message), true, message);
  }
});
