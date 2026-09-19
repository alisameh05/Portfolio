#!/usr/bin/env node
/**
 * check-toolchain.mjs
 *
 * Phase 1 toolchain verification (#12).
 *
 * Verifies that the pinned runtime and development toolchain declared in
 * `package.json`, `.nvmrc`, and `docs/phase1-versions.md` are consistent, and
 * records the effective versions to `evidence/phase-1-versions.json`.
 *
 * Pin files (fail on mismatch):
 *   - `.nvmrc` must equal `package.json#engines.node`
 *   - `package.json#packageManager` must equal `npm@<engines.npm>`
 *   - installed `typescript`, `@redocly/cli`, `@hey-api/openapi-ts`,
 *     `vitest`, `dependency-cruiser`, `zod`, `valibot`, `uuidv7` must equal
 *     the exact versions in `package.json#devDependencies`
 *   - `docs/phase1-versions.md` must exist and mention every pinned package
 *
 * Runtime observation (recorded, warn-only):
 *   - current `process.version` and `npm --version` are recorded. A major
 *     Node mismatch against the pinned 24.21.0 LTS is reported as a warning
 *     so the gate remains runnable on Windows dev machines, while CI uses
 *     the exact pinned runtime.
 *
 * Exits non-zero when any pin check fails. Emits no network, database, or
 * credential access.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE_PATH = join(ROOT, "evidence", "phase-1-versions.json");

const require = createRequire(import.meta.url);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function installedVersion(packageName) {
  try {
    // Read node_modules/<pkg>/package.json directly: `require("<pkg>/package.json")`
    // fails for packages with restrictive `exports` maps (dependency-cruiser,
    // valibot, uuidv7). Direct file read is deterministic and offline.
    const pkgPath = join(ROOT, "node_modules", ...packageName.split("/"), "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version;
  } catch {
    return undefined;
  }
}

function npmVersion() {
  try {
    return execSync("npm --version", { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

export function verifyToolchain(root = ROOT) {
  const failures = [];
  const warnings = [];

  const pkg = readJson(join(root, "package.json"));
  const nvmrc = existsSync(join(root, ".nvmrc"))
    ? readFileSync(join(root, ".nvmrc"), "utf8").trim()
    : undefined;

  const expectedNode = pkg.engines?.node;
  const expectedNpm = pkg.engines?.npm;
  const expectedPackageManager = pkg.packageManager;

  if (!expectedNode) failures.push("package.json#engines.node is missing");
  if (!expectedNpm) failures.push("package.json#engines.npm is missing");
  if (nvmrc !== expectedNode) {
    failures.push(`.nvmrc (${nvmrc ?? "missing"}) must equal engines.node (${expectedNode ?? "missing"})`);
  }
  if (expectedPackageManager !== `npm@${expectedNpm}`) {
    failures.push(
      `package.json#packageManager (${expectedPackageManager ?? "missing"}) must equal npm@${expectedNpm ?? "missing"}`,
    );
  }

  const pinned = pkg.devDependencies ?? {};
  const packagesToVerify = [
    "typescript",
    "@redocly/cli",
    "@hey-api/openapi-ts",
    "vitest",
    "dependency-cruiser",
    "zod",
    "valibot",
    "uuidv7",
  ];
  const effective = {};
  for (const name of packagesToVerify) {
    const expected = pinned[name];
    const actual = installedVersion(name);
    effective[name] = actual ?? "missing";
    if (!expected) {
      failures.push(`package.json#devDependencies[${name}] is missing`);
    } else if (actual !== expected) {
      failures.push(`${name}: installed ${actual ?? "missing"} must equal pinned ${expected}`);
    }
  }

  const versionsDoc = join(root, "docs", "phase1-versions.md");
  if (!existsSync(versionsDoc)) {
    failures.push("docs/phase1-versions.md not found");
  } else {
    const doc = readFileSync(versionsDoc, "utf8");
    for (const name of packagesToVerify) {
      if (!doc.includes(name) || !doc.includes(pinned[name] ?? "")) {
        failures.push(`docs/phase1-versions.md must record ${name}@${pinned[name] ?? "missing"}`);
      }
    }
  }

  const runtime = {
    node: process.version,
    npm: npmVersion() ?? "unknown",
  };
  if (expectedNode && !runtime.node.startsWith(`v${expectedNode.split(".")[0]}.`)) {
    warnings.push(
      `runtime ${runtime.node} differs from pinned Node ${expectedNode}; CI uses ${expectedNode}`,
    );
  }

  const manifest = {
    ticket: 12,
    parent: 1,
    pinned: {
      node: expectedNode,
      npm: expectedNpm,
      packageManager: expectedPackageManager,
      ...Object.fromEntries(packagesToVerify.map((name) => [name, pinned[name]])),
    },
    effective: {
      ...runtime,
      ...effective,
    },
    warnings,
  };

  return { failures, warnings, manifest };
}

export function main(argv = process.argv.slice(2)) {
  const outputIndex = argv.indexOf("--output");
  const outputPath = outputIndex === -1 ? EVIDENCE_PATH : join(ROOT, argv[outputIndex + 1]);
  const { failures, warnings, manifest } = verifyToolchain();

  for (const warning of warnings) console.warn(`! toolchain warning: ${warning}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`✗ toolchain: ${failure}`);
    console.error(`✗ toolchain verification: ${failures.length} check(s) FAILED`);
    return 1;
  }

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`✓ toolchain verification: pinned Node ${manifest.pinned.node}, npm ${manifest.pinned.npm}`);
  console.log(`✓ dependency/version manifest written to ${outputPath.replace(`${ROOT}\\`, "").replace(`${ROOT}/`, "")}`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].split("\\").join("/").endsWith("scripts/check-toolchain.mjs");
if (invokedDirectly) {
  process.exitCode = main();
}
