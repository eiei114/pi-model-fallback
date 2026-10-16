import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { behaviorAssertions, parseJsonLines, SDK_VERSIONS, smokeReportPath, VERIFICATION_CONTRACT } from "../scripts/pi-sdk-smoke-contract.mjs";

const root = resolve(import.meta.dirname, "..");

const response = (id, disposition = "handled") => ({ type: "response", id, command: "prompt", success: true, data: { disposition } });
const notify = (message) => ({ type: "extension_ui_request", method: "notify", message });
const cleanProcess = (rows) => ({ rows, exitCode: 0, timedOut: false, error: null, fullOutput: "" });

test("Pi SDK behavior contract parses JSONL and pins the frozen versions", () => {
  assert.equal(VERIFICATION_CONTRACT, "pi-sdk-behavior-v2");
  assert.deepEqual(parseJsonLines(`not-json\r\n${JSON.stringify(response("ok"))}\n[]\n`), [response("ok")]);
  assert.deepEqual(SDK_VERSIONS, {
    "@earendil-works/pi-agent-core": "1.2.0",
    "@earendil-works/pi-ai": "1.2.0",
    "@earendil-works/pi-coding-agent": "1.2.0",
    "@earendil-works/pi-tui": "1.2.0",
  });
});

test("normal smoke output is ignored and recording explicitly targets the committed report", () => {
  const committedReportPath = resolve(root, "docs/verification/pi-sdk-smoke.json");
  const normalReportPath = smokeReportPath(root);
  const ignoreCheck = spawnSync("git", ["check-ignore", "--quiet", "--", normalReportPath], { cwd: root });

  assert.equal(normalReportPath, resolve(root, "tmp/pi-sdk-smoke.json"));
  assert.equal(smokeReportPath(root, true), committedReportPath);
  assert.notEqual(normalReportPath, committedReportPath);
  assert.equal(ignoreCheck.status, 0, ignoreCheck.error?.message ?? "normal smoke output must be git-ignored");
});

test("extension registration and handled error assertions reject missing behavior", () => {
  const registration = cleanProcess([response("extension-load"), notify("Model fallback: enabled")]);
  assert.equal(behaviorAssertions("extension_load", registration)[0].passed, true);
  assert.equal(behaviorAssertions("extension_load", cleanProcess([]))[0].passed, false);

  const error = cleanProcess([response("error-path"), notify("Model fallback config error: Unsupported config version: 2.")]);
  assert.equal(behaviorAssertions("error_path", error)[0].passed, true);
  assert.equal(behaviorAssertions("error_path", cleanProcess([response("error-path")]))[0].passed, false);
});

test("happy path requires the actual failed source, successful fallback, state, and settlement", () => {
  const rows = [
    response("happy-path", "started"),
    { type: "message_end", message: { role: "assistant", provider: "pi-sdk-smoke-source", model: "source", stopReason: "error", errorMessage: "Error: 429 fixture" } },
    notify("Model fallback: pi-sdk-smoke-source/source → pi-sdk-smoke-target/target (429) until later."),
    { type: "message_end", message: { role: "assistant", provider: "pi-sdk-smoke-target", model: "target", stopReason: "stop", content: [{ type: "text", text: "pi-model-fallback-smoke-ok" }] } },
    { type: "agent_settled", aborted: false },
    { type: "message_end", message: { role: "user", content: "smoke" } },
  ];
  const state = { entries: [{ source: { provider: "pi-sdk-smoke-source", model: "source" },
    fallback: { provider: "pi-sdk-smoke-target", model: "target" }, status: 429 }] };
  assert.equal(behaviorAssertions("happy_path", { ...cleanProcess(rows), state })[0].passed, true);
  assert.equal(behaviorAssertions("happy_path", { ...cleanProcess(rows.filter((row) => row.type !== "agent_settled")), state })[0].passed, false);
  assert.equal(behaviorAssertions("happy_path", { ...cleanProcess(rows), state: { entries: [] } })[0].passed, false);
});

test("reload requires actual second-process status and feature responses plus clean shutdown", () => {
  const first = cleanProcess([response("reload-first"), notify("Model fallback: enabled")]);
  const second = cleanProcess([response("reload-status"), notify("Model fallback: enabled"), response("reload-feature"),
    notify("Model fallback: persistent state cleared; no remembered original model.")]);
  const good = behaviorAssertions("reload_cleanup", { first, second });
  assert.deepEqual(good.map((item) => item.id), ["reloaded_extension_registered", "reloaded_feature_response", "clean_shutdown"]);
  assert.ok(good.every((item) => item.passed));

  const missingStatus = cleanProcess([response("reload-feature"), notify("Model fallback: persistent state cleared; no remembered original model.")]);
  assert.equal(behaviorAssertions("reload_cleanup", { first, second: missingStatus })[0].passed, false);
  assert.equal(behaviorAssertions("reload_cleanup", { first, second: cleanProcess([response("reload-status")]) })[1].passed, false);
  assert.equal(behaviorAssertions("reload_cleanup", { first: { ...first, exitCode: 1 }, second })[2].passed, false);
  assert.equal(behaviorAssertions("reload_cleanup", { first, second: { ...second, fullOutput: "shutdown error" } })[2].passed, false);
});

test("native shell boundary rejects absent or non-exact version output", () => {
  assert.equal(behaviorAssertions("host_shell", { exitCode: 0, stdout: "1.2.0\r\n", stderr: "", timedOut: false })[0].passed, true);
  for (const stdout of ["", "11.2.0", "1.2.0 then error", "1.1.0"]) {
    assert.equal(behaviorAssertions("host_shell", { exitCode: 0, stdout, stderr: "", timedOut: false })[0].passed, false);
  }
});
