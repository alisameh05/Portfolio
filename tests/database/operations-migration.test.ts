import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("Phase 3 operations persistence migration (#50-#53)", () => {
  const migrations = readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((file) => file.endsWith(".sql"))
    .sort()
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
});
