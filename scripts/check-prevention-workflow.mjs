#!/usr/bin/env node
// Semantic, fail-closed validation of the required regression workflow.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import YAML from "yaml";
import { readFileSync as readPackageFile } from "node:fs";
import { REQUIRED_REGRESSION_TESTS } from "./run-validation-evolution-tests.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PREVENTION_WORKFLOW = ".github/workflows/validation-evolution-regressions.yml";
export const PR_VALIDATION_WORKFLOW = ".github/workflows/pr-validation.yml";
export const QUALIFICATION_WORKFLOW = ".github/workflows/phase3-7-qualification.yml";
export const REQUIRED_REGRESSION_TEST_COUNT = 34;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const normalizeRun = (value) => String(value ?? "").replaceAll("\r\n", "\n").trim();
const owns = (object, key) => Object.hasOwn(object ?? {}, key);
const exactKeys = (object, keys) => JSON.stringify(Object.keys(object ?? {}).sort()) === JSON.stringify([...keys].sort());
const EXPECTED_AGGREGATE_RUN = `node -e "process.exitCode = process.env.EVOLUTION_RESULTS !== 'success' || process.env.SELFCHECK_RESULTS !== 'success' ? 1 : 0"`;
const EXPECTED_CONTINUATION_SCAN = `node - <<'NODE'
import { readFileSync } from "node:fs";
const source = readFileSync(".github/workflows/validation-evolution-regressions.yml", "utf8");
if (/^\\s*continue-on-error:/mu.test(source)) {
  throw new Error("PREVENTION_WORKFLOW_ERROR_CONTINUING_KEY_PRESENT");
}
console.log("prevention workflow contains no error-continuing keys");
NODE`;

export function validatePreventionWorkflow(workflow) {
  const failures = [];
  if (!isObject(workflow)) return ["PREVENTION_WORKFLOW_INVALID_YAML"];
  const triggers = workflow.on ?? workflow.true;
  for (const name of ["pull_request", "merge_group", "workflow_dispatch"]) {
    if (!Object.hasOwn(triggers ?? {}, name)) failures.push(`PREVENTION_WORKFLOW_TRIGGER_MISSING:${name}`);
  }
  if (JSON.stringify(triggers?.pull_request?.branches ?? []) !== JSON.stringify(["master"])) {
    failures.push("PREVENTION_WORKFLOW_MASTER_SCOPE_INVALID");
  }
  if (Object.hasOwn(triggers?.pull_request ?? {}, "paths") || Object.hasOwn(triggers?.pull_request ?? {}, "paths-ignore")) {
    failures.push("PREVENTION_WORKFLOW_PATHS_FILTER_PRESENT");
  }
  const jobs = workflow.jobs;
  const mandatory = ["evolution-regressions", "prevention-workflow-selfcheck", "validation-evolution-regressions"];
  for (const id of mandatory) if (!Object.hasOwn(jobs ?? {}, id)) failures.push(`PREVENTION_WORKFLOW_JOB_MISSING:${id}`);
  for (const job of Object.values(jobs ?? {})) {
    if (!isObject(job)) continue;
    if (owns(job, "continue-on-error") && job["continue-on-error"] !== false) failures.push("PREVENTION_WORKFLOW_CONTINUE_ON_ERROR_PRESENT");
    for (const step of job.steps ?? []) {
      if (owns(step, "continue-on-error") && step["continue-on-error"] !== false) failures.push("PREVENTION_WORKFLOW_CONTINUE_ON_ERROR_PRESENT");
    }
  }
  const evolution = jobs?.["evolution-regressions"];
  const prHeadRef = "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
  for (const id of ["evolution-regressions", "prevention-workflow-selfcheck"]) {
    const checkouts = (jobs?.[id]?.steps ?? []).filter((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"));
    if (checkouts.length !== 1 || checkouts[0]?.with?.ref !== prHeadRef) failures.push(`PREVENTION_WORKFLOW_CURRENT_HEAD_CHECKOUT_INVALID:${id}`);
  }
  const requireDirectStep = (job, stepName, command, failureCode) => {
    if (!isObject(job) || owns(job, "if") || !Array.isArray(job.steps) || job.steps.some((step) => owns(step, "if"))) { failures.push(failureCode); return; }
    const matching = job.steps.filter((step) => step?.name === stepName);
    if (matching.length !== 1) { failures.push(failureCode); return; }
    const [step] = matching;
    if (normalizeRun(step.run) !== command || !exactKeys(step, ["name", "run"]) || owns(step, "if")) failures.push(failureCode);
  };
  requireDirectStep(evolution, "Validation-evolution registry and DAG tests", "npm run test:validation-evolution", "PREVENTION_WORKFLOW_TESTS_NOT_WIRED");
  requireDirectStep(evolution, "Prevention workflow configuration self-check", "npm run check:prevention-workflow", "PREVENTION_WORKFLOW_SELF_CHECK_NOT_WIRED");
  requireDirectStep(jobs?.["prevention-workflow-selfcheck"], "Check prevention workflow configuration", "npm run check:prevention-workflow", "PREVENTION_WORKFLOW_SELF_CHECK_NOT_WIRED");
  requireDirectStep(jobs?.["prevention-workflow-selfcheck"], "Fail on error-continuing keys", EXPECTED_CONTINUATION_SCAN, "PREVENTION_WORKFLOW_ERROR_CONTINUATION_SCAN_MISSING");
  const packageJson = JSON.parse(readPackageFile(join(ROOT, "package.json"), "utf8"));
  if (packageJson.scripts?.["test:validation-evolution"] !== "node scripts/run-validation-evolution-tests.mjs") {
    failures.push("PREVENTION_WORKFLOW_TEST_RUNNER_NOT_PINNED");
  }
  if (REQUIRED_REGRESSION_TESTS.length !== REQUIRED_REGRESSION_TEST_COUNT) failures.push("PREVENTION_WORKFLOW_TEST_INVENTORY_MISSING");
  const aggregate = jobs?.["validation-evolution-regressions"];
  if (aggregate?.name !== "validation-evolution-regressions" || aggregate?.if !== "always()") failures.push("PREVENTION_WORKFLOW_AGGREGATOR_NOT_ALWAYS");
  const needs = Array.isArray(aggregate?.needs) ? aggregate.needs : [aggregate?.needs].filter(Boolean);
  for (const id of mandatory.slice(0, 2)) {
    if (!needs.includes(id)) failures.push(`PREVENTION_WORKFLOW_AGGREGATOR_NEEDS_MISSING:${id}`);
  }
  const aggregateSteps = aggregate?.steps ?? [];
  const aggregateStep = aggregateSteps[0];
  const aggregateRun = normalizeRun(aggregateStep?.run);
  const aggregateEnv = aggregateStep?.env ?? {};
  if (needs.length !== mandatory.length - 1 || [...needs].sort().join("\n") !== [...mandatory.slice(0, 2)].sort().join("\n")) failures.push("PREVENTION_WORKFLOW_AGGREGATOR_DEPENDENCIES_INVALID");
  if (aggregateSteps.length !== 1 || aggregateStep?.name !== "Aggregate validation-evolution results" ||
      !exactKeys(aggregateStep, ["name", "env", "run"]) || Object.keys(aggregateEnv).sort().join("\n") !== ["EVOLUTION_RESULTS", "SELFCHECK_RESULTS"].sort().join("\n")) {
    failures.push("PREVENTION_WORKFLOW_AGGREGATOR_STRUCTURE_INVALID");
  }
  if (aggregateEnv.EVOLUTION_RESULTS !== "${{ needs.evolution-regressions.result }}" ||
      aggregateEnv.SELFCHECK_RESULTS !== "${{ needs.prevention-workflow-selfcheck.result }}") failures.push("PREVENTION_WORKFLOW_AGGREGATOR_WIRING_INVALID");
  for (const id of mandatory.slice(0, 2)) {
    const variable = id === "evolution-regressions" ? "EVOLUTION_RESULTS" : "SELFCHECK_RESULTS";
    const linked = aggregateEnv[variable] === `\${{ needs.${id}.result }}` && aggregateRun.includes(`process.env.${variable}`);
    if (!needs.includes(id) || !linked) failures.push(`PREVENTION_WORKFLOW_AGGREGATOR_JOB_NOT_FAILED_ON:${id}`);
  }
  if (aggregateRun !== EXPECTED_AGGREGATE_RUN) failures.push("PREVENTION_WORKFLOW_AGGREGATOR_NOT_STRICT_SUCCESS");
  return [...new Set(failures)];
}

export function validatePreventionWorkflowSource(source) {
  let parsed;
  try { parsed = YAML.parse(source); }
  catch { return ["PREVENTION_WORKFLOW_INVALID_YAML"]; }
  return validatePreventionWorkflow(parsed);
}

/** Standalone Phase 6 acceptance needs a fresh Phase 5 gate in the same checkout. */
export function validatePhase6PrerequisiteWorkflowSource(source) {
  let workflow;
  try { workflow = YAML.parse(source); } catch { return ["PHASE6_PREDECESSOR_WORKFLOW_INVALID_YAML"]; }
  const job = workflow?.jobs?.["phase6-media-cv"];
  const steps = job?.steps;
  if (!isObject(job) || !Array.isArray(steps) || owns(job, "if") ||
      (owns(job, "continue-on-error") && job["continue-on-error"] !== false) ||
      owns(workflow, "defaults") || owns(job, "defaults")) return ["PHASE6_PREDECESSOR_WORKFLOW_NOT_REQUIRED"];
  const commands = ["npm run setup:validation", "npm run phase5:gate", "npm run phase6:gate"];
  const positions = commands.map((command) => {
    const matches = steps.flatMap((step, index) => normalizeRun(step?.run) === command ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  });
  if (positions.some((index) => index < 0) || positions[0] >= positions[1] || positions[1] >= positions[2]) {
    return ["PHASE6_FRESH_PHASE5_PREDECESSOR_NOT_WIRED"];
  }
  const [setup, predecessor, gate] = positions.map((index) => steps[index]);
  if (!exactKeys(setup, ["name", "run"]) || !exactKeys(predecessor, ["name", "run"]) ||
      owns(gate, "if") || owns(gate, "working-directory") || owns(gate, "shell") ||
      (owns(gate, "continue-on-error") && gate["continue-on-error"] !== false) ||
      steps.slice(positions[0] + 1, positions[2]).some((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"))) {
    return ["PHASE6_FRESH_PHASE5_PREDECESSOR_NOT_REQUIRED"];
  }
  return [];
}

/** Hosted native gates must use the verified supported server, never the image default. */
export function validateNativePostgresWorkflowSource(source, jobId, gateCommand) {
  let workflow;
  try { workflow = YAML.parse(source); } catch { return ["NATIVE_POSTGRES_WORKFLOW_INVALID_YAML"]; }
  const job = workflow?.jobs?.[jobId], steps = job?.steps;
  if (!isObject(job) || !Array.isArray(steps) || job["runs-on"] !== "ubuntu-24.04" || owns(job, "if") ||
      (owns(job, "continue-on-error") && job["continue-on-error"] !== false) || owns(workflow, "defaults") || owns(job, "defaults") ||
      owns(workflow?.env, "PHASE7_POSTGRES_BIN") || owns(job?.env, "PHASE7_POSTGRES_BIN")) return ["NATIVE_POSTGRES_WORKFLOW_NOT_REQUIRED"];
  const positions = ["node scripts/setup-ci-native-postgres.mjs", gateCommand].map((command) => {
    const matches = steps.flatMap((step, index) => normalizeRun(step?.run) === command ? [index] : []);
    return matches.length === 1 ? matches[0] : -1;
  });
  if (positions.some((index) => index < 0) || positions[0] >= positions[1]) return ["NATIVE_POSTGRES_SETUP_NOT_WIRED"];
  const setup = steps[positions[0]], gate = steps[positions[1]];
  if (!exactKeys(setup, ["name", "run"]) || owns(gate, "if") || owns(gate, "working-directory") || owns(gate, "shell") ||
      (owns(gate, "continue-on-error") && gate["continue-on-error"] !== false) ||
      steps.slice(positions[0]).some((step) => owns(step?.env, "PHASE7_POSTGRES_BIN")) ||
      steps.slice(positions[0] + 1, positions[1]).some((step) => typeof step?.uses === "string" && step.uses.startsWith("actions/checkout@"))) {
    return ["NATIVE_POSTGRES_SETUP_NOT_REQUIRED"];
  }
  return [];
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/check-prevention-workflow.mjs")) {
  const failures = [...validatePreventionWorkflowSource(readFileSync(join(ROOT, PREVENTION_WORKFLOW), "utf8")),
    ...validatePhase6PrerequisiteWorkflowSource(readFileSync(join(ROOT, PR_VALIDATION_WORKFLOW), "utf8")),
    ...validateNativePostgresWorkflowSource(readFileSync(join(ROOT, PR_VALIDATION_WORKFLOW), "utf8"), "validation", "npm run phase7:focus:consent"),
    ...validateNativePostgresWorkflowSource(readFileSync(join(ROOT, QUALIFICATION_WORKFLOW), "utf8"), "phase3-7-qualification", "npm run phase8:qualify")];
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ ${failure}`);
    process.exitCode = 1;
  } else console.log("✓ prevention workflow configuration matches the validation-evolution contract.");
}
