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
  assert.match(releaseSection, /npm version patch --no-git-tag-version/);
  assert.match(releaseSection, /git add package\.json package-lock\.json/);
  assert.match(releaseSection, /git commit/);
  const commitIndex = releaseSection.indexOf("git commit");
  const pushIndex = releaseSection.indexOf("git push");
  assert.ok(commitIndex !== -1 && pushIndex !== -1 && commitIndex < pushIndex);
});
