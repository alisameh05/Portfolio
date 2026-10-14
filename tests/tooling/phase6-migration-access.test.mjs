import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const runner = readFileSync(new URL("scripts/phase6-migration-access.mjs", root), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const entrypoint = readFileSync(new URL("docker/validation/entrypoint.sh", root), "utf8");

test("Phase 6 migration-access gate has one runnable focused entrypoint and follows real Storage evidence", () => {
  assert.equal(packageJson.scripts["phase6:focus:migration-access"], "node scripts/phase6-migration-access.mjs");
  assert.match(packageJson.scripts["prephase6:focus:migration-access"], /validation:ready/u);
  assert.match(runner, /PHASE6_STORAGE_API_EVIDENCE_MISSING_OR_STALE/u);
  assert.match(runner, /real Storage API authorization/u);
  assert.match(runner, /privileged Storage API calls as policy proof/u);
  assert.match(runner, /PHASE6_CURRENT_OLD_CV_STORAGE_MATRIX_INCOMPLETE/u);
  assert.match(runner, /currentAndOldCvApiMatrix/u);
  assert.match(runner, /PHASE6_SERVICE_ROLE_DATABASE_SHORTCUT_FOUND/u);
  assert.match(runner, /PHASE6_PORTABLE_HISTORY_MAPPING_INCOMPLETE/u);
  assert.match(runner, /PHASE6_PORTABLE_REJECTION_HISTORY_MISSING/u);
  assert.match(runner, /PHASE6_APPLICATION_GRANT_ALLOWLIST_MISMATCH/u);
  assert.match(runner, /PHASE6_POOL_CONNECTION_NOT_REUSED/u);
  assert.match(runner, /PHASE6_WORKER_INHERITED_OWNER_SCOPE/u);
  assert.match(runner, /PHASE6_WORKER_POOL_SCOPE_NOT_CLEARED/u);
  assert.match(runner, /transferPortableDataset\(oldStatus\.DB_URL, cleanStatus\.DB_URL\)/u);
  assert.match(runner, /const targetBucket = "phase6-private-fixtures"/u);
  assert.match(runner, /targetBucket, targetObjectPath/u);
  assert.match(runner, /changedStorageMapping: sourceBucket !== targetBucket/u);
  assert.match(entrypoint, /npm run phase6:focus:migration-access/u);
});

test("Phase 6 migration-access evidence rejects stale generated types, missing indexes, and incomplete upgrade snapshots", () => {
  for (const required of [
    "PHASE6_GENERATED_DATABASE_TYPES_STALE",
    "PHASE6_MEDIA_HISTORY_PLAN_MISSING_INDEX",
    "PHASE6_CV_HISTORY_PLAN_MISSING_INDEX",
    "PHASE6_CLEAN_UPGRADE_CATALOG_DIFFERENCE",
    "PHASE6_PREDECESSOR_ROWS_CHANGED",
    "PHASE6_MIGRATION_LOCK_TIMEOUT_MISSING",
    "PHASE6_SOURCE_CHANGED_DURING_RUN",
    "criterionResults: criteria",
  ]) assert.ok(runner.includes(required), `missing fail-closed assertion: ${required}`);
});
