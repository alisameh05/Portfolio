#!/usr/bin/env node
// Runs the fixed issue-267 regression inventory and rejects incomplete TAP
// outcomes that Node would otherwise report as a successful process exit.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const REQUIRED_DATABASE_SECURITY_TESTS = Object.freeze([
  "Phase 4 migration integrity compares migration role memberships as order-independent catalog facts",
  "Phase 4 migration integrity accepts only the committed Phase 3 migration snapshot and matching checksums",
  "Phase 4 migration integrity rejects migration snapshot checksum drift",
  "Phase 4 migration integrity fails clean versus upgrade equivalence on grants, constraints, or policy drift",
  "Phase 4 migration integrity applies exact reviewed row replacements and rejects a changed declared target",
  "Phase 4 migration integrity rejects changed existing column types",
  "Phase 4 migration integrity rejects changed existing column defaults",
  "Phase 4 migration integrity rejects changed existing column nullability",
  "Phase 4 migration integrity rejects changed existing policy predicates",
  "Phase 4 migration integrity rejects changed existing policy roles",
  "Phase 4 migration integrity rejects changed existing table ownership",
  "Phase 4 migration integrity rejects changed existing RLS enforcement",
  "Phase 4 migration integrity rejects changed existing grantability",
  "Phase 4 migration integrity rejects changed existing constraint definitions",
  "Phase 4 migration integrity rejects changed existing index definitions",
  "Phase 4 migration integrity rejects duplicate table-scoped catalog identities instead of collapsing them",
  "Phase 4 migration integrity requires forced RLS and the intended policy roles and scope on every Phase 4 application table",
  "Phase 4 migration integrity requires timestamped Phase 5 migrations with bounded lock timeouts and recovery notes",
  "Phase 4 migration integrity rejects destructive Phase 5 contractions without an explicitly reviewed migration path",
  "Phase 4 migration integrity requires an explicit expand or lockstep compatibility boundary for every audited migration",
  "Phase 4 migration integrity limits Phase 5 safety checks to the Phase 5 migration window",
]);
export const REQUIRED_REGRESSION_TESTS = Object.freeze([
  "every committed migration is classified exactly once and matches the declared phase ranges",
  "undeclared, duplicate, or unreviewed transformation migrations fail closed",
  "a synthetic future transformation is admitted only through the injected shared registry",
  "canonical operations expectations bind complete row operations to reviewed migrations",
  "capabilities are declared per checkpoint, never learned from a database",
  "checkpoint pairing requires every historical suite to exist in the tree",
  "the qualification DAG is a valid, acyclic, topologically ordered definition",
  "completed nodes are reusable only while identity, definition, and evidence digests still verify",
  "safe resume reuses only a clean successful prefix and invalidates descendants when an artifact changes",
  "resume report proof rejects missing or changed tools, migrations, scope, checks, freshness, or cleanup",
  "gate predecessor verification fails closed for missing or drifting contexts",
  "the run file round-trips through read/record/write with digest evidence",
  "evidence digests are computed for existing files and null otherwise",
  "the declared prevention workflow runs the complete regression inventory and strict aggregator",
  "workflow mutations cannot omit triggers, suites, checks, or failures",
  "workflow checker rejects invalid YAML and missing regression job",
  "regression TAP rejects removed, skipped, cancelled, or failed constituents",
  "structured failures sanitize metadata, paths, causes, and serialized output",
  "combined cleanup failures retain the primary cause and every cleanup cause safely",
  "the real CLI with no Docker exits before changing evidence",
  "Docker preflight distinguishes executable, access, OS, and Compose failures",
  "explicit resume reuses only verified completed evidence and reruns missing nodes",
  "drifted identity, tool, or definition context forces every node to rerun",
  "qualification executes each node once in dependency order",
  "a failed later gate resumes after rechecking and retaining the clean successful prefix",
  "a failed, interrupted, or cleanup-failed gate does not reach later nodes",
  "uncommitted source and source edits during a gate are rejected",
  "qualification command rejects real TAP skips before returning a cacheable result",
  "compound contract verification reuses the actual earlier drift and compatibility executions",
  "qualification command rejects Vitest skips and cancelled or todo TAP outcomes",
]);
export const REQUIRED_CACHE_TESTS = Object.freeze([
  "reuses an equivalent checked command across phase gates only within the active run",
  "semantic aliases share a cache only after each invocation matches its reviewed command",
  "direct and npm route inventory aliases share the same artifact proof",
  "standalone runs and noncanonical commands never reuse",
  "failed, interrupted, skipped, or timed-out results are never cached",
  "source, environment, runtime, platform, and command changes make a fresh execution",
  "output artifacts must exist and remain byte-identical for reuse",
]);

export function validateValidationEvolutionTap(output, exitCode) {
  const failures = [];
  const names = [...output.matchAll(/^# Subtest: (.+)$/gmu)].map((match) => match[1]);
  if (names.length !== REQUIRED_REGRESSION_TESTS.length ||
      JSON.stringify([...names].sort()) !== JSON.stringify([...REQUIRED_REGRESSION_TESTS].sort())) {
    failures.push("VALIDATION_EVOLUTION_TEST_INVENTORY_MISMATCH");
  }
  const count = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "mu"))?.[1] ?? -1);
  if (exitCode !== 0) failures.push("VALIDATION_EVOLUTION_TEST_COMMAND_FAILED");
  if (count("tests") !== REQUIRED_REGRESSION_TESTS.length || count("pass") !== REQUIRED_REGRESSION_TESTS.length ||
      count("fail") !== 0 || count("cancelled") !== 0 || count("skipped") !== 0 || count("todo") !== 0) {
    failures.push("VALIDATION_EVOLUTION_TEST_COUNTS_INCOMPLETE");
  }
  return failures;
}

export function validatePrerequisiteCacheTap(output, exitCode) {
  const failures = [];
  const names = [...output.matchAll(/^# Subtest: (.+)$/gmu)].map((match) => match[1]);
  const count = (name) => Number(output.match(new RegExp(`^# ${name} (\\d+)$`, "mu"))?.[1] ?? -1);
  if (exitCode !== 0) failures.push("PREREQUISITE_CACHE_TEST_COMMAND_FAILED");
  if (names.length !== REQUIRED_CACHE_TESTS.length ||
      JSON.stringify([...names].sort()) !== JSON.stringify([...REQUIRED_CACHE_TESTS].sort()) ||
      count("tests") !== REQUIRED_CACHE_TESTS.length || count("pass") !== REQUIRED_CACHE_TESTS.length ||
      count("fail") !== 0 || count("cancelled") !== 0 || count("skipped") !== 0 || count("todo") !== 0) {
    failures.push("PREREQUISITE_CACHE_TEST_INVENTORY_INCOMPLETE");
  }
  return failures;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/run-validation-evolution-tests.mjs")) {
  const files = ["phase-contract-registry", "qualification-context", "prevention-workflow", "validation-errors", "phase8-qualify", "qualification-command"]
    .map((name) => join(ROOT, `tests/tooling/${name}.test.mjs`));
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-isolation=none", ...files], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  process.stdout.write(output);
  const failures = validateValidationEvolutionTap(output, result.status ?? 1);
  if (result.error) failures.push("VALIDATION_EVOLUTION_TEST_RUNNER_ERROR");
  const cacheTests = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-isolation=none",
    join(ROOT, "tests/tooling/qualification-prerequisite-cache.test.mjs")], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024,
  });
  const cacheOutput = `${cacheTests.stdout ?? ""}${cacheTests.stderr ?? ""}`;
  process.stdout.write(cacheOutput);
  failures.push(...validatePrerequisiteCacheTap(cacheOutput, cacheTests.status ?? 1));
  if (cacheTests.error) failures.push("PREREQUISITE_CACHE_TEST_RUNNER_ERROR");
  const temporaryRoot = mkdtempSync(join(tmpdir(), "validation-evolution-vitest-"));
  try {
    const reportPath = join(temporaryRoot, "vitest.json");
    const vitest = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run",
      "tests/database/phase4-migration-integrity.test.ts", "--reporter=json", `--outputFile=${reportPath}`], {
      cwd: ROOT, encoding: "utf8", timeout: 120_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(`${vitest.stdout ?? ""}${vitest.stderr ?? ""}`);
    let report;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { report = null; }
    const actual = report?.testResults?.flatMap((suite) => suite.assertionResults.map((test) => String(test.fullName))).sort() ?? [];
    const expected = [...REQUIRED_DATABASE_SECURITY_TESTS].sort();
    if (vitest.error || vitest.status !== 0) failures.push("VALIDATION_EVOLUTION_DATABASE_TEST_COMMAND_FAILED");
    if (JSON.stringify(actual) !== JSON.stringify(expected)) failures.push("VALIDATION_EVOLUTION_DATABASE_TEST_INVENTORY_MISMATCH");
    if (report?.numFailedTests !== 0 || report?.numPendingTests !== 0 || report?.numPassedTests !== expected.length) {
      failures.push("VALIDATION_EVOLUTION_DATABASE_TEST_COUNTS_INCOMPLETE");
    }
  } finally { rmSync(temporaryRoot, { recursive: true, force: true }); }
  for (const failure of failures) console.error(`✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}
