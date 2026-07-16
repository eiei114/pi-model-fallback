import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const usageMd = await readFile(new URL("../docs/usage.md", import.meta.url), "utf8");

test("usage docs avoid stale version-specific replay wording", () => {
  assert.doesNotMatch(usageMd, /v0\.1\.0/);
  assert.doesNotMatch(usageMd, /replayed in v\d/i);
  assert.match(usageMd, /not automatically replayed/i);
});
