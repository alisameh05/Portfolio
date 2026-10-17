import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

function assertDisposableFixture({ workdir, projectId }) {
  if (!/^shipwithali-phase6-(?:[a-f0-9]{16}|162-[a-f0-9]{12})$/u.test(projectId) ||
      dirname(resolve(workdir)) !== resolve(tmpdir()) || !basename(workdir).startsWith("shipwithali-phase6-") ||
      !readFileSync(join(workdir, "supabase", "config.toml"), "utf8").includes(`project_id = "${projectId}"`)) {
    throw new Error("PHASE6_MIGRATION_BOOTSTRAP_SCOPE_INVALID");
  }
}

function docker(args, stage) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`PHASE6_MIGRATION_BOOTSTRAP_${stage}_FAILED`);
  return result.stdout.trim();
}

// Only the generated disposable project's migration executor is elevated.
// Application/Worker roles and deployed Supabase projects are never targets.
export function withPhase6MigrationExecutor(fixture, run) {
  assertDisposableFixture(fixture);
  const container = `supabase_db_${fixture.projectId}`;
  const projectLabel = docker(["inspect", "--format", '{{index .Config.Labels "com.supabase.cli.project"}}', container], "CONTAINER");
  if (projectLabel !== fixture.projectId) throw new Error("PHASE6_MIGRATION_BOOTSTRAP_CONTAINER_MISMATCH");
  const query = (sql, stage) => docker(["exec", container, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", "-Atc", sql], stage);
  const originallySuperuser = query("select rolsuper from pg_roles where rolname = 'postgres'", "ROLE_QUERY");
  if (!["t", "f"].includes(originallySuperuser)) throw new Error("PHASE6_MIGRATION_BOOTSTRAP_ROLE_INVALID");
  if (originallySuperuser === "f") query("alter role postgres superuser", "ELEVATE");
  const restorePrivilege = () => {
    if (originallySuperuser === "f") query("alter role postgres nosuperuser", "RESTORE");
    if (query("select rolsuper from pg_roles where rolname = 'postgres'", "RESTORE_VERIFY") !== originallySuperuser) {
      throw new Error("PHASE6_MIGRATION_BOOTSTRAP_PRIVILEGE_RESTORE_FAILED");
    }
  };
  try { return run(); }
  finally { restorePrivilege(); }
}

// CLI start normally applies migrations before a local administrator can be
// used. Stage them outside its migration directory until the engine is ready.
export function startPhase6LocalProject(fixture, { start, migrate }) {
  assertDisposableFixture(fixture);
  const migrations = join(fixture.workdir, "supabase", "migrations");
  const staged = join(fixture.workdir, "phase6-pending-migrations");
  renameSync(migrations, staged);
  mkdirSync(migrations);
  try { start(); }
  finally {
    rmdirSync(migrations);
    renameSync(staged, migrations);
  }
  // Create capability roles through the normal CREATEROLE executor first.
  // PostgreSQL grants that creator ADMIN OPTION; creating them as a superuser
  // would skip it and break subsequent restricted-login fixture provisioning.
  const privilegedNames = readdirSync(migrations).filter(name => /^\d{14}_.+\.sql$/u.test(name) &&
    name >= "20261015093040_query_current_interaction_summaries.sql");
  if (privilegedNames.length === 0) return migrate();
  const privileged = join(fixture.workdir, "phase6-privileged-migrations");
  mkdirSync(privileged);
  for (const name of privilegedNames) renameSync(join(migrations, name), join(privileged, name));
  try { migrate(); }
  finally {
    for (const name of privilegedNames) renameSync(join(privileged, name), join(migrations, name));
    rmdirSync(privileged);
  }
  return withPhase6MigrationExecutor(fixture, migrate);
}
