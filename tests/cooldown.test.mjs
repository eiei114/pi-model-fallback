import assert from "node:assert/strict";
import test from "node:test";

const {
  cooldownMsFor,
  cooldownMsFromHeaders,
  remainingLabel,
  DEFAULT_429_COOLDOWN_MS,
  DEFAULT_RECOVERY_PROBE_MS,
  DEFAULT_TRANSIENT_COOLDOWN_MS,
} = await import("../lib/cooldown.ts");

test("a transient 429 uses the short default and a quota 429 keeps the long one", () => {
  assert.equal(cooldownMsFor(undefined, 429, {}, { transient: true }), DEFAULT_TRANSIENT_COOLDOWN_MS);
  assert.equal(cooldownMsFor(undefined, 429, {}, { transient: false }), DEFAULT_429_COOLDOWN_MS);
  assert.equal(cooldownMsFor(undefined, 429, {}), DEFAULT_429_COOLDOWN_MS);
  assert.equal(cooldownMsFor(undefined, 529, {}, { transient: true }), DEFAULT_TRANSIENT_COOLDOWN_MS);
});

test("a configured transientCooldownMs and a rule cooldown both override the defaults", () => {
  assert.equal(cooldownMsFor(undefined, 429, {}, { transient: true, transientCooldownMs: 60000 }), 60000);
  assert.equal(cooldownMsFor(3600000, 429, {}, { transient: true }), 3600000);
  assert.equal(cooldownMsFor(3600000, 429, {}, { transient: false }), 3600000);
});

test("retry headers win over every local default and classification", () => {
  assert.equal(cooldownMsFor(3600000, 429, { "Retry-After": "60" }, { transient: false }), 60000);
  assert.equal(cooldownMsFor(undefined, 500, { "x-ratelimit-reset-requests": "30" }), 30000);
});

test("5xx keeps the ten minute default", () => {
  assert.equal(cooldownMsFor(undefined, 503, {}), 600000);
  assert.equal(cooldownMsFor(undefined, 402, {}), 600000);
});

test("header parsing ignores unusable values", () => {
  assert.equal(cooldownMsFromHeaders({}), undefined);
  assert.equal(cooldownMsFromHeaders({ "retry-after": "0" }), undefined);
  assert.equal(cooldownMsFromHeaders({ "x-ratelimit-reset": "soon" }), undefined);
});

const nowMs = Date.parse("2026-11-12T10:00:00.000Z");

test("an unrepresentable Retry-After yields to a valid reset or local cooldown", (t) => {
  t.mock.method(Date, "now", () => nowMs);
  // The first delay fits in Date on its own but not when added to now.
  // The second overflows when converted from seconds to milliseconds.
  for (const retryAfter of ["8640000000000", "1e308"]) {
    const headers = { "Retry-After": retryAfter };
    const withReset = { ...headers, "x-ratelimit-reset": "30" };
    assert.equal(cooldownMsFor(3600000, 429, withReset), 30000);
    assert.equal(cooldownMsFromHeaders(headers), undefined);
    assert.equal(cooldownMsFor(3600000, 429, headers), 3600000);
    assert.equal(cooldownMsFor(undefined, 429, headers), DEFAULT_429_COOLDOWN_MS);
    assert.equal(cooldownMsFor(3600000, 429, { ...withReset, "Retry-After": "20" }), 20000);
  }
});

test("the exact Date limit is usable, but a reset one millisecond beyond it is skipped", (t) => {
  t.mock.method(Date, "now", () => nowMs);
  const maxDateMs = 8_640_000_000_000_000;
  const headers = { "x-ratelimit-reset-requests": "30" };
  const delay = cooldownMsFromHeaders({ ...headers, "x-ratelimit-reset": String(maxDateMs) });
  assert.equal(delay, maxDateMs - nowMs);
  assert.equal(new Date(nowMs + delay).toISOString(), "+275760-09-13T00:00:00.000Z");
  assert.equal(cooldownMsFromHeaders({ ...headers, "x-ratelimit-reset": String(maxDateMs + 1) }), 30000);
});

for (const [unit, toEpoch] of [["seconds", (ms) => ms / 1000], ["milliseconds", (ms) => ms]]) {
  test(`elapsed epoch ${unit} yield to a later reset header`, (t) => {
    t.mock.method(Date, "now", () => nowMs);
    assert.equal(cooldownMsFromHeaders({
      "x-ratelimit-reset": String(toEpoch(nowMs - 1000)),
      "x-ratelimit-reset-requests": "30",
    }), 30000);
  });

  test(`elapsed or current epoch ${unit} yield to the configured cooldown`, (t) => {
    t.mock.method(Date, "now", () => nowMs);
    for (const resetMs of [nowMs - 1000, nowMs]) {
      const headers = { "x-ratelimit-reset": String(toEpoch(resetMs)) };
      assert.equal(cooldownMsFromHeaders(headers), undefined);
      assert.equal(cooldownMsFor(3600000, 429, headers), 3600000);
    }
  });
}

test("valid epoch and relative resets still work, with Retry-After taking precedence", (t) => {
  t.mock.method(Date, "now", () => nowMs);
  const resetMs = nowMs + 45000;
  for (const reset of [String(resetMs / 1000), String(resetMs)]) {
    assert.equal(cooldownMsFromHeaders({ "x-ratelimit-reset": reset }), 45000);
  }
  assert.equal(cooldownMsFromHeaders({ "x-ratelimit-reset": "1.2345" }), 1235);
  const headers = { "x-ratelimit-reset": String(resetMs) };
  assert.equal(cooldownMsFromHeaders({ ...headers, "Retry-After": "20" }), 20000);
  assert.equal(cooldownMsFromHeaders({ ...headers, "Retry-After": new Date(nowMs + 10000).toUTCString() }), 10000);
});

test("remaining labels stay readable for the status command", () => {
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  assert.equal(remainingLabel("2026-11-12T10:09:00.000Z", now), "9m left");
  assert.equal(remainingLabel("2026-11-12T12:00:00.000Z", now), "2h left");
  assert.equal(remainingLabel("2026-11-14T10:00:00.000Z", now), "2d left");
  assert.equal(remainingLabel("2026-11-12T09:00:00.000Z", now), "expired");
  assert.equal(remainingLabel("not-a-date", now), "expired");
});

test("the probe window defaults below the transient cooldown so it can fire", () => {
  assert.equal(DEFAULT_RECOVERY_PROBE_MS, 300000);
  assert.ok(DEFAULT_RECOVERY_PROBE_MS < DEFAULT_TRANSIENT_COOLDOWN_MS);
});
