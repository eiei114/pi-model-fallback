import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/auto-release.yml"), "utf8");
const stableTagScript = resolve(root, ".github/scripts/latest-stable-tag.mjs");
const triggerBlock = workflow.split(/^permissions:/m, 1)[0];

test("releases have no automatic push trigger and require explicit dispatch authorization", () => {
  const triggers = [...triggerBlock.matchAll(/^  ([a-z_]+):/gm)].map((match) => match[1]);
  assert.deepEqual(triggers, ["workflow_dispatch"]);
  assert.match(workflow, /^      release_authorized:\r?\n        description: .+\r?\n        required: true\r?\n        type: boolean\r?\n        default: false$/m);
  assert.match(workflow, /^    if: github\.ref == 'refs\/heads\/main' && inputs\.release_authorized == true$/m);
  assert.doesNotMatch(workflow, /github\.event_name == 'push'/);
});

test("manual release compares package version against the latest release tag", () => {
  assert.match(workflow, /^          PREVIOUS_TAG=\$\(node \.github\/scripts\/latest-stable-tag\.mjs\)$/m);
  assert.match(workflow, /^          PREV_TAG=\$\(node \.github\/scripts\/latest-stable-tag\.mjs\)$/m);
  assert.equal([...workflow.matchAll(/node \.github\/scripts\/latest-stable-tag\.mjs/g)].length, 2);
  assert.doesNotMatch(workflow, /git tag --sort=-version:refname \| head -1/);
  assert.match(workflow, /git show "\$\{PREVIOUS_TAG\}:package\.json"/);
  assert.doesNotMatch(workflow, /github\.event\.before/);
});

function createTaggedRepository(tags) {
  const directory = mkdtempSync(resolve(tmpdir(), "pi-model-fallback-release-tags-"));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Release Workflow Test",
      "-c",
      "user.email=release-workflow-test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "initial commit",
    ],
    { cwd: directory, stdio: "ignore" },
  );
  for (const tag of tags) {
    execFileSync("git", ["tag", tag], { cwd: directory });
  }
  return directory;
}

test("stable release tag selection excludes prereleases and picks the newest stable tag", () => {
  const directory = createTaggedRepository([
    "v1.2.0",
    "v1.9.9",
    "v2.0.0-rc.1",
    "v9.0.0-alpha.1",
    "v10.0",
    "v11.0.0suffix",
    "x12.0.0",
  ]);

  try {
    const selectedTag = execFileSync(process.execPath, [stableTagScript], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    assert.equal(selectedTag, "v1.9.9");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test("stable release tag selection returns no baseline when only prereleases exist", () => {
  const directory = createTaggedRepository(["v1.2.3-rc.1", "v2.0.0-beta.1"]);

  try {
    const selectedTag = execFileSync(process.execPath, [stableTagScript], {
      cwd: directory,
      encoding: "utf8",
    }).trim();
    assert.equal(selectedTag, "");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});
