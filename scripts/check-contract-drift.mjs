#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const ARTIFACT_ROOTS = [
  "openapi/generated",
  "src/contracts/http/v1/generated",
  "src/contracts/http/owner/v1/generated",
];
const EXPECTED_ARTIFACTS = [
  "openapi/generated/public-v1.json",
  "openapi/generated/owner-v1.json",
  "src/contracts/http/v1/generated/index.ts",
  "src/contracts/http/v1/generated/types.gen.ts",
  "src/contracts/http/v1/generated/zod.gen.ts",
  "src/contracts/http/owner/v1/generated/index.ts",
  "src/contracts/http/owner/v1/generated/types.gen.ts",
  "src/contracts/http/owner/v1/generated/zod.gen.ts",
];

function parseArguments(arguments_) {
  const options = { skipGenerate: false };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--skip-generate") {
      options.skipGenerate = true;
      continue;
    }
    if (argument.startsWith("--")) {
      options[argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] =
        arguments_[index + 1];
      index += 1;
    }
  }
  return options;
}

function filesUnder(root) {
  const files = [];
  function visit(directory) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else files.push(relative(root, path).replaceAll("\\", "/"));
    }
  }
  ARTIFACT_ROOTS.forEach((artifactRoot) => visit(resolve(root, artifactRoot)));
  return files.sort();
}

function artifactSetProblems(root) {
  const actual = filesUnder(root);
  const expected = new Set(EXPECTED_ARTIFACTS);
  const actualSet = new Set(actual);
  const problems = [];
  for (const artifact of EXPECTED_ARTIFACTS) {
    if (!actualSet.has(artifact)) problems.push(`missing artifact: ${artifact}`);
  }
  for (const artifact of actual) {
    if (!expected.has(artifact)) problems.push(`unexpected generated artifact: ${artifact}`);
  }
  return problems;
}

function differingArtifacts(leftRoot, rightRoot) {
  const differences = [];
  for (const artifact of EXPECTED_ARTIFACTS) {
    const leftPath = resolve(leftRoot, artifact);
    const rightPath = resolve(rightRoot, artifact);
    if (!existsSync(leftPath) || !existsSync(rightPath)) continue;
    if (!readFileSync(leftPath).equals(readFileSync(rightPath))) differences.push(artifact);
  }
  return differences;
}

function build(outputRoot) {
  execFileSync(process.execPath, ["scripts/generate-contract-artifacts.mjs", "--output-root", outputRoot], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

export function main(arguments_ = process.argv.slice(2)) {
  const options = parseArguments(arguments_);
  const temporaryRoots = [];
  const committedRoot = resolve(options.committedRoot ?? ROOT);
  let candidateA = options.candidateA && resolve(options.candidateA);
  let candidateB = options.candidateB && resolve(options.candidateB);

  try {
    if (!options.skipGenerate) {
      candidateA = mkdtempSync(join(tmpdir(), "shipwithali-contract-a-"));
      candidateB = mkdtempSync(join(tmpdir(), "shipwithali-contract-b-"));
      temporaryRoots.push(candidateA, candidateB);
      build(candidateA);
      build(candidateB);
    }

    if (!candidateA || !candidateB) {
      throw new Error("--candidate-a and --candidate-b are required with --skip-generate");
    }

    const setProblems = [
      ...artifactSetProblems(committedRoot).map((problem) => `committed ${problem}`),
      ...artifactSetProblems(candidateA).map((problem) => `generation A ${problem}`),
      ...artifactSetProblems(candidateB).map((problem) => `generation B ${problem}`),
    ];
    if (setProblems.length > 0) {
      setProblems.forEach((problem) => console.error(`✗ ${problem}`));
      return 1;
    }

    const nondeterministic = differingArtifacts(candidateA, candidateB);
    if (nondeterministic.length > 0) {
      nondeterministic.forEach((artifact) =>
        console.error(`✗ nondeterministic generation: ${artifact}`),
      );
      return 1;
    }

    const drift = differingArtifacts(committedRoot, candidateA);
    if (drift.length > 0) {
      drift.forEach((artifact) => console.error(`✗ committed artifact drift: ${artifact}`));
      return 1;
    }

    console.log("✓ both clean generations are byte-for-byte deterministic");
    console.log("✓ committed bundles and generated transport artifacts contain no drift");
    console.log("✓ generated output is limited to transport types and validators; no server stubs exist");
    return 0;
  } finally {
    for (const temporaryRoot of temporaryRoots) {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(`✗ contract drift check failed: ${error.message}`);
  process.exitCode = 1;
}
