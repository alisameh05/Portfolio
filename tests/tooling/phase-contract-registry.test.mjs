import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrationSha256 } from "../../scripts/migration-checksum.mjs";
import {
  composeOperationsBoundary,
  capabilitiesForMigrations,
  DECLARED_CAPABILITIES_VARIABLE,
  declaredCapabilities,
  resolveMigrationClassifications,
  validateCheckpointPairing,
  validateTransformationShape,
  PHASE_DATABASE_CHECKPOINTS,
  PHASE5_MIGRATION_COMPATIBILITY,
  PHASE_DECLARED_ADDITIVE_MIGRATIONS,
} from "../../scripts/phase-contract-registry.mjs";
import { assertPhase3OperationsContractPreserved } from "../../scripts/phase4-migration-integrity.mjs";
import { partitionMigrationsAt } from "../../scripts/phase7-migration-boundary.mjs";

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
  assert.equal(kinds["operations-transformation"].length, 4);
  for (const [file, value] of classifications) {
    if (value.kind === "phase5") {
      assert.ok(PHASE5_MIGRATION_COMPATIBILITY[file], file);
    }
  }
});

test("the Phase 7 schedule migration stays between its true predecessor prefix and later Phase 8 migrations", () => {
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort();
  const boundary = partitionMigrationsAt(files, "20261026164603_phase7_durable_policy_schedule_keys.sql");
  assert.equal(boundary.predecessorMigrations.at(-1), "20261026100000_reconcile_all_owner_export_artifacts.sql");
  assert.equal(boundary.forwardMigration, "20261026164603_phase7_durable_policy_schedule_keys.sql");
  assert.deepEqual(boundary.laterMigrations, ["20261027014402_operations_observability_summary_indexes.sql", "20261029120000_actionable_incident_delivery.sql", "20261029150000_register_relational_backup_copies.sql", "20261030100000_register_object_backup_copies.sql", "20261031120000_secure_owner_configuration_http.sql"]);
  assert.throws(() => partitionMigrationsAt([...files, boundary.forwardMigration], boundary.forwardMigration),
    /PHASE7_MIGRATION_BOUNDARY_INVALID/u);
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
  assert.throws(() => resolveMigrationClassifications([phase3[0], "20260101000000_declared.sql"], {
    phase3Files: phase3,
    transformations: [],
    additiveMigrations: [{ migration: "20260101000000_declared.sql", migrationSha256: "0".repeat(64) }],
    migrationContents: new Map([["20260101000000_declared.sql", "select 1;"]]),
  }), /PHASE_CONTRACT_ADDITIVE_CHECKSUM_MISMATCH/u);
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

test("the configuration export migration admits only its source-bound outbox policy, insert grant, and unique index", () => {
  const policy = {
    schema: "operations", tableName: "outbox_events", name: "owner_export_produced_outbox_worker_insert",
    permissive: "permissive", roles: "{shipwithali_worker}", command: "INSERT", usingPredicate: "", withCheck: "true",
  };
  const grant = {
    schema: "operations", object: "outbox_events", objectType: "r", grantee: "shipwithali_worker",
    grantor: "shipwithali_migration", privilege: "INSERT", grantable: false,
  };
  const index = {
    schema: "operations", table: "outbox_events", name: "owner_export_produced_outbox_once",
    definition: "CREATE UNIQUE INDEX owner_export_produced_outbox_once ON operations.outbox_events USING btree (aggregate_id, aggregate_version) WHERE (event_type = 'portability.export_produced.v1'::text)",
  };
  const phase3 = {
    postgresMajor: 17,
    migrationLedger: [],
    schemas: [], objects: [], columns: [], constraints: [], policies: [], grants: [], defaultPrivileges: [],
    indexes: [], functions: [], triggers: [], types: [],
  };
  const upgraded = {
    ...structuredClone(phase3),
    migrationLedger: [{ version: "20261023100000", name: "build_configuration_owner_exports" }],
    policies: [policy],
    grants: [grant],
    indexes: [index],
  };
  assert.doesNotThrow(() => assertPhase3OperationsContractPreserved(phase3, upgraded, { transformations: [] }));
  assert.throws(() => assertPhase3OperationsContractPreserved(phase3, {
    ...upgraded,
    policies: [{ ...policy, roles: "{anon}" }],
  }, { transformations: [] }), /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_ALTERED/u);
  assert.throws(() => assertPhase3OperationsContractPreserved(phase3, {
    ...upgraded,
    policies: [],
  }, { transformations: [] }), /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_MISSING/u);
  assert.throws(() => assertPhase3OperationsContractPreserved(phase3, {
    ...upgraded,
    grants: [{ ...grant, grantable: true }],
  }, { transformations: [] }), /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_ALTERED/u);
  assert.throws(() => assertPhase3OperationsContractPreserved(phase3, {
    ...upgraded,
    grants: [],
  }, { transformations: [] }), /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_MISSING/u);
  assert.throws(() => assertPhase3OperationsContractPreserved(phase3, {
    ...upgraded,
    indexes: [{ ...index, definition: `${index.definition} OR true` }],
  }, { transformations: [] }), /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_ALTERED/u);
  assert.throws(() => assertPhase3OperationsContractPreserved(phase3, {
    ...upgraded,
    indexes: [],
  }, { transformations: [] }), /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_MISSING/u);
});

test("the Phase 7 schedule migration binds exact checks, indexes, defaults, and PostgreSQL engine variants", () => {
  const migration = PHASE_DECLARED_ADDITIVE_MIGRATIONS.find(row =>
    row.migration === "20261026164603_phase7_durable_policy_schedule_keys.sql");
  assert.ok(migration);
  assert.ok(migration.operationsAdditions.some(row => row.identity === "operations.jobs.jobs_semantic_schedule_pair_check" &&
    typeof row.expected.definition === "string"));
  assert.ok(migration.operationsAdditions.some(row => row.identity === "operations.jobs.jobs_policy_period_status_idx" &&
    row.expected.definition.includes("INCLUDE (status, work_incomplete)")));
  assert.ok(migration.operationsAdditions.some(row => row.identity === "operations.jobs.work_incomplete" &&
    row.expected.default === "false"));
  assert.equal(migration.operationsAdditionsByEngine["17"].length, 0);
  assert.equal(migration.operationsAdditionsByEngine["18"].length, 10);

  const blank = major => ({ postgresMajor: major, migrationLedger: [], schemas: [], objects: [], columns: [], constraints: [],
    policies: [], grants: [], defaultPrivileges: [], indexes: [], functions: [], triggers: [], types: [] });
  for (const postgresMajor of [17, 18]) {
    const phase3 = blank(postgresMajor);
    const upgraded = structuredClone(phase3);
    upgraded.migrationLedger = [{ version: "20261026164603", name: "phase7_durable_policy_schedule_keys" }];
    const additions = [...migration.operationsAdditions,
      ...(migration.operationsAdditionsByEngine[String(postgresMajor)] ?? [])];
    for (const addition of additions) upgraded[addition.category].push(structuredClone(addition.expected));
    assert.doesNotThrow(() => assertPhase3OperationsContractPreserved(phase3, upgraded, { transformations: [] }));
    if (postgresMajor !== 18) continue;

    const alteredCheck = structuredClone(upgraded);
    alteredCheck.constraints.find(row => row.name === "jobs_semantic_schedule_pair_check").definition += " OR true";
    assert.throws(() => assertPhase3OperationsContractPreserved(phase3, alteredCheck, { transformations: [] }),
      /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_ALTERED/u);
    const alteredIndex = structuredClone(upgraded);
    alteredIndex.indexes.find(row => row.name === "jobs_policy_period_status_idx").definition += " WHERE true";
    assert.throws(() => assertPhase3OperationsContractPreserved(phase3, alteredIndex, { transformations: [] }),
      /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_ALTERED/u);
    const alteredDefault = structuredClone(upgraded);
    alteredDefault.columns.find(row => row.name === "work_incomplete").default = "true";
    assert.throws(() => assertPhase3OperationsContractPreserved(phase3, alteredDefault, { transformations: [] }),
      /PHASE3_OPERATIONS_CONTRACT_DECLARED_ADDITION_ALTERED/u);
  }
});

test("the Phase 8 operations observability migration binds exact columns, all eleven index definitions, and its source checksum", () => {
  const name = "20261027014402_operations_observability_summary_indexes.sql";
  const migration = PHASE_DECLARED_ADDITIVE_MIGRATIONS.find(row => row.migration === name);
  assert.ok(migration);
  assert.equal(migration.migrationSha256, migrationSha256(readFileSync(join(ROOT, "supabase/migrations", name), "utf8")));
  const indexes = migration.operationsAdditions.filter(row => row.category === "indexes");
  const portabilityIndexes = migration.portabilityAdditions.filter(row => row.category === "indexes");
  const columns = migration.operationsAdditions.filter(row => row.category === "columns");
  assert.deepEqual([...indexes, ...portabilityIndexes].map(row => row.expected.name).toSorted(), [
    "jobs_operational_summary_dead_idx", "jobs_operational_summary_lease_idx", "jobs_operational_summary_status_idx",
    "outbox_events_operational_summary_dead_idx", "outbox_events_operational_summary_eligible_idx",
    "outbox_events_operational_summary_lease_idx", "outbox_events_operational_summary_retry_idx",
    "owner_exports_operational_summary_expired_idx", "owner_exports_operational_summary_failed_idx",
    "owner_exports_operational_summary_ready_idx", "owner_exports_operational_summary_recent_idx",
  ]);
  assert.equal(portabilityIndexes.length, 4);
  assert.deepEqual(portabilityIndexes.map(row => row.expected.definition).toSorted(), [
    "CREATE INDEX owner_exports_operational_summary_expired_idx ON portability.owner_exports USING btree (portfolio_id, expired_at DESC, export_id DESC) WHERE ((status = 'expired'::text) AND (expired_at IS NOT NULL))",
    "CREATE INDEX owner_exports_operational_summary_failed_idx ON portability.owner_exports USING btree (portfolio_id, failed_at DESC, export_id DESC) WHERE ((status = 'failed'::text) AND (failed_at IS NOT NULL))",
    "CREATE INDEX owner_exports_operational_summary_ready_idx ON portability.owner_exports USING btree (portfolio_id, completed_at DESC, export_id DESC) INCLUDE (started_at, artifact_content_length) WHERE ((status = 'ready'::text) AND (completed_at IS NOT NULL))",
    "CREATE INDEX owner_exports_operational_summary_recent_idx ON portability.owner_exports USING btree (portfolio_id, status, requested_at DESC, export_id DESC) INCLUDE (started_at, completed_at, artifact_content_length)",
  ]);
  assert.deepEqual(columns.map(row => row.identity).toSorted(), [
    "operations.jobs.lease_acquired_at", "operations.outbox_events.lease_acquired_at",
  ]);
  assert.equal(migration.operationsAdditions.length, indexes.length + columns.length);
  assert.ok(indexes.every(row => row.expected.definition.startsWith("CREATE INDEX ") && row.expected.definition.includes(" USING btree ")));
  assert.ok(columns.every(row => row.expected.nullable === "YES" && row.expected.default === null));
});

test("the #252 incident migration binds added columns, checks, index, restricted column grants, and source checksum", () => {
  const migration = PHASE_DECLARED_ADDITIVE_MIGRATIONS.find(row => row.migration === "20261029120000_actionable_incident_delivery.sql");
  assert.ok(migration);
  assert.equal(migration.migrationSha256, migrationSha256(readFileSync(join(ROOT, "supabase/migrations", migration.migration), "utf8")));
  assert.equal(migration.operationsAdditions.length, 47);
  const categories = Object.groupBy(migration.operationsAdditions, row => row.category);
  assert.equal(categories.columns.length, 16);
  assert.equal(categories.constraints.length, 12);
  assert.equal(categories.indexes.length, 1);
  assert.equal(categories.grants.length, 18);
  assert.ok(categories.columns.some(row => row.identity === "operations.incidents.measured_value" && row.expected.nullable === "YES"));
  assert.ok(categories.columns.some(row => row.identity === "operations.incidents.delivery_lease_generation" && row.expected.default === "0"));
  assert.ok(categories.constraints.some(row => row.identity === "operations.incidents.incidents_delivery_lease_pair_check"));
  assert.ok(categories.grants.every(row => row.expected.grantee === "shipwithali_worker" && row.expected.privilege === "UPDATE"));
});

test("the #253 relational backup migration binds exact checks, indexes, policies, restricted grants, PG18 NOT NULL variants, and source checksum", () => {
  const migration = PHASE_DECLARED_ADDITIVE_MIGRATIONS.find(row => row.migration === "20261029150000_register_relational_backup_copies.sql");
  assert.ok(migration);
  assert.equal(migration.migrationSha256, migrationSha256(readFileSync(join(ROOT, "supabase/migrations", migration.migration), "utf8")));
  assert.equal(migration.operationsAdditions.length, 76);
  const categories = Object.groupBy(migration.operationsAdditions, row => row.category);
  assert.equal(categories.objects.length, 1);
  assert.equal(categories.columns.length, 22);
  assert.equal(categories.constraints.length, 20);
  assert.equal(categories.policies.length, 6);
  assert.equal(categories.grants.length, 24);
  assert.equal(categories.indexes.length, 3);
  assert.ok(categories.objects.every(row => row.identity === "operations.relational_backup_copies" && row.expected.rlsForced === true));
  assert.ok(categories.constraints.some(row => row.identity === "operations.relational_backup_copies.relational_backup_copies_failure_shape_check"));
  assert.ok(categories.policies.every(row => ["{shipwithali_backup}", "{shipwithali_worker}"].includes(row.expected.roles)));
  assert.ok(categories.grants.filter(row => row.expected.grantee === "shipwithali_backup").every(row => ["SELECT", "INSERT", "UPDATE"].includes(row.expected.privilege)));
  assert.ok(categories.grants.every(row => row.expected.grantee !== "shipwithali_application" && row.expected.grantor === "shipwithali_migration"));
  assert.ok(categories.indexes.every(row => row.expected.definition.startsWith("CREATE ") && row.expected.definition.includes(" ON operations.relational_backup_copies ")));
  const pg18 = migration.operationsAdditionsByEngine["18"];
  assert.equal(pg18.length, 15);
  assert.ok(pg18.every(row => row.category === "constraints" && row.expected.type === "n"));
  assert.deepEqual(migration.operationsAdditionsByEngine["17"], []);
  const sql = readFileSync(join(ROOT, "supabase/migrations", migration.migration), "utf8");
  assert.match(sql, /grant update \(state, failure_code, verified_at, committed_at, deletion_acknowledged_at\)\s+on operations\.relational_backup_copies to shipwithali_backup;/u);
  assert.match(sql, /grant update \(safe_error_code, last_observed_at, occurrences, resolved_at,\s+recovery_recorded_at, delivery_state, next_delivery_at\)\s+on operations\.incidents to shipwithali_backup;/u);
  assert.doesNotMatch(sql, /grant (?:all|update)\s+on operations\.relational_backup_copies to shipwithali_backup;/u);
});

test("the issue 254 object backup migration declares its protected ledger contract", () => {
  const migration = PHASE_DECLARED_ADDITIVE_MIGRATIONS.find((entry) => entry.ticket === 254);
  assert.ok(migration);
  assert.equal(migration.migration, "20261030100000_register_object_backup_copies.sql");
  assert.equal(migration.migrationSha256, migrationSha256(readFileSync(join(ROOT, "supabase/migrations", migration.migration), "utf8")));
  const entries = migration.operationsAdditions;
  assert.ok(entries.some((entry) => entry.category === "objects" && entry.identity === "operations.object_backup_copies"));
  assert.ok(entries.some((entry) => entry.category === "objects" && entry.identity === "operations.object_backup_owner_scopes"));
  assert.equal(entries.filter((entry) => entry.category === "columns").length, 34);
  for (const identity of ["operations.object_backup_copies.object_backup_copies_watermark_order_check",
    "operations.object_backup_copies.object_backup_copies_usable_verified_check",
    "operations.object_backup_copies.object_backup_copies_backup_insert",
    "portfolio_config.settings.object_backup_owner_scope_inventory",
    "operations.object_backup_owner_scopes.v.shipwithali_backup:shipwithali_migration:SELECT",
    "operations.object_backup_copies.object_backup_copies_backup_update",
    "operations.object_backup_copies.object_backup_copies_worker_inspect",
    "operations.object_backup_copies.r.shipwithali_worker:shipwithali_migration:SELECT",
    "operations.incidents.object_backup_incidents_insert", "operations.incidents.object_backup_incidents_update",
    "operations.object_backup_copies.object_backup_copies_current_idx",
    "operations.object_backup_copies.object_backup_copies_retention_idx"]) {
    assert.ok(entries.some((entry) => entry.identity === identity), identity);
  }
  assert.equal(migration.operationsAdditionsByEngine["18"].length, 17);
  const sql = readFileSync(join(ROOT, "supabase/migrations", migration.migration), "utf8");
  assert.match(sql, /grant select on operations\.object_backup_copies to shipwithali_backup, shipwithali_worker;/u);
});

test("canonical operations expectations bind complete row operations to reviewed migrations", () => {
  const boundary = composeOperationsBoundary(undefined, 18);
  assert.equal(boundary.operations.length, 100);
  const pg17 = composeOperationsBoundary(undefined, 17);
  assert.equal(pg17.operations.length, 85);
  assert.ok(!pg17.operations.some((operation) => operation.category === "constraints" && operation.after?.type === "n"));
  assert.throws(() => composeOperationsBoundary(undefined, 16), /PHASE3_OPERATIONS_ENGINE_UNSUPPORTED/u);
  assert.ok(boundary.operations.some((operation) => operation.category === "objects" && operation.identity === "operations.incidents" && operation.after?.rlsForced === true));
  assert.ok(boundary.operations.some((operation) => operation.category === "grants" && operation.identity.includes("operations.incidents.safe_error_code.c")));
  assert.ok(boundary.operations.some((operation) => operation.category === "indexes" && operation.identity === "operations.outbox_events.outbox_events_due_idx" && operation.after?.definition.includes("dead_at")));
});

test("capabilities are declared per checkpoint, never learned from a database", () => {
  assert.deepEqual(declaredCapabilities().toSorted(), ["measurement.events", "operations.bounded_retries", "operations.incident_delivery", "operations.object_backup", "operations.observability", "operations.phase7_durable_schedules", "operations.relational_backup", "portability.analytics_export", "portability.configuration_export", "portability.content_export", "portability.cv_export", "portability.feedback_export", "portability.media_export", "portability.owner_export_requests", "portability.taxonomy_export"]);
  assert.deepEqual(capabilitiesForMigrations(
    ["20261023100000_build_configuration_owner_exports.sql"],
    [],
    [{ migration: "20261023100000_build_configuration_owner_exports.sql", capability: "portability.configuration_export", includeInDeclaredCapabilities: true }],
  ), ["portability.configuration_export"]);
  assert.deepEqual(capabilitiesForMigrations(
    ["20261023100000_build_configuration_owner_exports.sql"],
    [],
    [{ migration: "20261023100000_build_configuration_owner_exports.sql", capability: "portability.configuration_export" }],
  ), []);
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
