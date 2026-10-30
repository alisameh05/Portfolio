import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { StableId } from "@shared/domain";
import { Kysely, PostgresDialect } from "kysely";
import { buildOperationsSummaryQuery } from "../../src/modules/portability-operations/adapters/postgres-operations-summary.js";
import { Pool } from "pg";
import { Client } from "pg";
import { createPostgresObjectBackupCatalog } from "../../src/modules/portability-operations/adapters/postgres-object-backup-catalog.js";

describe("isolated PostgreSQL object-backup catalog evidence", () => {
  it("applies the migration, limits scope access, and allows the backup role to finalize then commit", async () => {
    const container = `phase8-object-catalog-${randomUUID().replaceAll("-", "")}`;
    const superPassword = `test-${randomUUID()}`;
    const backupPassword = `test-${randomUUID()}`;
    let containerStarted = false;
    let verified = false;
    let admin: Client | undefined, backup: Client | undefined;
    try {
      execFileSync("docker", ["run", "-d", "--rm", "--name", container, "-e", `POSTGRES_PASSWORD=${superPassword}`,
        "-p", "127.0.0.1::5432", "postgres:17-alpine"], { stdio: "ignore" });
      containerStarted = true;
      const mapped = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).trim();
      const port = Number(mapped.slice(mapped.lastIndexOf(":") + 1));
      if (!Number.isSafeInteger(port) || port < 1) throw new Error("OBJECT_BACKUP_POSTGRES_PORT_INVALID");
      for (let attempt = 0; attempt < 90; attempt += 1) {
        try { execFileSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { stdio: "ignore" }); break; }
        catch { if (attempt === 89) throw new Error("OBJECT_BACKUP_POSTGRES_START_FAILED"); await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      admin = new Client({ host: "127.0.0.1", port, user: "postgres", password: superPassword, database: "postgres" });
      await admin.connect();
      await admin.query(`create role shipwithali_migration nologin;
        create role shipwithali_backup login password '${backupPassword}';
        create role shipwithali_application nologin;
        create role shipwithali_worker nologin;
        create role anon nologin;
        create role authenticated nologin;
        create schema operations authorization shipwithali_migration;
        create schema portfolio_config authorization shipwithali_migration;
        grant usage on schema operations to shipwithali_backup, shipwithali_worker, shipwithali_application;
        grant usage on schema portfolio_config to shipwithali_migration;
        set role shipwithali_migration;
        create table portfolio_config.settings (portfolio_id uuid not null, owner_id uuid not null);
        alter table portfolio_config.settings enable row level security;
        alter table portfolio_config.settings force row level security;
        create table operations.incidents (incident_key text primary key, category text not null, owner_role text not null, remediation_pointer text not null);
        alter table operations.incidents enable row level security;
        alter table operations.incidents force row level security;
        create table operations.relational_backup_copies (state text not null, attempted_at timestamptz not null,
          committed_at timestamptz, source_watermark_at timestamptz not null, expires_at timestamptz,
          deletion_acknowledged_at timestamptz);
        alter table operations.relational_backup_copies enable row level security;
        alter table operations.relational_backup_copies force row level security;
        reset role;
        insert into portfolio_config.settings values ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002');
        grant shipwithali_migration to postgres;`);
      const migrationPath = fileURLToPath(new URL("../../supabase/migrations/20261030100000_register_object_backup_copies.sql", import.meta.url));
      await admin.query(readFileSync(migrationPath, "utf8"));
      backup = new Client({ host: "127.0.0.1", port, user: "shipwithali_backup", password: backupPassword, database: "postgres" });
      await backup.connect();
      const scope = await backup.query("select portfolio_id::text,owner_id::text from operations.object_backup_owner_scopes");
      expect(scope.rows).toEqual([{ portfolio_id: "00000000-0000-4000-8000-000000000001", owner_id: "00000000-0000-4000-8000-000000000002" }]);
      await expect(backup.query("select * from portfolio_config.settings")).rejects.toMatchObject({ code: "42501" });

      await admin.query(`create schema portability;
        create table operations.outbox_events(event_id uuid,occurred_at timestamptz,available_at timestamptz,attempt_count int,lease_expires_at timestamptz,completed_at timestamptz,dead_at timestamptz,lease_acquired_at timestamptz);
        create table operations.jobs(job_id uuid,status text,available_at timestamptz,lease_expires_at timestamptz,lease_acquired_at timestamptz);
        create table operations.phase7_schedule_progress(portfolio_id uuid,first_policy_period date,required_through_period date,retention_complete_through date,aggregate_finished_through date,last_complete_period date,phase text);
        create table portability.owner_exports(export_id uuid,portfolio_id uuid,status text,requested_at timestamptz,started_at timestamptz,completed_at timestamptz,failed_at timestamptz,expired_at timestamptz,artifact_content_length bigint);`);
      const compiler = new Kysely({ dialect: new PostgresDialect({ pool: new Pool() }) });
      const summary = buildOperationsSummaryQuery({ portfolioId: "00000000-0000-4000-8000-000000000001" as StableId<"Portfolio">, observedAt: "2026-10-30T01:00:00.000Z", windowSeconds: 86400, maxRows: 1000 }).compile(compiler);
      await compiler.destroy();
      const emptySummary = await admin.query(summary.sql, [...summary.parameters]);
      expect(emptySummary.rows[0].object_backup_watermark_age_hours).toBeNull();
      expect(emptySummary.rows[0].relational_backup_watermark_age_hours).toBeNull();
      const now = "2026-10-30T00:00:00.000Z";
      const attempt = { copyId: randomUUID(), destinationName: "independent-store", objectKey: `objects/${randomUUID()}/catalog.swob`,
        keyVersion: "test-v1", sourceWatermarkAt: now, relationalWatermarkAt: now, objectCount: 1, mediaBytes: 12, exportBytes: 0,
        ciphertextBytes: 0, catalogSha256: "0".repeat(64), ciphertextSha256: "0".repeat(64), attemptedAt: now, verifiedAt: null,
        committedAt: null, retentionLifetimeHours: 168, expiresAt: "2026-11-06T00:00:00.000Z", state: "uploading" as const, failureCode: null };
      const catalog = createPostgresObjectBackupCatalog(backup);
      await catalog.begin(attempt);
      const finalized = { ...attempt, ciphertextBytes: 4096, catalogSha256: "1".repeat(64), ciphertextSha256: "2".repeat(64) };
      await catalog.finalizeUploading(finalized);
      await catalog.markUsable(attempt.copyId, "2026-10-30T00:00:01.000Z", "2026-10-30T00:00:02.000Z");
      expect(await catalog.currentUsable("independent-store")).toMatchObject({
        copyId: attempt.copyId, state: "usable", ciphertextBytes: 4096,
        catalogSha256: finalized.catalogSha256, ciphertextSha256: finalized.ciphertextSha256,
      });
      await admin.query("insert into operations.relational_backup_copies(state,attempted_at,committed_at,source_watermark_at) values ('usable',$1,$1,$1)", [now]);
      const populatedSummary = await admin.query(summary.sql, [...summary.parameters]);
      expect(Number(populatedSummary.rows[0].object_backup_watermark_age_hours)).toBe(1);
      expect(Number(populatedSummary.rows[0].relational_backup_watermark_age_hours)).toBe(1);
      await admin.query("set role shipwithali_application");
      const metrics = await admin.query("select backup_type,state,object_count,object_bytes from operations.backup_copy_metrics where backup_type='object'");
      expect(metrics.rows).toEqual([{ backup_type: "object", state: "usable", object_count: 1, object_bytes: "12" }]);
      await expect(admin.query("select * from operations.object_backup_copies")).rejects.toMatchObject({ code: "42501" });
      await admin.query("reset role");
      await expect(catalog.acknowledgeDeletion(attempt.copyId, now)).rejects.toThrow();
      await admin.query("update operations.object_backup_copies set expires_at=clock_timestamp()-interval '1 second' where copy_id=$1", [attempt.copyId]);
      expect(await catalog.listExpired("independent-store", 100)).toHaveLength(1);
      await catalog.acknowledgeDeletion(attempt.copyId, now);
      expect(await catalog.listExpired("independent-store", 100)).toHaveLength(0);
      const failed = { ...attempt, copyId: randomUUID() };
      await catalog.begin(failed);
      await catalog.markFailed(failed.copyId, "OBJECT_BACKUP_INTERRUPTED");
      expect(await catalog.listExpired("independent-store", 100)).toHaveLength(1);
      await catalog.acknowledgeDeletion(failed.copyId, now);
      expect(await catalog.listExpired("independent-store", 100)).toHaveLength(0);
      verified = true;
    } finally {
      if (backup) await backup.end().catch(() => undefined);
      if (admin) await admin.end().catch(() => undefined);
      if (containerStarted) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      if (verified) process.stdout.write(JSON.stringify({ evidence: "isolated-postgres", migrationApplied: true, backupScopeViewOnly: true,
        finalizeAndCommit: true, applicationMetricsViewOnly: true, ownedContainerRemoved: true }) + "\n");
    }
  }, 120_000);
});
