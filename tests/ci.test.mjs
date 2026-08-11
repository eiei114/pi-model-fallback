import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ciYaml = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("ci workflow does not install Bun without running it", () => {
  const usesBun = /uses:\s*oven-sh\/setup-bun/.test(ciYaml);
  const runsBun = /run:.*\bbun\b/.test(ciYaml);
  assert.equal(
    usesBun && !runsBun,
    false,
    "setup-bun is present but no workflow step runs bun",
  );
});
