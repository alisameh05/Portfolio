#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildInventory } from "./check-route-inventory.mjs";
import { buildRuntimeBoundary } from "./check-runtime-boundary.mjs";
import { inspectRuntimeArchitecture } from "./check-runtime-architecture.mjs";
import {
  EXPECTED_OWNER_OPERATIONS,
  EXPECTED_PUBLIC_OPERATIONS,
  HISTORICAL_RESTRICTIONS,
  PHASE4_ALLOWED_ACTIVATION,
  PHASE5_ALLOWED_ACTIVATION,
  PHASES,
  allowedActivationsFor,
  getPhaseContext,
} from "./phase-context.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, "evidence", "phase-5-context.json");

function revision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return "unknown"; }
}

export function runPhase5Context(root = ROOT, env = process.env) {
  const failures = [];
  let phase = "unknown";
  try { phase = getPhaseContext(env); } catch (error) { failures.push(error instanceof Error ? error.message : "invalid phase context"); }
  if (phase !== PHASES.PHASE5) failures.push(`Phase context must be phase5 for current checks, found ${phase}`);

  const inventory = buildInventory();
  if (inventory.publicOperations.length !== EXPECTED_PUBLIC_OPERATIONS) failures.push(`Expected ${EXPECTED_PUBLIC_OPERATIONS} public operations, found ${inventory.publicOperations.length}`);
  if (inventory.ownerOperations.length !== EXPECTED_OWNER_OPERATIONS) failures.push(`Expected ${EXPECTED_OWNER_OPERATIONS} Owner operations, found ${inventory.ownerOperations.length}`);
  if (inventory.forbiddenFindings.length !== 0) failures.push(`${inventory.forbiddenFindings.length} forbidden route/source findings`);

  const boundary = buildRuntimeBoundary(root);
  if (boundary.verdict !== "pass") failures.push("Runtime boundary verdict is not pass");
  const architecture = inspectRuntimeArchitecture(root);
  if (architecture.verdict !== "pass") failures.push("Runtime architecture verdict is not pass");

  const currentActivation = allowedActivationsFor(PHASES.PHASE5);
  if (JSON.stringify(currentActivation) !== JSON.stringify(PHASE5_ALLOWED_ACTIVATION)) failures.push("Phase 5 current activation policy drifted");
  if (JSON.stringify(allowedActivationsFor(PHASES.PHASE4)) !== JSON.stringify(PHASE4_ALLOWED_ACTIVATION)) failures.push("Phase 4 historical activation policy changed");
  if (!HISTORICAL_RESTRICTIONS.phase2 || !HISTORICAL_RESTRICTIONS.phase3) failures.push("Historical Phase 2/3 restrictions are missing");

  return {
    phase,
    failures,
    operations: {
      public: inventory.publicOperations.length,
      owner: inventory.ownerOperations.length,
      forbiddenFindings: inventory.forbiddenFindings.length,
    },
    runtimeBoundary: boundary.verdict,
    runtimeArchitecture: architecture.verdict,
    historicalPolicies: {
      phase2: HISTORICAL_RESTRICTIONS.phase2,
      phase3: HISTORICAL_RESTRICTIONS.phase3,
      phase4Activation: [...PHASE4_ALLOWED_ACTIVATION],
    },
    currentActivation: currentActivation,
  };
}

function main() {
  const phaseEnv = { ...process.env, SHIPWITHALI_PHASE: process.env.SHIPWITHALI_PHASE ?? PHASES.PHASE5 };
  const result = runPhase5Context(ROOT, phaseEnv);
  const report = {
    schemaVersion: 1,
    ticket: 107,
    parent: 106,
    runId: randomUUID(),
    sourceRevision: revision(),
    scope: "phase-5-verification-context",
    verdict: result.failures.length === 0 ? "pass" : "fail",
    scenarioAcceptance: false,
    ...result,
    guarantees: {
      predecessor: "Phase 3 gate #55 and Phase 4 gate #90 are planning prerequisites; this command does not claim they ran in this invocation",
      current: "Phase 5 may activate Content and Publishing plus Taxonomy and Discovery only",
      publicBoundary: "five public and thirty-nine Owner HTTP operations remain unchanged",
      laterPhaseLimits: "no Lab/frontend executable surface, provider leakage, or extra public route is admitted",
    },
  };
  mkdirSync(join(ROOT, "evidence"), { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  if (report.verdict === "pass") {
    console.log(`✓ Phase 5 verification context: ${report.operations.public} public + ${report.operations.owner} Owner operations, runtime seams preserved`);
    console.log(JSON.stringify({ runId: report.runId, sourceRevision: report.sourceRevision, evidence: "evidence/phase-5-context.json", scenarioAcceptance: false }));
    return 0;
  }
  for (const failure of report.failures) console.error(`✗ Phase 5 context: ${failure}`);
  return 1;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/check-phase5-context.mjs")) process.exitCode = main();
