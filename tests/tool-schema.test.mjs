import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Isolate discovery before importing Pi; the probe is fully offline and deterministic.
const sandbox = await mkdtemp(join(tmpdir(), "pi-fallback-tool-schema-"));
process.env.HOME = sandbox;
process.env.PI_CODING_AGENT_DIR = sandbox;
process.env.PI_OFFLINE = "1";
globalThis.fetch = async () => { throw new Error("Network access is forbidden in the tool schema test"); };
const { InMemoryCredentialStore, fauxAssistantMessage, fauxToolCall, fauxProvider } = await import("@earendil-works/pi-ai");
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");

async function fixture() {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  const provider = fauxProvider({ provider: "tool-schema-source", api: "tool-schema-source", models: [{ id: "source", input: ["text"] }], tokensPerSecond: 100000 });
  runtime.registerNativeProvider(provider.provider);
  await runtime.refresh({ allowNetwork: false });
  const model = runtime.getModel("tool-schema-source", "source");
  assert.ok(model);
  const root = join(sandbox, "model-fallback");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "config.json"), JSON.stringify({ version: 1, enabled: true, autoRetry: true, rules: [{
    matchModels: [{ provider: "tool-schema-source", model: "source" }], statuses: [429],
    fallback: { provider: "tool-schema-target", model: "target" },
  }] }));
  const settings = SettingsManager.inMemory({
    packages: [], extensions: [], compaction: { enabled: false }, cacheWarming: "off", retry: { enabled: false, provider: { maxRetries: 0 } },
  });
  const loader = new DefaultResourceLoader({
    cwd: sandbox, agentDir: sandbox, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: "Offline tool schema fixture.", appendSystemPrompt: [],
    additionalExtensionPaths: [fileURLToPath(new URL("../extensions/index.ts", import.meta.url))],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: sandbox, agentDir: sandbox, modelRuntime: runtime, model,
    scopedModels: [{ model }], thinkingLevel: "off", settingsManager: settings,
    sessionManager: SessionManager.inMemory(sandbox), resourceLoader: loader });
  await session.bindExtensions({ mode: "headless", uiContext: { notify() {}, setStatus() {} } });
  return { session, provider };
}

// Pi 1.5.0 validates tool arguments with @earendil-works/pi-schema instead of TypeBox.
// The package's model_fallback_config tool still declares plain JSON Schema, so both a
// valid call (executes) and an invalid one (rejected before execute) must keep working.
test("real Pi 1.5.0 validates the model_fallback_config tool schema", { timeout: 20000 }, async (t) => {
  const { session, provider } = await fixture();
  t.after(async () => {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  });

  provider.setResponses([fauxAssistantMessage(fauxToolCall("model_fallback_config", { action: "status" }, { id: "valid-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("status reported")]);
  await session.prompt("Report the fallback status.");
  const valid = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "valid-call");
  assert.ok(valid, "the valid tool call must reach the extension tool");
  assert.notEqual(valid.isError, true, `valid arguments must pass validation: ${JSON.stringify(valid.content)}`);
  assert.match(valid.content[0].text, /^Model fallback: /,
    "the extension's own status text proves execute() ran, not just validation");

  provider.setResponses([fauxAssistantMessage(fauxToolCall("model_fallback_config", { action: "bogus" }, { id: "invalid-call" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("rejected")]);
  await session.prompt("Try an unknown action.");
  const invalid = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "invalid-call");
  assert.ok(invalid, "the invalid tool call must produce a tool result instead of crashing Pi");
  assert.equal(invalid.isError, true, "pi-schema must reject the unknown action");
  assert.match(invalid.content[0].text, /Validation failed for tool "model_fallback_config"/);
  assert.match(invalid.content[0].text, /- action: expected "read"/,
    "pi-schema reports the enum failure at the field path");

  provider.setResponses([fauxAssistantMessage(fauxToolCall("model_fallback_config", { configJson: "{}" }, { id: "missing-action" }), { stopReason: "toolUse" }),
    fauxAssistantMessage("rejected")]);
  await session.prompt("Omit the required action.");
  const missing = session.messages.find((message) => message.role === "toolResult" && message.toolCallId === "missing-action");
  assert.ok(missing, "a missing required field must come back as a tool result, not an extension crash");
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /- action: missing/,
    "pi-schema reports a missing required field at the field, which TypeBox did not");
  assert.equal(session.isIdle, true);
});
