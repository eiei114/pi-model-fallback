import assert from "node:assert/strict";
import test from "node:test";

const { emptyState, removeStateEntry, shouldProbeRecovery, upsertStateEntry, validateStateShape } = await import("../lib/state.ts");

const SOURCE = { provider: "zai", model: "glm-5.3" };
const FALLBACK = { provider: "zai-coding-cn", model: "glm-5.3" };

function entry(overrides = {}) {
  return {
    source: SOURCE,
    fallback: FALLBACK,
    status: 429,
    createdAt: "2026-11-12T10:00:00.000Z",
    until: "2026-11-12T10:10:00.000Z",
    ...overrides,
  };
}

test("transient entries are re-probed once the probe window has passed", () => {
  const transient = entry({ transient: true, probe: true });
  const createdAt = Date.parse(transient.createdAt);
  assert.equal(shouldProbeRecovery(transient, createdAt + 60000, 900000), false);
  assert.equal(shouldProbeRecovery(transient, createdAt + 900000, 900000), true);
  assert.equal(shouldProbeRecovery(transient, createdAt + 86400000, 900000), true);
});

test("quota and legacy entries are never probed", () => {
  const createdAt = Date.parse(entry().createdAt);
  assert.equal(shouldProbeRecovery(entry({ transient: false }), createdAt + 86400000, 900000), false);
  assert.equal(shouldProbeRecovery(entry(), createdAt + 86400000, 900000), false);
});

test("a transient entry with an explicit cooldown or reset header is never probed early", () => {
  const createdAt = Date.parse(entry().createdAt);
  assert.equal(shouldProbeRecovery(entry({ transient: true, probe: false }), createdAt + 86400000, 900000), false);
  assert.equal(shouldProbeRecovery(entry({ transient: true }), createdAt + 86400000, 900000), false);
});

test("a zero probe window disables probing", () => {
  const transient = entry({ transient: true, probe: true });
  assert.equal(shouldProbeRecovery(transient, Date.parse(transient.createdAt) + 86400000, 0), false);
});

test("state validation keeps the transient and probe flags", () => {
  const state = validateStateShape({ version: 1, entries: [entry({ transient: true, probe: true, futureField: "ignored" })] });
  assert.equal(state.entries[0].transient, true);
  assert.equal(state.entries[0].probe, true);
  const legacy = validateStateShape({ version: 1, entries: [entry()] });
  assert.equal(legacy.entries[0].transient, undefined);
  assert.equal(legacy.entries[0].probe, undefined);
});

test("removeStateEntry drops one source and leaves the rest", () => {
  const other = { provider: "minimax-cn", model: "MiniMax-M3.1-Flash" };
  let state = upsertStateEntry(emptyState(), entry({ transient: true }));
  state = upsertStateEntry(state, entry({ source: other, until: "2026-11-13T00:00:00.000Z" }));
  assert.equal(state.entries.length, 2);
  const pruned = removeStateEntry(state, SOURCE);
  assert.equal(pruned.entries.length, 1);
  assert.deepEqual(pruned.entries[0].source, other);
});
