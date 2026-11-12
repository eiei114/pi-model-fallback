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

test("remaining labels stay readable for the status command", () => {
  const now = Date.parse("2026-11-12T10:00:00.000Z");
  assert.equal(remainingLabel("2026-11-12T10:09:00.000Z", now), "9m left");
  assert.equal(remainingLabel("2026-11-12T12:00:00.000Z", now), "2h left");
  assert.equal(remainingLabel("2026-11-14T10:00:00.000Z", now), "2d left");
  assert.equal(remainingLabel("2026-11-12T09:00:00.000Z", now), "expired");
  assert.equal(remainingLabel("not-a-date", now), "expired");
});

test("the probe window defaults to fifteen minutes", () => {
  assert.equal(DEFAULT_RECOVERY_PROBE_MS, 900000);
});
