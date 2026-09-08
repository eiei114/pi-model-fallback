import { readFile } from "node:fs/promises";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

export function readModelRef(value: unknown, path: string): { provider: string; model: string } {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return {
    provider: readNonEmptyString(value.provider, `${path}.provider`),
    model: readNonEmptyString(value.model, `${path}.model`),
  };
}

export async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
