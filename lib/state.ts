import { randomUUID } from "node:crypto";
import { mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { modelRefKey, type ModelRef } from "./config.ts";
import { isNodeError, isRecord, readJsonIfExists, readModelRef, readNonEmptyString } from "./internal.ts";

export const STATE_VERSION = 1;
const WINDOWS_RENAME_RETRY_MS = 1000;
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

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
  const next = validateStateShape(state);
  // Explicit replacement (notably reset) must also be able to repair a corrupt old file.
  await withStateLock(path, (target, checkLock) => publishState(target, next, checkLock));
}

/** Serialize the entire read/modify/publish transaction, including across Pi processes. */
export async function updateState(path: string, update: (current: FallbackState) => FallbackState): Promise<FallbackState> {
  return withStateLock(path, async (target, checkLock) => {
    const next = validateStateShape(update(await readState(target)));
    checkLock();
    await publishState(target, next, checkLock);
    return next;
  });
}

async function withStateLock<T>(path: string, operation: (target: string, checkLock: () => void) => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  // Aliases of the same agent directory must share a lock (the state file may not exist yet).
  const target = join(await realpath(dirname(path)), basename(path));
  let compromised: Error | undefined;
  const release = await lockfile.lock(target, {
    realpath: false,
    retries: { retries: 100, factor: 1, minTimeout: 20, maxTimeout: 20, randomize: false },
    onCompromised: (error) => { compromised = error; },
  });
  const checkLock = () => { if (compromised) throw compromised; };
  try {
    checkLock();
    return await operation(target, checkLock);
  } finally {
    await release();
  }
}

async function publishState(path: string, state: FallbackState, checkLock: () => void): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(temporary, "wx", 0o600);
    created = true;
    try {
      await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    // Readers see either the old complete document or the new one, never a partial write.
    checkLock();
    await replaceStateFile(temporary, path, checkLock);
  } finally {
    if (created) await rm(temporary, { force: true });
  }
}

async function replaceStateFile(source: string, target: string, checkLock: () => void): Promise<void> {
  // Windows can reject replacement while an unlocked reader briefly has the target open.
  const deadline = Date.now() + WINDOWS_RENAME_RETRY_MS;
  let retryDelayMs = 10;
  for (;;) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (process.platform !== "win32" || !isNodeError(error) || !WINDOWS_RENAME_RETRY_CODES.has(error.code ?? "") || Date.now() >= deadline) throw error;
      await delay(retryDelayMs);
      checkLock();
      retryDelayMs = Math.min(retryDelayMs + 10, 100);
    }
  }
}

export function upsertStateEntry(state: FallbackState, entry: FallbackStateEntry): FallbackState {
  const sourceKey = modelRefKey(entry.source);
  return {
    version: STATE_VERSION,
    entries: [entry, ...state.entries.filter((item) => modelRefKey(item.source) !== sourceKey)],
  };
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

