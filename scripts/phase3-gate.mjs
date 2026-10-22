#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { createPhase3GateProject, removePhase3GateProject, skippedTestCount } from "./phase3-gate-support.mjs";
import { createQualificationPrerequisiteCache } from "./qualification-prerequisite-cache.mjs";
import { normalizeQualificationCommandResult } from "./qualification-command.mjs";
import {
  QUALIFICATION_CONTEXT_VARIABLE,
  qualificationDefinitionSha256,
  readQualificationRun,
  verifyGatePredecessors,
  currentRuntimeIdentity,
} from "./qualification-context.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REPORT = join(ROOT, "evidence", "phase-3-gate-report.json");
const CLI = join(ROOT, "node_modules", "supabase", "dist", "supabase.js");
const startedAt = Date.now();
const runId = randomUUID();
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const sourceTreeSha256 = workingTreeSourceSha256();
const prerequisiteCache = createQualificationPrerequisiteCache({ root: ROOT, sourceRevision, sourceTreeSha256,
  runtime: currentRuntimeIdentity(), environment: process.env });
const sharedContextPath = process.env[QUALIFICATION_CONTEXT_VARIABLE] ?? null;
const sharedPredecessors = verifyGatePredecessors({
  context: sharedContextPath === null ? null : readQualificationRun(ROOT, sharedContextPath),
  nodeIds: ["phase2"],
  root: ROOT,
  revision: sourceRevision,
  sourceTreeSha256,
  definitionHash: qualificationDefinitionSha256(),
});
const reusedEvidence = new Map([...sharedPredecessors.reuse.entries()].flatMap(([id, proof]) => [[id, proof], [proof.file, proof]]));
let postgresVersion = null;
const PHASE3_DATABASE_TESTS = Object.freeze([
  "tests/database/idempotency.test.ts",
  "tests/database/leased-jobs.test.ts",
  "tests/database/migration-security-baseline.test.ts",
  "tests/database/operations-migration.test.ts",
  "tests/database/optimistic-concurrency.test.ts",
  "tests/database/outbox.test.ts",
  "tests/database/persistence-contracts.test.ts",
  "tests/database/phase3-database-tests-command.test.ts",
  "tests/database/phase4-migration-integrity.test.ts",
  "tests/database/postgres-integration.test.ts",
  "tests/database/postgres-runtime.test.ts",
  "tests/database/postgres-transaction-runner.test.ts",
  "tests/database/role-rls-matrix.test.ts",
  "tests/database/toolchain-workflow.test.ts",
]);

function sanitize(value) {
  return value
    .replaceAll(ROOT, "<WORKSPACE>")
    .replaceAll(ROOT.split("\\").join("/"), "<WORKSPACE>")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-database-url]")
    .replace(/(?:password|token|secret|idempotency[-_]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function runUncached(name, entry, args, { env = {}, evidence, failOnSkipped = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env, CI: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      process.stdout.write(sanitize(chunk.toString("utf8")));
    });
    child.stderr.on("data", (chunk) => {
      chunks.push(chunk);
      process.stderr.write(sanitize(chunk.toString("utf8")));
    });
    let spawnError;
    child.on("error", (error) => {
      spawnError = error;
    });
    const heartbeat = setInterval(() => console.log(`… ${name} still running`), 10_000);
    child.on("close", (code) => {
      clearInterval(heartbeat);
      const output = `${sanitize(Buffer.concat(chunks).toString("utf8")).trimEnd()}\n`;
      if (evidence) {
        const path = join(ROOT, evidence);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, output, "utf8");
      }
      const skippedCount = failOnSkipped ? skippedTestCount(output) : 0;
      if (skippedCount > 0) {
        console.error(`✗ ${name}: skipped database suites are a failing verdict, never success`);
      }
      resolve({
        name,
        passed: code === 0 && spawnError === undefined && skippedCount === 0,
        exitCode: skippedCount > 0 ? 1 : (code ?? 1),
        skipped: skippedCount,
        evidence,
        output,
        errorCode: spawnError?.code ?? null,
      });
    });
  });
}

const SHARED_COMMANDS = Object.freeze({
  "strict-typecheck": "direct:typescript",
  "deterministic-lint": "direct:eslint",
  architecture: "direct:architecture-check.mjs",
});

async function run(name, entry, args, options = {}) {
  const script = SHARED_COMMANDS[name];
  if (script === undefined) {
    const result = await runUncached(name, entry, args, options);
    return { name: result.name, passed: result.passed, exitCode: result.exitCode,
      skipped: result.skipped, evidence: result.evidence };
  }
  const execution = await prerequisiteCache.runAsync({ script, args,
    entry: JSON.stringify({ entry: process.execPath, args: [join(ROOT, entry), ...args] }),
    environment: { ...process.env, ...options.env, CI: "1" }, sanitizeOutput: sanitize,
    invoke: async () => {
      const result = await runUncached(name, entry, args, options);
      return normalizeQualificationCommandResult({ status: result.exitCode, errorCode: result.errorCode,
        skipped: result.skipped, output: result.output });
    },
  });
  if (execution.reused) {
    console.log(`✓ ${name} — reused verified same-run prerequisite.`);
    if (options.evidence) {
      const path = join(ROOT, options.evidence);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, execution.output, "utf8");
    }
  }
  const passed = execution.status === 0 && execution.errorCode === null && execution.skipped === 0 && !execution.timedOut;
  return { name, passed, exitCode: passed ? 0 : 1, skipped: execution.skipped, evidence: options.evidence,
    reused: execution.reused === true, reuseProof: execution.reuseProof ?? null };
}

async function readLocalDatabaseUrl(workdir) {
  const chunks = [];
  const child = spawn(process.execPath, [CLI, "--workdir", workdir, "status", "--output", "json"], {
    cwd: ROOT,
    env: { ...process.env, CI: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve) => child.on("close", (value) => resolve(value ?? 1)));
  if (code !== 0) throw new Error("LOCAL_DB_STATUS_FAILED");
  const output = Buffer.concat(chunks).toString("utf8");
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) throw new Error("LOCAL_DB_STATUS_FAILED");
  let status;
  try {
    status = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new Error("LOCAL_DB_STATUS_FAILED");
  }
  const value = status.DB_URL ?? status.db_url;
  if (typeof value !== "string") throw new Error("LOCAL_DB_URL_MISSING");
  const url = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("LOCAL_DB_NOT_LOOPBACK");
  }
  return value;
}

function fresh(path) {
  const full = join(ROOT, path);
  if (!existsSync(full)) return false;
  const reused = reusedEvidence.get(path);
  if (reused !== undefined) {
    return createHash("sha256").update(readFileSync(full)).digest("hex") === reused.sha256;
  }
  return statSync(full).mtimeMs >= startedAt - 1_000;
}

function readJsonEvidence(path) {
  try { return JSON.parse(readFileSync(join(ROOT, path), "utf8")); } catch { return {}; }
}

function phase2ReportMatchesRuntime() {
  try {
    const report = JSON.parse(readFileSync(join(ROOT, "evidence", "phase-2-gate-report.json"), "utf8"));
    return report.verdict === "pass" && report.node === process.version;
  } catch {
    return false;
  }
}

console.log("═══════════════════════════════════════════════");
console.log("  Phase 3 PostgreSQL Completion Gate (#44)");
console.log("═══════════════════════════════════════════════");

const results = [];
let databaseStarted = false;
let databaseProject;
try {
  const sharedPhase2 = reusedEvidence.get("phase2");
  if (sharedPhase2 !== undefined) {
    console.log(
      `✓ shared-context predecessor phase2 — reused from ${sharedPhase2.file} (recorded ${sharedPhase2.completedAt}).`,
    );
    results.push({ name: "phase2-gate", passed: true, exitCode: 0, reused: true, evidence: "evidence/phase-2-gate-report.json" });
  } else {
    results.push(
      await run("phase2-gate", "scripts/phase2-gate.mjs", [], {
        evidence: "evidence/phase-3-phase2-gate.log",
      }),
    );
  }
  const phase2ReportConsistent = phase2ReportMatchesRuntime();
  console.log(
    `${phase2ReportConsistent ? "✓" : "✗"} phase2-report-runtime — nested report matches ${process.version}`,
  );
  results.push({
    name: "phase2-report-runtime",
    passed: phase2ReportConsistent,
    exitCode: phase2ReportConsistent ? 0 : 1,
    evidence: "evidence/phase-2-gate-report.json",
  });
  results.push(
    await run("database-toolchain", "scripts/check-database-toolchain.mjs", [], {
      evidence: "evidence/phase-3-database-toolchain.log",
    }),
  );
  results.push(
    await run("migration-clean-upgrade-equivalence", "scripts/check-database-baseline.mjs", ["--local", "--phase3"], {
      evidence: "evidence/phase-3-migration-equivalence.log",
    }),
  );

  databaseProject = createPhase3GateProject(ROOT);
  const databaseEnvironment = { SHIPWITHALI_LOCAL_VALIDATION_WORKDIR: databaseProject.workdir };
  const start = await run("local-database-start", "scripts/local-database.mjs", ["start"], {
    env: databaseEnvironment,
    evidence: "evidence/phase-3-local-start.log",
  });
  results.push(start);
  databaseStarted = start.passed;
  if (databaseStarted) {
    results.push(
      await run("local-database-reset", "scripts/local-database.mjs", ["reset"], {
        env: databaseEnvironment,
        evidence: "evidence/phase-3-local-reset.log",
      }),
    );
  }

  if (results.some((result) => !result.passed)) {
    throw new Error("PHASE3_PREREQUISITE_FAILED");
  }

  const databaseUrl = await readLocalDatabaseUrl(databaseProject.workdir);
  const versionClient = new Client({ connectionString: databaseUrl });
  await versionClient.connect();
  try {
    postgresVersion = (await versionClient.query("select version() as version")).rows[0]?.version ?? null;
  } finally {
    await versionClient.end();
  }
  const databaseEnv = {
    PHASE3_DATABASE_URL: databaseUrl,
    PHASE3_REQUIRE_DATABASE: "1",
  };
  const checks = [
    ["role-rls-types-plans", "scripts/check-phase3-database.mjs", [], databaseEnv, "evidence/phase-3-security-types-plans.log"],
    ["phase3-focused-tests", "node_modules/vitest/vitest.mjs", ["run", ...PHASE3_DATABASE_TESTS], databaseEnv, "evidence/phase-3-focused-tests.log"],
    ["strict-typecheck", "node_modules/typescript/bin/tsc", ["--noEmit"], {}, "evidence/phase-3-typecheck.log"],
    ["deterministic-lint", "node_modules/eslint/bin/eslint.js", ["."], {}, "evidence/phase-3-lint.log"],
    ["architecture", "scripts/architecture-check.mjs", [], {}, "evidence/phase-3-architecture.log"],
  ];
  for (const [name, entry, args, env, evidence] of checks) {
    results.push(await run(name, entry, args, { env, evidence, failOnSkipped: name === "phase3-focused-tests" }));
  }
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : "PHASE3_GATE_FAILED";
  console.error(`✗ ${code}`);
} finally {
  if (databaseProject) {
    const stopped = await run("local-database-stop", "scripts/local-database.mjs", ["stop"], {
        env: { SHIPWITHALI_LOCAL_VALIDATION_WORKDIR: databaseProject.workdir },
        evidence: "evidence/phase-3-local-stop.log",
      });
    results.push(stopped);
    if (stopped.passed) removePhase3GateProject(databaseProject);
  }
}

const requiredEvidence = [
  "evidence/phase-2-gate-report.json",
  "evidence/phase-3-database-toolchain.json",
  "evidence/phase-3-migration-baseline.json",
  "evidence/phase-3-database-verification.json",
  ...results.flatMap((result) => (result.evidence ? [result.evidence] : [])),
];
const evidence = requiredEvidence.map((file) => ({ file, fresh: fresh(file) }));
const failed = results.filter((result) => !result.passed);
const finalRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const finalSourceTreeSha256 = workingTreeSourceSha256();
if (finalRevision !== sourceRevision || finalSourceTreeSha256 !== sourceTreeSha256) {
  failed.push({ name: "source-identity-stable", passed: false });
}
const boundChecks = results.map((result) => ({ ...result, runId, sourceRevision, sourceTreeSha256, executed: true,
  skipped: result.skipped ?? 0, startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString() }));
const databaseBaseline = readJsonEvidence("evidence/phase-3-migration-baseline.json");
const databaseVerification = readJsonEvidence("evidence/phase-3-database-verification.json");
const postgresExecuted = results.some((result) => result.name === "phase3-focused-tests" && result.passed) && postgresVersion !== null;
const verdict =
  results.length >= 9 && failed.length === 0 && evidence.every((item) => item.fresh)
    ? "pass"
    : "fail";
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(
  REPORT,
  `${JSON.stringify(
    {
      ticket: 55,
      parent: 44,
      scope: "phase-3-postgresql-completion-gate",
      node: process.version,
      runId,
      sourceRevision,
      sourceTreeSha256,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      toolVersions: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      required: { success: verdict === "pass", executed: boundChecks.length, failed: failed.length,
        skipped: boundChecks.reduce((total, check) => total + check.skipped, 0) },
      counts: { total: boundChecks.length },
      verdict,
      checks: boundChecks,
      migrations: databaseVerification.migrations,
      cleanup: { attempted: results.some((result) => result.name === "local-database-stop"),
        success: results.some((result) => result.name === "local-database-stop" && result.passed) },
      realServiceScope: {
        runId, gateRunId: runId, sourceRevision, sourceTreeSha256,
        startedAt: new Date(startedAt).toISOString(), completedAt: new Date().toISOString(),
        postgresVersion, isolation: "isolated-loopback",
        required: { success: postgresExecuted && databaseBaseline.cleanUpgradeEquivalent === true },
        cleanUpgrade: { equivalent: databaseBaseline.cleanUpgradeEquivalent === true },
        services: { postgres: { available: postgresExecuted, executionCount: postgresExecuted ? 1 : 0 } },
        checks: boundChecks.filter((item) => ["migration-clean-upgrade-equivalence", "phase3-focused-tests", "role-rls-types-plans"]
          .includes(item.name)).map((item) => ({ name: item.name, executed: item.executed, passed: item.passed })),
        cleanup: results.some((result) => result.name === "local-database-stop" && result.passed),
      },
      evidence,
      guarantees: {
        predecessor: "complete Phase 2 gate runs first",
        database: "disposable loopback Supabase/PostgreSQL only",
        remoteCredentialsRequired: false,
        secretValuesRecorded: false,
        sourceBound: verdict === "pass",
        successfulCleanup: results.some((result) => result.name === "local-database-stop" && result.passed),
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

if (verdict === "pass") {
  console.log(`✓ Phase 3 gate: ALL ${results.length} CHECKS PASSED`);
  process.exitCode = 0;
} else {
  console.error(`✗ Phase 3 gate: ${failed.length} checks failed or evidence was missing/stale`);
  process.exitCode = 1;
}
