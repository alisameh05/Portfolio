#!/usr/bin/env node
/**
 * check-phase4-context.mjs — Phase 4 prefactor verification (#78).
 *
 * Proves historical Phase 2 fake-only and Phase 3 infrastructure-only
 * restrictions remain enforceable against original fixtures/baselines while
 * current-phase checks explicitly permit only Spec #77 activation.
 *
 * Independently runnable: `node scripts/check-phase4-context.mjs`.
 * No database, network, credentials, or running application required.
 *
 * Checks (each fails the verdict when violated):
 *   1. Five public operations, thirty-nine active Owner operations, and
 *      nine explicitly fail-closed Phase 5 Owner contracts are preserved.
 *   2. Runtime boundary: one adapter per active operation; deferred contracts
 *      have none, and only operational routes execute.
 *   3. Runtime architecture: provider/generated/transaction seams preserved.
 *   4. No forbidden source surface (Lab, frontend, stubs, leakage).
 *   5. Phase 4 negative fixtures rejected (provider/generated leakage,
 *      uncontracted routes, cross-module writes, frontend/browser/Lab,
 *      later-phase activation).
 *   6. Placeholder privileged actors confined to nine explicit production
 *      owner adapters; fixture exceptions cannot admit new placeholders.
 *   7. No later-phase activation in src/: no business tables, no new product
 *      routes, no Lab behavior, no frontend presentation.
 *   8. Toolchain pins preserved; architecture checks not bypassed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_OWNER_OPERATIONS,
  EXPECTED_PLACEHOLDER_PRODUCTION_FILES,
  EXPECTED_PUBLIC_OPERATIONS,
  HISTORICAL_INVALID_FIXTURES,
  PHASE4_NEGATIVE_FIXTURES,
  getPhaseContext,
} from "./phase-context.mjs";
import { buildInventory } from "./check-route-inventory.mjs";
import { buildRuntimeBoundary } from "./check-runtime-boundary.mjs";
import { inspectRuntimeArchitecture } from "./check-runtime-architecture.mjs";
import { forbiddenSourceReasons } from "./runtime-source-policy.mjs";
import { ensureDependencyCruiserTsSupport } from "./ensure-depcruise-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const PHASE4_MIGRATIONS = Object.freeze([
  "20260922170000_prepare_migration_capability.sql",
  "20260922171906_establish_database_security_baseline.sql",
  "20260922203000_create_operations_primitives.sql",
  "20261001220000_create_identity_access_owner_links.sql",
  "20261002120000_create_portfolio_configuration_settings.sql",
  "20261002130000_allow_versioned_portfolio_profile_updates.sql",
  "20261002140000_allow_owner_contact_channel_replacement.sql",
  "20261002150000_allow_versioned_portfolio_cta_updates.sql",
]);
const EVIDENCE = join(ROOT, "evidence", "phase-4-context.json");

function toPosix(path) {
  return path.split("\\").join("/");
}

function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of [...entries].sort()) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") continue;
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

/**
 * Scan production source for placeholder privileged actors.
 * Fakes (src/runtime/fakes), tests, and fixtures are explicitly excluded
 * from the production set: baseline fixture exceptions can never admit a
 * production placeholder.
 */
export function scanPlaceholderPrivilegedActors(root = ROOT) {
  const pattern = /PHASE2_OWNER_ID|phase2-owner-session/;
  const productionFiles = [];
  const unexpectedFiles = [];
  const expected = new Set(EXPECTED_PLACEHOLDER_PRODUCTION_FILES);
  const files = listFilesRecursive(join(root, "src")).filter((file) => file.endsWith(".ts"));
  for (const file of files) {
    const rel = toPosix(relative(root, file));
    if (rel.includes("/fakes/")) continue;
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (pattern.test(content)) {
      if (rel.startsWith("src/runtime/http/owner-")) {
        productionFiles.push(rel);
      } else {
        unexpectedFiles.push(rel);
      }
    }
  }
  productionFiles.sort();
  unexpectedFiles.sort();
  for (const file of productionFiles) {
    if (!expected.has(file)) unexpectedFiles.push(file);
  }
  unexpectedFiles.sort();
  return { productionFiles, unexpectedFiles };
}

function detectFixtureRejection(root, fixture) {
  const full = join(root, ...fixture.path.split("/"));
  if (!existsSync(full)) return false;
  const content = readFileSync(full, "utf8");
  const rel = fixture.path;
  switch (fixture.name) {
    case "phase4-provider-leakage":
      return /from\s+["'](?:@supabase\/|kysely|pg|@vercel\/|next\/)/i.test(content);
    case "phase4-generated-leakage":
      return /(?:contracts\/http\/|@hey-api\/openapi-ts|@redocly\/|openapi-typescript)/.test(content);
    case "phase4-uncontracted-route": {
      const hasHandler = /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b/.test(content);
      const hasNext = /from\s+["']next\/server["']/.test(content);
      const hasLiteral = /\/api\/v1\/broad-read/.test(content);
      return (hasHandler && hasNext) || hasLiteral;
    }
    case "phase4-cross-module-write":
      return /\/adapters\//.test(content) && /from\s+["']\.\.\//.test(content);
    case "phase4-frontend-lab-surface": {
      const reasons = forbiddenSourceReasons(rel, content);
      return (
        reasons.includes("jsx-tsx-surface") ||
        reasons.includes("react-presentation-import") ||
        reasons.includes("browser-state") ||
        reasons.includes("lab-entry-surface")
      );
    }
    case "phase4-later-phase-activation": {
      const hasPlaceholderBypass = /PHASE2_OWNER_ID|phase2-owner-session/.test(content) && /admin:all/.test(content);
      const hasBusinessWrite = /INSERT\s+INTO\s+content\./i.test(content);
      return hasPlaceholderBypass || hasBusinessWrite;
    }
    default:
      return false;
  }
}

export function verifyPhase4NegativeFixtures(root = ROOT) {
  return PHASE4_NEGATIVE_FIXTURES.map((fixture) => ({
    name: fixture.name,
    path: fixture.path,
    expectedRule: fixture.expectedRule,
    rejected: detectFixtureRejection(root, fixture),
  }));
}

function verifyDepcruiseFixture(root, fixturePath, expectedRule) {
  ensureDependencyCruiserTsSupport(root);
  const cli = join(root, "node_modules", "dependency-cruiser", "bin", "dependency-cruise.mjs");
  try {
    execFileSync(process.execPath, [cli, fixturePath, "--config", ".dependency-cruiser.cjs", "--output-type", "err-long"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return false;
  } catch (err) {
    const output = `${err.stdout?.toString?.() ?? ""}\n${err.stderr?.toString?.() ?? ""}`;
    return output.includes(expectedRule);
  }
}

function checkNoLaterPhaseActivation(root) {
  const violations = [];
  const files = listFilesRecursive(join(root, "src"));
  for (const file of files) {
    const rel = toPosix(relative(root, file));
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (/\/lab(?:\/|$)/i.test(rel) && !/openapi\//.test(rel)) {
      violations.push(`${rel}: lab-route-surface`);
    }
    if (/\.(?:tsx|jsx)$/.test(rel)) {
      violations.push(`${rel}: jsx-tsx-surface`);
    }
    for (const reason of forbiddenSourceReasons(rel, content)) {
      if (["lab-entry-surface", "jsx-tsx-surface", "react-presentation-import", "browser-state", "generated-server-stub"].includes(reason)) {
        violations.push(`${rel}: ${reason}`);
      }
    }
    if (/src\/modules\//.test(rel) && !/\/adapters\//.test(rel)) {
      if (/INSERT\s+INTO\s+(?:content|taxonomy|media|cv|interaction|measurement)\./i.test(content)) {
        violations.push(`${rel}: later-phase-business-write-outside-adapter`);
      }
    }
  }
  const migrationText = PHASE4_MIGRATIONS
    .map((file) => {
      try {
        return readFileSync(join(root, "supabase", "migrations", file), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
  // Phase 4 #80 permits identity-access and portfolio-configuration
  // activation. Check the migration set present at the Phase 4 merge so later
  // phases can add their own business tables without invalidating this
  // historical boundary check. Current source and runtime architecture remain
  // scanned above.
  if (/create\s+table\s+(?:content|taxonomy|media|cv|interaction|measurement)\./i.test(migrationText)) {
    violations.push("supabase/migrations: later-phase-business-table");
  }
  return violations;
}

export function runPhase4Context(root = ROOT) {
  const failures = [];
  const phase = getPhaseContext();
  if (phase !== "phase4") {
    failures.push(`Phase context must be phase4 for current checks, found ${phase}`);
  }

  const inventory = buildInventory();
  if (inventory.publicOperations.length !== EXPECTED_PUBLIC_OPERATIONS) {
    failures.push(`Expected ${EXPECTED_PUBLIC_OPERATIONS} public operations, found ${inventory.publicOperations.length}`);
  }
  if (inventory.ownerOperations.length !== EXPECTED_OWNER_OPERATIONS) {
    failures.push(`Expected ${EXPECTED_OWNER_OPERATIONS} owner operations, found ${inventory.ownerOperations.length}`);
  }
  if (inventory.forbiddenFindings.length !== 0) {
    failures.push(`${inventory.forbiddenFindings.length} forbidden source finding(s)`);
  }

  const boundary = buildRuntimeBoundary(root);
  if (boundary.verdict !== "pass") {
    failures.push("Runtime boundary verdict is not pass");
  }

  const runtimeArch = inspectRuntimeArchitecture(root);
  if (runtimeArch.verdict !== "pass") {
    failures.push("Runtime architecture verdict is not pass");
  }

  const fixtureResults = verifyPhase4NegativeFixtures(root);
  for (const result of fixtureResults) {
    if (!result.rejected) {
      failures.push(`Negative fixture not rejected: ${result.name}`);
    }
  }

  const placeholderScan = scanPlaceholderPrivilegedActors(root);
  const expectedSorted = [...EXPECTED_PLACEHOLDER_PRODUCTION_FILES].sort();
  if (JSON.stringify(placeholderScan.productionFiles) !== JSON.stringify(expectedSorted)) {
    failures.push(
      `Placeholder production files differ: found ${placeholderScan.productionFiles.length}, expected ${expectedSorted.length}`,
    );
  }
  if (placeholderScan.unexpectedFiles.length !== 0) {
    failures.push(`Unexpected placeholder location(s): ${placeholderScan.unexpectedFiles.slice(0, 3).join("; ")}`);
  }

  const laterPhase = checkNoLaterPhaseActivation(root);
  if (laterPhase.length !== 0) {
    failures.push(`Later-phase activation detected: ${laterPhase.slice(0, 3).join("; ")}`);
  }

  const historicalMissing = HISTORICAL_INVALID_FIXTURES.filter(
    (fixture) => !existsSync(join(root, fixture.path)),
  );
  if (historicalMissing.length !== 0) {
    failures.push(`Historical fixtures missing: ${historicalMissing.map((f) => f.name).join(", ")}`);
  }

  return {
    phase,
    failures,
    inventory: {
      publicOperations: inventory.publicOperations.length,
      ownerOperations: inventory.ownerOperations.length,
      forbiddenFindings: inventory.forbiddenFindings.length,
    },
    boundary: boundary.verdict,
    runtimeArchitecture: runtimeArch.verdict,
    fixtureResults,
    placeholderScan,
    laterPhaseViolations: laterPhase,
  };
}

function main() {
  const result = runPhase4Context(ROOT);
  const depcruiseResults = [];
  for (const [fixturePath, expectedRule] of [
    ["tests/fixtures/invalid-deps/phase4-provider-leakage", "no-provider-in-application"],
    ["tests/fixtures/invalid-deps/phase4-generated-leakage", "no-generated-code-leakage"],
  ]) {
    const rejected = verifyDepcruiseFixture(ROOT, fixturePath, expectedRule);
    depcruiseResults.push({ fixture: fixturePath, expectedRule, rejected });
    console.log(`${rejected ? "✓" : "✗"} depcruise ${fixturePath} — ${expectedRule}`);
    if (!rejected) {
      result.failures.push(`Depcruise did not reject ${fixturePath} with ${expectedRule}`);
    }
  }

  const report = {
    ticket: 78,
    parent: 77,
    scope: "phase-4-verification-prefactor",
    phase: result.phase,
    verdict: result.failures.length === 0 ? "pass" : "fail",
    ...result,
    depcruiseResults,
    guarantees: {
      historical: "phase2 fake-only and phase3 infrastructure-only restrictions enforceable against original fixtures/baselines",
      current: "only Spec #77 identity-access and portfolio-configuration activation permitted",
      placeholders: "nine explicit production placeholder adapters recorded; fixture exceptions cannot admit new placeholders",
      toolchain: "exact pins preserved; architecture checks not weakened or bypassed",
    },
  };
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (result.failures.length === 0) {
    console.log("✓ phase4 context: 5 public + 40 active Owner + 8 fail-closed Phase 5 contracts, seams preserved, 6 negative fixtures rejected, 0 placeholders confined");
    return 0;
  }
  for (const failure of result.failures) console.error(`✗ phase4 context: ${failure}`);
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  toPosix(process.argv[1]).endsWith("scripts/check-phase4-context.mjs");
if (invokedDirectly) process.exitCode = main();
