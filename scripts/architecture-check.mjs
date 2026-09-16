#!/usr/bin/env node
/**
 * architecture-check.mjs
 *
 * Runs dependency-cruiser against src/ to enforce the Phase 1 module
 * dependency rules. Reports each rule violation clearly and exits 1 if
 * any forbidden dependency is detected.
 *
 * Also validates the intentionally invalid fixture:
 *   tests/fixtures/invalid-deps/
 *
 * The fixture MUST be rejected by the checker for the expected rule(s):
 *   - no-provider-in-domain
 *   - no-deep-cross-module-import
 *
 * A fixture that is NOT rejected causes this script to exit 1 as well.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\\/]$/, "");

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

// ── 1. Check src/ against allowed dependency graph ──────────────────────────
const srcCheck = run(
  "Architecture check: src/",
  `npx depcruise src --config .dependency-cruiser.cjs --output-type err-long`,
);
if (!srcCheck.ok) {
  console.error(
    "\n✗ Architecture check FAILED: forbidden dependencies detected in src/",
  );
  overallOk = false;
} else {
  console.log("✓ Architecture check passed: no forbidden dependencies in src/");
}

// ── 2. Validate the invalid fixture is correctly rejected ────────────────────
const FIXTURE_DIR = join(ROOT, "tests", "fixtures", "invalid-deps");

if (!existsSync(FIXTURE_DIR)) {
  console.warn(
    "\n⚠ Fixture directory not found: tests/fixtures/invalid-deps/",
    "\n  The intentionally invalid fixture must be created before the gate is complete.",
  );
  // Not a hard failure yet — fixture is created alongside the architecture tests
} else {
  const fixtureCheck = run(
    "Architecture check: invalid fixture (must be REJECTED)",
    `npx depcruise ${FIXTURE_DIR} --config .dependency-cruiser.cjs --output-type err-long`,
  );

  if (fixtureCheck.ok) {
    // Bad: the fixture was accepted — the checker failed to detect the violation
    console.error(
      "\n✗ Invalid fixture was NOT rejected — the architecture checker missed a violation.",
      "\n  The fixture must trigger at least: no-provider-in-domain and no-deep-cross-module-import",
    );
    overallOk = false;
  } else {
    // Good: the fixture was correctly rejected
    const expected = [
      "no-provider-in-domain",
      "no-deep-cross-module-import",
    ];
    const allExpectedPresent = expected.every((rule) =>
      fixtureCheck.output.includes(rule),
    );

    if (!allExpectedPresent) {
      console.error(
        "\n✗ Fixture was rejected but for unexpected rules.",
        `\n  Expected rules: ${expected.join(", ")}`,
        `\n  Got: ${fixtureCheck.output.slice(0, 500)}`,
      );
      overallOk = false;
    } else {
      console.log(
        "✓ Invalid fixture correctly rejected for expected rule(s):",
        expected.join(", "),
      );
    }
  }
}

// ── Result ───────────────────────────────────────────────────────────────────
if (!overallOk) {
  console.error("\n✗ architecture-check: FAILED");
  process.exit(1);
}

console.log("\n✓ architecture-check: PASSED");
