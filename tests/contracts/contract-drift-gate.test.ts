import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const checkerPath = "scripts/check-contract-drift.mjs";
const artifacts = [
  "openapi/generated/public-v1.json",
  "openapi/generated/owner-v1.json",
  "src/contracts/http/v1/generated/index.ts",
  "src/contracts/http/v1/generated/types.gen.ts",
  "src/contracts/http/v1/generated/zod.gen.ts",
  "src/contracts/http/owner/v1/generated/index.ts",
  "src/contracts/http/owner/v1/generated/types.gen.ts",
  "src/contracts/http/owner/v1/generated/zod.gen.ts",
];
const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) =>
    rmSync(directory, { recursive: true, force: true }),
  );
});

function artifactTree(content = "generated\n") {
  const root = mkdtempSync(join(tmpdir(), "shipwithali-drift-"));
  temporaryDirectories.push(root);
  for (const artifact of artifacts) {
    const path = join(root, artifact);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${artifact}:${content}`);
  }
  return root;
}

function runDrift(committedRoot: string, candidateA: string, candidateB: string) {
  return spawnSync(
    process.execPath,
    [
      checkerPath,
      "--skip-generate",
      "--committed-root",
      committedRoot,
      "--candidate-a",
      candidateA,
      "--candidate-b",
      candidateB,
    ],
    { encoding: "utf8" },
  );
}

describe("contract artifact drift gate", () => {
  it("accepts two deterministic generations that match committed artifacts", () => {
    const committed = artifactTree();
    const candidateA = artifactTree();
    const candidateB = artifactTree();

    const result = runDrift(committed, candidateA, candidateB);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("byte-for-byte deterministic");
  });

  it("rejects a manual edit, stale output, or uncommitted regeneration", () => {
    const committed = artifactTree();
    const candidateA = artifactTree();
    const candidateB = artifactTree();
    writeFileSync(join(committed, artifacts[3]!), "hand edited\n");

    const result = runDrift(committed, candidateA, candidateB);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("committed artifact drift");
    expect(`${result.stdout}\n${result.stderr}`).toContain(artifacts[3]);
  });

  it("rejects a missing generated file", () => {
    const committed = artifactTree();
    const candidateA = artifactTree();
    const candidateB = artifactTree();
    const missingRoot = mkdtempSync(join(tmpdir(), "shipwithali-drift-missing-"));
    temporaryDirectories.push(missingRoot);
    for (const artifact of artifacts.slice(1)) {
      const path = join(missingRoot, artifact);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${artifact}:generated\n`);
    }

    const result = runDrift(committed, missingRoot, candidateB);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("missing artifact");
    expect(`${result.stdout}\n${result.stderr}`).toContain(artifacts[0]);
  });

  it("rejects nondeterministic clean generation", () => {
    const committed = artifactTree();
    const candidateA = artifactTree();
    const candidateB = artifactTree();
    writeFileSync(join(candidateB, artifacts[6]!), "different ordering\n");

    const result = runDrift(committed, candidateA, candidateB);

    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("nondeterministic generation");
    expect(`${result.stdout}\n${result.stderr}`).toContain(artifacts[6]);
  });
});
