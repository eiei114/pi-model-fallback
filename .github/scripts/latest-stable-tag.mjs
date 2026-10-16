import { execFileSync } from "node:child_process";

const stableVersionTag = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const tags = execFileSync("git", ["tag", "--sort=-version:refname"], {
  encoding: "utf8",
});
const latestStableTag = tags.split(/\r?\n/).find((tag) => stableVersionTag.test(tag));

if (latestStableTag) {
  process.stdout.write(`${latestStableTag}\n`);
}
