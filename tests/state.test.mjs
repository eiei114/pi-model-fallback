import assert from "node:assert/strict";
import test from "node:test";

const { findActiveStateEntry, pruneExpiredState, upsertStateEntry, validateStateShape } = await import("../lib/state.ts");

test("state finds active persistent fallback entries", () => {
  const now = new Date("2026-06-30T00:00:00Z");
  const state = {
    version: 1,
    entries: [
      {
        source: { provider: "zai", model: "glm-5-turbo" },
        fallback: { provider: "deepseek", model: "deepseek-v4-flash" },
        status: 429,
        createdAt: "2026-06-29T00:00:00Z",
        until: "2026-07-03T00:00:00Z",
      },
    ],
  };
  const active = findActiveStateEntry(state, { provider: "zai", model: "glm-5-turbo" }, now);
  assert.deepEqual(active?.fallback, { provider: "deepseek", model: "deepseek-v4-flash" });
});

test("state prunes expired entries", () => {
  const pruned = pruneExpiredState(
    {
      version: 1,
      entries: [
        {
          source: { provider: "zai", model: "glm-4.7" },
          fallback: { provider: "deepseek", model: "deepseek-v4-flash" },
          status: 429,
          createdAt: "2026-06-29T00:00:00Z",
          until: "2026-06-29T01:00:00Z",
        },
      ],
    },
    new Date("2026-06-30T00:00:00Z"),
  );
  assert.equal(pruned.entries.length, 0);
});

test("state upsert replaces source model entry", () => {
  const state = upsertStateEntry(
    {
      version: 1,
      entries: [
        {
          source: { provider: "zai", model: "glm-4.7" },
          fallback: { provider: "deepseek", model: "old" },
          status: 429,
          createdAt: "2026-06-29T00:00:00Z",
          until: "2026-06-30T00:00:00Z",
        },
      ],
    },
    {
      source: { provider: "zai", model: "glm-4.7" },
      fallback: { provider: "deepseek", model: "deepseek-v4-flash" },
      status: 429,
      createdAt: "2026-06-29T01:00:00Z",
      until: "2026-07-03T00:00:00Z",
    },
  );
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].fallback.model, "deepseek-v4-flash");
});

test("state validation rejects malformed dates", () => {
  assert.throws(
    () => validateStateShape({ version: 1, entries: [{ source: {}, fallback: {}, status: 429, createdAt: "x", until: "x" }] }),
    /ISO date|non-empty/,
  );
});
