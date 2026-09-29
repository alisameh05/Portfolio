#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { cleanupIsolatedProjects as cleanupProjects, findUnrevokedFunctions } from "./database-baseline-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const DEFAULT_BASELINE_PATH = join(ROOT, "supabase", "baselines", "phase2.json");
const EVIDENCE_PATH = join(ROOT, "evidence", "phase-3-migration-baseline.json");
const CLI_ENTRY = join(ROOT, "node_modules", "supabase", "dist", "supabase.js");

const SCHEMAS = Object.freeze([
  "portfolio_config",
  "content",
  "taxonomy",
  "media",
  "cv",
  "interaction",
  "measurement",
  "identity_access",
  "operations",
  "public_read",
]);

const CAPABILITY_ROLES = Object.freeze([
  "shipwithali_application",
  "shipwithali_worker",
  "shipwithali_migration",
  "shipwithali_backup",
]);

const RESTRICTED_ROLES = Object.freeze([
  "anon",
  "authenticated",
  "shipwithali_application",
  "shipwithali_worker",
  "shipwithali_backup",
]);

const SECRET_PATTERN =
  /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SERVICE_ROLE_KEY)\s*=\s*\S+/i;
const PHASE3_MODE = process.argv.includes("--phase3");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (index !== -1 && (value === undefined || value.startsWith("--"))) {
    throw new Error(`MISSING_ARGUMENT_VALUE_${name.slice(2).toUpperCase()}`);
  }
  return value;
}

const baselineArgument = argumentValue("--baseline");
const BASELINE_PATH = baselineArgument
  ? isAbsolute(baselineArgument)
    ? baselineArgument
    : resolve(ROOT, baselineArgument)
  : DEFAULT_BASELINE_PATH;

function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

function selectedMigrationFiles() {
  if (PHASE3_MODE) return migrationFiles();
  const baseline = baselineMigrationPath().split(/[\\/]/).at(-1);
  return migrationFiles().filter((name) => name <= baseline);
}

function baselineMigrationPath() {
  const paths = migrationFiles().filter((name) =>
    name.endsWith("_establish_database_security_baseline.sql"),
  );
  if (paths.length !== 1) {
    throw new Error("BASELINE_MIGRATION_MISSING");
  }
  return join(MIGRATIONS, paths[0]);
}

function verifySources(baselinePath = BASELINE_PATH) {
  const failures = [];
  if (!existsSync(baselinePath)) {
    failures.push("Phase 2 baseline manifest is missing");
    return failures;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (
    baseline.release !== "phase-2" ||
    baseline.platform !== "local-supabase" ||
    JSON.stringify(baseline.applicationMigrations) !== "[]" ||
    JSON.stringify(baseline.applicationSchemas) !== "[]"
  ) {
    failures.push("Phase 2 baseline must declare zero application migrations and schemas");
  }

  let migrationPath;
  try {
    migrationPath = baselineMigrationPath();
  } catch {
    failures.push("Exactly one timestamped database security baseline migration is required");
    return failures;
  }

  const migration = readFileSync(migrationPath, "utf8");
  const normalized = migration.replace(/\s+/g, " ").toLowerCase();
  const seed = readFileSync(join(ROOT, "supabase", "seed.sql"), "utf8");

  for (const required of [
    "set lock_timeout = '5s';",
    "-- rollback:",
    "-- forward fix:",
    "nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
  ]) {
    if (!normalized.includes(required)) failures.push(`Migration is missing required policy: ${required}`);
  }

  for (const role of CAPABILITY_ROLES) {
    if (!normalized.includes(`'${role}'`)) failures.push(`Capability role ${role} is missing`);
  }

  for (const schema of SCHEMAS) {
    const required = `create schema ${schema} authorization shipwithali_migration;`;
    if (!normalized.includes(required)) failures.push(`${schema} is missing: ${required}`);
  }
  for (const required of [
    "'revoke all on schema %i from public, anon, authenticated'",
    "'revoke all on all tables in schema %i from public, anon, authenticated'",
    "'revoke all on all sequences in schema %i from public, anon, authenticated'",
    "'revoke all on all functions in schema %i from public, anon, authenticated'",
    "'alter default privileges in schema %i revoke all on tables from public, anon, authenticated'",
    "'alter default privileges in schema %i revoke all on sequences from public, anon, authenticated'",
    "'alter default privileges in schema %i revoke all on functions from public, anon, authenticated'",
  ]) {
    if (!normalized.includes(required)) failures.push(`Privilege loop is missing: ${required}`);
  }

  const source = `${migration}\n${seed}`;
  if (/\bcreate\s+(?:unlogged\s+)?table\b/i.test(source)) {
    failures.push("Ticket #46 cannot create production or test tables");
  }
  if (/\b(?:insert\s+into|copy\s+\S+\s+from\s+stdin)\b/i.test(source)) {
    failures.push("Ticket #46 cannot add seed or fixture rows");
  }
  if (/grant .+ to (?:anon|authenticated)/i.test(normalized)) {
    failures.push("anon and authenticated cannot receive application schema access");
  }
  if (SECRET_PATTERN.test(source)) failures.push("Database sources contain credential material");

  const allMigrations = migrationFiles()
    .map((file) => readFileSync(join(MIGRATIONS, file), "utf8"))
    .join("\n");
  for (const name of findUnrevokedFunctions(allMigrations)) {
    failures.push(`Function ${name} is missing an explicit REVOKE from public clients`);
  }

  return failures;
}

function localOnlyEnvironment() {
  const environment = { ...process.env, CI: "1" };
  for (const name of [
    "DATABASE_URL",
    "DATABASE_DIRECT_URL",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_PROJECT_ID",
  ]) {
    delete environment[name];
  }
  return environment;
}

function runLocalCommand(workdir, args, errorCode) {
  if (!existsSync(CLI_ENTRY)) throw new Error("LOCAL_SUPABASE_CLI_MISSING");
  try {
    return execFileSync(process.execPath, [CLI_ENTRY, "--workdir", workdir, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: localOnlyEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error(errorCode);
  }
}

function readLocalDatabaseUrl(workdir) {
  const output = runLocalCommand(
    workdir,
    ["status", "--output", "json"],
    "LOCAL_DB_UNAVAILABLE",
  );

  const jsonStart = output.indexOf("{");
  const status = JSON.parse(output.slice(jsonStart));
  const connectionString = status.DB_URL ?? status.db_url;
  if (typeof connectionString !== "string") throw new Error("LOCAL_DB_URL_MISSING");

  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("LOCAL_DB_URL_NOT_LOOPBACK");
  }
  return url;
}

function isolatedConfig(projectId, basePort) {
  let config = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
  const replacements = new Map([
    ['project_id = "shipwithali-portfolio"', `project_id = "${projectId}"`],
    ["port = 54320", `port = ${basePort}`],
    ["port = 54321", `port = ${basePort + 1}`],
    ["port = 54322", `port = ${basePort + 2}`],
    ["port = 54323", `port = ${basePort + 3}`],
    ["port = 54324", `port = ${basePort + 4}`],
    ["port = 54327", `port = ${basePort + 7}`],
    ["port = 54329", `port = ${basePort + 9}`],
  ]);
  for (const [from, to] of replacements) {
    if (!config.includes(from)) throw new Error("LOCAL_CONFIG_PORT_LAYOUT_CHANGED");
    config = config.replace(from, to);
  }
  return config;
}

function copyRepositoryMigrations(workdir) {
  const destination = join(workdir, "supabase", "migrations");
  for (const file of selectedMigrationFiles()) {
    copyFileSync(join(MIGRATIONS, file), join(destination, file));
  }
}

function createIsolatedWorkdir(kind, basePort, includeMigrations) {
  const projectPrefix =
    kind === "upgrade" ? "shipwithali-46-upgrade" : "shipwithali-46-clean";
  const projectId = `${projectPrefix}-${process.pid}`;
  const workdir = mkdtempSync(join(tmpdir(), `${projectId}-`));
  try {
    const supabase = join(workdir, "supabase");
    mkdirSync(join(supabase, "migrations"), { recursive: true });
    writeFileSync(
      join(supabase, "config.toml"),
      isolatedConfig(projectId, basePort),
      "utf8",
    );
    writeFileSync(
      join(supabase, "seed.sql"),
      `-- ${kind} verification contains no application seed data.\n`,
      "utf8",
    );
    if (includeMigrations) copyRepositoryMigrations(workdir);
    return { projectId, workdir };
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true });
    throw error;
  }
}

function cleanupIsolatedProjects(projects) {
  return cleanupProjects(projects, {
    stop: (project) => {
      runLocalCommand(
        project.workdir,
        ["stop", "--project-id", project.projectId, "--no-backup"],
        "LOCAL_DB_STOP_FAILED",
      );
    },
    remove: (workdir) => rmSync(workdir, { recursive: true, force: true }),
  });
}

async function assertPriorBaseline(baseUrl) {
  const client = new Client({ connectionString: baseUrl.toString() });
  await client.connect();
  try {
    const schemas = await client.query(
      "select nspname from pg_namespace where nspname = any($1::text[]) order by nspname",
      [SCHEMAS],
    );
    if (schemas.rowCount !== 0) throw new Error("PHASE2_BASELINE_CONTAINS_APPLICATION_SCHEMAS");

    const markers = await client.query(
      `select to_regclass('supabase_migrations.schema_migrations') is not null as migrations,
              to_regclass('auth.users') is not null as auth,
              to_regclass('storage.objects') is not null as storage`,
    );
    const marker = markers.rows[0];
    if (!marker?.migrations || !marker.auth || !marker.storage) {
      throw new Error("PHASE2_BASELINE_IS_NOT_INITIALIZED_SUPABASE");
    }

    const migrations = await client.query(
      "select version from supabase_migrations.schema_migrations order by version",
    );
    if (migrations.rowCount !== 0) {
      throw new Error("PHASE2_BASELINE_CONTAINS_APPLICATION_MIGRATIONS");
    }

    const roles = await client.query(
      "select rolname from pg_roles where rolname = any($1::text[]) order by rolname",
      [CAPABILITY_ROLES],
    );
    if (roles.rowCount !== 0) throw new Error("PHASE2_BASELINE_CONTAINS_CAPABILITY_ROLES");
  } finally {
    await client.end();
  }
}

async function verifyFutureDefaults(baseUrl) {
  const client = new Client({ connectionString: baseUrl.toString() });
  await client.connect();
  try {
    await client.query("set role shipwithali_migration");
    for (const schema of SCHEMAS) {
      await client.query(`create table ${schema}.__privilege_probe (id integer)`);
      await client.query(`create sequence ${schema}.__privilege_probe_sequence`);
      await client.query(
        `create function ${schema}.__privilege_probe_function() returns integer language sql immutable as 'select 1'`,
      );
    }
    await client.query("reset role");

    const privileges = await client.query(
      `select role_name, schema_name,
              has_table_privilege(role_name, schema_name || '.__privilege_probe', 'SELECT') as table_select,
              has_sequence_privilege(role_name, schema_name || '.__privilege_probe_sequence', 'USAGE') as sequence_usage,
              has_function_privilege(role_name, schema_name || '.__privilege_probe_function()', 'EXECUTE') as function_execute
         from unnest($1::text[]) role_name
        cross join unnest($2::text[]) schema_name
        order by role_name, schema_name`,
      [RESTRICTED_ROLES, SCHEMAS],
    );
    if (
      privileges.rows.some(
        (row) => row.table_select || row.sequence_usage || row.function_execute,
      )
    ) {
      throw new Error("FUTURE_OBJECT_DEFAULT_PRIVILEGE_IS_NOT_RESTRICTIVE");
    }
  } finally {
    try {
      await client.query("reset role");
      await client.query("set role shipwithali_migration");
      for (const schema of SCHEMAS) {
        await client.query(`drop table if exists ${schema}.__privilege_probe`);
        await client.query(`drop sequence if exists ${schema}.__privilege_probe_sequence`);
        await client.query(`drop function if exists ${schema}.__privilege_probe_function()`);
      }
      await client.query("reset role");
    } finally {
      await client.end();
    }
  }
}

async function snapshot(baseUrl) {
  const client = new Client({ connectionString: baseUrl.toString() });
  await client.connect();
  try {
    const schemas = await client.query(
      `select n.nspname as schema, pg_get_userbyid(n.nspowner) as owner
         from pg_namespace n
        where n.nspname = any($1::text[])
        order by n.nspname`,
      [SCHEMAS],
    );
    const roles = await client.query(
      `select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
         from pg_roles
        where rolname = any($1::text[])
        order by rolname`,
      [CAPABILITY_ROLES],
    );
    const privileges = await client.query(
      `select role_name, schema_name,
              has_schema_privilege(role_name, schema_name, 'USAGE') as has_usage,
              has_schema_privilege(role_name, schema_name, 'CREATE') as has_create
         from unnest($1::text[]) role_name
        cross join unnest($2::text[]) schema_name
        order by role_name, schema_name`,
      [RESTRICTED_ROLES, SCHEMAS],
    );
    const defaults = await client.query(
      `select n.nspname as schema, d.defaclobjtype as object_type,
              coalesce(grantee.rolname, 'PUBLIC') as grantee, x.privilege_type
         from pg_default_acl d
         join pg_namespace n on n.oid = d.defaclnamespace
         cross join lateral aclexplode(d.defaclacl) x
         left join pg_roles grantee on grantee.oid = x.grantee
        where d.defaclrole = (select oid from pg_roles where rolname = 'shipwithali_migration')
          and n.nspname = any($1::text[])
        order by n.nspname, d.defaclobjtype, grantee, x.privilege_type`,
      [SCHEMAS],
    );
    const objects = await client.query(
      `select n.nspname as schema, c.relname as name, c.relkind as kind,
              pg_get_userbyid(c.relowner) as owner
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any($1::text[])
        order by n.nspname, c.relname, c.relkind`,
      [SCHEMAS],
    );
    const migrations = await client.query(
      "select version from supabase_migrations.schema_migrations order by version",
    );

    if (schemas.rowCount !== SCHEMAS.length) throw new Error("APPLICATION_SCHEMA_COUNT_MISMATCH");
    if (roles.rowCount !== CAPABILITY_ROLES.length) throw new Error("CAPABILITY_ROLE_COUNT_MISMATCH");
    if (schemas.rows.some((row) => row.owner !== "shipwithali_migration")) {
      throw new Error("APPLICATION_SCHEMA_OWNER_MISMATCH");
    }
    if (
      roles.rows.some(
        (row) =>
          row.rolcanlogin ||
          row.rolsuper ||
          row.rolcreatedb ||
          row.rolcreaterole ||
          row.rolreplication ||
          row.rolbypassrls,
      )
    ) {
      throw new Error("CAPABILITY_ROLE_IS_OVERPRIVILEGED");
    }
    if (
      privileges.rows.some((row) => {
        if (!PHASE3_MODE) return row.has_usage || row.has_create;
        const expectedUsage =
          row.schema_name === "operations" &&
          [
            "shipwithali_application",
            "shipwithali_worker",
            "shipwithali_backup",
          ].includes(row.role_name);
        return row.has_create || row.has_usage !== expectedUsage;
      })
    ) {
      throw new Error("CAPABILITY_SCHEMA_ACCESS_MISMATCH");
    }
    if (defaults.rows.some((row) => row.grantee === "PUBLIC")) {
      throw new Error("PUBLIC_HAS_DEFAULT_OBJECT_PRIVILEGES");
    }

    return {
      schemas: schemas.rows,
      roles: roles.rows,
      privileges: privileges.rows,
      defaultPrivileges: defaults.rows,
      objects: objects.rows,
      migrationVersions: migrations.rows.map((row) => row.version),
    };
  } finally {
    await client.end();
  }
}

async function verifyLocal() {
  const basePort = 54000 + (process.pid % 500) * 20;
  const projects = [];
  let evidence;
  let primaryError;

  try {
    const upgradeProject = createIsolatedWorkdir("upgrade", basePort, false);
    projects.push(upgradeProject);
    const cleanProject = createIsolatedWorkdir("clean", basePort + 10, true);
    projects.push(cleanProject);

    runLocalCommand(upgradeProject.workdir, ["start"], "UPGRADE_DB_START_FAILED");
    const upgradeUrl = readLocalDatabaseUrl(upgradeProject.workdir);
    await assertPriorBaseline(upgradeUrl);

    copyRepositoryMigrations(upgradeProject.workdir);
    runLocalCommand(
      upgradeProject.workdir,
      ["migration", "up", "--local"],
      "UPGRADE_MIGRATION_FAILED",
    );
    await verifyFutureDefaults(upgradeUrl);
    const upgrade = await snapshot(upgradeUrl);

    runLocalCommand(
      upgradeProject.workdir,
      ["migration", "up", "--local"],
      "UPGRADE_MIGRATION_REPLAY_FAILED",
    );
    const replayedUpgrade = await snapshot(upgradeUrl);
    if (JSON.stringify(replayedUpgrade) !== JSON.stringify(upgrade)) {
      throw new Error("UPGRADE_MIGRATION_IS_NOT_NOOP");
    }

    runLocalCommand(cleanProject.workdir, ["start"], "CLEAN_DB_START_FAILED");
    runLocalCommand(
      cleanProject.workdir,
      ["db", "reset", "--local"],
      "CLEAN_DB_RESET_FAILED",
    );
    const cleanUrl = readLocalDatabaseUrl(cleanProject.workdir);
    await verifyFutureDefaults(cleanUrl);
    const clean = await snapshot(cleanUrl);

    const expectedVersions = selectedMigrationFiles().map((name) => name.slice(0, 14));
    if (
      JSON.stringify(upgrade.migrationVersions) !== JSON.stringify(expectedVersions) ||
      JSON.stringify(clean.migrationVersions) !== JSON.stringify(expectedVersions)
    ) {
      throw new Error("MIGRATION_HISTORY_MISMATCH");
    }
    if (JSON.stringify(clean) !== JSON.stringify(upgrade)) {
      throw new Error("CLEAN_AND_UPGRADE_BASELINES_DIFFER");
    }

    const migrationPath = baselineMigrationPath();
    evidence = {
      ticket: PHASE3_MODE ? 54 : 46,
      parent: 44,
      scope: PHASE3_MODE
        ? "phase-3-complete-migration-equivalence"
        : "phase-3-migration-security-baseline",
      baseline: "phase-2",
      migration: migrationPath.slice(MIGRATIONS.length + 1),
      migrationSha256: createHash("sha256")
        .update(readFileSync(migrationPath))
        .digest("hex"),
      schemas: SCHEMAS,
      capabilityRoles: CAPABILITY_ROLES,
      migrationVersions: clean.migrationVersions,
      migrationChecksums: selectedMigrationFiles().map((file) => ({
        file,
        sha256: createHash("sha256").update(readFileSync(join(MIGRATIONS, file))).digest("hex"),
      })),
      applicationObjectCount: clean.objects.length,
      cleanUpgradeEquivalent: true,
      migrationReplayNoop: true,
      isolatedProjects: true,
      remoteCredentialsRequired: false,
    };
  } catch (error) {
    primaryError = error;
  }

  const cleanupFailures = cleanupIsolatedProjects(projects);
  if (cleanupFailures.length > 0) {
    if (primaryError) {
      console.error(
        "! LOCAL_DB_CLEANUP_FAILED: isolated project metadata retained for recovery",
      );
    } else {
      throw new Error("LOCAL_DB_CLEANUP_FAILED");
    }
  }

  if (primaryError) throw primaryError;
  return evidence;
}

async function main() {
  const sourceOnly = process.argv.includes("--source-only");
  const local = process.argv.includes("--local");
  const checkOnly = process.argv.includes("--check-only");

  try {
    const failures = verifySources();
    if (failures.length > 0) {
      for (const failure of failures) console.error(`✗ ${failure}`);
      process.exitCode = 1;
    } else {
      console.log("✓ Phase 3 migration baseline source verification passed");
      if (local) {
        const localEvidence = await verifyLocal();
        if (!checkOnly) {
          mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
          writeFileSync(EVIDENCE_PATH, `${JSON.stringify(localEvidence, null, 2)}\n`, "utf8");
        }
        console.log(
          `✓ Clean and Phase 2 baseline upgrades produced equivalent ${
            PHASE3_MODE ? "complete Phase 3" : "security-baseline"
          } database state`,
        );
      } else if (!sourceOnly) {
        throw new Error("VERIFICATION_MODE_REQUIRED");
      }
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "DATABASE_BASELINE_CHECK_FAILED";
    const safe = /^[A-Z0-9_]+$/.test(code) ? code : "DATABASE_BASELINE_CHECK_FAILED";
    console.error(`✗ ${safe}: local migration verification failed without exposing provider output`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) await main();
