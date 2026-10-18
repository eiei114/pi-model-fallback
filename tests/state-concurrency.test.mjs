import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import lockfile from "proper-lockfile";
import { emptyState, readState, updateState, upsertStateEntry, writeState } from "../lib/state.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const modelFallback = (await createJiti(import.meta.url).import("../extensions/index.ts")).default;
const source = (name) => ({ provider: "fixture", model: name });
const refModel = ({ provider, model }) => ({ provider, id: model });

async function sharedProject(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-fallback-concurrency-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const root = join(cwd, ".pi", "model-fallback");
  await mkdir(root, { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["pi-model-fallback"] }));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, enabled: true, autoRetry: true,
    rules: [{ matchProviders: ["fixture"], statuses: [503], cooldownMs: 60000,
      fallback: source("backup") }] }));
  return { cwd, statePath: join(root, "state.json") };
}

async function instance(cwd, name) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const ctx = { cwd, mode: "rpc", hasUI: false, model: refModel(source(name)),
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
    ui: { notify() {}, setStatus() {} } };
  modelFallback({
    on(type, handler) { handlers.set(type, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool() {},
    async setModel(model) { ctx.model = model; await handlers.get("model_select")?.({ model }, ctx); return true; },
  });
  await handlers.get("before_agent_start")({}, ctx);
  return {
    ctx, commands,
    async fail() {
      const message = { role: "assistant", provider: ctx.model.provider, model: ctx.model.id,
        stopReason: "error", errorMessage: "HTTP 503 service unavailable", content: [] };
      const entry = { id: name, message };
      entries.push(entry);
      await handlers.get("turn_end")({ message, messageEntryId: entry.id }, ctx);
      return handlers.get("agent_before_settle")({ outcome: "error", entries: [], context: {
        contextEntries: entries.map(entry => ({ sourceEntry: entry, messages: [entry.message] })), canContinue: false,
      } }, ctx);
    },
  };
}

test("independent extension instances preserve both cooldowns after reading the same empty state", async (t) => {
  const h = await sharedProject(t);
  // Both instances cache the empty file before either failure reaches persistence.
  const first = await instance(h.cwd, "source-a");
  const second = await instance(h.cwd, "source-b");
  const settled = await Promise.all([first.fail(), second.fail()]);
  assert.ok(settled.every(result => result?.continue === true));
  const state = JSON.parse(await readFile(h.statePath, "utf8"));
  assert.deepEqual(state.entries.map(entry => entry.source.model).sort(), ["source-a", "source-b"]);
});

function entry(name, duration = 60000) {
  return { source: source(name), fallback: source("backup"), status: 503,
    createdAt: new Date().toISOString(), until: new Date(Date.now() + duration).toISOString() };
}

test("independent processes merge every source under the same state lock", { timeout: 20000 }, async (t) => {
  const h = await sharedProject(t);
  const children = Array.from({ length: 4 }, (_, index) => fork(
    fileURLToPath(new URL("./fixtures/state-writer.mjs", import.meta.url)), [h.statePath, String(index)],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  ));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const completions = children.map(child => new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`worker exit ${code}/${signal}: ${stderr}`)));
  }));
  // Reject early exits during startup rather than waiting forever for a ready message.
  await Promise.race([Promise.all(children.map(child => new Promise((resolve, reject) => {
    child.once("message", message => message === "ready" ? resolve() : reject(new Error("invalid ready message")));
    child.once("exit", () => reject(new Error("worker exited before ready")));
  }))), Promise.all(completions).then(() => { throw new Error("workers finished before release"); })]);
  for (const child of children) child.send("start");
  await Promise.all(completions);
  const state = await readState(h.statePath);
  const expected = Array.from({ length: 4 }, (_, worker) => Array.from({ length: 4 }, (_, index) => `${worker}-${index}`)).flat().sort();
  assert.deepEqual(state.entries.map(item => item.source.model).sort(), expected);
});

test("unlocked readers never observe partial JSON during repeated replacements", { timeout: 10000 }, async (t) => {
  const h = await sharedProject(t);
  await writeState(h.statePath, { version: 1, entries: [entry("initial")] });
  let finished = false;
  let samples = 0;
  const writer = (async () => {
    try {
      for (let index = 0; index < 30; index++) await writeState(h.statePath, {
        version: 1, entries: [{ ...entry(`writer-${index}`), ruleName: index % 2 ? "short" : "long".repeat(16000) }],
      });
    } finally { finished = true; }
  })();
  const reader = (async () => {
    while (!finished) {
      const state = JSON.parse(await readFile(h.statePath, "utf8"));
      assert.equal(state.version, 1);
      assert.equal(state.entries.length, 1);
      samples++;
    }
  })();
  await Promise.all([writer, reader]);
  assert.ok(samples > 0);
});

test("a cached pre-reset snapshot cannot resurrect cleared cooldown entries", async (t) => {
  const h = await sharedProject(t);
  await writeState(h.statePath, { version: 1, entries: [entry("old-source")] });
  const pending = await instance(h.cwd, "pending-source");
  const resetting = await instance(h.cwd, "reset-source");
  await resetting.commands.get("model-fallback:reset").handler("", resetting.ctx);
  await pending.fail();
  const state = await readState(h.statePath);
  assert.deepEqual(state.entries.map(item => item.source.model), ["pending-source"]);
});

test("pruning and upsert preserve entries written after another session cached its state", async (t) => {
  const h = await sharedProject(t);
  await writeState(h.statePath, { version: 1, entries: [entry("expired", -1000), entry("existing")] });
  const pending = await instance(h.cwd, "pending-source");
  await updateState(h.statePath, state => upsertStateEntry(state, entry("new-source")));
  await pending.fail();
  const state = await readState(h.statePath);
  assert.deepEqual(state.entries.map(item => item.source.model).sort(), ["existing", "new-source", "pending-source"]);
});

test("a failed transaction preserves the last document and releases the lock", async (t) => {
  const h = await sharedProject(t);
  await writeState(h.statePath, { version: 1, entries: [entry("existing")] });
  const before = await readFile(h.statePath, "utf8");
  await assert.rejects(updateState(h.statePath, () => { throw new Error("fixture mutation failure"); }), /fixture mutation failure/);
  await assert.rejects(updateState(h.statePath, () => ({ version: 2, entries: [] })), /Unsupported state version/);
  assert.equal(await readFile(h.statePath, "utf8"), before);
  await updateState(h.statePath, state => upsertStateEntry(state, entry("after-failure")));
  assert.deepEqual((await readdir(join(h.cwd, ".pi", "model-fallback"))).sort(), ["config.json", "state.json"]);
});

test("reset repairs malformed state without silently discarding it on an ordinary update", async (t) => {
  const h = await sharedProject(t);
  await writeFile(h.statePath, "{broken state");
  await assert.rejects(updateState(h.statePath, state => upsertStateEntry(state, entry("new"))), SyntaxError);
  assert.equal(await readFile(h.statePath, "utf8"), "{broken state");
  const resetting = await instance(h.cwd, "reset-source");
  await resetting.commands.get("model-fallback:reset").handler("", resetting.ctx);
  assert.deepEqual(await readState(h.statePath), emptyState());
});

test("lock contention times out without an unlocked overwrite", { timeout: 10000 }, async (t) => {
  const h = await sharedProject(t);
  await writeState(h.statePath, { version: 1, entries: [entry("original")] });
  const before = await readFile(h.statePath, "utf8");
  const release = await lockfile.lock(h.statePath, { realpath: false });
  try {
    await assert.rejects(writeState(h.statePath, emptyState()), { code: "ELOCKED" });
    assert.equal(await readFile(h.statePath, "utf8"), before);
  } finally { await release(); }
  await writeState(h.statePath, emptyState());
  assert.deepEqual(await readState(h.statePath), emptyState());
});

test("directory aliases share the same lock before the state file exists", async (t) => {
  const h = await sharedProject(t);
  const alias = join(h.cwd, "alias");
  await symlink(join(h.cwd, ".pi", "model-fallback"), alias, process.platform === "win32" ? "junction" : "dir");
  await Promise.all([
    updateState(h.statePath, state => upsertStateEntry(state, entry("canonical"))),
    updateState(join(alias, "state.json"), state => upsertStateEntry(state, entry("alias"))),
  ]);
  assert.equal((await readState(h.statePath)).entries.length, 2);
});

test("replacement/reset waits for the same lock as a merging transaction", async (t) => {
  const h = await sharedProject(t);
  await writeState(h.statePath, { version: 1, entries: [entry("old")] });
  const release = await lockfile.lock(h.statePath, { realpath: false });
  let settled = false;
  const resetting = writeState(h.statePath, emptyState()).then(() => { settled = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(settled, false);
    assert.equal((await readState(h.statePath)).entries.length, 1);
  } finally { await release(); }
  await resetting;
  assert.equal((await readState(h.statePath)).entries.length, 0);
});
