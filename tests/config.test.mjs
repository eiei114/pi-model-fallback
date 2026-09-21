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

test("default config enables auto retry", () => {
  assert.equal(defaultConfig().autoRetry, true);
});

test("config validation defaults autoRetry to true and preserves explicit false", () => {
  assert.equal(validateConfigShape({ version: 1, enabled: true, rules: [{ matchProviders: ["zai"], fallback }] }).autoRetry, true);
  assert.equal(validateConfigShape({ version: 1, enabled: true, autoRetry: false, rules: [{ matchProviders: ["zai"], fallback }] }).autoRetry, false);
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

test("rule warnings detect provider subset rules with covered statuses", () => {
  const config = warningConfig([
    { name: "broad-providers", matchProviders: ["zai", "openai"], fallback },
    { name: "provider-subset", matchProviders: ["zai"], statuses: [429], fallback: { provider: "openai", model: "gpt-4.1-mini" } },
  ]);

  const warnings = analyzeRuleWarnings(config);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "shadowed_rule");
  assert.equal(warnings[0].ruleIndex, 1);
  assert.equal(warnings[0].shadowedByRuleIndex, 0);
  assert.deepEqual(warnings[0].statuses, [429]);
  assert.deepEqual(warnings[0].matchProviders, ["zai"]);
});

test("rule warnings detect model subset rules with covered statuses", () => {
  const config = warningConfig([
    {
      name: "broad-models",
      matchModels: [
        { provider: "zai", model: "glm-4.7" },
        { provider: "zai", model: "glm-5" },
      ],
      statuses: [429, 500],
      fallback,
    },
    { name: "model-subset", matchModels: [{ provider: "zai", model: "glm-4.7" }], statuses: [429], fallback: { provider: "openai", model: "gpt-4.1-mini" } },
  ]);

  const warnings = analyzeRuleWarnings(config);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "shadowed_rule");
  assert.equal(warnings[0].ruleIndex, 1);
  assert.equal(warnings[0].shadowedByRuleIndex, 0);
  assert.deepEqual(warnings[0].statuses, [429]);
  assert.deepEqual(warnings[0].matchModels, [{ provider: "zai", model: "glm-4.7" }]);
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

test("reason-scoped rule fires only for the listed reason", () => {
  const config = warningConfig([
    {
      name: "context-overflow",
      matchProviders: ["openrouter"],
      statuses: [400],
      reasons: ["context_length_exceeded"],
      fallback: { provider: "openrouter", model: "z-ai/glm-5.3-flash" },
    },
  ]);

  const model = { provider: "openrouter", id: "nex-agi/nex-n2.5-mini:free" };
  assert.deepEqual(findFallback(config, model, 400, "context_length_exceeded")?.fallback, { provider: "openrouter", model: "z-ai/glm-5.3-flash" });
  assert.equal(findFallback(config, model, 400, "insufficient_quota"), undefined);
  assert.equal(findFallback(config, model, 400), undefined);
  assert.equal(findFallback(config, model, 429, "context_length_exceeded"), undefined);
});

test("rules without reasons still match when a reason is parsed", () => {
  const config = warningConfig([{ matchProviders: ["zai"], fallback }]);
  assert.deepEqual(findFallback(config, { provider: "zai", id: "glm-4.7" }, 429, "rate_limited")?.fallback, fallback);
});

test("findFallback never targets the failing model itself", () => {
  const config = warningConfig([
    { name: "broad-openrouter", matchProviders: ["openrouter"], fallback: { provider: "openrouter", model: "z-ai/glm-5.3-flash" } },
  ]);

  assert.equal(findFallback(config, { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, 429), undefined);
  assert.deepEqual(findFallback(config, { provider: "openrouter", id: "nex-agi/nex-n2.5-mini:free" }, 429)?.fallback, { provider: "openrouter", model: "z-ai/glm-5.3-flash" });
});

test("rules with disjoint reasons on the same scope are not reported as shadowed", () => {
  const config = warningConfig([
    { name: "other-400s", matchProviders: ["zai"], statuses: [400], reasons: ["insufficient_quota"], fallback: { provider: "openai", model: "gpt-4.1-mini" } },
    { name: "context-400s", matchProviders: ["zai"], statuses: [400], reasons: ["context_length_exceeded"], fallback: { provider: "openai", model: "gpt-4.1" } },
  ]);

  assert.equal(analyzeRuleWarnings(config).length, 0);
});

test("unrestricted earlier rule still shadows a later reason-scoped rule", () => {
  const config = warningConfig([
    { name: "broad", matchProviders: ["zai"], statuses: [400], fallback: { provider: "openai", model: "gpt-4.1-mini" } },
    { name: "scoped", matchProviders: ["zai"], statuses: [400], reasons: ["context_length_exceeded"], fallback: { provider: "openai", model: "gpt-4.1" } },
  ]);

  const warnings = analyzeRuleWarnings(config);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, "shadowed_rule");
});

test("config validation accepts reasons and rejects invalid entries", () => {
  const config = validateConfigShape({
    version: 1,
    enabled: true,
    rules: [{ matchProviders: ["zai"], reasons: ["context_length_exceeded"], fallback }],
  });
  assert.deepEqual(config.rules[0].reasons, ["context_length_exceeded"]);
  assert.throws(
    () => validateConfigShape({ version: 1, enabled: true, rules: [{ matchProviders: ["zai"], reasons: [], fallback }] }),
    /must not be empty/,
  );
});
