import assert from "node:assert/strict";
import test from "node:test";

const { parseStatusFromErrorMessage } = await import("../lib/error-status.ts");

test("parseStatusFromErrorMessage extracts anchored HTTP statuses", () => {
  assert.equal(parseStatusFromErrorMessage("HTTP 429 Too Many Requests"), 429);
  assert.equal(parseStatusFromErrorMessage("Provider returned status: 503"), 503);
  assert.equal(parseStatusFromErrorMessage("HTTP/1.1 502 Bad Gateway"), 502);
  assert.equal(parseStatusFromErrorMessage("rate limit exceeded with status 429"), 429);
  assert.equal(parseStatusFromErrorMessage("error 500 from upstream"), 500);
});

test("parseStatusFromErrorMessage ignores unrelated 3-digit numbers", () => {
  assert.equal(parseStatusFromErrorMessage("429 tokens remaining in context window"), undefined);
  assert.equal(parseStatusFromErrorMessage("processed 404 items before retry"), undefined);
  assert.equal(parseStatusFromErrorMessage("model returned 200 words of output"), undefined);
});
