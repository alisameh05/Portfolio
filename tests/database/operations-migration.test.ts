import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnrevokedFunctions } from "../../scripts/database-baseline-support.mjs";

const ROOT = process.cwd();

describe("Phase 3 operations persistence migration (#50-#53)", () => {
  const migrationFiles = readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrations = migrationFiles
    .map((file) => readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"))
    .join("\n")
    .toLowerCase();

  it.each(["idempotency_records", "outbox_events", "jobs"])(
    "creates and force-protects operations.%s",
    (table) => {
      expect(migrations).toContain(`create table operations.${table}`);
      expect(migrations).toContain(`alter table operations.${table} enable row level security`);
      expect(migrations).toContain(`alter table operations.${table} force row level security`);
    },
  );

  it("enforces deterministic due-work indexes and lease invariants", () => {
    expect(migrations).toMatch(/create index outbox_events_due_idx[\s\S]*available_at[\s\S]*event_id/);
    expect(migrations).toMatch(/create index jobs_due_idx[\s\S]*available_at[\s\S]*job_id/);
    expect(migrations).toContain("lease_token is not null");
    expect(migrations).toContain("attempt_count >= 0");
  });

  it("keeps leased-job identities application-supplied with database-enforced status invariants", () => {
    const operationsMigration = migrationFiles
      .filter((file) => file.includes("create_operations_primitives"))
      .map((file) => readFileSync(join(ROOT, "supabase", "migrations", file), "utf8"))
      .join("\n")
      .toLowerCase();
    expect(operationsMigration).toContain("create table operations.jobs");
    expect(operationsMigration).toContain("job_id uuid primary key");
    expect(operationsMigration).not.toMatch(/job_id\s+uuid\s+(primary key\s+)?default/);
    expect(operationsMigration).not.toMatch(/job_id\s+uuid\s+default/);
    expect(operationsMigration).toContain("status in ('available', 'leased', 'completed')");
    expect(operationsMigration).toContain("status = 'leased'");
    expect(operationsMigration).toContain("status = 'available'");
    expect(operationsMigration).toContain("status = 'completed'");
    expect(operationsMigration).toContain("payload_version integer not null check (payload_version > 0)");
    expect(operationsMigration).toContain("job_type text not null");
    expect(operationsMigration).toContain("payload jsonb not null");
    expect(operationsMigration).toContain("available_at timestamptz not null");
    expect(operationsMigration).toContain("attempt_count integer not null default 0 check (attempt_count >= 0)");
    expect(operationsMigration).toContain("lease_owner text");
    expect(operationsMigration).toContain("lease_token text");
    expect(operationsMigration).toContain("lease_expires_at timestamptz");
    expect(operationsMigration).toContain("completed_at timestamptz");
    expect(operationsMigration).toContain("last_error_code");
  });

  it("keeps public clients and capability roles least-privileged", () => {
    expect(migrations).not.toMatch(/grant\s+.+operations\.(?:idempotency_records|outbox_events|jobs).+to\s+(?:anon|authenticated)/);
    expect(migrations).toContain("to shipwithali_application");
    expect(migrations).toContain("to shipwithali_worker");
    expect(migrations).not.toMatch(/grant\s+(?:all|create).+to\s+shipwithali_(?:application|worker)/);
    expect(migrations).toContain("grant insert on operations.outbox_events to shipwithali_application");
    expect(migrations).not.toMatch(/grant\s+select[^;]*operations\.outbox_events\s+to\s+shipwithali_application/);
    expect(migrations).not.toContain("for all to shipwithali_application");
    expect(migrations).not.toContain("for all to shipwithali_worker");
  });

  it("pairs every created function with an explicit public revoke", () => {
    // PostgreSQL 17 ignores default-privilege entries for new functions, so
    // the migration contract requires an object-level revoke per function.
    expect(findUnrevokedFunctions(migrations)).toEqual([]);
    expect(
      findUnrevokedFunctions(
        "create function operations.report() returns integer language sql immutable as 'select 1'",
      ),
    ).toEqual(["operations.report()"]);
    expect(
      findUnrevokedFunctions(
        `create function operations.report() returns integer language sql immutable as 'select 1';
         revoke all on function operations.report() from public, anon, authenticated;`,
      ),
    ).toEqual([]);
    expect(
      findUnrevokedFunctions(
        `create function operations.report(integer) returns integer language sql immutable as 'select 1';
         create function operations.report(text) returns integer language sql immutable as 'select 1';
         revoke all on function operations.report(integer) from public, anon, authenticated;`,
      ),
    ).toEqual(["operations.report(text)"]);
    expect(
      findUnrevokedFunctions(
        `create function alpha.report() returns integer language sql immutable as 'select 1';
         create function beta.report() returns integer language sql immutable as 'select 1';
         revoke all on function alpha.report() from public, anon, authenticated;`,
      ),
    ).toEqual(["beta.report()"]);
  });
});
