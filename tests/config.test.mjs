import assert from "node:assert/strict";
import test from "node:test";

const { analyzeRuleWarnings, defaultConfig, findFallback, validateConfigShape } = await import("../lib/config.ts");

const fallback = { provider: "deepseek", model: "deepseek-v4-flash" };

function warningConfig(rules) {
  return validateConfigShape({ version: 1, enabled: true, rules });
}

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
    () => validateConfigShape({ version: 1, enabled: true, rules: [{ fallback }] }),
    /matchProviders or matchModels/,
  );
});

test("rule warnings detect provider-wide rule shadowing a later model-specific rule", () => {
  const config = warningConfig([
    { name: "provider-wide", matchProviders: ["zai"], fallback },
    { name: "specific-model", matchModels: [{ provider: "zai", model: "glm-4.7" }], fallback: { provider: "openai", model: "gpt-4.1-mini" } },
  ]);

  const warnings = analyzeRuleWarnings(config);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "provider_rule_shadows_model");
  assert.equal(warnings[0].ruleIndex, 1);
  assert.equal(warnings[0].shadowedByRuleIndex, 0);
  assert.deepEqual(warnings[0].statuses, [429, 500, 502, 503, 504]);
  assert.deepEqual(warnings[0].matchModels, [{ provider: "zai", model: "glm-4.7" }]);
});

test("rule warnings detect duplicate same-scope and same-status rules", () => {
  const config = warningConfig([
    {
      name: "first",
      matchModels: [
        { provider: "zai", model: "glm-4.7" },
        { provider: "openai", model: "gpt-4.1-mini" },
      ],
      statuses: [503, 429],
      fallback,
    },
    {
      name: "duplicate",
      matchModels: [
        { provider: "openai", model: "gpt-4.1-mini" },
        { provider: "zai", model: "glm-4.7" },
      ],
      statuses: [429, 503],
      fallback: { provider: "anthropic", model: "claude-sonnet-4" },
    },
  ]);

  const warnings = analyzeRuleWarnings(config);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "duplicate_rule");
  assert.equal(warnings[0].ruleIndex, 1);
  assert.equal(warnings[0].shadowedByRuleIndex, 0);
  assert.deepEqual(warnings[0].statuses, [429, 503]);
  assert.deepEqual(warnings[0].matchModels, [
    { provider: "openai", model: "gpt-4.1-mini" },
    { provider: "zai", model: "glm-4.7" },
  ]);
});

test("rule warnings do not report partial status overlaps as complete shadows", () => {
  const config = warningConfig([
    { name: "provider-429", matchProviders: ["zai"], statuses: [429], fallback },
    { name: "specific-429-and-500", matchModels: [{ provider: "zai", model: "glm-4.7" }], statuses: [429, 500], fallback: { provider: "openai", model: "gpt-4.1-mini" } },
  ]);

  assert.deepEqual(analyzeRuleWarnings(config), []);
});

test("rule warning analysis does not change first-match fallback order", () => {
  const config = warningConfig([
    { name: "provider-wide", matchProviders: ["zai"], fallback },
    { name: "specific-model", matchModels: [{ provider: "zai", model: "glm-4.7" }], fallback: { provider: "openai", model: "gpt-4.1-mini" } },
  ]);

  assert.equal(analyzeRuleWarnings(config).length, 1);
  assert.deepEqual(findFallback(config, { provider: "zai", id: "glm-4.7" }, 429)?.fallback, fallback);
});
