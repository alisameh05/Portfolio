#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
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

/** Check the real Linux engine before any gate can overwrite acceptance evidence. */
export function requireQualificationDocker(probe = spawnSync) {
  const options = { cwd: ROOT, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true };
  const engine = probe("docker", ["info", "--format", "{{.OSType}}"], options);
  if (engine.error?.code === "ENOENT") {
    throw new Error("PHASE8_DOCKER_MISSING: Docker is not on PATH. Run qualification on a Docker-capable host; a Node-only cloud runner cannot run real-service gates.");
  }
  if (engine.error || engine.status !== 0) {
    throw new Error("PHASE8_DOCKER_UNAVAILABLE: Start the Linux Docker engine and allow this process to access it, then rerun qualification.");
  }
  if (String(engine.stdout ?? "").trim() !== "linux") {
    throw new Error("PHASE8_DOCKER_LINUX_REQUIRED: Switch Docker Desktop to Linux containers before qualification.");
  }
  const compose = probe("docker", ["compose", "version"], options);
  if (compose.error || compose.status !== 0) {
    throw new Error("PHASE8_DOCKER_COMPOSE_REQUIRED: Install the Docker Compose plugin or Docker Desktop before qualification.");
  }
}

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
export async function qualifyPrerequisites({ checkEnvironment = requireQualificationDocker, getIdentity = identity, run = execute, log = console.log } = {}) {
  try { checkEnvironment(); }
  catch (error) { log(error.message); return 1; }
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
