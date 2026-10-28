import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";

setKeybindings(new KeybindingsManager({ "app.interrupt": { defaultKeys: "escape", description: "Interrupt" } }));
const modelFallback = (await createJiti(import.meta.url).import("../extensions/index.ts")).default;
const SOURCE = { provider: "fixture", model: "source" };
const FALLBACK = { provider: "fixture", model: "fallback" };
const NEXT = { provider: "fixture", model: "third" };
const refModel = ({ provider, model }) => ({ provider, id: model });
const rule = (from, to) => ({ matchModels: [from], statuses: [429, 529], fallback: to });

async function createHarness({ rules = [rule(SOURCE, FALLBACK)], autoRetry = true, switchModel, preselect = false, enabled = true, stateFileContents } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-model-fallback-boundary-"));
  const root = join(cwd, ".pi", "model-fallback");
  await mkdir(root, { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["pi-model-fallback"] }));
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, enabled, autoRetry, rules }));
  if (stateFileContents !== undefined) await writeFile(join(root, "state.json"), stateFileContents);
  else if (preselect) await writeFile(join(root, "state.json"), JSON.stringify({ version: 1, entries: [{ source: SOURCE, fallback: FALLBACK, status: 429, until: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString() }] }));
  const handlers = new Map();
  const calls = { models: [], prompts: [], notifications: [] };
  const tools = new Map();
  let terminalInput;
  let ctx;
  let serial = 0;
  const entries = [{ type: "message", id: "user", message: { role: "user", content: "finish the existing work" } }];
  const pi = {
    on(type, handler) { handlers.set(type, handler); },
    registerCommand() {}, registerTool(tool) { tools.set(tool.name, tool); },
    async setModel(model) {
      if (switchModel && !(await switchModel(model))) return false;
      calls.models.push(model);
      const previousModel = ctx.model;
      ctx.model = model;
      await handlers.get("model_select")?.({ model, previousModel, source: "set" }, ctx);
      return true;
    },
    sendUserMessage(...args) { calls.prompts.push(args); },
  };
  ctx = {
    cwd, mode: "tui", hasUI: true, model: refModel(SOURCE),
    modelRegistry: { find: (provider, id) => ({ provider, id }) },
    ui: {
      notify: (message, level) => calls.notifications.push({ message, level }), setStatus() {},
      confirm: async () => true,
      onTerminalInput(handler) { terminalInput = handler; return () => { terminalInput = undefined; }; },
    },
    sessionManager: { getBranch: () => entries, getEntries: () => entries },
  };
  modelFallback(pi);
  await handlers.get("session_start")?.({}, ctx);
  async function start() { await handlers.get("before_agent_start")?.({ messageType: "user", prompt: "finish the existing work" }, ctx); }
  await start();
  async function fail(errorMessage = "Error: 429 quota exceeded") {
    const message = { role: "assistant", provider: ctx.model.provider, model: ctx.model.id, stopReason: "error", errorMessage, content: [] };
    const entry = { type: "message", id: `error-${++serial}`, message };
    entries.push(entry);
    await handlers.get("turn_end")?.({ message, messageEntryId: entry.id }, ctx);
    return entry;
  }
  async function settle(outcome = "error") {
    const handler = handlers.get("agent_before_settle");
    assert.equal(typeof handler, "function", "fallback must use Pi's actionable settle boundary");
    return handler({ outcome, entries: [], continue: false, context: { contextEntries: entries.map(entry => ({ sourceEntry: entry, messages: [entry.message] })), pendingMessages: [], canContinue: false } }, ctx);
  }
  return { calls, ctx, entries, handlers, fail, settle, start, tools, escape: () => terminalInput?.("\u001b"), statePath: join(root, "state.json") };
}

test("a failure switches only at settlement and continues without a second user request", async () => {
  const h = await createHarness();
  const failed = await h.fail();
  assert.equal(h.calls.models.length, 0, "do not interfere with core retries");
  assert.deepEqual(await h.settle(), { entries: [{ type: "context_edit", targetId: failed.id, replacement: null }], continue: true });
  assert.deepEqual(h.calls.models, [refModel(FALLBACK)]);
  assert.equal(h.calls.prompts.length, 0);
  const state = JSON.parse(await readFile(h.statePath, "utf8"));
  assert.deepEqual(state.entries[0].source, SOURCE);
  assert.deepEqual(state.entries[0].fallback, FALLBACK);
});

test("finite cascade survives agent_start continuation events without revisiting failed models", async () => {
  const h = await createHarness({ rules: [rule(SOURCE, FALLBACK), rule(FALLBACK, NEXT), rule(NEXT, SOURCE)] });
  await h.fail();
  assert.equal((await h.settle()).continue, true);
  await h.handlers.get("agent_start")?.({}, h.ctx);
  await h.fail();
  assert.equal((await h.settle()).continue, true);
  await h.fail();
  assert.equal(await h.settle(), undefined);
  assert.deepEqual(h.calls.models, [refModel(FALLBACK), refModel(NEXT)]);
  assert.equal(h.calls.prompts.length, 0);
});

test("persistent preselection still allows an onward fallback but not a return to the source", async () => {
  const h = await createHarness({ preselect: true, rules: [rule(SOURCE, FALLBACK), rule(FALLBACK, NEXT), rule(NEXT, SOURCE)] });
  assert.deepEqual(h.calls.models, [refModel(FALLBACK)]);
  await h.fail();
  assert.equal((await h.settle()).continue, true);
  await h.fail();
  assert.equal(await h.settle(), undefined);
  assert.deepEqual(h.calls.models, [refModel(FALLBACK), refModel(NEXT)]);
});

test("response metadata keeps retry headers without switching before settlement", async () => {
  const h = await createHarness();
  await h.handlers.get("after_provider_response")({ status: 429, headers: { "retry-after": "60" } }, h.ctx);
  assert.equal(h.calls.models.length, 0);
  await h.fail("You have hit your usage limit.");
  await h.settle();
  const { entries } = JSON.parse(await readFile(h.statePath, "utf8"));
  assert.ok(Date.parse(entries[0].until) - Date.parse(entries[0].createdAt) <= 61000);
});

test("idle timeout errors trigger fallback after settlement even after HTTP 200", async () => {
  for (const errorMessage of [
    "terminated",
    "Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.",
  ]) {
    const h = await createHarness({ rules: [{ matchModels: [SOURCE], statuses: [503], fallback: FALLBACK }] });
    if (errorMessage === "terminated") await h.handlers.get("after_provider_response")({ status: 200, headers: {} }, h.ctx);
    const failed = await h.fail(errorMessage);
    assert.deepEqual(h.calls.models, [], "do not switch before Pi settles its retries");
    assert.deepEqual(await h.settle(), { entries: [{ type: "context_edit", targetId: failed.id, replacement: null }], continue: true });
    assert.deepEqual(h.calls.models, [refModel(FALLBACK)]);
    const { entries } = JSON.parse(await readFile(h.statePath, "utf8"));
    assert.equal(entries[0].status, 503);
    assert.equal(Date.parse(entries[0].until) - Date.parse(entries[0].createdAt), 600000);
    assert.equal(h.calls.prompts.length, 0);
  }
});

test("a terminated message on an aborted turn never triggers fallback", async () => {
  const h = await createHarness({ rules: [{ matchModels: [SOURCE], statuses: [503], fallback: FALLBACK }] });
  const message = { role: "assistant", ...SOURCE, stopReason: "aborted", errorMessage: "terminated" };
  await h.handlers.get("turn_end")({ message, messageEntryId: "aborted" }, h.ctx);
  assert.equal(await h.settle("aborted"), undefined);
  assert.deepEqual(h.calls.models, []);
  assert.equal(existsSync(h.statePath), false);
});

test("response status cannot cross models or provider requests", async () => {
  const h = await createHarness({ rules: [rule(SOURCE, FALLBACK), rule(FALLBACK, NEXT)] });
  await h.handlers.get("after_provider_response")({ status: 429, headers: {} }, h.ctx);
  h.ctx.model = refModel(FALLBACK);
  await h.fail("Unclassified provider error");
  assert.equal(await h.settle(), undefined);
  await h.handlers.get("after_provider_response")({ status: 429, headers: {} }, h.ctx);
  await h.handlers.get("before_provider_request")({}, h.ctx);
  await h.fail("Unclassified provider error");
  assert.equal(await h.settle(), undefined);
  assert.equal(h.calls.models.length, 0);
});

test("interrupt during core retry suppresses fallback even if settlement remains an error", async () => {
  const h = await createHarness();
  await h.fail(); h.escape();
  assert.equal(await h.settle(), undefined);
  assert.equal(h.calls.models.length, 0);
  await h.start(); await h.fail();
  assert.equal((await h.settle()).continue, true);
});

test("aborted settlement never switches or resumes", async () => {
  const h = await createHarness(); await h.fail();
  assert.equal(await h.settle("aborted"), undefined);
  assert.equal(h.calls.models.length, 0);
});

test("interrupt while target activation is pending prevents continuation and persistence", async () => {
  let release, entered;
  const reached = new Promise(resolve => { entered = resolve; });
  const h = await createHarness({ switchModel: () => { entered(); return new Promise(resolve => { release = resolve; }); } });
  await h.fail(); const settling = h.settle();
  await Promise.race([reached, settling]); h.escape(); release(true);
  assert.equal(await settling, undefined);
  assert.equal(existsSync(h.statePath), false);
});

test("successful retry clears the old failure", async () => {
  const h = await createHarness(); await h.fail();
  await h.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop" }, messageEntryId: "ok" }, h.ctx);
  assert.equal(await h.settle("completed"), undefined);
  assert.equal(h.calls.models.length, 0);
});

test("unavailable target stops without persisting or replaying", async () => {
  const h = await createHarness({ switchModel: async () => false }); await h.fail();
  assert.equal(await h.settle(), undefined);
  assert.equal(existsSync(h.statePath), false);
  assert.equal(h.calls.prompts.length, 0);
});

test("autoRetry false switches the model without continuing", async () => {
  const h = await createHarness({ autoRetry: false }); await h.fail();
  assert.equal(await h.settle(), undefined);
  assert.deepEqual(h.calls.models, [refModel(FALLBACK)]);
});

test("disabled config skips persistent state loading at agent startup", async () => {
  const h = await createHarness({ enabled: false, stateFileContents: "not-json" });
  assert.equal(h.calls.notifications.some(({ message }) => message.includes("state error")), false);
  assert.deepEqual(h.calls.models, []);
});

test("manual selection cancels pending fallback", async () => {
  const h = await createHarness(); await h.fail(); h.ctx.model = refModel(NEXT);
  await h.handlers.get("model_select")({ model: h.ctx.model, source: "set" }, h.ctx);
  assert.equal(await h.settle(), undefined);
  assert.equal(h.calls.models.length, 0);
});

test("saving config mid-run does not disable fallback for later failures", async () => {
  const h = await createHarness();
  const tool = h.tools.get("model_fallback_config");
  assert.equal(typeof tool?.execute, "function");
  await tool.execute("save-1", { action: "save", configJson: JSON.stringify({ version: 1, enabled: true, autoRetry: true, rules: [rule(SOURCE, FALLBACK)] }) }, undefined, undefined, h.ctx);
  await h.fail();
  assert.equal((await h.settle()).continue, true);
  assert.deepEqual(h.calls.models, [refModel(FALLBACK)]);
});

test("shutdown removes the terminal listener and pending work", async () => {
  const h = await createHarness(); await h.fail();
  await h.handlers.get("session_shutdown")({}, h.ctx); h.escape();
  assert.equal(await h.settle(), undefined);
});
