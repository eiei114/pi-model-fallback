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

test("pi devDependencies stay on the same release line", () => {
  const requiredPiPackages = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];

  const piVersions = requiredPiPackages.map((name) => {
    const version = packageJson.devDependencies?.[name];
    assert.ok(version, `missing devDependency ${name}`);
    return version.replace(/^[~^]/, "");
  });

  assert.ok(
    piVersions.every((version) => version === piVersions[0]),
    `pi devDependencies should share one version line, got: ${requiredPiPackages.map((name, index) => `${name}@${piVersions[index]}`).join(", ")}`,
  );
});
