import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const usageMd = await readFile(new URL("../docs/usage.md", import.meta.url), "utf8");
const contributingMd = await readFile(new URL("../CONTRIBUTING.md", import.meta.url), "utf8");
const changelogMd = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("usage docs avoid stale version-specific replay wording", () => {
  assert.doesNotMatch(usageMd, /v0\.1\.0/);
  assert.doesNotMatch(usageMd, /replayed in v\d/i);
  assert.match(usageMd, /not automatically replayed/i);
});

function parseChangelogSections(markdown) {
  const sections = [];
  let current = null;

  for (const line of markdown.split("\n")) {
    const versionMatch = line.match(/^## (?:\[(.+?)\] - (.+)|(\d+\.\d+\.\d+)|Unreleased)$/);
    if (versionMatch) {
      current = {
        version: versionMatch[1] ?? versionMatch[3] ?? "Unreleased",
        date: versionMatch[2] ?? null,
        headings: [],
      };
      sections.push(current);
      continue;
    }

    const headingMatch = line.match(/^### (.+)$/);
    if (headingMatch && current) {
      current.headings.push(headingMatch[1]);
    }
  }

  return sections;
}

test("changelog avoids placeholder dates and duplicate section headings", () => {
  assert.doesNotMatch(changelogMd, /YYYY-MM-DD/);

  for (const section of parseChangelogSections(changelogMd)) {
    const duplicates = section.headings.filter((heading, index) => section.headings.indexOf(heading) !== index);
    assert.deepEqual(
      duplicates,
      [],
      `CHANGELOG [${section.version}] repeats section headings: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
});

test("changelog latest release matches package version", () => {
  const releasedSections = parseChangelogSections(changelogMd).filter((section) => section.version !== "Unreleased");
  assert.ok(releasedSections.length > 0, "CHANGELOG should include at least one released version");
  assert.equal(
    releasedSections[0].version,
    packageJson.version,
    "top released CHANGELOG entry should match package.json version",
  );
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
