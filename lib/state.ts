import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelRef } from "./config.js";

export const STATE_VERSION = 1;

export interface FallbackStateEntry {
  source: ModelRef;
  fallback: ModelRef;
  status: number;
  until: string;
  createdAt: string;
  ruleName?: string;
}

export interface FallbackState {
  version: 1;
  entries: FallbackStateEntry[];
}

export function emptyState(): FallbackState {
  return { version: STATE_VERSION, entries: [] };
}

export async function readState(path: string, now = new Date()): Promise<FallbackState> {
  const json = await readJsonIfExists(path);
  const state = json === undefined ? emptyState() : validateStateShape(json);
  return pruneExpiredState(state, now);
}

export async function writeState(path: string, state: FallbackState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(validateStateShape(state), null, 2)}\n`, "utf8");
}

export function upsertStateEntry(state: FallbackState, entry: FallbackStateEntry): FallbackState {
  const sourceKey = modelRefKey(entry.source);
  return {
    version: STATE_VERSION,
    entries: [entry, ...state.entries.filter((item) => modelRefKey(item.source) !== sourceKey)],
  };
}

function modelRefKey(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

export function findActiveStateEntry(state: FallbackState, source: ModelRef, now = new Date()): FallbackStateEntry | undefined {
  const sourceKey = modelRefKey(source);
  return state.entries.find((entry) => modelRefKey(entry.source) === sourceKey && Date.parse(entry.until) > now.getTime());
}

export function pruneExpiredState(state: FallbackState, now = new Date()): FallbackState {
  const nowMs = now.getTime();
  return {
    version: STATE_VERSION,
    entries: state.entries.filter((entry) => Date.parse(entry.until) > nowMs),
  };
}

export function validateStateShape(value: unknown): FallbackState {
  if (!isRecord(value)) throw new Error("State must be an object.");
  if (value.version !== STATE_VERSION) throw new Error(`Unsupported state version: ${String(value.version)}.`);
  if (!Array.isArray(value.entries)) throw new Error("entries must be an array.");
  return {
    version: STATE_VERSION,
    entries: value.entries.map((entry, index) => validateEntry(entry, index)),
  };
}

function validateEntry(value: unknown, index: number): FallbackStateEntry {
  if (!isRecord(value)) throw new Error(`entries[${index}] must be an object.`);
  const until = readNonEmptyString(value.until, `entries[${index}].until`);
  const createdAt = readNonEmptyString(value.createdAt, `entries[${index}].createdAt`);
  if (Number.isNaN(Date.parse(until))) throw new Error(`entries[${index}].until must be an ISO date.`);
  if (Number.isNaN(Date.parse(createdAt))) throw new Error(`entries[${index}].createdAt must be an ISO date.`);
  const status = value.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) throw new Error(`entries[${index}].status must be an HTTP status code.`);
  const entry: FallbackStateEntry = {
    source: readModelRef(value.source, `entries[${index}].source`),
    fallback: readModelRef(value.fallback, `entries[${index}].fallback`),
    status,
    until,
    createdAt,
  };
  if (typeof value.ruleName === "string" && value.ruleName.trim() !== "") entry.ruleName = value.ruleName.trim();
  return entry;
}

function readModelRef(value: unknown, path: string): ModelRef {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  return {
    provider: readNonEmptyString(value.provider, `${path}.provider`),
    model: readNonEmptyString(value.model, `${path}.model`),
  };
}

function readNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${path} must be a non-empty string.`);
  return value.trim();
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
