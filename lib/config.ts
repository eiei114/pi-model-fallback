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
