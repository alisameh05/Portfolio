#!/usr/bin/env node
/**
 * phase1-gate.mjs
 *
 * Phase 1 conformance gate — aggregates all Phase 1 checks and returns a
 * single passing or failing exit code.
 *
 * Each constituent check is reported clearly. A single failing check causes
 * the gate to exit 1 at the end (all checks still run to show the full picture).
 *
 * Checks included in this gate:
 *   1. TypeScript typecheck (tsc --noEmit)
 *   2. Architecture check (dependency rules + invalid fixture)
 *   3. Shared-contract tests (vitest run tests/shared-domain/)
 *   4. Contract checks (lint/bundle — wired in later Phase 1 tickets)
 *   5. Frontend/Lab exclusion scan
 *   6. Dependency/version manifest presence
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\\/]$/, "");

const results = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.error(`✗ ${name}`);
    if (err?.message) console.error(`  ${err.message}`);
  }
}

function runCmd(cmd, label) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
  } catch {
    throw new Error(`Command failed: ${cmd}`);
  }
}

console.log("═══════════════════════════════════════════════");
console.log("  Phase 1 Conformance Gate");
console.log("═══════════════════════════════════════════════\n");

// ── 1. TypeScript typecheck ──────────────────────────────────────────────────
check("TypeScript typecheck (tsc --noEmit)", () => {
  runCmd("npx tsc --noEmit", "typecheck");
});

// ── 2. Architecture check ────────────────────────────────────────────────────
check("Architecture check (dependency rules + invalid fixture)", () => {
  runCmd("node scripts/architecture-check.mjs", "architecture-check");
});

// ── 3. Shared-contract unit tests ────────────────────────────────────────────
check("Shared-contract tests (vitest)", () => {
  runCmd("npx vitest run tests/shared-domain/", "shared-domain tests");
});

// ── 4. Contract lint and bundle ──────────────────────────────────────────────
check("Contract lint and bundle (Phase 1 later tickets)", () => {
  // OpenAPI contracts are created in later Phase 1 tickets (#4+).
  // This stub passes if openapi/ source trees do not yet exist.
  const publicSrc = join(ROOT, "openapi", "public-v1");
  const ownerSrc = join(ROOT, "openapi", "owner-v1");
  if (existsSync(publicSrc) || existsSync(ownerSrc)) {
    runCmd("npm run test:contracts", "contract checks");
  } else {
    console.log(
      "  (openapi/ source trees not yet present — contract checks deferred)",
    );
  }
});

// ── 5. Frontend / Lab exclusion scan ─────────────────────────────────────────
check("Frontend and Lab exclusion scan", () => {
  // Scan src/ for JSX/TSX files. Any match is a Phase 1 scope violation.

  /** @param {string} dir */
  function findJsxFiles(dir) {
    /** @type {string[]} */
    const found = [];
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return found; // directory does not exist yet — OK in Phase 1
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) {
          found.push(...findJsxFiles(full));
        } else if (/\.(tsx|jsx)$/.test(entry)) {
          found.push(full);
        }
      } catch {
        // skip unreadable entries
      }
    }
    return found;
  }

  const jsxFiles = findJsxFiles(join(ROOT, "src"));
  if (jsxFiles.length > 0) {
    throw new Error(`JSX/TSX files found in src/:\n${jsxFiles.join("\n")}`);
  }

  console.log("  No JSX/TSX surface detected in src/ ✓");
});

// ── 6. Dependency/version manifest ───────────────────────────────────────────
check("Dependency/version manifest present", () => {
  const manifest = join(ROOT, "docs", "phase1-versions.md");
  if (!existsSync(manifest)) {
    throw new Error("docs/phase1-versions.md not found");
  }
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log("\n═══════════════════════════════════════════════");
const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;

if (failed === 0) {
  console.log(`  ✓ Phase 1 gate: ALL ${passed} CHECKS PASSED`);
  console.log("═══════════════════════════════════════════════");
  process.exit(0);
} else {
  console.error(
    `  ✗ Phase 1 gate: ${failed} of ${results.length} checks FAILED`,
  );
  results
    .filter((r) => !r.ok)
    .forEach((r) => console.error(`    ✗ ${r.name}`));
  console.log("═══════════════════════════════════════════════");
  process.exit(1);
}
