import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The extension imports TS files via ".js" specifiers, which pi resolves through jiti.
// jiti is a transitive dependency of the pi installation rather than of this repo.
async function loadJiti() {
  try {
    return await import("jiti");
  } catch {
    const { homedir } = await import("node:os");
    return await import(join(homedir(), ".pi", "agent", "npm", "node_modules", "jiti", "lib", "jiti.mjs"));
  }
}
const { createJiti } = await loadJiti();
const jiti = createJiti(import.meta.url);
const modelFallback = (await jiti.import("../extensions/index.ts")).default;

const SOURCE = { provider: "opencode-go", model: "glm-5.3-flash" };
const FALLBACK = { provider: "openrouter", model: "poolside/laguna-xs-2.1:free" };
const SOURCE_KEY = `${SOURCE.provider}/${SOURCE.model}`;
const FALLBACK_KEY = `${FALLBACK.provider}/${FALLBACK.model}`;

async function makeProject() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-model-fallback-auto-retry-"));
  await mkdir(join(cwd, ".pi"), { recursive: true });
  // Project-local state so tests never touch the real agent directory.
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ packages: ["pi-model-fallback"] }), "utf8");
  const configPath = join(cwd, ".pi", "model-fallback", "config.json");
  const statePath = join(cwd, ".pi", "model-fallback", "state.json");
  await mkdir(join(cwd, ".pi", "model-fallback"), { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      enabled: true,
      autoRetry: true,
      rules: [
        {
          name: "opencode-go-to-laguna-free",
          matchProviders: ["opencode-go"],
          statuses: [401, 402, 403, 429, 500, 502, 503, 504],
          fallback: FALLBACK,
        },
      ],
    }),
    "utf8",
  );
  return { cwd, configPath, statePath };
}

function createHarness(cwd, { entries = [] } = {}) {
  const handlers = new Map();
  const calls = { setModel: [], sendUserMessage: [], notifications: [] };
  const pi = {
    on(type, handler) {
      handlers.set(type, handler);
    },
    registerCommand() {},
    registerTool() {},
    async setModel(model) {
      calls.setModel.push(model);
      return true;
    },
    async sendUserMessage(text, options) {
      calls.sendUserMessage.push({ text, options });
    },
  };
  modelFallback(pi);
  const ctx = {
    cwd,
    hasUI: true,
    model: { provider: SOURCE.provider, id: SOURCE.model },
    modelRegistry: {
      find: (provider, id) => ({ provider, id }),
    },
    ui: {
      notify: (message, level) => calls.notifications.push({ message, level }),
      setStatus() {},
      confirm: async () => true,
    },
    sessionManager: {
      getEntries: () => entries,
    },
  };
  return { pi, handlers, calls, ctx };
}

async function seedPersistent401(statePath) {
  await mkdir(statePath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
  await writeFile(
    statePath,
    JSON.stringify({
      version: 1,
      entries: [
        {
          source: SOURCE,
          fallback: FALLBACK,
          status: 401,
          until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
          ruleName: "opencode-go-to-laguna-free",
        },
      ],
    }),
    "utf8",
  );
}

const creditsErrorAssistantMessage = {
  role: "assistant",
  provider: SOURCE.provider,
  model: SOURCE.model,
  errorMessage: `Error: 401: {"type":"CreditsError","message":"Insufficient balance."}`,
};

test("auto-retries failed prompt on preselected fallback when the original model 401s", async () => {
  const project = await makeProject();
  await seedPersistent401(project.statePath);
  const harness = createHarness(project.cwd, {
    entries: [{ message: { role: "user", content: "hello there" } }],
  });

  await harness.handlers.get("agent_start")(undefined, harness.ctx);
  assert.deepEqual(harness.calls.setModel, [{ provider: FALLBACK.provider, id: FALLBACK.model }], "agent_start preselects the fallback model");

  await harness.handlers.get("turn_end")({ message: creditsErrorAssistantMessage }, harness.ctx);

  assert.equal(harness.calls.sendUserMessage.length, 1, "failed prompt should be retried on the fallback");
  assert.equal(harness.calls.sendUserMessage[0].text, "hello there");
  assert.deepEqual(harness.calls.sendUserMessage[0].options, { deliverAs: "followUp" });

  const state = JSON.parse(await readFile(project.statePath, "utf8"));
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].status, 401);
});

test("does not auto-retry when the active fallback itself fails", async () => {
  const project = await makeProject();
  await seedPersistent401(project.statePath);
  const harness = createHarness(project.cwd, {
    entries: [{ message: { role: "user", content: "hello there" } }],
  });

  await harness.handlers.get("agent_start")(undefined, harness.ctx);

  // The fallback model itself fails: provider/model matches the active fallback key.
  await harness.handlers.get("turn_end")(
    {
      message: {
        role: "assistant",
        provider: FALLBACK.provider,
        model: FALLBACK.model,
        errorMessage: "Error: 429: {\"type\":\"RateLimitError\",\"message\":\"Too many requests\"}",
      },
    },
    harness.ctx,
  );

  assert.equal(harness.calls.sendUserMessage.length, 0, "a failing fallback must not trigger another retry");
});