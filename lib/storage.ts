import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultConfig, validateConfigShape, type ModelFallbackConfig } from "./config.ts";
import { readJsonIfExists } from "./internal.ts";

export interface ModelFallbackPaths {
  dir: string;
  config: string;
  state: string;
}

export function modelFallbackPaths(agentDir: string): ModelFallbackPaths {
  const dir = join(agentDir, "model-fallback");
  return { dir, config: join(dir, "config.json"), state: join(dir, "state.json") };
}

export async function readConfig(path: string): Promise<ModelFallbackConfig> {
  const json = await readJsonIfExists(path);
  return json === undefined ? defaultConfig() : validateConfigShape(json);
}

export async function writeConfig(path: string, config: ModelFallbackConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validateConfigShape(config), null, 2)}\n`, "utf8");
}

