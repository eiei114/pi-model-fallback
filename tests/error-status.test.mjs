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
});

test("parseStatusFromErrorMessage extracts statuses behind an Error prefix", () => {
  assert.equal(
    parseStatusFromErrorMessage('Error: 401: {"type":"CreditsError","message":"Insufficient balance. Manage your billing here."}'),
    401,
  );
  assert.equal(parseStatusFromErrorMessage("error: 429 too many requests"), 429);
  assert.equal(parseStatusFromErrorMessage("ERROR 500: internal server error"), 500);
});

test("parseStatusFromErrorMessage ignores unrelated 3-digit numbers", () => {
  assert.equal(parseStatusFromErrorMessage("429 tokens remaining in context window"), undefined);
  assert.equal(parseStatusFromErrorMessage("processed 404 items before retry"), undefined);
  assert.equal(parseStatusFromErrorMessage("model returned 200 words of output"), undefined);
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
