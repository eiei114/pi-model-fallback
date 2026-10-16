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

test("Pi SDK devDependencies are pinned to the verified 1.2.0 wave", () => {
  const expected = {
    "@earendil-works/pi-agent-core": "1.2.0",
    "@earendil-works/pi-ai": "1.2.0",
    "@earendil-works/pi-coding-agent": "1.2.0",
    "@earendil-works/pi-tui": "1.2.0",
  };

  for (const [name, version] of Object.entries(expected)) {
    assert.equal(packageJson.devDependencies?.[name], version, `${name} must be an exact 1.2.0 dev/test pin`);
  }
});
