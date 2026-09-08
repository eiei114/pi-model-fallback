import assert from "node:assert/strict";
import test from "node:test";

const { isRecord, readJsonIfExists, readModelRef, readNonEmptyString } = await import("../lib/internal.ts");

test("isRecord accepts plain objects and rejects arrays", () => {
  assert.equal(isRecord({ ok: true }), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
});

test("readNonEmptyString trims and rejects empty values", () => {
  assert.equal(readNonEmptyString("  zai  ", "provider"), "zai");
  assert.throws(() => readNonEmptyString("   ", "provider"), /non-empty string/);
});

test("readModelRef validates provider and model fields", () => {
  assert.deepEqual(readModelRef({ provider: "zai", model: "glm-4.7" }, "model"), {
    provider: "zai",
    model: "glm-4.7",
  });
  assert.throws(() => readModelRef({ provider: "", model: "x" }, "model"), /non-empty string/);
});

test("readJsonIfExists returns undefined for missing files", async () => {
  const missingPath = `model-fallback-missing-${Date.now()}.json`;
  assert.equal(await readJsonIfExists(missingPath), undefined);
});
