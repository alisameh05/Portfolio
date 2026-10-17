import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import { phase6StorageDefaultDenyProof, stopProject, PHASE6_APPLICATION_COLUMN_UPDATES, phase6ColumnUpdateProof, phase6DefinerFunctionProof, phase6WorkerSchemaProof, makeProject, phase6MediaFactPlanProof, phase6MigrationFailureCode } from "../../scripts/phase6-migration-access.mjs";
import { phase6PdfFixture } from "../../scripts/phase6-verification-support.mjs";
import { migrationSha256 } from "../../scripts/migration-checksum.mjs";
import { withPhase6MigrationExecutor } from "../../scripts/phase6-local-migration-bootstrap.mjs";

const root = new URL("../../", import.meta.url);
const runner = readFileSync(new URL("scripts/phase6-migration-access.mjs", root), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const entrypoint = readFileSync(new URL("docker/validation/entrypoint.sh", root), "utf8");

test("released Phase 7 migrations retain the checksums published at d652fd4", () => {
  for (const [name, sha256] of [
    ["20261015093040_query_current_interaction_summaries.sql", "8fbef1951cc33e3a6ae286dc9f1d53bee87b45eb0dc9e45e4c080eb7a56cea88"],
    ["20261015202000_expire_measurement_detail_and_aggregate_retention.sql", "04e33297a492b55c2dc8b2392fc9f0291fa3e10f9ade40e7c9ef6fc97b297221"],
  ]) {
    assert.equal(migrationSha256(readFileSync(new URL(`supabase/migrations/${name}`, root), "utf8")), sha256);
  }
});

test("historical migration bootstrap rejects targets outside its disposable fixture scope", () => {
  let invoked = false;
  assert.throws(() => withPhase6MigrationExecutor({ workdir: process.cwd(), projectId: "production" }, () => { invoked = true; }),
    { message: "PHASE6_MIGRATION_BOOTSTRAP_SCOPE_INVALID" });
  assert.equal(invoked, false);
});

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

test("Phase 6 baseline comparison canonicalizes line endings and still rejects SQL drift", () => {
  const sql = "set lock_timeout = '5s';\nselect 1;\n";
  assert.equal(migrationSha256(sql), migrationSha256(sql.replaceAll("\n", "\r\n")));
  assert.notEqual(migrationSha256(sql), migrationSha256(sql.replace("select 1", "select 2")));
  assert.match(runner, /migrationSha256\(historical\)\s*!==\s*migrationSha256\(/u);
});

test("Phase 6 successful migration verification stops each owned project once", () => {
  assert.equal([...runner.matchAll(/await stopProject\(clean\)/gu)].length, 1);
  assert.equal([...runner.matchAll(/await stopProject\(old\)/gu)].length, 1);
});

test("Phase 6 migration evidence retains the validated Storage integration summary", () => {
  assert.match(runner, /integration: storageIntegration\.checks,/u);
});
test("Phase 6 baseline preserves Git's existing trailing-whitespace comparison", () => {
  const historical = "select 1;";
  const checkout = "select 1;\r\n";
  assert.equal(migrationSha256(historical), migrationSha256(checkout.trimEnd()));
  assert.match(runner, /migrationSha256\(readFileSync\(join\(ROOT, "supabase", "migrations", name\), "utf8"\)\.trimEnd\(\)\)/u);
});

test("migration failures expose only a safe stage and SQLSTATE", () => {
  const failure = Object.assign(new Error("private provider payload and password=sentinel"), {
    code: "23505", detail: "postgres://private:secret@example.test/database"
  });
  assert.equal(phase6MigrationFailureCode(failure, "SEED_PREDECESSOR"), "PHASE6_MIGRATION_ACCESS_SEED_PREDECESSOR_FAILED:23505");
  assert.equal(phase6MigrationFailureCode(failure, "https://private.example"), "PHASE6_MIGRATION_ACCESS_UNKNOWN_FAILED:23505");
  assert.equal(phase6MigrationFailureCode(new Error("PHASE6_WORKER_POOL_SCOPE_NOT_CLEARED"), "ROLE_MATRIX"), "PHASE6_WORKER_POOL_SCOPE_NOT_CLEARED");
  assert.equal(phase6MigrationFailureCode(Object.assign(new Error("private"), { code: "invalid private" }), "IMPORT_DATA"), "PHASE6_MIGRATION_ACCESS_IMPORT_DATA_FAILED");
});

test("portable PDF fixtures are deterministic documents with an exact cross-reference offset", () => {
  const bytes = phase6PdfFixture();
  assert.deepEqual(bytes, phase6PdfFixture());
  const text = bytes.toString("utf8");
  assert.ok(text.startsWith("%PDF-1.4\n"));
  const offset = Number(/startxref\n(\d+)\n%%EOF/u.exec(text)?.[1]);
  assert.equal(text.slice(offset, offset + 5), "xref\n");
  assert.ok(text.includes("/Type /Page "));
});

test("bounded Media batch proof accepts its primary or scoped covering index only", () => {
  for (const name of ["assets_pkey", "assets_media_id_portfolio_id_owner_id_key"]) {
    assert.equal(phase6MediaFactPlanProof({"Index Name": name, "Index Cond": "(media_id = ANY ('{id}'::uuid[]))"}), true);
  }
  assert.equal(phase6MediaFactPlanProof({"Node Type": "Seq Scan"}), false);
  assert.equal(phase6MediaFactPlanProof({"Index Name": "unrelated_idx", "Index Cond": "media_id = ANY ('{id}')"}), false);
  assert.equal(phase6MediaFactPlanProof({"Index Name": "assets_media_id_portfolio_id_owner_id_key", "Index Cond": "portfolio_id = 'id'"}), false);
});

test("isolated project IDs remain exact within the CLI name limit", () => {
  const project = makeProject("fixture-source-with-a-long-label", 50000, []);
  try {
    assert.ok(project.projectId.length <= 36);
    assert.match(project.projectId, /^shipwithali-phase6-162-[a-f0-9]{12}$/u);
    assert.ok(readFileSync(join(project.workdir, "supabase/config.toml"), "utf8").includes('project_id = "' + project.projectId + '"'));
  } finally { rmSync(project.workdir, { recursive: true, force: true }); }
});

test("catalog proof permits only the reviewed Phase 7 Worker retention definers", () => {
  const valid = { schema: "measurement", name: "seal_daily_aggregate_checkpoint",
    argument_types: "uuid, date, boolean, timestamp with time zone", result_type: "void",
    security_definer: true, owner: "shipwithali_migration", owner_can_login: false,
    owner_superuser: false, owner_bypass_rls: false, config: ["search_path=pg_catalog, measurement"],
    worker_execute: true, anon_execute: false, authenticated_execute: false,
    service_role_execute: false, application_execute: false, backup_execute: false };
  assert.equal(phase6DefinerFunctionProof(valid), true);
  assert.equal(phase6DefinerFunctionProof({ ...valid, name: "begin_retention_checkpoint",
    argument_types: "uuid, uuid, text, timestamp with time zone, text" }), true);
  for (const changed of [{ name: "unreviewed" }, { schema: "media" }, { argument_types: "text" },
    { owner_can_login: true }, { owner_superuser: true }, { owner_bypass_rls: true },
    { config: ["search_path=public"] }, { application_execute: true }, { worker_execute: false }]) {
    assert.equal(phase6DefinerFunctionProof({ ...valid, ...changed }), false);
  }
});

test("catalog proof permits documented Worker schemas and forbids domain access or DDL", () => {
  for (const schema_name of ["operations", "measurement", "interaction"]) {
    assert.equal(phase6WorkerSchemaProof([{ role_name: "shipwithali_worker", schema_name, usage: true, create: false }]), true);
  }
  for (const schema_name of ["media", "cv_portfolio", "content"]) {
    assert.equal(phase6WorkerSchemaProof([{ role_name: "shipwithali_worker", schema_name, usage: true, create: false }]), false);
  }
  assert.equal(phase6WorkerSchemaProof([{ role_name: "shipwithali_worker", schema_name: "operations", usage: true, create: true }]), false);
});

test("Media and CV UPDATE privileges stay on their exact approved columns", () => {
  const grants = Object.entries(PHASE6_APPLICATION_COLUMN_UPDATES).flatMap(([table, columns]) => columns.map(column_name => ({
    schema: table.split(".")[0], table_name: table.split(".")[1], column_name,
    grantee: "shipwithali_application", is_grantable: "NO"
  })));
  assert.deepEqual(PHASE6_APPLICATION_COLUMN_UPDATES["cv_portfolio.versions"], ["is_current", "state"]);
  assert.equal(phase6ColumnUpdateProof(grants), true);
  assert.equal(phase6ColumnUpdateProof(grants.slice(1)), false);
  assert.equal(phase6ColumnUpdateProof([...grants, { ...grants[0], column_name: "media_id" }]), false);
  assert.equal(phase6ColumnUpdateProof(grants.map((row, index) => index === 0 ? { ...row, is_grantable: "YES" } : row)), false);
  assert.equal(phase6ColumnUpdateProof([...grants, { ...grants[0], grantee: "shipwithali_worker" }]), false);
  assert.equal(phase6ColumnUpdateProof([...grants, { ...grants[0], grantee: "PUBLIC" }]), false);
  assert.ok(runner.includes("from information_schema.column_privileges"));
  assert.ok(runner.includes("from information_schema.table_privileges"));
  assert.ok(runner.includes("PHASE6_PUBLIC_TABLE_GRANT_FOUND"));
});

test("project cleanup rejects paths outside its owned temporary scope before invoking Docker", async () => {
  await assert.rejects(stopProject({ workdir: new URL("../../", import.meta.url).pathname, projectId: "shipwithali-phase6-162-000000000000" }), /PHASE6_MIGRATION_ACCESS_CLEANUP_SCOPE_INVALID/u);
});

test("private Storage catalogs require RLS and the reviewed default-deny policy mode", () => {
  const tables = [{ table: "buckets", rls: true }, { table: "objects", rls: true }];
  assert.equal(phase6StorageDefaultDenyProof(tables, []), true);
  assert.equal(phase6StorageDefaultDenyProof(tables.slice(1), []), false);
  assert.equal(phase6StorageDefaultDenyProof(tables.map(row => ({ ...row, rls: false })), []), false);
  assert.equal(phase6StorageDefaultDenyProof(tables, [{ policyname: "unreviewed_allow" }]), false);
});
