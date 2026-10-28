import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Isolate discovery before importing Pi; no credentials or network requests are needed.
const sandbox = await mkdtemp(join(tmpdir(), "pi-fallback-sdk-"));
process.env.HOME = sandbox;
process.env.PI_CODING_AGENT_DIR = sandbox;
process.env.PI_OFFLINE = "1";
globalThis.fetch = async () => { throw new Error("Network access is forbidden in the fallback SDK tests"); };
const { InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { KeybindingsManager, setKeybindings } = await import("@earendil-works/pi-tui");
const { Type } = await import("typebox");
setKeybindings(new KeybindingsManager({ "app.interrupt": { defaultKeys: "ctrl+x", description: "Fixture interrupt" } }));
const error = (status = 429) => fauxAssistantMessage("", { stopReason: "error", errorMessage: `Error: ${status} provider unavailable` });

async function fixture(t, { circular = false, retry = false, preselect = false, customTools = [], statuses = [429, 529] } = {}) {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const source = fauxProvider({ provider: "fixture-source", api: "fixture-source", models: [{ id: "source", input: ["text", "image"] }], tokensPerSecond: 100000 });
  const target = fauxProvider({ provider: "fixture-target", api: "fixture-target", models: [{ id: "target", input: ["text", "image"] }], tokensPerSecond: 100000 });
  runtime.registerNativeProvider(source.provider);
  runtime.registerNativeProvider(target.provider);
  await runtime.refresh({ allowNetwork: false });
  const sourceModel = runtime.getModel("fixture-source", "source");
  const targetModel = runtime.getModel("fixture-target", "target");
  assert.ok(sourceModel);
  assert.ok(targetModel);
  const rules = [{ matchModels: [{ provider: "fixture-source", model: "source" }], statuses, fallback: { provider: "fixture-target", model: "target" } }];
  if (circular) rules.push({ matchModels: [{ provider: "fixture-target", model: "target" }], statuses: [429, 529], fallback: { provider: "fixture-source", model: "source" } });
  const root = join(sandbox, "model-fallback");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, enabled: true, autoRetry: true, rules }));
  await writeFile(join(root, "state.json"), JSON.stringify({ version: 1, entries: preselect ? [{
    source: { provider: "fixture-source", model: "source" }, fallback: { provider: "fixture-target", model: "target" },
    status: 429, createdAt: new Date().toISOString(), until: new Date(Date.now() + 3600000).toISOString(),
  }] : [] }));
  const settings = SettingsManager.inMemory({ packages: [], extensions: [], compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1000, provider: { maxRetries: 0 } } });
  const counts = { beforeAgentStart: 0, agentStart: 0 };
  const loader = new DefaultResourceLoader({
    cwd: sandbox, agentDir: sandbox, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Offline failover fixture.", appendSystemPrompt: [],
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/index.ts", import.meta.url))],
    extensionFactories: [(pi) => {
      pi.on("before_agent_start", () => { counts.beforeAgentStart++; });
      pi.on("agent_start", () => { counts.agentStart++; });
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = SessionManager.inMemory(sandbox);
  const { session } = await createAgentSession({ cwd: sandbox, agentDir: sandbox, modelRuntime: runtime, model: sourceModel,
    scopedModels: [{ model: sourceModel }, { model: targetModel }], thinkingLevel: "off", settingsManager: settings,
    sessionManager: manager, resourceLoader: loader, tools: customTools.map(tool => tool.name), customTools });
  const inputs = new Set();
  const errors = [];
  await session.bindExtensions({ mode: "tui", uiContext: {
    onTerminalInput(handler) { inputs.add(handler); return () => inputs.delete(handler); },
    notify() {}, setStatus() {},
  }, onError: error => errors.push(error) });
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    assert.equal(inputs.size, 0);
    assert.deepEqual(errors, []);
  });
  return { session, source, target, runtime, manager, counts, interrupt: () => { for (const handler of inputs) handler("\x18"); } };
}

test("real Pi continues with images and completed tool results without replaying the user request", { timeout: 10000 }, async (t) => {
  let toolCalls = 0;
  const tool = { name: "fixture_write", label: "Fixture write", description: "Count an already completed write", parameters: Type.Object({}),
    async execute() { toolCalls++; return { content: [{ type: "text", text: "write completed" }], details: {} }; } };
  const h = await fixture(t, { customTools: [tool] });
  h.source.setResponses([fauxAssistantMessage(fauxToolCall("fixture_write", {}, { id: "write-once" }), { stopReason: "toolUse" }), error()]);
  let context;
  h.target.setResponses([messages => { context = structuredClone(messages.messages); return fauxAssistantMessage("continued"); }]);
  const image = { type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=", mimeType: "image/png" };
  await h.session.prompt("Continue the task after the write.", { images: [image] });
  assert.equal(h.session.model.provider, "fixture-target");
  assert.equal(h.source.state.callCount, 2);
  assert.equal(h.target.state.callCount, 1);
  assert.equal(toolCalls, 1);
  assert.equal(h.counts.beforeAgentStart, 1);
  assert.equal(h.counts.agentStart, 2);
  assert.equal(h.session.messages.filter(m => m.role === "user").length, 1);
  assert.ok(context.some(m => m.role === "toolResult" && m.toolCallId === "write-once"));
  assert.ok(context.some(m => m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "image")));
  assert.equal(context.some(m => m.role === "assistant" && m.stopReason === "error"), false);
  assert.equal(h.manager.getEntries().filter(e => e.type === "context_edit").length, 1);
});

test("real Pi stops a circular fallback chain after each model fails once", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, { circular: true });
  h.source.setResponses([error()]);
  h.target.setResponses([error(529)]);
  await h.session.prompt("Do not repeat indefinitely.");
  assert.equal(h.source.state.callCount, 1);
  assert.equal(h.target.state.callCount, 1);
  assert.equal(h.session.isIdle, true);
  assert.equal(h.counts.beforeAgentStart, 1);
});

test("Pi's own retry finishes before fallback changes the selected model", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, { retry: true });
  h.source.setResponses([error(), error()]);
  h.target.setResponses([fauxAssistantMessage("continued")]);
  await h.session.prompt("Continue after retry exhaustion.");
  assert.equal(h.source.state.callCount, 2);
  assert.equal(h.target.state.callCount, 1);
});

test("Pi retries idle timeout errors before switching to the fallback model", { timeout: 15000 }, async (t) => {
  for (const errorMessage of [
    "terminated",
    "Request timed out. Node.js fetch timed out waiting for response headers; configure a matching undici fetch and fetchOptions.dispatcher with an Agent whose headersTimeout is at least the SDK timeout.",
  ]) {
    await t.test(errorMessage.slice(0, 30), async (subtest) => {
      const h = await fixture(subtest, { retry: true, statuses: [503] });
      const fail = async (_context, options, _state, model) => {
        if (errorMessage === "terminated") await options.onResponse({ status: 200, headers: {} }, model);
        return fauxAssistantMessage("", { stopReason: "error", errorMessage });
      };
      h.source.setResponses([fail, fail]);
      h.target.setResponses([fauxAssistantMessage("continued")]);
      await h.session.prompt("Continue after a stalled provider.");
      assert.equal(h.source.state.callCount, 2);
      assert.equal(h.target.state.callCount, 1);
      assert.equal(h.session.model.provider, "fixture-target");
      assert.equal(h.session.messages.filter(m => m.role === "user").length, 1);
    });
  }
});

test("custom interrupt during Pi retry cancels fallback despite abortRetry's error outcome", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, { retry: true });
  h.source.setResponses([error()]);
  h.target.setResponses([fauxAssistantMessage("must not run")]);
  let interrupted = false;
  h.session.subscribe(event => {
    if (event.type === "auto_retry_start") queueMicrotask(() => {
      interrupted = true;
      h.interrupt();
      h.session.abortRetry();
    });
  });
  await h.session.prompt("Cancel while waiting.");
  assert.equal(interrupted, true);
  assert.equal(h.source.state.callCount, 1);
  assert.equal(h.target.state.callCount, 0);
  assert.equal(h.session.model.provider, "fixture-source");
});

test("observed HTTP status survives friendly error text without a numeric status", { timeout: 10000 }, async (t) => {
  const h = await fixture(t);
  h.source.setResponses([async (_context, options, _state, model) => {
    await options.onResponse({ status: 429, headers: { "retry-after": "1" } }, model);
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "You have hit your ChatGPT usage limit." });
  }]);
  h.target.setResponses([fauxAssistantMessage("continued")]);
  await h.session.prompt("Continue after quota failure.");
  assert.equal(h.source.state.callCount, 1);
  assert.equal(h.target.state.callCount, 1);
});

test("an earlier HTTP status cannot mask a later unclassified failure", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, { retry: true });
  h.source.setResponses([async (_context, options, _state, model) => {
    await options.onResponse({ status: 429, headers: {} }, model);
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "rate limit exceeded" });
  }, fauxAssistantMessage("", { stopReason: "error", errorMessage: "Authentication failed" })]);
  h.target.setResponses([fauxAssistantMessage("must not run")]);
  await h.session.prompt("Do not reuse an earlier response.");
  assert.equal(h.source.state.callCount, 2);
  assert.equal(h.target.state.callCount, 0);
});

test("interrupt during persistent preselection prevents the initial inference", { timeout: 10000 }, async (t) => {
  const h = await fixture(t, { preselect: true });
  h.source.setResponses([fauxAssistantMessage("must not run")]);
  h.target.setResponses([fauxAssistantMessage("must not run")]);
  const originalCheck = h.runtime.checkAuth.bind(h.runtime);
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.runtime.checkAuth = async (provider, options) => {
    if (provider === "fixture-target") { entered(); await gate; }
    return originalCheck(provider, options);
  };
  const prompting = h.session.prompt("Cancel before the request starts.");
  await Promise.race([reached, prompting.then(() => { throw new Error("preselection was not reached"); })]);
  assert.equal(h.session.isIdle, false);
  h.interrupt();
  const aborting = h.session.abort();
  release();
  await Promise.all([prompting, aborting]);
  assert.equal(h.source.state.callCount, 0);
  assert.equal(h.target.state.callCount, 0);
  assert.equal(h.session.isIdle, true);
});

test("SDK abort during target activation cannot start a fallback inference", { timeout: 10000 }, async (t) => {
  const h = await fixture(t);
  h.source.setResponses([error()]);
  h.target.setResponses([fauxAssistantMessage("must not run")]);
  const originalCheck = h.runtime.checkAuth.bind(h.runtime);
  let entered;
  let release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  h.runtime.checkAuth = async (provider, options) => {
    if (provider === "fixture-target") { entered(); await gate; }
    return originalCheck(provider, options);
  };
  const prompting = h.session.prompt("Stop before the next inference.");
  await Promise.race([reached, prompting.then(() => { throw new Error("target activation was not reached"); })]);
  const aborting = h.session.abort();
  release();
  await Promise.all([prompting, aborting]);
  assert.equal(h.target.state.callCount, 0);
  assert.equal(h.session.isIdle, true);
});
