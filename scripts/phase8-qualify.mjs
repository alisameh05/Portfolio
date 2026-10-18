#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { sourceMetadataAtRevision } from "./phase8-prerequisite-qualification.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const QUALIFICATION_STEPS = Object.freeze([
  ["validation environment", "scripts/validation-environment.mjs"],
  ["Phase 3", "scripts/phase3-gate.mjs"],
  ["Phase 4", "scripts/phase4-gate.mjs"],
  ["Phase 5", "scripts/phase5-gate.mjs"],
  ["Phase 6", "scripts/docker-validation.mjs", "gate"],
  ["Phase 7", "scripts/phase7-gate.mjs"],
  ["prerequisite qualification", "scripts/phase8-prerequisite-qualification.mjs"],
].map(Object.freeze));

function identity() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  return { revision, tree: workingTreeSourceSha256(), committedTree: sourceMetadataAtRevision(ROOT, revision).sourceTreeSha256 };
}

function execute([, script, ...args]) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: "inherit", windowsHide: true });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/** Regenerate all evidence on one committed source tree; never reuse a failed gate. */
export async function qualifyPrerequisites({ getIdentity = identity, run = execute, log = console.log } = {}) {
  const expected = getIdentity();
  if (expected.tree !== expected.committedTree) {
    log("Commit the final source changes before qualification. Evidence files may remain uncommitted.");
    return 1;
  }
  log(`Qualifying Phases 3–7 at ${expected.revision}; source ${expected.tree}.`);
  for (const step of QUALIFICATION_STEPS) {
    const before = getIdentity();
    if (before.revision !== expected.revision || before.tree !== expected.tree) {
      log("Source changed during qualification. Restart npm run phase8:qualify after committing the final source.");
      return 1;
    }
    log(`Running ${step[0]}.`);
    const result = await run(step);
    if (result !== 0) {
      log(`${step[0]} failed. Resolve its reported failure, then rerun npm run phase8:qualify.`);
      return Number.isInteger(result) && result > 0 && result < 256 ? result : 1;
    }
    const after = getIdentity();
    if (after.revision !== expected.revision || after.tree !== expected.tree) {
      log("Source changed during qualification. Restart npm run phase8:qualify after committing the final source.");
      return 1;
    }
  }
  return 0;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase8-qualify.mjs")) {
  try { process.exitCode = await qualifyPrerequisites(); }
  catch (error) { console.error(`Qualification could not run: ${error.message}`); process.exitCode = 1; }
}
