#!/usr/bin/env node
/**
 * architecture-check.mjs
 *
 * Runs dependency-cruiser against src/ to enforce Phase 1 module dependency rules.
 * Also validates all intentionally invalid fixtures against their expected stable rule
 * identifiers, and verifies module skeleton constraints (no persistence, no provider
 * calls, no Route Handlers, no UI, and no Lab entry implementation).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDependencyCruiserTsSupport } from "./ensure-depcruise-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\\/]$/, "");
const DEPCRUISE_CLI = join(
  ROOT,
  "node_modules",
  "dependency-cruiser",
  "bin",
  "dependency-cruise.mjs",
);

// Shared deterministic seam: dependency-cruiser 16.10.3 must parse TS 6.0.x.
// See scripts/ensure-depcruise-support.mjs (also used by arch tests + gate).
ensureDependencyCruiserTsSupport(ROOT);

function run(label, cmd, opts = {}) {
  console.log(`\n── ${label} ──`);
  try {
    const output = execSync(cmd, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      ...opts,
    });
    if (output.trim()) console.log(output.trim());
    return { ok: true, output };
  } catch (err) {
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    const combined = (stdout + stderr).trim();
    if (combined) console.error(combined);
    return { ok: false, output: combined, code: err.status ?? 1 };
  }
}

let overallOk = true;
const report = [];

function recordCheck(name, passed, message) {
  report.push({ name, passed, message });
  if (!passed) {
    overallOk = false;
  }
}

// ── 1. Check src/ against allowed dependency graph ──────────────────────────
const srcCheck = run(
  "Architecture check: src/",
  `"${process.execPath}" "${DEPCRUISE_CLI}" src --config .dependency-cruiser.cjs --output-type err-long`,
);
if (!srcCheck.ok) {
  console.error("\n✗ Architecture check FAILED: forbidden dependencies detected in src/");
  recordCheck("Clean dependency graph for src/", false, "Forbidden dependencies detected");
} else {
  console.log("✓ Architecture check passed: no forbidden dependencies in src/");
  recordCheck("Clean dependency graph for src/", true, "src/ cruised with 0 violations");
}

// ── 2. Validate the invalid fixtures are correctly rejected ──────────────────
const FIXTURE_SUITES = [
  {
    name: "Provider leakage fixture",
    path: "tests/fixtures/invalid-deps/provider-leakage",
    expectedRule: "no-provider-in-domain",
  },
  {
    name: "Generated-code leakage fixture",
    path: "tests/fixtures/invalid-deps/generated-code-leakage",
    expectedRule: "no-generated-code-leakage",
  },
  {
    name: "Runtime HTTP leakage fixture",
    path: "tests/fixtures/invalid-deps/module-http-leakage",
    expectedRule: "no-runtime-http-in-module-application",
  },
  {
    name: "Deep cross-module import fixture",
    path: "tests/fixtures/invalid-deps/deep-cross-module-import",
    expectedRule: "no-deep-cross-module-import",
  },
  {
    name: "Cycle fixture",
    path: "tests/fixtures/invalid-deps/cycle",
    expectedRule: "no-cycles",
  },
];

console.log("\n── Validating Invalid Architecture Fixtures ──");

for (const suite of FIXTURE_SUITES) {
  const fullPath = join(ROOT, suite.path);
  if (!existsSync(fullPath)) {
    console.error(`✗ Fixture directory not found: ${suite.path}`);
    recordCheck(suite.name, false, `Fixture directory missing: ${suite.path}`);
    continue;
  }

  const check = run(
    `Testing fixture rejection: ${suite.name}`,
    `"${process.execPath}" "${DEPCRUISE_CLI}" ${suite.path} --config .dependency-cruiser.cjs --output-type err-long`,
  );

  if (check.ok) {
    console.error(`✗ ${suite.name} was NOT rejected — expected rule: ${suite.expectedRule}`);
    recordCheck(suite.name, false, `Failed to reject invalid dependency pattern`);
  } else if (!check.output.includes(suite.expectedRule)) {
    console.error(
      `✗ ${suite.name} was rejected for unexpected rule. Expected: ${suite.expectedRule}`,
    );
    recordCheck(
      suite.name,
      false,
      `Rejected with wrong rule (expected ${suite.expectedRule})`,
    );
  } else {
    console.log(`✓ ${suite.name} correctly rejected with rule: ${suite.expectedRule}`);
    recordCheck(suite.name, true, `Correctly rejected with rule ${suite.expectedRule}`);
  }
}

// ── 3. Verify Nine Module Skeletons & Structural Invariants ──────────────────
const EXPECTED_MODULES = [
  "portfolio-configuration",
  "content-publishing",
  "taxonomy-discovery",
  "media",
  "cv-portfolio",
  "interaction-moderation",
  "measurement",
  "identity-access",
  "portability-operations",
];

console.log("\n── Validating Module Skeletons and Invariants ──");

let skeletonsOk = true;
const modulesDir = join(ROOT, "src", "modules");

for (const mod of EXPECTED_MODULES) {
  const modDir = join(modulesDir, mod);
  if (!existsSync(modDir)) {
    console.error(`✗ Module skeleton missing: src/modules/${mod}`);
    skeletonsOk = false;
    continue;
  }

  const requiredSubdirs = ["domain", "application", "ports", "adapters"];
  for (const sub of requiredSubdirs) {
    const subDir = join(modDir, sub);
    if (!existsSync(subDir)) {
      console.error(`✗ Missing required subdirectory: src/modules/${mod}/${sub}`);
      skeletonsOk = false;
    }
  }

  const barrel = join(modDir, "index.ts");
  if (!existsSync(barrel)) {
    console.error(`✗ Missing public interface barrel: src/modules/${mod}/index.ts`);
    skeletonsOk = false;
  }
}

if (skeletonsOk) {
  console.log("✓ All nine module skeletons exist with required subdirectories and index.ts barrels");
  recordCheck(
    "Nine module skeletons structure",
    true,
    "All 9 modules have domain/, application/, ports/, adapters/, and index.ts",
  );
} else {
  recordCheck("Nine module skeletons structure", false, "Missing module or subdirectories");
}

// ── 4. Verify Purity (No Persistence, Providers, Route Handlers, UI, Lab) ─────
function scanFiles(dir) {
  const results = [];
  try {
    const list = readdirSync(dir);
    for (const item of list) {
      const full = join(dir, item);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...scanFiles(full));
      } else {
        results.push(full);
      }
    }
  } catch {
    // skip unreadable
  }
  return results;
}

const moduleFiles = scanFiles(modulesDir);
let purityOk = true;
const purityViolations = [];

for (const file of moduleFiles) {
  const relative = file.replace(ROOT, "").replace(/^[\\\/]/, "").replace(/\\/g, "/");

  // Check 1: No Route Handlers inside modules
  if (/(?:^|\/)route\.(?:ts|js)$/.test(relative)) {
    purityViolations.push(`${relative}: Route Handler found in module skeleton`);
    purityOk = false;
  }

  // Check 2: No JSX/TSX
  if (/\.(?:tsx|jsx)$/.test(relative)) {
    purityViolations.push(`${relative}: UI / JSX file found in module skeleton`);
    purityOk = false;
  }

  const content = readFileSync(file, "utf8");
  const isAdapter = /\/adapters\//.test(relative);

  // Check 3: No Lab entry implementation (ADR-0007 / Acceptance Criteria)
  // Matching active Lab entry class, function, or interface definitions
  if (/\b(?:class|function|interface)\s+LabEntry\b/i.test(content)) {
    purityViolations.push(`${relative}: Lab entry implementation found (deferred after v1)`);
    purityOk = false;
  }

  // Check 4: No active persistence SQL queries
  if (
    /\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO\s+|DELETE\s+FROM\s+|UPDATE\s+.+\s+SET)\b/i.test(content) &&
    !isAdapter
  ) {
    purityViolations.push(`${relative}: Active SQL persistence query found outside an adapter`);
    purityOk = false;
  }

  // Check 5: Provider calls remain confined to adapters.
  if (/from\s+["'](?:@supabase\/|kysely|pg|@vercel\/|next\/)/i.test(content) && !isAdapter) {
    purityViolations.push(`${relative}: Provider package import found outside a module adapter`);
    purityOk = false;
  }
}

if (purityOk) {
  console.log("✓ Modules confine persistence/providers to adapters and contain no Route Handlers, UI, or Lab entry implementation");
  recordCheck(
    "Module skeleton purity",
    true,
    "Persistence/providers confined to adapters; no Route Handlers, UI, or Lab entry implementation",
  );
} else {
  console.error("✗ Purity violations found:\n " + purityViolations.join("\n  "));
  recordCheck("Module skeleton purity", false, purityViolations.join("; "));
}

// ── 5. Verify Phase 2 runtime boundaries ────────────────────────────────────
const runtimeArchitectureCheck = run(
  "Runtime architecture boundaries",
  `"${process.execPath}" scripts/check-runtime-architecture.mjs`,
);
if (runtimeArchitectureCheck.ok) {
  recordCheck(
    "Phase 2 runtime architecture",
    true,
    "Framework, environment, generated transport, provider, and Route Handler boundaries preserved",
  );
} else {
  recordCheck(
    "Phase 2 runtime architecture",
    false,
    "Runtime architecture boundary violation detected",
  );
}

// ── 6. Reviewable Architecture Report ─────────────────────────────────────────
console.log("\n═════════════════════════════════════════════════════════════════");
console.log("             ARCHITECTURE CONFORMANCE REPORT                    ");
console.log("═════════════════════════════════════════════════════════════════");
for (const item of report) {
  const symbol = item.passed ? "✓ PASS" : "✗ FAIL";
  console.log(`[${symbol}] ${item.name.padEnd(38)} : ${item.message}`);
}
console.log("═════════════════════════════════════════════════════════════════");

if (!overallOk) {
  console.error("\n✗ architecture-check: FAILED");
  process.exit(1);
}

console.log("\n✓ architecture-check: ALL CHECKS PASSED");
process.exit(0);
