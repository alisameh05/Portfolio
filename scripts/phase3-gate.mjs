#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REPORT = join(ROOT, "evidence", "phase-3-gate-report.json");
const CLI = join(ROOT, "node_modules", "supabase", "dist", "supabase.js");
const startedAt = Date.now();

function sanitize(value) {
  return value
    .replaceAll(ROOT, "<WORKSPACE>")
    .replaceAll(ROOT.split("\\").join("/"), "<WORKSPACE>")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-database-url]")
    .replace(/(?:password|token|secret|idempotency[-_]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function run(name, entry, args, { env = {}, evidence, failOnSkipped = false } = {}) {
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
      const skipped =
        failOnSkipped &&
        /[1-9]\d*\s+skipped/i.test(output.replaceAll(/\u001B\[[0-9;]*m/g, ""));
      if (skipped) {
        console.error(`✗ ${name}: skipped database suites are a failing verdict, never success`);
      }
      resolve({
        name,
        passed: code === 0 && spawnError === undefined && !skipped,
        exitCode: skipped ? 1 : (code ?? 1),
        evidence,
      });
    });
  });
}

async function readLocalDatabaseUrl() {
  const chunks = [];
  const child = spawn(process.execPath, [CLI, "status", "--output", "json"], {
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
  return existsSync(full) && statSync(full).mtimeMs >= startedAt - 1_000;
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
try {
  results.push(
    await run("phase2-gate", "scripts/phase2-gate.mjs", [], {
      evidence: "evidence/phase-3-phase2-gate.log",
    }),
  );
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

  const start = await run("local-database-start", "scripts/local-database.mjs", ["start"], {
    evidence: "evidence/phase-3-local-start.log",
  });
  results.push(start);
  databaseStarted = start.passed;
  if (databaseStarted) {
    results.push(
      await run("local-database-reset", "scripts/local-database.mjs", ["reset"], {
        evidence: "evidence/phase-3-local-reset.log",
      }),
    );
  }

  if (results.some((result) => !result.passed)) {
    throw new Error("PHASE3_PREREQUISITE_FAILED");
  }

  const databaseUrl = await readLocalDatabaseUrl();
  const databaseEnv = {
    PHASE3_DATABASE_URL: databaseUrl,
    PHASE3_REQUIRE_DATABASE: "1",
  };
  const checks = [
    ["phase3-focused-tests", "node_modules/vitest/vitest.mjs", ["run", "tests/database"], databaseEnv, "evidence/phase-3-focused-tests.log"],
    ["role-rls-types-plans", "scripts/check-phase3-database.mjs", [], databaseEnv, "evidence/phase-3-security-types-plans.log"],
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
  if (databaseStarted) {
    results.push(
      await run("local-database-stop", "scripts/local-database.mjs", ["stop"], {
        evidence: "evidence/phase-3-local-stop.log",
      }),
    );
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
      verdict,
      checks: results,
      evidence,
      guarantees: {
        predecessor: "complete Phase 2 gate runs first",
        database: "disposable loopback Supabase/PostgreSQL only",
        remoteCredentialsRequired: false,
        secretValuesRecorded: false,
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
