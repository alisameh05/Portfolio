import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeOperationsBoundary,
  DECLARED_CAPABILITIES_VARIABLE,
  declaredCapabilities,
  resolveMigrationClassifications,
  validateCheckpointPairing,
  validateTransformationShape,
  PHASE_DATABASE_CHECKPOINTS,
  PHASE5_MIGRATION_COMPATIBILITY,
} from "../../scripts/phase-contract-registry.mjs";
import { assertPhase3OperationsContractPreserved } from "../../scripts/phase4-migration-integrity.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("every committed migration is classified exactly once and matches the declared phase ranges", () => {
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
  const phase3 = Object.keys(JSON.parse(readFileSync(join(ROOT, "supabase/baselines/phase3.json"), "utf8")).migrations);
  const classifications = resolveMigrationClassifications(files, {
    phase3Files: phase3,
    migrationContents: new Map(files.map((file) => [file, readFileSync(join(ROOT, "supabase/migrations", file), "utf8")])),
  });
  assert.equal(classifications.size, files.length);
  const kinds = Object.groupBy(classifications, ([, value]) => value.kind);
  assert.ok(Object.keys(kinds).every((kind) => ["baseline", "phase4-release", "phase5", "operations-transformation", "declared-additive"].includes(kind)));
  assert.equal(kinds["operations-transformation"].length, 2);
  for (const [file, value] of classifications) {
    if (value.kind === "phase5") {
      assert.ok(PHASE5_MIGRATION_COMPATIBILITY[file], file);
    }
  }
});

test("undeclared, duplicate, or unreviewed transformation migrations fail closed", () => {
  const phase3 = ["20260922170000_prepare_migration_capability.sql"];
  assert.throws(
    () => resolveMigrationClassifications([phase3[0], "20260101000000_unreviewed.sql"], { phase3Files: phase3 }),
    /PHASE_CONTRACT_MIGRATION_UNDECLARED/u,
  );
  assert.throws(
    () => resolveMigrationClassifications([phase3[0], "20261022000000_duplicate.sql", "20261022000000_duplicate.sql"], {
      phase3Files: phase3,
    }),
    /PHASE_CONTRACT_MIGRATION_DUPLICATE/u,
  );
  assert.throws(
    () => resolveMigrationClassifications([phase3[0], "20260101000000_declared.sql", "20260101000000_declared.sql"], {
      phase3Files: phase3,
      additiveMigrations: [{ migration: "20260101000000_declared.sql" }, { migration: "20260101000000_declared.sql" }],
    }),
    /PHASE_CONTRACT_MIGRATION_DUPLICATE/u,
  );
  assert.throws(
    () => validateTransformationShape({ migration: "x.sql" }),
    /PHASE_REGISTRY_TRANSFORMATION_INVALID/u,
  );
});

test("a synthetic future transformation is admitted only through the injected shared registry", () => {
  const phase3 = ["20260922170000_prepare_migration_capability.sql"];
  const migration = "20261022000000_future_operations_contract.sql";
  const object = { schema: "operations", name: "future_events", kind: "r", owner: "shipwithali_migration", rlsEnabled: true, rlsForced: true };
  const column = { schema: "operations", tableName: "future_events", name: "event_id", position: 1, type: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: "NO", default: null, identity: "NO", identityGeneration: null, generated: "NEVER", generationExpression: null, characterMaximumLength: null, numericPrecision: null, numericScale: null, datetimePrecision: null };
  const constraint = { schema: "operations", tableName: "future_events", name: "future_events_event_id_check", type: "c", validated: true, definition: "CHECK (event_id IS NOT NULL)" };
  const policy = { schema: "operations", tableName: "future_events", name: "future_events_worker_insert", permissive: "permissive", roles: "{shipwithali_worker}", command: "INSERT", usingPredicate: "", withCheck: "event_id IS NOT NULL" };
  const grant = { schema: "operations", object: "future_events", objectType: "r", grantee: "shipwithali_worker", grantor: "shipwithali_migration", privilege: "INSERT", grantable: false };
  const index = { schema: "operations", table: "future_events", name: "future_events_event_id_idx", definition: "CREATE INDEX future_events_event_id_idx ON operations.future_events USING btree (event_id)" };
  const transformation = {
    migration, ticket: 999, capability: "operations.synthetic_future", boundary: "reviewed test transformation",
    operations: [
      { category: "objects", identity: "operations.future_events", before: null, after: object },
      { category: "columns", identity: "operations.future_events.event_id", before: null, after: column },
      { category: "constraints", identity: "operations.future_events.future_events_event_id_check", before: null, after: constraint },
      { category: "policies", identity: "operations.future_events.future_events_worker_insert", before: null, after: policy },
      { category: "grants", identity: "operations.future_events.r.shipwithali_worker:shipwithali_migration:INSERT", before: null, after: grant },
      { category: "indexes", identity: "operations.future_events.future_events_event_id_idx", before: null, after: index },
    ],
  };
  const additive = [{ migration, ticket: 999, capability: "operations.synthetic_future" }];
  assert.throws(() => resolveMigrationClassifications([...phase3, migration], { phase3Files: phase3 }), /PHASE_CONTRACT_MIGRATION_UNDECLARED/u);
  const result = resolveMigrationClassifications([...phase3, migration], {
    phase3Files: phase3, transformations: [transformation], additiveMigrations: additive,
  });
  assert.equal(result.get(migration).transformation, transformation);
  assert.equal(composeOperationsBoundary([transformation], 17).operations.length, 6);
  const before = { postgresMajor: 17, schemas: [{ name: "operations", owner: "shipwithali_migration", acl: "" }], objects: [], columns: [], constraints: [], policies: [], grants: [], defaultPrivileges: [], indexes: [], functions: [], triggers: [], types: [] };
  const after = { ...structuredClone(before), objects: [object], columns: [column], constraints: [constraint], policies: [policy], grants: [grant], indexes: [index] };
  assert.throws(() => assertPhase3OperationsContractPreserved(before, after, { transformations: [] }), /PHASE3_OPERATIONS_CONTRACT_UNEXPECTED_ADDITION/u);
  assert.doesNotThrow(() => assertPhase3OperationsContractPreserved(before, after, {
    transformations: [transformation],
  }));
  const altered = structuredClone(after);
  altered.columns[0].nullable = "YES";
  assert.throws(() => assertPhase3OperationsContractPreserved(before, altered, { transformations: [transformation] }),
    /PHASE3_OPERATIONS_CONTRACT_ALTERED.*operations\.future_events\.event_id/u);
});

test("canonical operations expectations bind complete row operations to reviewed migrations", () => {
  const boundary = composeOperationsBoundary(undefined, 18);
  assert.equal(boundary.operations.length, 98);
  const pg17 = composeOperationsBoundary(undefined, 17);
  assert.equal(pg17.operations.length, 83);
  assert.ok(!pg17.operations.some((operation) => operation.category === "constraints" && operation.after?.type === "n"));
  assert.throws(() => composeOperationsBoundary(undefined, 16), /PHASE3_OPERATIONS_ENGINE_UNSUPPORTED/u);
  assert.ok(boundary.operations.some((operation) => operation.category === "objects" && operation.identity === "operations.incidents" && operation.after?.rlsForced === true));
  assert.ok(boundary.operations.some((operation) => operation.category === "grants" && operation.identity.includes("operations.incidents.safe_error_code.c")));
  assert.ok(boundary.operations.some((operation) => operation.category === "indexes" && operation.identity === "operations.outbox_events.outbox_events_due_idx" && operation.after?.definition.includes("dead_at")));
});

test("capabilities are declared per checkpoint, never learned from a database", () => {
  assert.deepEqual(declaredCapabilities().toSorted(), ["measurement.events", "operations.bounded_retries"]);
  assert.equal(DECLARED_CAPABILITIES_VARIABLE, "PHASE_DATABASE_CAPABILITIES");
});

test("checkpoint pairing requires every historical suite to exist in the tree", () => {
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((name) => name.endsWith(".sql"));
  const phase3 = Object.keys(JSON.parse(readFileSync(join(ROOT, "supabase/baselines/phase3.json"), "utf8")).migrations);
  const classifications = resolveMigrationClassifications(files, { phase3Files: phase3 });
  const existingFiles = new Set(PHASE_DATABASE_CHECKPOINTS.flatMap((checkpoint) => checkpoint.suites.map((suite) => suite.file))
    .filter((file) => existsSync(join(ROOT, file))));
  assert.doesNotThrow(() => validateCheckpointPairing({ classifications, phase3Files: phase3, existingFiles }));
  const incomplete = new Set([...existingFiles].slice(1));
  assert.throws(
    () => validateCheckpointPairing({ classifications, phase3Files: phase3, existingFiles: incomplete }),
    /PHASE_CHECKPOINT_SUITE_MISSING/u,
  );
});
