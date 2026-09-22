#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE_PATH = join(ROOT, "evidence", "phase-3-database-toolchain.json");

const EXPECTED = Object.freeze({
  dependencies: {
    kysely: "0.29.6",
    pg: "8.23.0",
  },
  devDependencies: {
    "@types/pg": "8.23.1",
    "kysely-codegen": "0.20.0",
    supabase: "2.117.0",
  },
});

const EXPECTED_SCRIPTS = Object.freeze({
  "db:verify": "node scripts/check-database-toolchain.mjs",
  "db:start": "node scripts/local-database.mjs start",
  "db:status": "node scripts/local-database.mjs status",
  "db:reset": "node scripts/local-database.mjs reset",
  "db:reuse": "node scripts/local-database.mjs reuse",
  "db:stop": "node scripts/local-database.mjs stop",
});

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function installedVersion(root, name) {
  const path = join(root, "node_modules", ...name.split("/"), "package.json");
  return existsSync(path) ? readJson(path).version : undefined;
}

function verify(root = ROOT) {
  const failures = [];
  const packageJson = readJson(join(root, "package.json"));
  const lockfile = readJson(join(root, "package-lock.json"));
  const lockRoot = lockfile.packages?.[""] ?? {};
  const actual = {};

  for (const [section, pins] of Object.entries(EXPECTED)) {
    for (const [name, expectedVersion] of Object.entries(pins)) {
      const declared = packageJson[section]?.[name];
      const lockedDeclaration = lockRoot[section]?.[name];
      const lockedVersion = lockfile.packages?.[`node_modules/${name}`]?.version;
      const installed = installedVersion(root, name);
      actual[name] = installed ?? "missing";

      if (declared !== expectedVersion) {
        failures.push(`${name}: package.json must pin ${expectedVersion}, found ${declared ?? "missing"}`);
      }
      if (lockedDeclaration !== expectedVersion || lockedVersion !== expectedVersion) {
        failures.push(`${name}: package-lock.json must resolve exactly ${expectedVersion}`);
      }
      if (installed !== expectedVersion) {
        failures.push(`${name}: installed ${installed ?? "missing"} must equal ${expectedVersion}`);
      }
    }
  }

  for (const [name, expectedCommand] of Object.entries(EXPECTED_SCRIPTS)) {
    if (packageJson.scripts?.[name] !== expectedCommand) {
      failures.push(`${name}: package script must be ${expectedCommand}`);
    }
  }

  for (const requiredPath of [
    "supabase/config.toml",
    "supabase/seed.sql",
    "supabase/migrations/.gitkeep",
    "scripts/local-database.mjs",
    "docs/phase3-local-database.md",
  ]) {
    if (!existsSync(join(root, requiredPath))) {
      failures.push(`${requiredPath}: required repository-owned local database artifact is missing`);
    }
  }

  const cliEntry = join(root, "node_modules", "supabase", "dist", "supabase.js");
  let cliVersion = "missing";
  if (!existsSync(cliEntry)) {
    failures.push("project-local Supabase CLI entrypoint is missing; run npm ci");
  } else {
    try {
      cliVersion = execFileSync(process.execPath, [cliEntry, "--version"], {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, CI: "1" },
      }).trim();
    } catch {
      failures.push("project-local Supabase CLI could not report its version");
    }
    if (cliVersion !== EXPECTED.devDependencies.supabase) {
      failures.push(
        `project-local Supabase CLI reports ${cliVersion}; expected ${EXPECTED.devDependencies.supabase}`,
      );
    }
  }

  return {
    failures,
    evidence: {
      ticket: 45,
      parent: 44,
      scope: "phase-3-local-postgresql-toolchain",
      node: packageJson.engines?.node,
      packageManager: packageJson.packageManager,
      expected: { ...EXPECTED.dependencies, ...EXPECTED.devDependencies },
      installed: actual,
      supabaseCli: cliVersion,
      commandSource: "project-local node_modules/supabase/dist/supabase.js",
      remoteCredentialsRequired: false,
    },
  };
}

const checkOnly = process.argv.includes("--check-only");
const { failures, evidence } = verify();
if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  console.error(`✗ Phase 3 database toolchain verification failed (${failures.length} check(s))`);
  process.exitCode = 1;
} else {
  if (!checkOnly) {
    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  console.log("✓ Phase 3 database toolchain verification passed");
  console.log(`✓ Supabase CLI ${evidence.supabaseCli} resolved from the project lockfile`);
}
