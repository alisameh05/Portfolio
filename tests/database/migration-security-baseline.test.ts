import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertBaselineSnapshotsEquivalent,
  assertPhase3Rls,
  cleanupIsolatedProjects,
  cleanupProbeRole,
  isPhase2BaselineMarkers,
} from "../../scripts/database-baseline-support.mjs";

const ROOT = process.cwd();
const MIGRATIONS = join(ROOT, "supabase", "migrations");

function migrationFiles() {
  return readdirSync(MIGRATIONS).filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name));
}

function migrationSource() {
  const files = migrationFiles().filter((name) =>
    name.endsWith("_establish_database_security_baseline.sql"),
  );
  expect(files).toHaveLength(1);
  return readFileSync(join(MIGRATIONS, files[0]!), "utf8");
}

function runNode(...args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
}

describe("Phase 3 migration and security baseline (#46)", () => {
  it("fails closed when an expected Phase 3 table is missing or lacks forced RLS", () => {
    const requiredTables = [
      { schema: "operations", name: "idempotency_records", kind: "r", rls_enabled: true, rls_forced: true },
      { schema: "operations", name: "outbox_events", kind: "r", rls_enabled: true, rls_forced: true },
      { schema: "operations", name: "jobs", kind: "r", rls_enabled: true, rls_forced: true },
    ];

    expect(() => assertPhase3Rls(requiredTables.slice(0, 2))).toThrow(
      "PHASE3_EXPECTED_TABLE_MISSING",
    );
    expect(() =>
      assertPhase3Rls(requiredTables.map((table) =>
        table.name === "jobs" ? { ...table, rls_forced: false } : table,
      )),
    ).toThrow("PHASE3_TABLE_RLS_NOT_ENFORCED");
    expect(() =>
      assertPhase3Rls(requiredTables.map((table) =>
        table.name === "jobs" ? { ...table, rls_enabled: false } : table,
      )),
    ).toThrow("PHASE3_TABLE_RLS_NOT_ENFORCED");
  });

  it("fails closed when a disposable probe role cannot be dropped", async () => {
    const statements: string[] = [];
    await expect(
      cleanupProbeRole({
        admin: {
          async query(statement: string) {
            statements.push(statement);
            if (statement.startsWith("drop role")) throw new Error("injected drop failure");
          },
          async end() {},
        },
        probe: { async end() {} },
        login: "phase3_verify_test",
        role: "shipwithali_application",
      }),
    ).rejects.toThrow("PROBE_ROLE_CLEANUP_FAILED");

    expect(statements).toEqual([
      'revoke shipwithali_application from "phase3_verify_test"',
      'alter role "phase3_verify_test" nologin',
      'drop role if exists "phase3_verify_test"',
    ]);
  });

  it("ships one reviewed timestamped migration with bounded locking and recovery guidance", () => {
    const migration = migrationSource();
    expect(migration).toMatch(/^-- Phase 3 database security baseline/m);
    expect(migration).toMatch(/^set lock_timeout = '5s';$/m);
    expect(migration).toMatch(/^-- Rollback:/m);
    expect(migration).toMatch(/^-- Forward fix:/m);
  });

  it("creates only passwordless least-privilege capability roles", () => {
    const migration = migrationSource().replace(/\s+/g, " ").toLowerCase();

    for (const role of [
      "shipwithali_application",
      "shipwithali_worker",
      "shipwithali_migration",
      "shipwithali_backup",
    ]) {
      expect(migration).toContain(`'${role}'`);
    }
    expect(migration).toContain(
      "nologin nosuperuser nocreatedb nocreaterole noreplication nobypassrls",
    );
    expect(migration).not.toMatch(/\b(?:login|password)\s+'[^']+'/);
  });

  it("creates the declared schemas under migration ownership and records logical owners", () => {
    const migration = migrationSource().toLowerCase();
    const schemaOwners = {
      portfolio_config: "portfolio configuration",
      content: "content and publishing",
      taxonomy: "taxonomy and discovery",
      media: "media",
      cv: "cv portfolio",
      interaction: "interaction and moderation",
      measurement: "measurement",
      identity_access: "identity and access",
      operations: "portability and operations",
      public_read: "producing module",
    } as const;

    for (const [schema, owner] of Object.entries(schemaOwners)) {
      expect(migration).toMatch(
        new RegExp(`create schema ${schema} authorization shipwithali_migration;`),
      );
      expect(migration).toMatch(
        new RegExp(`comment on schema ${schema} is '[^']*${owner}[^']*';`),
      );
    }
  });

  it("denies implicit schema and future-object access", () => {
    const migration = migrationSource().replace(/\s+/g, " ").toLowerCase();

    expect(migration).toContain(
      "'revoke all on schema %i from public, anon, authenticated'",
    );
    for (const objectType of ["tables", "sequences", "functions"]) {
      expect(migration).toContain(
        `'revoke all on all ${objectType} in schema %i from public, anon, authenticated'`,
      );
      expect(migration).toContain(
        `'alter default privileges in schema %i revoke all on ${objectType} from public, anon, authenticated'`,
      );
    }

    expect(migration).not.toMatch(/grant .+ to (?:anon|authenticated)/);
  });

  it("records Phase 2 as an initialized local baseline with no application migrations", () => {
    const baseline = JSON.parse(
      readFileSync(join(ROOT, "supabase", "baselines", "phase2.json"), "utf8"),
    ) as {
      release: string;
      platform: string;
      applicationMigrations: unknown[];
      applicationSchemas: unknown[];
    };

    expect(baseline).toEqual({
      release: "phase-2",
      platform: "local-supabase",
      applicationMigrations: [],
      applicationSchemas: [],
    });
  });

  it("keeps migrations and seeds free of later-phase data and credentials", () => {
    const source = `${migrationSource()}\n${readFileSync(join(ROOT, "supabase", "seed.sql"), "utf8")}`;

    expect(source).not.toMatch(/\bcreate\s+(?:unlogged\s+)?table\b/i);
    expect(source).not.toMatch(/\b(?:insert\s+into|copy\s+\S+\s+from\s+stdin)\b/i);
    expect(source).not.toMatch(
      /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SERVICE_ROLE_KEY)\s*=\s*\S+/i,
    );
  });

  it("exposes offline and live clean-versus-upgrade verification commands", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const guide = readFileSync(join(ROOT, "docs", "phase3-local-database.md"), "utf8");

    expect(packageJson.scripts).toMatchObject({
      "db:baseline:verify": "node scripts/check-database-baseline.mjs --source-only",
      "db:baseline:test": "node scripts/check-database-baseline.mjs --local",
    });
    expect(guide).toContain("npm run db:baseline:verify");
    expect(guide).toContain("npm run db:baseline:test");
  });

  it("passes the focused offline baseline verifier without exposing credentials", () => {
    const result = runNode("scripts/check-database-baseline.mjs", "--source-only", "--check-only");
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(output).toContain("Phase 3 migration baseline source verification passed");
    expect(output).not.toMatch(
      /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SERVICE_ROLE_KEY)\s*=\s*\S+/i,
    );
  });

  it("uses isolated Supabase projects for clean and upgrade verification", () => {
    const verifier = readFileSync(
      join(ROOT, "scripts", "check-database-baseline.mjs"),
      "utf8",
    );

    expect(verifier).toContain("shipwithali-46-upgrade");
    expect(verifier).toContain("shipwithali-46-clean");
    expect(verifier).toContain('["migration", "up", "--local"]');
    expect(verifier).toContain('["db", "reset", "--local"]');
    expect(verifier).toContain("migrationVersions");
    expect(verifier).not.toMatch(/drop\s+role/i);
  });

  it("retains recovery metadata and attempts every isolated-project cleanup", () => {
    const upgradeWorkdir = mkdtempSync(join(tmpdir(), "shipwithali-cleanup-upgrade-"));
    const cleanWorkdir = mkdtempSync(join(tmpdir(), "shipwithali-cleanup-clean-"));
    const attempted: string[] = [];
    const projects = [
      { projectId: "shipwithali-46-upgrade-test", workdir: upgradeWorkdir },
      { projectId: "shipwithali-46-clean-test", workdir: cleanWorkdir },
    ];

    try {
      const failures = cleanupIsolatedProjects(projects, {
        stop(project: { projectId: string; workdir: string }) {
          attempted.push(project.projectId);
          if (project.projectId.includes("upgrade")) throw new Error("injected stop failure");
        },
        remove(workdir: string) {
          rmSync(workdir, { recursive: true, force: true });
        },
      });

      expect(attempted).toEqual([
        "shipwithali-46-clean-test",
        "shipwithali-46-upgrade-test",
      ]);
      expect(failures).toEqual(["shipwithali-46-upgrade-test"]);
      expect(existsSync(cleanWorkdir)).toBe(false);
      expect(existsSync(upgradeWorkdir)).toBe(true);
      expect(verifierTargetsNormalProject(attempted)).toBe(false);
    } finally {
      rmSync(upgradeWorkdir, { recursive: true, force: true });
      rmSync(cleanWorkdir, { recursive: true, force: true });
    }
  });

  it("accepts an initialized baseline with storage disabled and rejects drifted markers", () => {
    // Local topology disables Storage but keeps auth platform tables;
    // storage.objects must stay absent (see supabase/config.toml). The
    // migration-history table may be absent before the first `migration up`,
    // so empty history is verified separately from platform markers.
    expect(isPhase2BaselineMarkers({ auth: true, storage: false })).toBe(true);
    expect(isPhase2BaselineMarkers({ auth: true, storage: true })).toBe(false);
    expect(isPhase2BaselineMarkers({ auth: false, storage: false })).toBe(false);
  });

  it("proves clean and upgrade equivalence covers policies, indexes, and functions", () => {
    const verifier = readFileSync(
      join(ROOT, "scripts", "check-database-baseline.mjs"),
      "utf8",
    );
    expect(verifier).toContain("pg_policies");
    expect(verifier).toContain("pg_indexes");
    expect(verifier).toContain("pg_proc");
    // PostgreSQL 17 keeps PUBLIC EXECUTE on new functions, so the privilege
    // probe follows the production pattern (create + explicit revoke).
    expect(verifier).toContain("revoke all on function");
  });

  it("rejects a prior-release baseline that contains application state", () => {
    const directory = mkdtempSync(join(tmpdir(), "shipwithali-invalid-phase2-baseline-"));
    const baselinePath = join(directory, "phase2.json");
    writeFileSync(
      baselinePath,
      JSON.stringify({
        release: "phase-2",
        platform: "local-supabase",
        applicationMigrations: ["unexpected"],
        applicationSchemas: ["content"],
      }),
      "utf8",
    );

    try {
      const result = runNode(
        "scripts/check-database-baseline.mjs",
        "--source-only",
        "--check-only",
        "--baseline",
        baselinePath,
      );
      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "Phase 2 baseline must declare zero application migrations and schemas",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function verifierTargetsNormalProject(projectIds: string[]) {
  return projectIds.includes("shipwithali-portfolio");
}
