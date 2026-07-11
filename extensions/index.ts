import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  defaultConfig,
  findFallback,
  modelKey,
  modelRefKey,
  validateConfigShape,
  type ModelFallbackConfig,
  type ModelRef,
} from "../lib/config.js";
import { parseStatusFromErrorMessage } from "../lib/error-status.js";
import { emptyState, findActiveStateEntry, pruneExpiredState, readState, upsertStateEntry, validateStateShape, writeState, type FallbackState } from "../lib/state.js";
import { modelFallbackPaths, readConfig, writeConfig, type ModelFallbackPaths } from "../lib/storage.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATUS_KEY = "model-fallback";
const DEFAULT_429_COOLDOWN_MS = 72 * 60 * 60 * 1000;
const DEFAULT_5XX_COOLDOWN_MS = 10 * 60 * 1000;

export default function modelFallback(pi: ExtensionAPI) {
  let paths: ModelFallbackPaths = modelFallbackPaths(getAgentDir());
  let pathsResolvedForCwd: string | undefined;
  let config: ModelFallbackConfig | undefined;
  let state: FallbackState | undefined;
  let originalModelKey: string | undefined;
  let activeFallbackKey: string | undefined;
  let lastFallbackReason: string | undefined;

  function syncPaths(ctx: ExtensionContext): void {
    if (pathsResolvedForCwd === ctx.cwd) return;
    pathsResolvedForCwd = ctx.cwd;
    paths = shouldUseProjectLocalState(ctx) ? modelFallbackPaths(join(ctx.cwd, ".pi")) : modelFallbackPaths(getAgentDir());
  }

  async function loadConfig(ctx: ExtensionContext): Promise<ModelFallbackConfig | undefined> {
    try {
      syncPaths(ctx);
      config = await readConfig(paths.config);
      return config;
    } catch (error) {
      ctx.ui.notify(`Model fallback config error: ${errorMessage(error)}`, "warning");
      return undefined;
    }
  }

  async function loadState(ctx: ExtensionContext): Promise<FallbackState | undefined> {
    try {
      syncPaths(ctx);
      const statePath = paths.state;
      if (!existsSync(statePath)) {
        state = emptyState();
        return state;
      }

      const before = validateStateShape(JSON.parse(await readFile(statePath, "utf8")));
      const after = pruneExpiredState(before);
      state = after;
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await writeState(statePath, after);
      }
      return state;
    } catch (error) {
      ctx.ui.notify(`Model fallback state error: ${errorMessage(error)}`, "warning");
      return undefined;
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, activeFallbackKey ? `fallback:${activeFallbackKey}` : undefined);
  }

  async function applyPersistentFallback(ctx: ExtensionContext): Promise<void> {
    const current = ctx.model;
    if (!current) return;
    const loadedConfig = config ?? (await loadConfig(ctx));
    if (!loadedConfig?.enabled) return;
    const loadedState = state ?? (await loadState(ctx));
    if (!loadedState) return;

    const active = findActiveStateEntry(loadedState, modelToRef(current));
    if (!active) return;

    const fallbackModel = ctx.modelRegistry.find(active.fallback.provider, active.fallback.model);
    if (!fallbackModel) {
      ctx.ui.notify(`Model fallback state target missing: ${modelRefKey(active.fallback)}`, "warning");
      return;
    }

    const ok = await pi.setModel(fallbackModel);
    if (!ok) {
      ctx.ui.notify(`Model fallback auth unavailable: ${modelRefKey(active.fallback)}`, "warning");
      return;
    }

    originalModelKey = modelKey(current);
    activeFallbackKey = modelRefKey(active.fallback);
    lastFallbackReason = `persistent ${active.status} from ${originalModelKey} until ${active.until}`;
    updateStatus(ctx);
    ctx.ui.notify(`Model fallback preselected: ${originalModelKey} → ${activeFallbackKey} until ${active.until}.`, "warning");
  }

  async function persistFailure(source: ModelRef, status: number, headers: Record<string, string>, ctx: ExtensionContext): Promise<void> {
    const loaded = config ?? (await loadConfig(ctx));
    if (!loaded) return;
    const match = findFallback(loaded, { provider: source.provider, id: source.model }, status);
    if (!match) return;
    if (activeFallbackKey && activeFallbackKey === modelRefKey(match.fallback)) return;

    const fallbackModel = ctx.modelRegistry.find(match.fallback.provider, match.fallback.model);
    if (!fallbackModel) {
      ctx.ui.notify(`Model fallback missing: ${modelRefKey(match.fallback)}`, "warning");
      return;
    }

    const now = new Date();
    const until = new Date(now.getTime() + cooldownMsFor(match.rule.cooldownMs, status, headers)).toISOString();
    const loadedState = state ?? (await loadState(ctx)) ?? { version: 1 as const, entries: [] };
    state = upsertStateEntry(loadedState, {
      source,
      fallback: match.fallback,
      status,
      until,
      createdAt: now.toISOString(),
      ruleName: match.rule.name,
    });
    await writeState(paths.state, state);

    const ok = await pi.setModel(fallbackModel);
    if (!ok) {
      ctx.ui.notify(`Model fallback auth unavailable: ${modelRefKey(match.fallback)}`, "warning");
      return;
    }

    originalModelKey = modelRefKey(source);
    activeFallbackKey = modelRefKey(match.fallback);
    lastFallbackReason = `${status} from ${originalModelKey}; persistent until ${until}`;
    updateStatus(ctx);
    ctx.ui.notify(`Model fallback: ${originalModelKey} → ${activeFallbackKey} (${status}). Future sessions preselect fallback until ${until}.`, "warning");
  }

  pi.on("agent_start", async (_event, ctx) => {
    await loadConfig(ctx);
    await loadState(ctx);
    await applyPersistentFallback(ctx);
    updateStatus(ctx);
  });

  pi.on("model_select", async (event, ctx) => {
    if (activeFallbackKey && modelKey(event.model) !== activeFallbackKey) {
      activeFallbackKey = undefined;
      originalModelKey = undefined;
      lastFallbackReason = undefined;
      updateStatus(ctx);
    }
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const current = ctx.model;
    const loaded = config ?? (await loadConfig(ctx));
    if (!current || !loaded) return;
    if (event.status >= 200 && event.status < 300) return;
    if (activeFallbackKey && modelKey(current) === activeFallbackKey) return;

    await persistFailure(modelToRef(current), event.status, event.headers, ctx);
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as unknown;
    if (!isRecord(message) || message.role !== "assistant") return;
    const errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    if (!errorMessage) return;
    const status = parseStatusFromErrorMessage(errorMessage);
    if (status === undefined) return;
    const provider = typeof message.provider === "string" ? message.provider : ctx.model?.provider;
    const model = typeof message.model === "string" ? message.model : ctx.model?.id;
    if (!provider || !model) return;
    if (activeFallbackKey && `${provider}/${model}` === activeFallbackKey) return;
    await persistFailure({ provider, model }, status, {}, ctx);
  });

  pi.registerCommand("model-fallback:status", {
    description: "Show model fallback status",
    handler: async (_args, ctx) => {
      const loaded = config ?? (await loadConfig(ctx)) ?? defaultConfig();
      const loadedState = state ?? (await loadState(ctx)) ?? { version: 1 as const, entries: [] };
      ctx.ui.notify(formatStatus(loaded, loadedState, paths.config, paths.state, activeFallbackKey, originalModelKey, lastFallbackReason), "info");
    },
  });

  pi.registerCommand("model-fallback:reset", {
    description: "Return from fallback model to the pre-fallback model when remembered and clear persistent state",
    handler: async (_args, ctx) => {
      syncPaths(ctx);
      state = { version: 1, entries: [] };
      await writeState(paths.state, state);
      if (!originalModelKey) {
        ctx.ui.notify("Model fallback: persistent state cleared; no remembered original model.", "info");
        activeFallbackKey = undefined;
        lastFallbackReason = undefined;
        updateStatus(ctx);
        return;
      }
      const [provider, ...modelParts] = originalModelKey.split("/");
      const model = ctx.modelRegistry.find(provider, modelParts.join("/"));
      if (!model) {
        ctx.ui.notify(`Model fallback original missing: ${originalModelKey}`, "warning");
        return;
      }
      const ok = await pi.setModel(model);
      if (!ok) {
        ctx.ui.notify(`Model fallback original auth unavailable: ${originalModelKey}`, "warning");
        return;
      }
      activeFallbackKey = undefined;
      originalModelKey = undefined;
      lastFallbackReason = undefined;
      updateStatus(ctx);
      ctx.ui.notify(`Model fallback reset: ${modelKey(model)}; persistent state cleared.`, "info");
    },
  });

  pi.registerTool({
    name: "model_fallback_config",
    label: "Model Fallback Config",
    description: "Read, validate, or save pi-model-fallback configuration.",
    promptSnippet: "Read, validate, or save pi-model-fallback configuration after user asks.",
    promptGuidelines: [
      "Use model_fallback_config when the user asks to inspect or configure model fallback rules.",
      "Use action=save only after preparing the full JSON config; the tool asks for confirmation before writing.",
    ],
    parameters: Type.Object({
      action: Type.Union([Type.Literal("read"), Type.Literal("status"), Type.Literal("validate"), Type.Literal("save")]),
      configJson: Type.Optional(Type.String({ description: "Full ModelFallbackConfig JSON for validate or save." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      syncPaths(ctx);
      if (params.action === "read" || params.action === "status") {
        const current = await readConfig(paths.config);
        const currentState = await readState(paths.state);
        return textResult(JSON.stringify(current, null, 2), {
          configPath: paths.config,
          statePath: paths.state,
          state: currentState,
          activeFallbackKey,
          originalModelKey,
          lastFallbackReason,
        });
      }
      if (!params.configJson) throw new Error("configJson is required for validate/save.");
      const nextConfig = validateConfigShape(JSON.parse(params.configJson));
      validateRegisteredModels(ctx, nextConfig);
      if (params.action === "validate") return textResult("Config is valid.", { config: nextConfig });
      if (!ctx.hasUI) return textResult("Config not saved: confirmation UI is unavailable.", { configPath: paths.config });
      const ok = await ctx.ui.confirm("Save model fallback config?", summarizeConfig(nextConfig));
      if (!ok) return textResult("Config not saved.", { configPath: paths.config });
      await writeConfig(paths.config, nextConfig);
      config = nextConfig;
      return textResult("Config saved.", { configPath: paths.config });
    },
  });
}

function shouldUseProjectLocalState(ctx: ExtensionContext): boolean {
  const projectSettingsPath = join(ctx.cwd, ".pi", "settings.json");
  return existsSync(projectSettingsPath) && projectSettingsIncludesThisPackage(projectSettingsPath);
}

function projectSettingsIncludesThisPackage(projectSettingsPath: string): boolean {
  try {
    const settings = JSON.parse(readFileSync(projectSettingsPath, "utf8")) as unknown;
    if (!isRecord(settings) || !Array.isArray(settings.packages)) return false;
    return settings.packages.some((entry) => packageEntryMatchesThisPackage(entry, dirname(projectSettingsPath)));
  } catch {
    return false;
  }
}

function packageEntryMatchesThisPackage(entry: unknown, settingsDir: string): boolean {
  const source = typeof entry === "string" ? entry : isRecord(entry) && typeof entry.source === "string" ? entry.source : undefined;
  if (!source) return false;
  if (source.includes("pi-model-fallback")) return true;
  return resolve(settingsDir, source) === resolve(PACKAGE_ROOT);
}

function validateRegisteredModels(ctx: ExtensionContext, nextConfig: ModelFallbackConfig): void {
  for (const rule of nextConfig.rules) {
    const fallback = ctx.modelRegistry.find(rule.fallback.provider, rule.fallback.model);
    if (!fallback) throw new Error(`Unknown fallback model: ${modelRefKey(rule.fallback)}`);
  }
}

function formatStatus(
  config: ModelFallbackConfig,
  state: FallbackState,
  configPath: string,
  statePath: string,
  activeFallbackKey?: string,
  originalModelKey?: string,
  reason?: string,
): string {
  return [
    `Model fallback: ${config.enabled ? "enabled" : "disabled"}`,
    `Config: ${configPath}`,
    `State: ${statePath}`,
    `Rules: ${config.rules.length}`,
    `Persistent entries: ${state.entries.length}`,
    ...state.entries.map((entry) => `- ${modelRefKey(entry.source)} -> ${modelRefKey(entry.fallback)} until ${entry.until} (${entry.status})`),
    `Active fallback: ${activeFallbackKey ?? "none"}`,
    `Original model: ${originalModelKey ?? "none"}`,
    `Reason: ${reason ?? "none"}`,
  ].join("\n");
}

function summarizeConfig(config: ModelFallbackConfig): string {
  return [
    `enabled: ${config.enabled}`,
    ...config.rules.map((rule) => `${rule.name ?? "rule"}: ${rule.matchProviders?.join(",") ?? "models"} -> ${modelRefKey(rule.fallback)}`),
  ].join("\n");
}

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details: details ?? {} };
}

function cooldownMsFor(ruleCooldownMs: number | undefined, status: number, headers: Record<string, string>): number {
  const headerMs = cooldownMsFromHeaders(headers);
  if (headerMs !== undefined) return headerMs;
  if (ruleCooldownMs !== undefined) return ruleCooldownMs;
  if (status === 429) return DEFAULT_429_COOLDOWN_MS;
  if (status >= 500 && status <= 599) return DEFAULT_5XX_COOLDOWN_MS;
  return DEFAULT_5XX_COOLDOWN_MS;
}

function cooldownMsFromHeaders(headers: Record<string, string>): number | undefined {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const retryAfter = parseRetryAfter(normalized["retry-after"]);
  if (retryAfter !== undefined) return retryAfter;

  for (const name of ["x-ratelimit-reset", "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "ratelimit-reset", "x-rate-limit-reset"]) {
    const parsed = parseResetHeader(normalized[name]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000);
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs) && dateMs > Date.now()) return dateMs - Date.now();
  return undefined;
}

function parseResetHeader(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && numeric > 0) {
    if (numeric > 1_000_000_000_000) return Math.max(0, numeric - Date.now());
    if (numeric > 1_000_000_000) return Math.max(0, numeric * 1000 - Date.now());
    return Math.ceil(numeric * 1000);
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs) && dateMs > Date.now()) return dateMs - Date.now();
  return undefined;
}

function modelToRef(model: { provider: string; id: string }): ModelRef {
  return { provider: model.provider, model: model.id };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
