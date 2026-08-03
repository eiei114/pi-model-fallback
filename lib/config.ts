import type { Model } from "@earendil-works/pi-ai";

export const CONFIG_VERSION = 1;
export const DEFAULT_FALLBACK_STATUSES = [429, 500, 502, 503, 504] as const;

export interface ModelRef {
  provider: string;
  model: string;
}

export interface FallbackRule {
  name?: string;
  matchProviders?: string[];
  matchModels?: ModelRef[];
  statuses?: number[];
  /** Persistent failover cooldown in milliseconds after a matching failure. Defaults: 429 => 72h, 5xx => 10m. */
  cooldownMs?: number;
  fallback: ModelRef;
}

export interface ModelFallbackConfig {
  version: 1;
  enabled: boolean;
  rules: FallbackRule[];
}

export interface MatchedFallback {
  rule: FallbackRule;
  fallback: ModelRef;
}

export type RuleWarningCode = "provider_rule_shadows_model" | "shadowed_rule" | "duplicate_rule";

export interface RuleWarning {
  severity: "warning";
  code: RuleWarningCode;
  message: string;
  ruleIndex: number;
  ruleName?: string;
  shadowedByRuleIndex: number;
  shadowedByRuleName?: string;
  statuses: number[];
  matchProviders?: string[];
  matchModels?: ModelRef[];
}

interface NormalizedRuleForWarnings {
  providers: Set<string>;
  modelKeys: Set<string>;
  models: ModelRef[];
  statuses: Set<number>;
}

export function defaultConfig(): ModelFallbackConfig {
  return {
    version: CONFIG_VERSION,
    enabled: true,
    rules: [
      {
        name: "zai-to-deepseek-flash",
        matchProviders: ["zai"],
        statuses: [...DEFAULT_FALLBACK_STATUSES],
        fallback: { provider: "deepseek", model: "deepseek-v4-flash" },
      },
    ],
  };
}

export function validateConfigShape(value: unknown): ModelFallbackConfig {
  if (!isRecord(value)) throw new Error("Config must be an object.");
  if (value.version !== CONFIG_VERSION) throw new Error(`Unsupported config version: ${String(value.version)}.`);
  const enabled = typeof value.enabled === "boolean" ? value.enabled : true;
  if (!Array.isArray(value.rules)) throw new Error("rules must be an array.");
  if (value.rules.length === 0) throw new Error("rules must include at least one fallback rule.");

  return {
    version: CONFIG_VERSION,
    enabled,
    rules: value.rules.map((ruleValue, index) => validateRule(ruleValue, index)),
  };
}

export function findFallback(config: ModelFallbackConfig, model: Pick<Model<any>, "provider" | "id">, status: number): MatchedFallback | undefined {
  if (!config.enabled) return undefined;
  for (const rule of config.rules) {
    if (!statusesFor(rule).has(status)) continue;
    if (!modelMatches(rule, model)) continue;
    return { rule, fallback: rule.fallback };
  }
  return undefined;
}

export function analyzeRuleWarnings(config: ModelFallbackConfig): RuleWarning[] {
  const normalizedRules = config.rules.map((rule) => normalizeRuleForWarnings(rule));
  const warnings: RuleWarning[] = [];

  rules:
  for (let ruleIndex = 1; ruleIndex < config.rules.length; ruleIndex += 1) {
    const laterRule = config.rules[ruleIndex];
    const later = normalizedRules[ruleIndex];
    const reportedModelShadowKeys = new Set<string>();

    for (let earlierIndex = 0; earlierIndex < ruleIndex; earlierIndex += 1) {
      const earlierRule = config.rules[earlierIndex];
      const earlier = normalizedRules[earlierIndex];

      if (setsEqual(earlier.statuses, later.statuses) && ruleScopesEqual(earlier, later)) {
        warnings.push(duplicateRuleWarning(laterRule, ruleIndex, later, earlierRule, earlierIndex));
        continue rules;
      }

      if (statusSetCovers(earlier.statuses, later.statuses) && ruleScopeCovers(earlier, later)) {
        warnings.push(scopeShadowWarning(laterRule, ruleIndex, later, earlierRule, earlierIndex, earlier));
        continue rules;
      }

      if (earlier.providers.size === 0 || later.models.length === 0 || !statusSetCovers(earlier.statuses, later.statuses)) continue;

      const shadowedModels = later.models.filter((entry) => earlier.providers.has(entry.provider) && !reportedModelShadowKeys.has(modelRefKey(entry)));
      if (shadowedModels.length === 0) continue;
      for (const entry of shadowedModels) reportedModelShadowKeys.add(modelRefKey(entry));

      warnings.push(providerModelShadowWarning(laterRule, ruleIndex, later, earlierRule, earlierIndex, shadowedModels));
    }
  }

  return warnings;
}

export function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function modelKey(model: Pick<Model<any>, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

function validateRule(value: unknown, index: number): FallbackRule {
  if (!isRecord(value)) throw new Error(`rules[${index}] must be an object.`);
  const rule: FallbackRule = { fallback: readModelRef(value.fallback, `rules[${index}].fallback`) };
  if (typeof value.name === "string" && value.name.trim() !== "") rule.name = value.name.trim();
  if (value.matchProviders !== undefined) rule.matchProviders = readStringArray(value.matchProviders, `rules[${index}].matchProviders`);
  if (value.matchModels !== undefined) rule.matchModels = readModelRefArray(value.matchModels, `rules[${index}].matchModels`);
  if (value.statuses !== undefined) rule.statuses = readStatuses(value.statuses, `rules[${index}].statuses`);
  if (value.cooldownMs !== undefined) rule.cooldownMs = readPositiveInteger(value.cooldownMs, `rules[${index}].cooldownMs`);
  if ((!rule.matchProviders || rule.matchProviders.length === 0) && (!rule.matchModels || rule.matchModels.length === 0)) {
    throw new Error(`rules[${index}] must define matchProviders or matchModels.`);
  }
  return rule;
}

function modelMatches(rule: FallbackRule, model: Pick<Model<any>, "provider" | "id">): boolean {
  if (rule.matchModels?.some((entry) => entry.provider === model.provider && entry.model === model.id)) return true;
  if (rule.matchProviders?.includes(model.provider)) return true;
  return false;
}

function statusesFor(rule: FallbackRule): Set<number> {
  return new Set(rule.statuses && rule.statuses.length > 0 ? rule.statuses : DEFAULT_FALLBACK_STATUSES);
}

function normalizeRuleForWarnings(rule: FallbackRule): NormalizedRuleForWarnings {
  const modelsByKey = new Map((rule.matchModels ?? []).map((entry) => [modelRefKey(entry), entry]));
  return {
    providers: new Set(rule.matchProviders ?? []),
    modelKeys: new Set(modelsByKey.keys()),
    models: [...modelsByKey.values()],
    statuses: statusesFor(rule),
  };
}

function ruleScopesEqual(left: NormalizedRuleForWarnings, right: NormalizedRuleForWarnings): boolean {
  return setsEqual(left.providers, right.providers) && setsEqual(left.modelKeys, right.modelKeys);
}

function ruleScopeCovers(earlier: NormalizedRuleForWarnings, later: NormalizedRuleForWarnings): boolean {
  return setCovers(earlier.providers, later.providers) && later.models.every((entry) => earlier.providers.has(entry.provider) || earlier.modelKeys.has(modelRefKey(entry)));
}

function duplicateRuleWarning(laterRule: FallbackRule, ruleIndex: number, later: NormalizedRuleForWarnings, earlierRule: FallbackRule, earlierIndex: number): RuleWarning {
  return {
    severity: "warning",
    code: "duplicate_rule",
    message: `${ruleLabel(laterRule, ruleIndex)} is shadowed by ${ruleLabel(earlierRule, earlierIndex)} because both rules match the same providers/models and statuses; the earlier rule wins first.`,
    ruleIndex,
    ruleName: laterRule.name,
    shadowedByRuleIndex: earlierIndex,
    shadowedByRuleName: earlierRule.name,
    statuses: sortedNumbers(later.statuses),
    matchProviders: sortedStrings(later.providers),
    matchModels: sortedModels(later.models),
  };
}

function scopeShadowWarning(
  laterRule: FallbackRule,
  ruleIndex: number,
  later: NormalizedRuleForWarnings,
  earlierRule: FallbackRule,
  earlierIndex: number,
  earlier: NormalizedRuleForWarnings,
): RuleWarning {
  const providerCoveredModels = later.models.filter((entry) => earlier.providers.has(entry.provider));
  const allModelsProviderCovered = later.providers.size === 0 && later.models.length > 0 && providerCoveredModels.length === later.models.length;
  if (allModelsProviderCovered) return providerModelShadowWarning(laterRule, ruleIndex, later, earlierRule, earlierIndex, providerCoveredModels);

  return {
    severity: "warning",
    code: "shadowed_rule",
    message: `${ruleLabel(laterRule, ruleIndex)} is shadowed by ${ruleLabel(earlierRule, earlierIndex)} because the earlier rule covers its provider/model scope and statuses; the earlier rule wins first.`,
    ruleIndex,
    ruleName: laterRule.name,
    shadowedByRuleIndex: earlierIndex,
    shadowedByRuleName: earlierRule.name,
    statuses: sortedNumbers(later.statuses),
    matchProviders: sortedStrings(later.providers),
    matchModels: sortedModels(later.models),
  };
}

function providerModelShadowWarning(
  laterRule: FallbackRule,
  ruleIndex: number,
  later: NormalizedRuleForWarnings,
  earlierRule: FallbackRule,
  earlierIndex: number,
  shadowedModels: ModelRef[],
): RuleWarning {
  return {
    severity: "warning",
    code: "provider_rule_shadows_model",
    message: `${ruleLabel(laterRule, ruleIndex)} has model match ${formatModelList(shadowedModels)} shadowed by ${ruleLabel(earlierRule, earlierIndex)} for statuses ${formatStatusList(later.statuses)}; the earlier provider-wide rule wins first.`,
    ruleIndex,
    ruleName: laterRule.name,
    shadowedByRuleIndex: earlierIndex,
    shadowedByRuleName: earlierRule.name,
    statuses: sortedNumbers(later.statuses),
    matchProviders: sortedStrings(new Set(shadowedModels.map((entry) => entry.provider))),
    matchModels: sortedModels(shadowedModels),
  };
}

function statusSetCovers(earlier: Set<number>, later: Set<number>): boolean {
  return setCovers(earlier, later);
}

function setsEqual<T>(left: Set<T>, right: Set<T>): boolean {
  return left.size === right.size && setCovers(left, right);
}

function setCovers<T>(earlier: Set<T>, later: Set<T>): boolean {
  for (const value of later) {
    if (!earlier.has(value)) return false;
  }
  return true;
}

function sortedNumbers(values: Set<number>): number[] {
  return [...values].sort((left, right) => left - right);
}

function sortedStrings(values: Set<string>): string[] | undefined {
  const sorted = [...values].sort();
  return sorted.length > 0 ? sorted : undefined;
}

function sortedModels(models: ModelRef[]): ModelRef[] | undefined {
  const sorted = [...new Map(models.map((entry) => [modelRefKey(entry), entry])).values()].sort((left, right) => modelRefKey(left).localeCompare(modelRefKey(right)));
  return sorted.length > 0 ? sorted : undefined;
}

function ruleLabel(rule: FallbackRule, index: number): string {
  return rule.name ? `rules[${index}] (${rule.name})` : `rules[${index}]`;
}

function formatStatusList(statuses: Set<number>): string {
  return sortedNumbers(statuses).join(", ");
}

function formatModelList(models: ModelRef[]): string {
  return models.map(modelRefKey).sort().join(", ");
}

function readModelRef(value: unknown, path: string): ModelRef {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return {
    provider: readNonEmptyString(value.provider, `${path}.provider`),
    model: readNonEmptyString(value.model, `${path}.model`),
  };
}

function readModelRefArray(value: unknown, path: string): ModelRef[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  if (value.length === 0) throw new Error(`${path} must not be empty.`);
  return value.map((entry, index) => readModelRef(entry, `${path}[${index}]`));
}

function readStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  if (value.length === 0) throw new Error(`${path} must not be empty.`);
  return value.map((entry, index) => readNonEmptyString(entry, `${path}[${index}]`));
}

function readStatuses(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  if (value.length === 0) throw new Error(`${path} must not be empty.`);
  return value.map((entry, index) => {
    if (!Number.isInteger(entry) || entry < 100 || entry > 599) throw new Error(`${path}[${index}] must be an HTTP status code.`);
    return entry;
  });
}

function readPositiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${path} must be a positive integer.`);
  return value;
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
