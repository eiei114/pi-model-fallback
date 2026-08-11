import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ciYaml = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

const BUN_SETUP_USES = "oven-sh/setup-bun";
const BUN_COMMAND_RE = /(?:^|[|;&]\s*)bun(?:\s|$)/;

function readBlockScalar(lines, startIndex, contentIndent = 8) {
  const blockLines = [];
  let index = startIndex;
  const indentPrefix = " ".repeat(contentIndent);

  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "") {
      blockLines.push("");
      index += 1;
      continue;
    }
    if (!line.startsWith(indentPrefix)) {
      break;
    }
    blockLines.push(line.slice(contentIndent));
    index += 1;
  }

  return { value: blockLines.join("\n"), nextIndex: index };
}

function assignRunBlockScalar(step, lines, startIndex) {
  const block = readBlockScalar(lines, startIndex);
  step.run = block.value;
  return block.nextIndex;
}

function parseWorkflowJobs(yaml) {
  const lines = yaml.split("\n");
  const jobs = [];
  let index = 0;

  while (index < lines.length && lines[index] !== "jobs:") {
    index += 1;
  }
  index += 1;

  while (index < lines.length) {
    const jobMatch = lines[index].match(/^  ([\w-]+):$/);
    if (!jobMatch) {
      break;
    }

    const jobName = jobMatch[1];
    const steps = [];
    index += 1;

    while (index < lines.length && (lines[index].startsWith("    ") || lines[index].trim() === "")) {
      if (lines[index] === "    steps:") {
        index += 1;
        while (index < lines.length && lines[index].startsWith("      - ")) {
          const parsedStep = parseStep(lines, index);
          steps.push(parsedStep.step);
          index = parsedStep.nextIndex;
        }
      } else {
        index += 1;
      }
    }

    jobs.push({ name: jobName, steps });
  }

  return jobs;
}

function parseStep(lines, startIndex) {
  const step = {};
  let index = startIndex;
  const firstLine = lines[index].slice(8);

  if (firstLine.includes(":")) {
    const colonIndex = firstLine.indexOf(":");
    const key = firstLine.slice(0, colonIndex).trim();
    const value = firstLine.slice(colonIndex + 1).trim();
    if (key === "uses") {
      step.uses = value;
      index += 1;
    } else if (key === "run") {
      if (value === "|" || value === ">") {
        index = assignRunBlockScalar(step, lines, startIndex + 1);
      } else {
        step.run = value;
        index += 1;
      }
    } else {
      index += 1;
    }
  } else {
    index += 1;
  }

  while (index < lines.length && lines[index].startsWith("      ")) {
    const line = lines[index].slice(6);
    if (line.startsWith("- ")) {
      break;
    }

    if (line.includes(":")) {
      const colonIndex = line.indexOf(":");
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();

      if (key === "run" && (value === "" || value === "|" || value === ">")) {
        index = assignRunBlockScalar(step, lines, index + 1);
        continue;
      }

      if (key === "run" || key === "uses") {
        step[key] = value;
      }
    }

    index += 1;
  }

  return { step, nextIndex: index };
}

function stepUsesBunSetup(step) {
  return typeof step.uses === "string" && step.uses.includes(BUN_SETUP_USES);
}

function stepRunsBunCommand(step) {
  if (typeof step.run !== "string") {
    return false;
  }

  return step.run
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .some((line) => {
      if (/^(echo|npm|pnpm|yarn)\b/.test(line)) {
        return false;
      }
      if (/\b(npm|pnpm|yarn)\s+(install|i|add)\b.*\bbun\b/.test(line)) {
        return false;
      }
      return BUN_COMMAND_RE.test(line);
    });
}

function findJobsWithUnusedBunSetup(yaml) {
  return parseWorkflowJobs(yaml).flatMap((job) => {
    const usesBunSetup = job.steps.some(stepUsesBunSetup);
    const runsBun = job.steps.some(stepRunsBunCommand);
    return usesBunSetup && !runsBun ? [job.name] : [];
  });
}

test("ci workflow does not install Bun without running it", () => {
  const jobsWithUnusedBunSetup = findJobsWithUnusedBunSetup(ciYaml);
  assert.deepEqual(
    jobsWithUnusedBunSetup,
    [],
    `setup-bun is present without a bun command in jobs: ${jobsWithUnusedBunSetup.join(", ")}`,
  );
});

test("workflow parser recognizes hyphenated job ids", () => {
  const yaml = `
jobs:
  ci-test:
    steps:
      - uses: oven-sh/setup-bun@v2
      - run: npm test
`;

  assert.deepEqual(findJobsWithUnusedBunSetup(yaml), ["ci-test"]);
});

test("workflow parser reads multiline run block scalars", () => {
  const yaml = `
jobs:
  ci-test:
    steps:
      - uses: oven-sh/setup-bun@v2
      - run: |
          bun test
          echo done
`;

  assert.deepEqual(findJobsWithUnusedBunSetup(yaml), []);
});
