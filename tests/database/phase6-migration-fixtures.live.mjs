import assert from "node:assert/strict";
import { copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { Client } from "pg";
import { makeProject, startProject, resetProject, applyProjectMigrations, stopProject, seedPredecessorRows, boundedPlans, privilegeMatrix, transferPortableDataset, catalogSnapshot, generatedTypes, phase6MigrationFailureCode } from "../../scripts/phase6-migration-access.mjs";

// Explicit live regression command; this never emits acceptance artifacts.
// node --test tests/database/phase6-migration-fixtures.live.mjs
test("migration fixtures preserve valid accepted-PDF history, scoped access and portable references", { timeout: 300_000 }, async () => {
  const migrations = readdirSync(new URL("../../supabase/migrations/", import.meta.url)).filter(name => /^\d{14}_.+\.sql$/u.test(name)).sort();
  const correction = "20261017142000_revoke_public_aggregate_guard_execution.sql";
  assert.ok(migrations.includes(correction));
  const projects = [];
  const basePort = 56_000 + (process.pid % 100) * 40;
  let stage = "START_SOURCE";
  try {
    const source = makeProject("fixture-source", basePort, migrations.filter(name => name !== correction)); projects.push(source);
    const sourceStatus = await startProject(source);
    stage = "RELEASED_PHASE7_UPGRADE";
    const upgradeProbe = new Client({ connectionString: sourceStatus.DB_URL }); await upgradeProbe.connect();
    try {
      assert.equal((await upgradeProbe.query("select rolsuper from pg_roles where rolname = 'postgres'")).rows[0].rolsuper, false);
      assert.equal((await upgradeProbe.query("select has_function_privilege('anon', 'measurement.prevent_sealed_aggregate_checkpoint_rewrite()', 'EXECUTE') as allowed")).rows[0].allowed, true);
      copyFileSync(new URL(`../../supabase/migrations/${correction}`, import.meta.url), join(source.migrationDir, correction));
      applyProjectMigrations(source);
      for (const role of ["anon", "authenticated", "shipwithali_application", "shipwithali_backup"]) {
        assert.equal((await upgradeProbe.query("select has_function_privilege($1, 'measurement.prevent_sealed_aggregate_checkpoint_rewrite()', 'EXECUTE') as allowed", [role])).rows[0].allowed, false);
      }
      assert.equal((await upgradeProbe.query("select rolsuper from pg_roles where rolname = 'postgres'")).rows[0].rolsuper, false);
    } finally { await upgradeProbe.end(); }
    stage = "SOURCE_CATALOG";
    const sourceCatalog = await catalogSnapshot(sourceStatus.DB_URL);
    const sourceTypes = await generatedTypes(sourceStatus.DB_URL);
    stage = "PUBLIC_GRANT_REJECTION";
    const grantProbe = new Client({ connectionString: sourceStatus.DB_URL }); await grantProbe.connect();
    try {
      for (const [grant, revoke, code] of [
        ["grant update(media_id) on media.assets to public", "revoke update(media_id) on media.assets from public", "PHASE6_APPLICATION_COLUMN_GRANT_ALLOWLIST_MISMATCH"],
        ["grant select(original_file_name) on media.assets to public", "revoke select(original_file_name) on media.assets from public", "PHASE6_APPLICATION_COLUMN_GRANT_ALLOWLIST_MISMATCH"],
        ["grant update on media.assets to public", "revoke update on media.assets from public", "PHASE6_PUBLIC_TABLE_GRANT_FOUND"],
      ]) {
        await grantProbe.query(grant);
        try { await assert.rejects(catalogSnapshot(sourceStatus.DB_URL), { message: code }); }
        finally { await grantProbe.query(revoke); }
      }
    } finally { await grantProbe.end(); }
    assert.deepEqual(await catalogSnapshot(sourceStatus.DB_URL), sourceCatalog);
    stage = "SEED_PREDECESSOR";
    await seedPredecessorRows(sourceStatus.DB_URL);
    stage = "BOUNDED_PLANS";
    const plans = await boundedPlans(sourceStatus.DB_URL);
    assert.equal(plans.currentResolved, 1);
    assert.equal(plans.mediaAttemptsReturned, 100);
    assert.equal(plans.cvVersionsReturned, 100);
    stage = "RETAINED_PLAN_READ";
    assert.deepEqual((await boundedPlans(sourceStatus.DB_URL, { seed: false })).portableObject, plans.portableObject);
    stage = "ACCEPTED_PDF_HISTORY";
    const client = new Client({ connectionString: sourceStatus.DB_URL }); await client.connect();
    try {
      const history = await client.query(`select a.kind,a.declared_media_type,a.declared_sha256,a.declared_byte_length::int,
        approval.accepted_at,activation.activated_at,version.registered_at,decision.decided_at,attempt.finished_at,attempt.result,attempt.input_sha256,attempt.input_object_id::text,attempt.output_object_id::text,
        attempt.output_sha256,object.source_object_id::text,object.sha256,object.byte_length::int,
        version.version_id::text,portfolio.current_version_id::text
        from cv_portfolio.portfolios portfolio
        join cv_portfolio.versions version on version.version_id=portfolio.current_version_id
        join cv_portfolio.acceptance_history approval on approval.version_id=version.version_id
        join cv_portfolio.activation_history activation on activation.version_id=version.version_id
        join media.assets a on a.media_id=version.media_id
        join media.decision_history decision on decision.decision_id=version.media_decision_id
        join media.processing_attempts attempt on attempt.attempt_id=decision.processing_attempt_id
        join media.processed_objects object on object.object_id=version.media_object_id`);
      assert.equal(history.rowCount, 1);
      const row = history.rows[0];
      assert.equal(row.kind, "document"); assert.equal(row.declared_media_type, "application/pdf");
      assert.equal(row.result, "passed");
      assert.ok(row.decided_at >= row.finished_at);
      assert.ok(row.registered_at >= row.decided_at);
      assert.ok(row.accepted_at >= row.registered_at);
      assert.ok(row.activated_at >= row.accepted_at);
      assert.equal(row.declared_sha256, row.input_sha256); assert.equal(row.input_sha256, row.sha256);
      assert.equal(row.output_sha256, row.sha256); assert.equal(row.output_object_id, plans.portableObject.objectId);
      assert.equal(row.input_object_id, row.source_object_id);
      assert.equal(row.declared_byte_length, row.byte_length);
      assert.equal(row.version_id, row.current_version_id);
      assert.notEqual(row.version_id, plans.portableObject.mediaId);
    } finally { await client.end(); }
    stage = "RESTRICTED_PRINCIPALS";
    assert.equal((await privilegeMatrix(sourceStatus.DB_URL)).executionCount, 17);
    stage = "START_TARGET";
    const target = makeProject("fixture-target", basePort + 20, migrations); projects.push(target);
    const targetStatus = await startProject(target);
    stage = "CLEAN_RESET";
    resetProject(target);
    stage = "TARGET_CATALOG";
    assert.deepEqual(await catalogSnapshot(targetStatus.DB_URL), sourceCatalog);
    assert.equal(await generatedTypes(targetStatus.DB_URL), sourceTypes);
    stage = "IMPORT_DATA";
    assert.ok((await transferPortableDataset(sourceStatus.DB_URL, targetStatus.DB_URL)).rowsTransferred > 20_000);
    stage = "IMPORTED_PLANS";
    assert.deepEqual((await boundedPlans(targetStatus.DB_URL, { seed: false })).portableObject, plans.portableObject);
  } catch (error) {
    throw new Error("PHASE6_FIXTURE_REGRESSION:" + phase6MigrationFailureCode(error, stage));
  } finally {
    let cleanupFailed = false;
    for (const project of projects.reverse()) {
      try { await stopProject(project); } catch { cleanupFailed = true; }
    }
    assert.equal(cleanupFailed, false, "PHASE6_FIXTURE_CLEANUP_FAILED");
  }
});
