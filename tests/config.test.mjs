import assert from "node:assert/strict";
import test from "node:test";

const { defaultConfig, findFallback, validateConfigShape } = await import("../lib/config.ts");

test("default config falls back from zai 429 to deepseek flash", () => {
  const config = defaultConfig();
  const match = findFallback(config, { provider: "zai", id: "glm-4.7" }, 429);
  assert.deepEqual(match?.fallback, { provider: "deepseek", model: "deepseek-v4-flash" });
});

test("default config does not affect healthy responses or non-matching providers", () => {
  const config = defaultConfig();
  assert.equal(findFallback(config, { provider: "zai", id: "glm-4.7" }, 200), undefined);
  assert.equal(findFallback(config, { provider: "deepseek", id: "deepseek-v4-flash" }, 429), undefined);
});

test("config validation requires matchProviders or matchModels", () => {
  assert.throws(
    () => validateConfigShape({ version: 1, enabled: true, rules: [{ fallback: { provider: "deepseek", model: "deepseek-v4-flash" } }] }),
    /matchProviders or matchModels/,
  );
});
