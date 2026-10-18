import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  analyzeRuleWarnings,
  defaultConfig,
  findFallback,
  modelKey,
  modelRefKey,
  validateConfigShape,
  type ModelFallbackConfig,
  type ModelRef,
  type RuleWarning,
} from "../lib/config.js";
import { parseReasonFromErrorMessage, parseStatusFromErrorMessage } from "../lib/error-status.js";
import { findActiveStateEntry, readState, updateState, upsertStateEntry, writeState, type FallbackState } from "../lib/state.js";
import { isRecord } from "../lib/internal.ts";
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
  // Models already fallen back to during this run (plus the original). A cascade may only
  // target a model never visited, which makes chains (free → kimi → glm) safe while
  // preventing A→B→A ping-pong with circular rules.
  let visitedFallbackKeys = new Set<string>();
  let cancelled = false;
  let generation = 0;
  let switching = false;
  let uiPromptOpen = false;
  let removeTerminalListener: (() => void) | undefined;
  let responseFailure: { modelKey: string; status: number; headers: Record<string, string> } | undefined;
  let pendingFailure: { source: ModelRef; status: number; reason?: string; entryId: string; headers: Record<string, string> } | undefined;

  function cancelFallback(): void {
    cancelled = true;
    invalidatePending();
  }

  // Drop fallback work computed from superseded state without disabling fallback
  // for the rest of the run (unlike cancelFallback).
  function invalidatePending(): void {
    generation += 1;
    pendingFailure = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    removeTerminalListener?.();
    if (ctx.mode === "tui") {
      removeTerminalListener = ctx.ui.onTerminalInput((data) => {
        if ((pendingFailure || switching) && !uiPromptOpen && getKeybindings().matches(data, "app.interrupt")) cancelFallback();
        // Observe cancellation without consuming autocomplete, overlay, or editor input.
        return undefined;
      });
    }
  });
  pi.on("ui_prompt_start", () => { uiPromptOpen = true; });
  pi.on("ui_prompt_end", () => { uiPromptOpen = false; });
  pi.on("session_shutdown", () => {
    cancelFallback();
    removeTerminalListener?.();
    removeTerminalListener = undefined;
  });
  pi.on("session_before_switch", cancelFallback);
  pi.on("session_before_tree", cancelFallback);

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
      // Prune the snapshot for selection, but never write a stale read back over another session.
      // Mutating transactions prune the current on-disk state while holding the state lock.
      state = await readState(paths.state);
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

    originalModelKey = modelKey(current);
    activeFallbackKey = modelRefKey(active.fallback);
    visitedFallbackKeys = new Set([originalModelKey, activeFallbackKey]);
    lastFallbackReason = `persistent ${active.status} from ${originalModelKey} until ${active.until}`;
    updateStatus(ctx);
    let ok = false;
    switching = true;
    try {
      ok = await pi.setModel(fallbackModel);
    } finally {
      switching = false;
    }
    if (!ok) {
      ctx.ui.notify(`Model fallback auth unavailable: ${modelRefKey(active.fallback)}`, "warning");
      originalModelKey = undefined;
      activeFallbackKey = undefined;
      lastFallbackReason = undefined;
      visitedFallbackKeys = new Set();
      updateStatus(ctx);
      return;
    }
    updateStatus(ctx);
    ctx.ui.notify(`Model fallback preselected: ${originalModelKey} → ${activeFallbackKey} until ${active.until}.`, "warning");
  }

  async function persistFailure(source: ModelRef, status: number, headers: Record<string, string>, ctx: ExtensionContext, isCancelled: () => boolean, reason?: string): Promise<boolean> {
    const loaded = config ?? (await loadConfig(ctx));
    if (!loaded) return false;
    const match = findFallback(loaded, { provider: source.provider, id: source.model }, status, reason);
    if (!match) return false;

    const fallbackModel = ctx.modelRegistry.find(match.fallback.provider, match.fallback.model);
    if (!fallbackModel) {
      ctx.ui.notify(`Model fallback missing: ${modelRefKey(match.fallback)}`, "warning");
      return false;
    }

    const fallbackKey = modelRefKey(match.fallback);
    const sourceKey = modelRefKey(source);
    if (visitedFallbackKeys.has(fallbackKey) || isCancelled()) return false;

    const now = new Date();
    const until = new Date(now.getTime() + cooldownMsFor(match.rule.cooldownMs, status, headers)).toISOString();

    const prevOriginal = originalModelKey;
    const prevActive = activeFallbackKey;
    const prevReason = lastFallbackReason;
    const prevVisited = visitedFallbackKeys;
    // Mark before setModel so the model_select handler keeps fallback bookkeeping.
    if (!originalModelKey) originalModelKey = sourceKey;
    activeFallbackKey = fallbackKey;
    visitedFallbackKeys = new Set(prevVisited);
    visitedFallbackKeys.add(sourceKey);
    visitedFallbackKeys.add(fallbackKey);
    lastFallbackReason = `${status} from ${sourceKey}${reason ? ` (${reason})` : ""}; persistent until ${until}`;
    updateStatus(ctx);

    let ok = false;
    try {
      ok = await pi.setModel(fallbackModel);
    } catch (error) {
      ctx.ui.notify(`Model fallback switch failed: ${errorMessage(error)}`, "warning");
    }
    if (!ok || isCancelled()) {
      originalModelKey = prevOriginal;
      activeFallbackKey = prevActive;
      lastFallbackReason = prevReason;
      visitedFallbackKeys = prevVisited;
      updateStatus(ctx);
      if (!ok) ctx.ui.notify(`Model fallback auth unavailable: ${modelRefKey(match.fallback)}`, "warning");
      return false;
    }
    if (isCancelled()) return false;
    state = await updateState(paths.state, (current) => isCancelled() ? current : upsertStateEntry(current, {
      source, fallback: match.fallback, status, until, createdAt: now.toISOString(), ruleName: match.rule.name,
    }));
    if (isCancelled()) return false;
    ctx.ui.notify(`Model fallback: ${sourceKey} → ${activeFallbackKey} (${status}). Future sessions preselect fallback until ${until}.`, "warning");
    return true;
  }

  pi.on("before_agent_start", async (_event, ctx) => {
    cancelled = false;
    generation += 1;
    pendingFailure = undefined;
    responseFailure = undefined;
    await loadConfig(ctx);
    await loadState(ctx);
    visitedFallbackKeys = new Set(ctx.model ? [modelKey(ctx.model)] : []);
    await applyPersistentFallback(ctx);
    updateStatus(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    // Preselection happens before a run exists; abort once its controller is active.
    if (cancelled) ctx.abort();
  });

  pi.on("model_select", async (event, ctx) => {
    if (modelKey(event.model) !== activeFallbackKey) {
      cancelFallback();
      activeFallbackKey = undefined;
      originalModelKey = undefined;
      lastFallbackReason = undefined;
      visitedFallbackKeys = new Set();
      updateStatus(ctx);
    }
  });

  pi.on("before_provider_request", () => { responseFailure = undefined; });
  pi.on("after_provider_response", (event, ctx) => {
    responseFailure = event.status >= 400 && ctx.model
      ? { modelKey: modelKey(ctx.model), status: event.status, headers: event.headers }
      : undefined;
  });

  pi.on("turn_end", (event) => {
    const response = responseFailure;
    responseFailure = undefined;
    pendingFailure = undefined;
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const source = { provider: message.provider, model: message.model };
    const observed = response?.modelKey === modelRefKey(source) ? response : undefined;
    const errorText = message.errorMessage ?? "";
    const status = parseStatusFromErrorMessage(errorText) ?? observed?.status;
    if (status !== undefined) {
      pendingFailure = { source, status, reason: parseReasonFromErrorMessage(errorText),
        entryId: event.messageEntryId, headers: observed?.headers ?? {} };
    }
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const failure = pendingFailure;
    if (event.outcome !== "error" || cancelled || !failure || !ctx.model || modelKey(ctx.model) !== modelRefKey(failure.source)) return;
    const visibleFailure = event.context.contextEntries.some((entry) => entry.sourceEntry.id === failure.entryId && entry.messages.some((message) => message.role === "assistant" && message.stopReason === "error"));
    if (!visibleFailure && !event.context.canContinue) return;
    pendingFailure = undefined;
    const currentGeneration = generation;
    const isCancelled = () => cancelled || generation !== currentGeneration;
    switching = true;
    try {
      const switched = await persistFailure(failure.source, failure.status, failure.headers, ctx, isCancelled, failure.reason);
      if (!switched || isCancelled() || config?.autoRetry === false) return;
      return {
        entries: visibleFailure ? [...event.entries, { type: "context_edit" as const, targetId: failure.entryId, replacement: null }] : event.entries,
        continue: true,
      };
    } finally {
      switching = false;
    }
  });

  pi.on("agent_settled", () => {
    pendingFailure = undefined;
    responseFailure = undefined;
  });

  pi.registerCommand("model-fallback:status", {
    description: "Show model fallback status",
    handler: async (_args, ctx) => {
      const loaded = config ?? (await loadConfig(ctx)) ?? defaultConfig();
      const loadedState = state ?? (await loadState(ctx)) ?? { version: 1 as const, entries: [] };
      ctx.ui.notify(formatStatus(loaded, loadedState, paths.config, paths.state, analyzeRuleWarnings(loaded), activeFallbackKey, originalModelKey, lastFallbackReason), "info");
    },
  });

  pi.registerCommand("model-fallback:reset", {
    description: "Return from fallback model to the pre-fallback model when remembered and clear persistent state",
    handler: async (_args, ctx) => {
      cancelFallback();
      syncPaths(ctx);
      state = { version: 1, entries: [] };
      await writeState(paths.state, state);
      if (!originalModelKey) {
        ctx.ui.notify("Model fallback: persistent state cleared; no remembered original model.", "info");
        activeFallbackKey = undefined;
        lastFallbackReason = undefined;
        visitedFallbackKeys = new Set();
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
      visitedFallbackKeys = new Set();
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
        const warnings = analyzeRuleWarnings(current);
        const details = configToolDetails(paths.config, paths.state, currentState, warnings, activeFallbackKey, originalModelKey, lastFallbackReason);
        const text = params.action === "status"
          ? formatStatus(current, currentState, paths.config, paths.state, warnings, activeFallbackKey, originalModelKey, lastFallbackReason)
          : JSON.stringify(current, null, 2);
        return textResult(text, details);
      }
      if (!params.configJson) throw new Error("configJson is required for validate/save.");
      const nextConfig = validateConfigShape(JSON.parse(params.configJson));
      const warnings = analyzeRuleWarnings(nextConfig);
      validateRegisteredModels(ctx, nextConfig);
      if (params.action === "validate") return textResult(configResultText("Config is valid.", warnings), { config: nextConfig, ...warningDetails(warnings) });
      if (!ctx.hasUI) return textResult("Config not saved: confirmation UI is unavailable.", { configPath: paths.config, ...warningDetails(warnings) });
      const ok = await ctx.ui.confirm("Save model fallback config?", summarizeConfig(nextConfig, warnings));
      if (!ok) return textResult("Config not saved.", { configPath: paths.config, ...warningDetails(warnings) });
      invalidatePending();
      await writeConfig(paths.config, nextConfig);
      config = nextConfig;
      return textResult(configResultText("Config saved.", warnings), { configPath: paths.config, ...warningDetails(warnings) });
    },
  });
}

function autoRetryEnabled(config: ModelFallbackConfig): boolean {
  return config.autoRetry !== false;
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
  warnings: RuleWarning[],
  activeFallbackKey?: string,
  originalModelKey?: string,
  reason?: string,
): string {
  return [
    `Model fallback: ${config.enabled ? "enabled" : "disabled"}`,
    `Auto retry: ${autoRetryEnabled(config) ? "enabled" : "disabled"}`,
    `Config: ${configPath}`,
    `State: ${statePath}`,
    `Rules: ${config.rules.length}`,
    `Config warnings: ${warningSummary(warnings)}`,
    `Persistent entries: ${state.entries.length}`,
    ...state.entries.map((entry) => `- ${modelRefKey(entry.source)} -> ${modelRefKey(entry.fallback)} until ${entry.until} (${entry.status})`),
    `Active fallback: ${activeFallbackKey ?? "none"}`,
    `Original model: ${originalModelKey ?? "none"}`,
    `Reason: ${reason ?? "none"}`,
  ].join("\n");
}

function summarizeConfig(config: ModelFallbackConfig, warnings: RuleWarning[]): string {
  return [
    `enabled: ${config.enabled}`,
    `autoRetry: ${autoRetryEnabled(config)}`,
    ...config.rules.map((rule) => `${rule.name ?? "rule"}: ${rule.matchProviders?.join(",") ?? "models"} -> ${modelRefKey(rule.fallback)}`),
    `warnings: ${warningSummary(warnings)}`,
  ].join("\n");
}

function configToolDetails(
  configPath: string,
  statePath: string,
  state: FallbackState,
  warnings: RuleWarning[],
  activeFallbackKey?: string,
  originalModelKey?: string,
  lastFallbackReason?: string,
): Record<string, unknown> {
  return {
    configPath,
    statePath,
    state,
    activeFallbackKey,
    originalModelKey,
    lastFallbackReason,
    ...warningDetails(warnings),
  };
}

function warningDetails(warnings: RuleWarning[]): Record<string, unknown> {
  return {
    warningCount: warnings.length,
    warningSummary: warningSummary(warnings),
    warnings,
  };
}

function configResultText(prefix: string, warnings: RuleWarning[]): string {
  if (warnings.length === 0) return prefix;
  return `${prefix} ${warningSummary(warnings)}`;
}

function warningSummary(warnings: RuleWarning[]): string {
  if (warnings.length === 0) return "none";
  if (warnings.length === 1) return `1 warning: ${warnings[0].message}`;
  return `${warnings.length} warnings: ${warnings.map((warning) => warning.message).join("; ")}`;
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

