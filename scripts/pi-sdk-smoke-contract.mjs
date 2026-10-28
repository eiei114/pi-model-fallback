import { resolve } from "node:path";

export const VERIFICATION_CONTRACT = "pi-sdk-behavior-v2";
export const SDK_VERSIONS = Object.freeze({
  "@earendil-works/pi-agent-core": "1.4.0",
  "@earendil-works/pi-ai": "1.4.0",
  "@earendil-works/pi-coding-agent": "1.4.0",
  "@earendil-works/pi-tui": "1.4.0",
});
const COMMITTED_REPORT_PATH = "docs/verification/pi-sdk-smoke.json";

export function smokeReportPath(root, record = false) {
  return resolve(root, record ? COMMITTED_REPORT_PATH : "tmp/pi-sdk-smoke.json");
}

export const UNHANDLED_ERROR_PATTERN = /unhandled promise rejection|uncaught (?:exception|error)|shutdown(?: error| failed)|error while shutting down/i;
export const EXTENSION_LOAD_ERROR_PATTERN = /failed to load extension|error loading extension|extension load error/i;

export function parseJsonLines(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch {
      return [];
    }
  });
}

function assertion(id, expected, observed, passed) {
  return { id, expected, observed: JSON.stringify(observed), passed: passed === true };
}

function commandResponse(rows, id) {
  return rows.find((row) => row.type === "response" && row.id === id && row.command === "prompt");
}

function notifications(rows) {
  return rows.filter((row) => row.type === "extension_ui_request" && row.method === "notify" && typeof row.message === "string");
}

function processClean(process) {
  return process.exitCode === 0 && !process.timedOut && !process.error
    && !UNHANDLED_ERROR_PATTERN.test(process.fullOutput)
    && !EXTENSION_LOAD_ERROR_PATTERN.test(process.fullOutput);
}

function handled(response) {
  return response?.success === true && response.data?.disposition === "handled";
}

export function behaviorAssertions(name, observed) {
  if (name === "extension_load") {
    const response = commandResponse(observed.rows, "extension-load");
    const status = notifications(observed.rows).find((row) => row.message.startsWith("Model fallback: enabled"));
    return [assertion("extension_registered", "The actual Pi host handles the package's registered status command",
      { response: response ?? null, notification: status ?? null, exit_code: observed.exitCode },
      handled(response) && !!status && processClean(observed))];
  }

  if (name === "happy_path") {
    const response = commandResponse(observed.rows, "happy-path");
    const failure = observed.rows.find((row) => row.type === "message_end" && row.message?.role === "assistant"
      && row.message.provider === "pi-sdk-smoke-source" && row.message.model === "source"
      && row.message.stopReason === "error" && /429/.test(row.message.errorMessage ?? ""));
    const fallback = observed.rows.find((row) => row.type === "message_end" && row.message?.role === "assistant"
      && row.message.provider === "pi-sdk-smoke-target" && row.message.model === "target"
      && row.message.stopReason === "stop"
      && row.message.content?.some((block) => block.type === "text" && block.text.includes("pi-model-fallback-smoke-ok")));
    const notice = notifications(observed.rows).find((row) => row.message.startsWith(
      "Model fallback: pi-sdk-smoke-source/source → pi-sdk-smoke-target/target (429)",
    ));
    const settled = observed.rows.find((row) => row.type === "agent_settled" && row.aborted === false);
    const userMessages = observed.rows.filter((row) => row.type === "message_end" && row.message?.role === "user");
    const entry = observed.state?.entries?.find((item) => item.source?.provider === "pi-sdk-smoke-source"
      && item.source?.model === "source" && item.fallback?.provider === "pi-sdk-smoke-target"
      && item.fallback?.model === "target" && item.status === 429);
    return [assertion("feature_response", "The real Pi run handles a 429, persists the configured fallback, and returns the target response",
      { response: response ?? null, source_error: failure ?? null, fallback_response: fallback ?? null,
        fallback_notification: notice ?? null, agent_settled: settled ?? null, user_message_count: userMessages.length,
        persisted_state: entry ?? null, exit_code: observed.exitCode },
      response?.success === true && response.data?.disposition === "started" && !!failure && !!fallback && !!notice
        && !!settled && userMessages.length === 1 && !!entry && processClean(observed))];
  }

  if (name === "error_path") {
    const response = commandResponse(observed.rows, "error-path");
    const warning = notifications(observed.rows).find((row) => row.message.startsWith("Model fallback config error:")
      && row.message.includes("Unsupported config version: 2"));
    return [assertion("handled_error", "The actual extension reports a malformed config as a handled warning without crashing Pi",
      { response: response ?? null, warning: warning ?? null, exit_code: observed.exitCode },
      handled(response) && !!warning && processClean(observed))];
  }

  if (name === "reload_cleanup") {
    const statusResponse = commandResponse(observed.second.rows, "reload-status");
    const resetResponse = commandResponse(observed.second.rows, "reload-feature");
    const status = notifications(observed.second.rows).find((row) => row.message.startsWith("Model fallback: enabled"));
    const reset = notifications(observed.second.rows).find((row) => row.message.startsWith(
      "Model fallback: persistent state cleared; no remembered original model.",
    ));
    const clean = processClean(observed.first) && processClean(observed.second);
    return [
      assertion("reloaded_extension_registered", "A second real Pi process reloads the extension and handles its registered status command",
        { response: statusResponse ?? null, notification: status ?? null, second_exit_code: observed.second.exitCode },
        handled(statusResponse) && !!status && processClean(observed.second)),
      assertion("reloaded_feature_response", "The reloaded second process executes reset and returns its package-specific handled response",
        { response: resetResponse ?? null, notification: reset ?? null }, handled(resetResponse) && !!reset),
      assertion("clean_shutdown", "Both actual Pi processes exit cleanly without unhandled, extension-load, or shutdown errors",
        { first_exit_code: observed.first.exitCode, second_exit_code: observed.second.exitCode,
          first_timed_out: observed.first.timedOut, second_timed_out: observed.second.timedOut,
          first_unhandled_error: UNHANDLED_ERROR_PATTERN.test(observed.first.fullOutput),
          second_unhandled_error: UNHANDLED_ERROR_PATTERN.test(observed.second.fullOutput),
          first_extension_load_error: EXTENSION_LOAD_ERROR_PATTERN.test(observed.first.fullOutput),
          second_extension_load_error: EXTENSION_LOAD_ERROR_PATTERN.test(observed.second.fullOutput) }, clean),
    ];
  }

  if (name === "host_shell") {
    const output = observed.stdout.trim();
    return [assertion("native_shell_boundary", "The native host shell launches the locally pinned Pi CLI and returns exactly 1.4.0",
      { exit_code: observed.exitCode, output, expected_version: SDK_VERSIONS["@earendil-works/pi-coding-agent"],
        stderr: observed.stderr.trim(), error: observed.error ?? null },
      observed.exitCode === 0 && !observed.timedOut && !observed.error
        && output === SDK_VERSIONS["@earendil-works/pi-coding-agent"] && !EXTENSION_LOAD_ERROR_PATTERN.test(observed.stderr))];
  }

  throw new Error(`Unknown Pi SDK smoke case: ${name}`);
}
