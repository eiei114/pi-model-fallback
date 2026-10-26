import assert from "node:assert/strict";
import test from "node:test";

const { parseReasonFromErrorMessage, parseStatusFromErrorMessage } = await import("../lib/error-status.ts");

test("parseStatusFromErrorMessage extracts anchored HTTP statuses", () => {
  assert.equal(parseStatusFromErrorMessage("HTTP 429 Too Many Requests"), 429);
  assert.equal(parseStatusFromErrorMessage("Provider returned status: 503"), 503);
  assert.equal(parseStatusFromErrorMessage("HTTP/1.1 502 Bad Gateway"), 502);
  assert.equal(parseStatusFromErrorMessage("rate limit exceeded with status 429"), 429);
  assert.equal(parseStatusFromErrorMessage("error 500 from upstream"), 500);
});

test("parseStatusFromErrorMessage extracts leading bare status codes", () => {
  assert.equal(
    parseStatusFromErrorMessage('401: {"type":"CreditsError","message":"Insufficient balance."}'),
    401,
  );
  assert.equal(
    parseStatusFromErrorMessage('429: {"message":"Provider returned error","code":429}'),
    429,
  );
  assert.equal(parseStatusFromErrorMessage("503: service unavailable"), 503);
  // An explicit status relayed alongside an empty-response phrase must win over
  // the synthesized 502.
  assert.equal(parseStatusFromErrorMessage("429: stream closed before a terminal event"), 429);
  assert.equal(parseStatusFromErrorMessage("upstream error 503: stream ended without a terminal event"), 503);
});

test("parseStatusFromErrorMessage extracts statuses behind an Error prefix", () => {
  assert.equal(
    parseStatusFromErrorMessage('Error: 401: {"type":"CreditsError","message":"Insufficient balance. Manage your billing here."}'),
    401,
  );
  assert.equal(parseStatusFromErrorMessage("error: 429 too many requests"), 429);
  assert.equal(parseStatusFromErrorMessage("ERROR 500: internal server error"), 500);
});

test("parseStatusFromErrorMessage extracts a status behind an Error prefix without a trailing colon", () => {
  // GitHub Copilot surfaces quota exhaustion exactly like this. It fell between
  // two patterns: the leading-bare-status one needs a colon AFTER the number,
  // and the "error <status>" one needs whitespace directly after "error".
  assert.equal(parseStatusFromErrorMessage("Error: 429 quota exceeded"), 429);
  assert.equal(parseStatusFromErrorMessage("error: 503 upstream unavailable"), 503);
  assert.equal(parseStatusFromErrorMessage("Error 429 quota exceeded"), 429);
  assert.equal(parseStatusFromErrorMessage("ERROR: 500 something broke"), 500);
});

test("parseStatusFromErrorMessage extracts a bare status followed by a quota noun", () => {
  assert.equal(parseStatusFromErrorMessage("429 quota exceeded"), 429);
  assert.equal(parseStatusFromErrorMessage("403 quota exhausted for this month"), 403);
});

test("parseStatusFromErrorMessage synthesizes 502 for empty-provider responses", () => {
  // Providers can complete the HTTP request with 200 but deliver nothing —
  // empty stream, empty body, or a truncated SSE stream. The harness surfaces
  // these with distinct literal texts and no numeric status. Without the
  // synthesis the agent retries the same dead model.
  assert.equal(parseStatusFromErrorMessage("Provider returned an empty response"), 502);
  assert.equal(parseStatusFromErrorMessage("provider returned an empty response after 30s"), 502);
  assert.equal(parseStatusFromErrorMessage("Stream ended without finish_reason"), 502);
  assert.equal(parseStatusFromErrorMessage("openrouter response has no body"), 502);
  assert.equal(parseStatusFromErrorMessage("Attempted to iterate over an Anthropic response with no body"), 502);
  assert.equal(parseStatusFromErrorMessage("Mistral response has no body"), 502);
  assert.equal(parseStatusFromErrorMessage("openrouter stream ended without a terminal event"), 502);
  // Router-relayed SSE death uses different wording (CLIProxyAPI/upstream routers):
  // "closed before" instead of "ended without". Without this the turn just fails.
  assert.equal(parseStatusFromErrorMessage("upstream stream closed before a terminal event (last event: response.output_item.done)"), 502);
  assert.equal(parseStatusFromErrorMessage("upstream stream closed before the terminal event"), 502);
  assert.equal(parseStatusFromErrorMessage("stream was closed before a terminal response event"), 502);
  assert.equal(parseStatusFromErrorMessage("provider stream ended before a terminal event"), 502);
  // The clause needs the terminal-event object; a bare "closed before" is not enough.
  assert.equal(parseStatusFromErrorMessage("stream closed before the response body arrived"), undefined);
  assert.equal(parseStatusFromErrorMessage("connection closed before headers"), undefined);
  // Explicit statuses still win when both match; the synthetic 502 is only a
  // fallback for messages that carry no status at all.
  assert.equal(parseStatusFromErrorMessage("429: stream closed before a terminal event"), 429);
  assert.equal(parseStatusFromErrorMessage("502: Provider returned an empty response"), 502);
  assert.equal(parseStatusFromErrorMessage("429: Provider returned an empty response"), 429);
  // Refusals and user-initiated aborts must NOT trigger fallback.
  assert.equal(parseStatusFromErrorMessage("Provider finish_reason: content_filter"), undefined);
  assert.equal(parseStatusFromErrorMessage("Request was aborted"), undefined);
  // Prose containing neither the phrase nor a status stays unmatched.
  assert.equal(parseStatusFromErrorMessage("429 tokens remaining in context window"), undefined);
});

test("parseStatusFromErrorMessage synthesizes 502 for router-relayed stream death", () => {
  // CLIProxyAPI (openai-responses) reports the identical failure with the router's
  // wording. pi's own retry patterns cover "ended without" and "stream ended before
  // a terminal response event" but not "closed before", so neither Pi nor this
  // extension recognized the failure and the turn failed with no fallback.
  assert.equal(parseStatusFromErrorMessage("upstream stream closed before a terminal event (last event: response.output_item.done)"), 502);
  assert.equal(parseStatusFromErrorMessage("Upstream stream closed before a terminal event"), 502);
  assert.equal(parseStatusFromErrorMessage("stream closed before terminal event"), 502);
  // A user abort or an unrelated stream close must stay unmatched.
  assert.equal(parseStatusFromErrorMessage("stream closed before the user prompt was sent"), undefined);
  assert.equal(parseStatusFromErrorMessage("Request was aborted"), undefined);
});

test("parseStatusFromErrorMessage ignores unrelated 3-digit numbers", () => {
  assert.equal(parseStatusFromErrorMessage("429 tokens remaining in context window"), undefined);
  assert.equal(parseStatusFromErrorMessage("processed 404 items before retry"), undefined);
  assert.equal(parseStatusFromErrorMessage("model returned 200 words of output"), undefined);
  // The Error-prefix pattern is anchored and requires the word "error", so
  // prose that merely begins with a status-shaped number stays unmatched.
  assert.equal(parseStatusFromErrorMessage("429 tokens left before the quota resets"), undefined);
  assert.equal(parseStatusFromErrorMessage("the 500 most recent errors were summarised"), undefined);
});

test("parseStatusFromErrorMessage extracts a parenthesized status inside an error wrapper", () => {
  // Provider wrappers place the status between parentheses with the wrapper text
  // in between, so both the anchored leading-status pattern and the
  // "error <status>" pattern miss it and no rule ever sees a status.
  assert.equal(parseStatusFromErrorMessage("omni API error (503): overloaded"), 503);
  assert.equal(parseStatusFromErrorMessage("omni API error (503): service temporarily unavailable"), 503);
  assert.equal(parseStatusFromErrorMessage("omni API error (500): internal error"), 500);
  assert.equal(parseStatusFromErrorMessage("chat_completion_error (429): rate limited"), 429);
  assert.equal(parseStatusFromErrorMessage("upstream_failure (502)"), 502);
  assert.equal(parseStatusFromErrorMessage("omni API error (503):"), 503);
  // Parentheses without the error/failure wrapper must not be treated as a status.
  assert.equal(parseStatusFromErrorMessage("(503) items processed"), undefined);
  assert.equal(parseStatusFromErrorMessage("(5 o3) malformed"), undefined);
  assert.equal(parseStatusFromErrorMessage("(50300) processed"), undefined);
});

test("parseStatusFromErrorMessage recognizes Anthropic SDK status plus JSON", () => {
  assert.equal(parseStatusFromErrorMessage('429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}'), 429);
  assert.equal(parseStatusFromErrorMessage('529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), 529);
  assert.equal(parseStatusFromErrorMessage('401 {"type":"error","error":{"type":"authentication_error","message":"Invalid credentials"}}'), 401);
  assert.equal(parseStatusFromErrorMessage("429 tokens remaining"), undefined);
});

test("parseStatusFromErrorMessage recognizes Anthropic streaming errors", () => {
  assert.equal(parseStatusFromErrorMessage('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'), 529);
  assert.equal(parseStatusFromErrorMessage('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}'), 429);
  assert.equal(parseStatusFromErrorMessage('{"type":"error","error":{"type":"api_error","message":"Internal error"}}'), 500);
  assert.equal(parseStatusFromErrorMessage("Anthropic stream ended before message_stop"), 502);
  assert.equal(parseStatusFromErrorMessage('{"type":"error","error":{"type":"authentication_error"}}'), undefined);
  assert.equal(parseStatusFromErrorMessage('{"type":"message","error":{"type":"overloaded_error"}}'), undefined);
  assert.equal(parseStatusFromErrorMessage('{"type":"error","error":"overloaded_error"}'), undefined);
  assert.equal(parseStatusFromErrorMessage('{"type":"error","error":null}'), undefined);
  assert.equal(parseStatusFromErrorMessage('{"type":"error","error":'), undefined);
});

test("parseStatusFromErrorMessage recognizes transport failures but not cancellation", () => {
  for (const message of ["Connection error.", "Request timed out.", "fetch failed", "connect ECONNRESET", "connect ECONNREFUSED", "lookup ENOTFOUND", "lookup EAI_AGAIN", "connect ETIMEDOUT"]) {
    assert.equal(parseStatusFromErrorMessage(message), 503, message);
  }
  assert.equal(parseStatusFromErrorMessage("Request was aborted"), undefined);
  assert.equal(parseStatusFromErrorMessage("Operation aborted"), undefined);
  assert.equal(parseStatusFromErrorMessage("401: Unauthorized"), 401);
  assert.equal(parseStatusFromErrorMessage("HTTP 429: connect ECONNRESET"), 429);
});

test("parseReasonFromErrorMessage extracts quoted provider error codes", () => {
  assert.equal(
    parseReasonFromErrorMessage(
      'Error: 400: {"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"error\\":{\\"message\\":\\"The request is 262237 tokens long and exceeds this model context length of 262144 tokens.\\",\\"code\\":\\"context_length_exceeded\\"}}","provider_name":"Nex AGI","is_byok":false,"provider_error_code":"context_length_exceeded"}}',
    ),
    "context_length_exceeded",
  );
  assert.equal(parseReasonFromErrorMessage('{"error":{"code":"insufficient_quota"}}'), "insufficient_quota");
});

test("parseReasonFromErrorMessage falls back to prose patterns", () => {
  assert.equal(
    parseReasonFromErrorMessage("The request is 262237 tokens long and exceeds this model's context length of 262144 tokens."),
    "context_length_exceeded",
  );
  assert.equal(parseReasonFromErrorMessage("request failed after 3 attempts"), undefined);
});

test("parseReasonFromErrorMessage ignores numeric status codes", () => {
  assert.equal(parseReasonFromErrorMessage('{"message":"Provider returned error","code":400}'), undefined);
});
