import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/auto-release.yml"), "utf8");
const triggerBlock = workflow.split(/^permissions:/m, 1)[0];

test("releases have no automatic push trigger and require explicit dispatch authorization", () => {
  const triggers = [...triggerBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
  assert.deepEqual(triggers, ["workflow_dispatch"]);
  assert.match(workflow, /^      release_authorized:\r?\n        description: .+\r?\n        required: true\r?\n        type: boolean\r?\n        default: false$/m);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main' && inputs\.release_authorized == true$/m);
});

test("manual release compares package version against the latest release tag", () => {
  assert.match(workflow, /PREVIOUS_TAG=\$\(git tag --sort=-version:refname \| head -1\)/);
  assert.match(workflow, /git show "\$\{PREVIOUS_TAG\}:package\.json"/);
  assert.doesNotMatch(workflow, /github\.event\.before/);
});
