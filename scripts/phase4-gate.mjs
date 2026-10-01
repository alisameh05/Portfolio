#!/usr/bin/env node
/**
 * phase4-gate.mjs — Phase 4 prefactor gate (#78).
 *
 * Prefactor verdict: predecessor invariant coverage runs in its appropriate
 * historical/current phase context plus the new Phase 4 context check. Full
 * Phase 4 business, Auth, RLS, concurrency, and migration-equivalence checks
 * land in tickets #79-#90; this gate already enforces the failure semantics
 * they will rely on:
 *
 *   - Every constituent remains independently runnable via package.json.
 *   - A single failure, absent required local service, missing/skipped or
 *     partial result, obsolete phase restriction, or stale evidence fails
 *     the verdict. Required local-service unavailability never produces a
 *     passing result (LOCAL_DB_UNAVAILABLE / required-service failure).
 *   - Historical Phase 2 fake-only and Phase 3 infrastructure-only
 *     restrictions are evaluated against original fixtures/baselines; the
 *     current-phase context explicitly permits only Spec #77 activation.
 *
 * No live GitHub exchange, production secrets, remote writes, or deployed
 * services required. Deterministic, offline after install.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const REPORT = join(ROOT, "evidence", "phase-4-gate-report.json");
const startedAt = Date.now();

function sanitize(value) {
  return value
    .replaceAll(ROOT, "<WORKSPACE>")
    .replaceAll(ROOT.split("\\").join("/"), "<WORKSPACE>")
    .replaceAll(tmpdir(), "<TEMP>")
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-database-url]")
    .replace(/(?:password|token|secret|idempotency[-_]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]");
}

function run(name, entry, args, { env = {}, evidence, failOnSkipped = false, requiresService = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env, CI: "1", SHIPWITHALI_PHASE: "phase4" },
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
      const raw = Buffer.concat(chunks).toString("utf8");
      const output = `${sanitize(raw).trimEnd()}\n`;
      if (evidence) {
        const path = join(ROOT, evidence);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, output, "utf8");
      }
      const stripped = output.replaceAll(/\u001B\[[0-9;]*m/g, "");
      const skipped = failOnSkipped && /[1-9]\d*\s+skipped|\bskipped\b.*[1-9]|missing.*service|partial/i.test(stripped);
      if (skipped) {
        console.error(`✗ ${name}: skipped, missing-service, or partial result is a failing verdict, never success`);
      }
      const missingService =
        requiresService !== null &&
        (/LOCAL_DB_UNAVAILABLE|LOCAL_DB_URL_MISSING|PHASE3_DATABASE_URL_REQUIRED|ECONNREFUSED|database.*unavailable/i.test(stripped) ||
          code !== 0);
      if (requiresService !== null && missingService) {
        console.error(`✗ ${name}: required local service ${requiresService} unavailable — gate cannot pass`);
      }
      resolve({
        name,
        passed: code === 0 && spawnError === undefined && !skipped && !(requiresService !== null && missingService),
        exitCode: skipped || (requiresService !== null && missingService) ? 1 : (code ?? 1),
        evidence,
      });
    });
  });
}

function fresh(path) {
  const full = join(ROOT, path);
  return existsSync(full) && statSync(full).mtimeMs >= startedAt - 1_000;
}

console.log("═══════════════════════════════════════════════");
console.log("  Phase 4 Prefactor Gate (#78)");
console.log("═══════════════════════════════════════════════");

const results = [];
try {
  results.push(
    await run("phase2-gate-predecessor", "scripts/phase2-gate.mjs", [], {
      evidence: "evidence/phase-4-phase2-gate.log",
      failOnSkipped: true,
    }),
  );
  results.push(
    await run("database-toolchain", "scripts/check-database-toolchain.mjs", [], {
      evidence: "evidence/phase-4-database-toolchain.log",
    }),
  );
  results.push(
    await run("migration-baseline-source", "scripts/check-database-baseline.mjs", ["--source-only"], {
      evidence: "evidence/phase-4-migration-baseline-source.log",
    }),
  );
  results.push(
    await run("phase3-database-source", "scripts/check-phase3-database.mjs", ["--source-only"], {
      evidence: "evidence/phase-4-phase3-database-source.log",
    }),
  );
  results.push(
    await run("toolchain", "scripts/check-toolchain.mjs", [], {
      evidence: "evidence/phase-4-toolchain.log",
    }),
  );
  results.push(
    await run("contract-drift", "scripts/check-contract-drift.mjs", [], {
      evidence: "evidence/phase-4-contract-drift.log",
    }),
  );
  results.push(
    await run("contract-compatibility", "scripts/check-contract-compatibility.mjs", [], {
      evidence: "evidence/phase-4-contract-compatibility.log",
    }),
  );
  results.push(
    await run("contract-tests", "node_modules/vitest/vitest.mjs", ["run", "tests/contracts"], {
      evidence: "evidence/phase-4-contract-tests.log",
      failOnSkipped: true,
    }),
  );
  results.push(
    await run("strict-typecheck", "node_modules/typescript/bin/tsc", ["--noEmit"], {
      evidence: "evidence/phase-4-typecheck.log",
    }),
  );
  results.push(
    await run("deterministic-lint", "node_modules/eslint/bin/eslint.js", ["."], {
      evidence: "evidence/phase-4-lint.log",
    }),
  );
  results.push(
    await run("architecture", "scripts/architecture-check.mjs", [], {
      evidence: "evidence/phase-4-architecture.log",
    }),
  );
  results.push(
    await run("route-inventory", "scripts/check-route-inventory.mjs", [], {
      evidence: "evidence/phase-4-route-inventory.log",
    }),
  );
  results.push(
    await run("runtime-boundary", "scripts/check-runtime-boundary.mjs", [], {
      evidence: "evidence/phase-4-runtime-boundary.log",
    }),
  );
  results.push(
    await run("runtime-architecture", "scripts/check-runtime-architecture.mjs", [], {
      evidence: "evidence/phase-4-runtime-architecture.log",
    }),
  );
  results.push(
    await run("phase4-context", "scripts/check-phase4-context.mjs", [], {
      evidence: "evidence/phase-4-context-check.log",
      failOnSkipped: true,
    }),
  );
  results.push(
    await run("phase4-focused-tests", "node_modules/vitest/vitest.mjs", ["run", "tests/phase4"], {
      evidence: "evidence/phase-4-focused-tests.log",
      failOnSkipped: true,
    }),
  );
  // Required local-service probe: documents loopback database availability
  // without requiring it for the prefactor verdict. When later tickets add
  // real PostgreSQL/RLS/concurrency checks with requiresService set, any
  // LOCAL_DB_UNAVAILABLE or missing-service output fails the gate instead of
  // passing vacuously. Stale evidence likewise fails below.
  results.push(
    await run("local-service-probe", "scripts/check-database-toolchain.mjs", [], {
      evidence: "evidence/phase-4-local-service-probe.log",
    }),
  );
} catch (error) {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : "PHASE4_GATE_FAILED";
  console.error(`✗ ${code}`);
}

const requiredEvidence = [
  "evidence/phase-4-context.json",
  ...results.flatMap((result) => (result.evidence ? [result.evidence] : [])),
];
const evidence = requiredEvidence.map((file) => ({ file, fresh: fresh(file) }));
const failed = results.filter((result) => !result.passed);
const stale = evidence.filter((item) => !item.fresh);
const verdict =
  results.length >= 10 && failed.length === 0 && stale.length === 0 ? "pass" : "fail";
mkdirSync(dirname(REPORT), { recursive: true });
writeFileSync(
  REPORT,
  `${JSON.stringify(
    {
      ticket: 78,
      parent: 77,
      scope: "phase-4-verification-prefactor-gate",
      node: process.version,
      verdict,
      checks: results,
      evidence,
      guarantees: {
        predecessor: "complete Phase 2 gate plus Phase 3 source baselines run first in phase4 context",
        historical: "phase2 fake-only and phase3 infrastructure-only restrictions evaluated against original fixtures/baselines",
        current: "only Spec #77 identity-access and portfolio-configuration activation permitted",
        failureSemantics: "single failure, absent required local service (LOCAL_DB_UNAVAILABLE), missing/skipped/partial result, or stale evidence fails the verdict",
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
  console.log(`✓ Phase 4 prefactor gate: ALL ${results.length} CHECKS PASSED`);
  process.exitCode = 0;
} else {
  console.error(
    `✗ Phase 4 prefactor gate: ${failed.length} checks failed, ${stale.length} stale/missing evidence — missing services, skipped checks, and stale evidence cannot produce a passing result`,
  );
  process.exitCode = 1;
}
