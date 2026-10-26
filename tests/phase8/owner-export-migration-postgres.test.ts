import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createStableId } from "../../src/shared/domain/index.js";

const adminUrl = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const target = "20261026100000_reconcile_all_owner_export_artifacts.sql";

describe.runIf(Boolean(adminUrl))("Issue #247 restricted-role ledger migration", () => {
  it.each([false, true])("replays with existing revoked exports: %s and removes temporary access", async (upgrade) => {
    const admin = new Client({ connectionString: adminUrl });
    const databaseName = `export_migration_${randomUUID().replaceAll("-", "")}`;
    let database: Client | undefined;
    let created = false;
    try {
      await admin.connect();
      await admin.query(`create database ${databaseName}`);
      created = true;
      const url = new URL(adminUrl!);
      url.pathname = `/${databaseName}`;
      database = new Client({ connectionString: url.href });
      await database.connect();
      await database.query(`grant create on database ${databaseName} to shipwithali_migration`);
      const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql") && name < target).sort();
      for (const name of migrations) await database.query(readFileSync(`supabase/migrations/${name}`, "utf8"));
      const revokedAt = "2026-10-25T12:00:00.000Z";
      const deletedAt = "2026-10-25T12:01:00.000Z";
      const rows = [null, deletedAt].map(artifactDeletedAt => ({
        exportId: createStableId("OwnerExport"), portfolioId: createStableId("Portfolio"),
        artifactId: createStableId("OwnerExportArtifact"), artifactDeletedAt,
      }));
      if (upgrade) {
        for (const row of rows) await database.query(`insert into portability.owner_exports (
          export_id, portfolio_id, owner_id, included_scopes, status, schema_version, requested_at,
          failed_at, failure_code, candidate_artifact_id, candidate_sha256, candidate_content_length,
          artifact_revoked_at, artifact_deleted_at
        ) values ($1,$2,$3,array['moderation-history'],'failed','1.7',$4,$4,'OWNER_EXPORT_ASSEMBLY_FAILED',
          $5,$6,1,$4,$7)`, [row.exportId, row.portfolioId, createStableId("Owner"), revokedAt,
          row.artifactId, "a".repeat(64), row.artifactDeletedAt]);
      }
      // The SQL itself SET ROLEs to the real NOSUPERUSER NOBYPASSRLS migration role.
      await database.query(readFileSync(`supabase/migrations/${target}`, "utf8"));
      const ledger = await database.query(`select export_id, portfolio_id, artifact_id, revoked_at,
        revocation_code, artifact_deleted_at from portability.owner_export_invalidation_ledger order by export_id`);
      expect(ledger.rows).toEqual(upgrade ? rows.sort((a, b) => a.exportId.localeCompare(b.exportId)).map(row => ({
        export_id: row.exportId, portfolio_id: row.portfolioId, artifact_id: row.artifactId,
        revoked_at: new Date(revokedAt), revocation_code: "prior_revocation",
        artifact_deleted_at: row.artifactDeletedAt === null ? null : new Date(row.artifactDeletedAt),
      })) : []);
      const role = await database.query(`select rolsuper, rolbypassrls from pg_roles where rolname='shipwithali_migration'`);
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const permissions = await database.query(`select
        has_table_privilege('shipwithali_migration','portability.owner_exports','SELECT') as can_select`);
      expect(permissions.rows).toEqual([{ can_select: false }]);
      const columnGrants = await database.query(`select grants.privilege_type from pg_attribute attribute,
        lateral aclexplode(attribute.attacl) grants where attribute.attrelid='portability.owner_exports'::regclass
        and attribute.attname='artifact_revocation_code' and grants.grantee='shipwithali_migration'::regrole`);
      expect(columnGrants.rows).toEqual([]);
      const policies = await database.query(`select policyname from pg_policies where schemaname='portability'
        and policyname like 'owner_exports_migration_revocation_backfill_%'`);
      expect(policies.rows).toEqual([]);
    } finally {
      await database?.end();
      if (created) await admin.query(`drop database ${databaseName} with (force)`);
      await admin.end();
    }
  }, 60_000);
});
