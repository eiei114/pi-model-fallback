import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  behaviorAssertions,
  EXTENSION_LOAD_ERROR_PATTERN,
  parseJsonLines,
  SDK_VERSIONS,
  UNHANDLED_ERROR_PATTERN,
  VERIFICATION_CONTRACT,
  smokeReportPath,
} from "./pi-sdk-smoke-contract.mjs";

const PROBE_TIMEOUT_MS = 15_000;
const root = resolve(import.meta.dirname, "..");
const recordReport = process.argv.includes("--record");
const committedReportPath = smokeReportPath(root, true);
const reportPath = smokeReportPath(root, recordReport);
const committedReportBefore = recordReport ? null : readFileSync(committedReportPath);
const fixturePath = resolve(root, "tests/fixtures/pi-sdk-smoke-provider.mjs");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const packageJson = readJson(resolve(root, "package.json"));
const installedVersions = Object.fromEntries(Object.keys(SDK_VERSIONS).map((name) => [
  name,
  readJson(resolve(root, "node_modules", name, "package.json")).version,
]));

for (const [name, expected] of Object.entries(SDK_VERSIONS)) {
  if (packageJson.devDependencies?.[name] !== expected || installedVersions[name] !== expected) {
    throw new Error(`Smoke requires exact ${name}@${expected}; manifest=${packageJson.devDependencies?.[name]}, installed=${installedVersions[name]}`);
  }
}

const piPackageRoot = resolve(root, "node_modules/@earendil-works/pi-coding-agent");
const piManifest = readJson(resolve(piPackageRoot, "package.json"));
const piCli = resolve(piPackageRoot, piManifest.bin.pi);
const rpcArgs = [
  piCli,
  "--offline",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-context-files",
  "--no-prompt-templates",
  "--no-themes",
  "--no-mcp",
  "-e",
  resolve(root, "extensions/index.ts"),
  "-e",
  fixturePath,
  "--mode",
  "rpc",
];

function writeConfig(agentDir, config) {
  const directory = join(agentDir, "model-fallback");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({ retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } } }, null, 2)}\n`);
}

function validConfig() {
  return {
    version: 1,
    enabled: true,
    autoRetry: true,
    rules: [{
      matchModels: [{ provider: "pi-sdk-smoke-source", model: "source" }],
      statuses: [429],
      cooldownMs: 60_000,
      fallback: { provider: "pi-sdk-smoke-target", model: "target" },
    }],
  };
}

function makeAgentDir() {
  return mkdtempSync(join(tmpdir(), "pi-model-fallback-sdk-smoke-"));
}

function redactLocalPaths(value, agentDir) {
  if (typeof value === "string") {
    let redacted = value;
    if (agentDir) {
      redacted = redacted
        .replaceAll(agentDir, "<isolated-agent-dir>")
        .replaceAll(agentDir.replaceAll("\\", "/"), "<isolated-agent-dir>");
    }
    return redacted.replaceAll(root, "<repo>").replaceAll(root.replaceAll("\\", "/"), "<repo>");
  }
  if (Array.isArray(value)) return value.map((item) => redactLocalPaths(item, agentDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactLocalPaths(item, agentDir)]));
  }
  return value;
}

function runPi({ agentDir, commands, initialModel = false }) {
  const args = [...rpcArgs];
  if (initialModel) args.push("--provider", "pi-sdk-smoke-source", "--model", "source", "--thinking", "off");

  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const rows = [];
    const waiters = [];
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let error;
    let timedOut = false;
    let closed = false;
    let settled = false;
    let exitCode;
    let signal;
    let cleanupTimer;
    const startedAt = Date.now();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(cleanupTimer);
      if (pendingLine.trim()) rows.push(...parseJsonLines(pendingLine).map((row) => redactLocalPaths(row, agentDir)));
      for (const waiter of waiters.splice(0)) waiter.reject(new Error("Pi process closed before the expected RPC record"));
      resolveResult({ rows, stdout, stderr, exitCode, signal, timedOut, error, durationMs: Date.now() - startedAt,
        fullOutput: `${stdout}${stderr}`, agentDir });
    };

    const parseChunk = (chunk) => {
      pendingLine += chunk;
      const lines = pendingLine.split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        rows.push(...parseJsonLines(line).map((row) => redactLocalPaths(row, agentDir)));
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          const waiter = waiters[index];
          const match = rows.find(waiter.predicate);
          if (match) {
            waiters.splice(index, 1);
            waiter.resolve(match);
          }
        }
      }
    };
    const waitFor = (predicate, description) => {
      const match = rows.find(predicate);
      if (match) return Promise.resolve(match);
      if (closed) return Promise.reject(new Error(`Pi exited before ${description}`));
      return new Promise((resolveWaiter, rejectWaiter) => waiters.push({
        predicate,
        resolve: resolveWaiter,
        reject: rejectWaiter,
      }));
    };
    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      child.kill();
      cleanupTimer = setTimeout(() => {
        if (!closed) {
          error ??= "Pi process did not exit within the one-second cleanup grace after the probe deadline";
          child.kill("SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          finish();
        }
      }, 1_000);
    }, PROBE_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      parseChunk(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (cause) => { error = cause.message; });
    child.stdin.on("error", (cause) => { error ??= cause.message; });
    child.on("close", (code, childSignal) => {
      closed = true;
      exitCode = code;
      signal = childSignal;
      finish();
    });

    void (async () => {
      try {
        for (const command of commands) {
          child.stdin.write(`${JSON.stringify({ id: command.id, type: "prompt", message: command.message })}\n`);
          const response = await waitFor((row) => row.type === "response" && row.id === command.id && row.command === "prompt",
            `response to ${command.id}`);
          if (command.waitForAgentSettled && response.success === true && response.data?.disposition === "started") {
            await waitFor((row) => row.type === "agent_settled", "agent_settled");
          }
        }
        child.stdin.end();
      } catch (cause) {
        error ??= cause.message;
        if (!child.stdin.destroyed) child.stdin.end();
        if (!closed) child.kill();
      }
    })();
  });
}

function processEvidence(process) {
  const rpcRecords = process.rows.filter((row) => row.type === "response" || row.type === "extension_ui_request"
    || row.type === "agent_settled" || row.type === "auto_retry_start"
    || row.type === "message_end" && row.message?.role !== "system"
    || row.type === "turn_end");
  return JSON.stringify({ exit_code: process.exitCode, signal: process.signal ?? null,
    timed_out: process.timedOut, duration_ms: process.durationMs, rpc_records: rpcRecords,
    stderr: redactLocalPaths(process.stderr.trim(), process.agentDir ?? ""),
    error: process.error ? redactLocalPaths(process.error, process.agentDir ?? "") : null });
}

function asCase(name, observed, processes, extraEvidence = "") {
  const assertions = behaviorAssertions(name, redactLocalPaths(observed, processes[0]?.agentDir ?? ""));
  const fullOutput = processes.map((process) => process.fullOutput).join("\n");
  const exitCode = name === "reload_cleanup" ? observed.second.exitCode : observed.exitCode;
  const passed = assertions.every((item) => item.passed)
    && !UNHANDLED_ERROR_PATTERN.test(fullOutput)
    && !EXTENSION_LOAD_ERROR_PATTERN.test(fullOutput);
  return {
    name,
    command: "npm run smoke:pi",
    exit_code: exitCode ?? 1,
    passed,
    evidence: `${processes.map(processEvidence).join("\n--- next Pi process ---\n")}${extraEvidence}`,
    assertions,
    fullOutput,
  };
}

async function runIsolatedCase(name, config, commands, options = {}) {
  const agentDir = makeAgentDir();
  try {
    writeConfig(agentDir, config);
    const process = await runPi({ agentDir, commands, initialModel: options.initialModel });
    const statePath = join(agentDir, "model-fallback", "state.json");
    let state;
    try { state = readJson(statePath); } catch { state = null; }
    return asCase(name, { ...process, state }, [process]);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

function runHostShell() {
  const agentDir = makeAgentDir();
  try {
    let executable;
    let args;
    if (process.platform === "win32") {
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      executable = resolve(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe");
      args = ["-NoProfile", "-NonInteractive", "-Command",
        `& ${quote(process.execPath)} ${quote(piCli)} --no-extensions --version; exit $LASTEXITCODE`];
    } else {
      executable = "/bin/sh";
      args = ["-c", 'exec "$1" "$2" --no-extensions --version', "pi-sdk-host-shell", process.execPath, piCli];
    }
    const result = spawnSync(executable, args, {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", HOME: agentDir },
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const observed = {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? 1,
      timedOut: result.error?.code === "ETIMEDOUT",
      error: result.error?.message,
      agentDir,
    };
    const smokeCase = asCase("host_shell", observed, [{ ...observed, rows: [], fullOutput: `${observed.stdout}${observed.stderr}` }]);
    return smokeCase;
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

const cases = [];
cases.push(await runIsolatedCase("extension_load", validConfig(), [
  { id: "extension-load", message: "/model-fallback:status" },
]));
cases.push(await runIsolatedCase("happy_path", validConfig(), [
  { id: "happy-path", message: "Exercise the deterministic fallback response.", waitForAgentSettled: true },
], { initialModel: true }));
cases.push(await runIsolatedCase("error_path", { version: 2, enabled: true, rules: [] }, [
  { id: "error-path", message: "/model-fallback:status" },
]));

{
  const agentDir = makeAgentDir();
  try {
    writeConfig(agentDir, validConfig());
    const first = await runPi({ agentDir, commands: [{ id: "reload-first", message: "/model-fallback:status" }] });
    const second = await runPi({ agentDir, commands: [
      { id: "reload-status", message: "/model-fallback:status" },
      { id: "reload-feature", message: "/model-fallback:reset" },
    ] });
    cases.push(asCase("reload_cleanup", { first, second }, [first, second]));
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
}

cases.push(runHostShell());

const report = {
  schema_version: 1,
  verification_contract: VERIFICATION_CONTRACT,
  sdk_versions: installedVersions,
  platform: process.platform,
  model_inference: "No paid inference; actual pinned Pi CLI/RPC, extension loader, lifecycle and fallback model runtime use a deterministic offline faux provider.",
  unhandled_errors: cases.filter((item) => UNHANDLED_ERROR_PATTERN.test(item.fullOutput)).length,
  extension_load_errors: cases.filter((item) => EXTENSION_LOAD_ERROR_PATTERN.test(item.fullOutput)).length,
  cases: cases.map(({ fullOutput: _fullOutput, ...item }) => item),
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
if (!recordReport && !readFileSync(committedReportPath).equals(committedReportBefore)) {
  throw new Error("Normal Pi smoke runs must preserve the committed verification report");
}
console.log(JSON.stringify({ verification_contract: VERIFICATION_CONTRACT, platform: process.platform,
  cases: cases.map(({ name, passed, exit_code }) => ({ name, passed, exit_code })) }));
if (cases.some((item) => !item.passed) || report.unhandled_errors !== 0 || report.extension_load_errors !== 0) process.exitCode = 1;
