import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { defaultConfig, findFallback, modelKey, modelRefKey, validateConfigShape, type ModelFallbackConfig } from "../lib/config.js";
import { modelFallbackPaths, readConfig, writeConfig, type ModelFallbackPaths } from "../lib/storage.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const STATUS_KEY = "model-fallback";

export default function modelFallback(pi: ExtensionAPI) {
  let paths: ModelFallbackPaths = modelFallbackPaths(getAgentDir());
  let config: ModelFallbackConfig | undefined;
  let originalModelKey: string | undefined;
  let activeFallbackKey: string | undefined;
  let lastFallbackReason: string | undefined;

  function syncPaths(ctx: ExtensionContext): void {
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

  function updateStatus(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, activeFallbackKey ? `fallback:${activeFallbackKey}` : undefined);
  }

  pi.on("session_start", async (_event, ctx) => {
    await loadConfig(ctx);
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

    const match = findFallback(loaded, current, event.status);
    if (!match) return;

    const fallbackModel = ctx.modelRegistry.find(match.fallback.provider, match.fallback.model);
    if (!fallbackModel) {
      ctx.ui.notify(`Model fallback missing: ${modelRefKey(match.fallback)}`, "warning");
      return;
    }

    const ok = await pi.setModel(fallbackModel);
    if (!ok) {
      ctx.ui.notify(`Model fallback auth unavailable: ${modelRefKey(match.fallback)}`, "warning");
      return;
    }

    originalModelKey = modelKey(current);
    activeFallbackKey = modelRefKey(match.fallback);
    lastFallbackReason = `${event.status} from ${originalModelKey}`;
    updateStatus(ctx);
    ctx.ui.notify(`Model fallback: ${originalModelKey} → ${activeFallbackKey} (${event.status}). Re-run the prompt to use fallback.`, "warning");
  });

  pi.registerCommand("model-fallback:status", {
    description: "Show model fallback status",
    handler: async (_args, ctx) => {
      const loaded = config ?? (await loadConfig(ctx)) ?? defaultConfig();
      ctx.ui.notify(formatStatus(loaded, paths.config, activeFallbackKey, originalModelKey, lastFallbackReason), "info");
    },
  });

  pi.registerCommand("model-fallback:reset", {
    description: "Return from fallback model to the pre-fallback model when remembered",
    handler: async (_args, ctx) => {
      if (!originalModelKey) {
        ctx.ui.notify("Model fallback: no remembered original model.", "info");
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
      ctx.ui.notify(`Model fallback reset: ${modelKey(model)}`, "info");
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
        return textResult(JSON.stringify(current, null, 2), { configPath: paths.config, activeFallbackKey, originalModelKey, lastFallbackReason });
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

function formatStatus(config: ModelFallbackConfig, configPath: string, activeFallbackKey?: string, originalModelKey?: string, reason?: string): string {
  return [
    `Model fallback: ${config.enabled ? "enabled" : "disabled"}`,
    `Config: ${configPath}`,
    `Rules: ${config.rules.length}`,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
