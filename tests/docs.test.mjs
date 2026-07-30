import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const usageMd = await readFile(new URL("../docs/usage.md", import.meta.url), "utf8");
const contributingMd = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");

test("usage docs avoid stale version-specific replay wording", () => {
  assert.doesNotMatch(usageMd, /v0\.1\.0/);
  assert.doesNotMatch(usageMd, /replayed in v\d/i);
  assert.match(usageMd, /not automatically replayed/i);
});

test("contributing release docs commit version bump before push", () => {
  const releaseSection = contributingMd.slice(contributingMd.indexOf("## Release"));
  const codeBlockMatch = releaseSection.match(/```bash\n([\s\S]*?)```/);
  assert.ok(codeBlockMatch, "release section should include a bash example");
  const releaseCommands = codeBlockMatch[1];

  assert.match(releaseSection, /Update `CHANGELOG\.md`/);
  assert.match(releaseCommands, /npm version patch --no-git-tag-version/);
  assert.match(
    releaseCommands,
    /git add package\.json package-lock\.json CHANGELOG\.md/,
  );
  assert.match(releaseCommands, /git commit/);
  assert.match(releaseCommands, /git push/);

  const versionIndex = releaseCommands.indexOf("npm version");
  const addIndex = releaseCommands.indexOf("git add");
  const commitIndex = releaseCommands.indexOf("git commit");
  const pushIndex = releaseCommands.indexOf("git push");
  assert.ok(
    versionIndex < addIndex &&
      addIndex < commitIndex &&
      commitIndex < pushIndex,
  );
});
