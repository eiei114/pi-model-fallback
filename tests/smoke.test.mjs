import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("package declares extension-only pi resources", () => {
  assert.deepEqual(packageJson.pi, { extensions: ["./extensions"] });
  assert.equal(packageJson.pi.skills, undefined);
  assert.equal(packageJson.pi.prompts, undefined);
  assert.equal(packageJson.pi.themes, undefined);
});

test("package metadata points at pi-model-fallback", () => {
  assert.equal(packageJson.name, "pi-model-fallback");
  assert.ok(packageJson.keywords.includes("pi-package"));
  assert.match(packageJson.repository.url, /eiei114\/pi-model-fallback/);
});

test("package uses public publish config", () => {
  assert.equal(packageJson.publishConfig.access, "public");
});
