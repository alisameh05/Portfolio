import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPhase4ApplicationRls,
  assertPhase4SnapshotsEquivalent,
  roleMembershipContract,
  phase3OperationsContract,
  phase4ReleaseContract,
  assertPhase5MigrationSafety,
  PHASE5_MIGRATION_COMPATIBILITY,
  PHASE4_APPLICATION_TABLES,
  validatePhase3MigrationSnapshot,
  assertPhase3OperationsContractPreserved,
} from "../../scripts/phase4-migration-integrity.mjs";

const phase3Files = [
  "20260922170000_prepare_migration_capability.sql",
  "20260922171906_establish_database_security_baseline.sql",
  "20260922203000_create_operations_primitives.sql",
];
const contents = new Map(phase3Files.map((name) => [name, `-- ${name}\n`]));
const sha256 = (text: string) => createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
type CatalogRow = { schema?: string; name?: string; [key: string]: unknown };
type OperationsSnapshot = {
  postgresMajor: 17 | 18;
  schemas: CatalogRow[];
  objects: CatalogRow[];
  columns: CatalogRow[];
  constraints: CatalogRow[];
  policies: CatalogRow[];
  grants: CatalogRow[];
  defaultPrivileges: CatalogRow[];
  indexes: CatalogRow[];
  functions: CatalogRow[];
  triggers: CatalogRow[];
  types: CatalogRow[];
};

describe("Phase 4 migration integrity", () => {
  it("compares migration role memberships as order-independent catalog facts", () => {
    const rows = [
      { role: "shipwithali_migration", member: "postgres", adminOption: false },
      { role: "shipwithali_summary_reader", member: "shipwithali_migration", adminOption: false },
    ];
    expect(roleMembershipContract(rows)).toEqual(roleMembershipContract([...rows].reverse()));
    expect(roleMembershipContract(rows)).not.toEqual(roleMembershipContract([
      ...rows.slice(0, 1), { ...rows[1]!, adminOption: true },
    ]));
    const baseline = { roleMemberships: rows, policies: [], grants: [] };
    const reordered = { roleMemberships: [...rows].reverse(), policies: [], grants: [] };
    expect(phase4ReleaseContract(baseline)).toEqual(phase4ReleaseContract(reordered));
  });

  it("accepts only the committed Phase 3 migration snapshot and matching checksums", () => {
    const checksums = Object.fromEntries(phase3Files.map((name) => [name, sha256(contents.get(name)!)]));
    const snapshot = { release: "phase-3", migrations: checksums };

    expect(() => validatePhase3MigrationSnapshot(snapshot, phase3Files, contents)).not.toThrow();
    expect(() => validatePhase3MigrationSnapshot(snapshot, [...phase3Files, "20261001000000_new.sql"], contents)).toThrow(
      "PHASE3_MIGRATION_SNAPSHOT_SOURCE_MISMATCH",
    );
  });

  it("rejects migration snapshot checksum drift", () => {
    const snapshot = {
      release: "phase-3",
      migrations: Object.fromEntries(phase3Files.map((name) => [name, sha256(contents.get(name)!)])),
    };
    const changed = new Map(contents).set(phase3Files[0]!, "-- changed\n");

    expect(() => validatePhase3MigrationSnapshot(snapshot, phase3Files, changed)).toThrow(
      "PHASE3_MIGRATION_SNAPSHOT_CHECKSUM_MISMATCH",
    );
  });

  it("fails clean versus upgrade equivalence on grants, constraints, or policy drift", () => {
    const clean = {
      grants: [{ grantee: "application", privilege: "SELECT" }],
      constraints: [{ name: "settings_version_positive", definition: "CHECK (version > 0)" }],
      policies: [{ table: "settings", using: "portfolio_id = trusted_portfolio" }],
    };

    expect(() => assertPhase4SnapshotsEquivalent(clean, structuredClone(clean))).not.toThrow();
    expect(() => assertPhase4SnapshotsEquivalent(
      clean,
      { ...structuredClone(clean), policies: [{ table: "settings", using: "true" }] },
    )).toThrow("PORTFOLIO_SETTINGS_DATABASE_STATE_DIFFER:policies");
  });

  it("applies exact reviewed row replacements and rejects a changed declared target", () => {
    const phase3: OperationsSnapshot = {
      postgresMajor: 17,
      schemas: [{ name: "operations", owner: "shipwithali_migration", acl: "" }],
      objects: [{ schema: "operations", name: "jobs", kind: "r", owner: "shipwithali_migration", rlsEnabled: true, rlsForced: true }],
      columns: [], constraints: [], policies: [], grants: [], defaultPrivileges: [], indexes: [], functions: [], triggers: [], types: [],
    };
    const oldPolicy = { schema: "operations", tableName: "jobs", name: "worker_insert", permissive: "permissive", roles: "{shipwithali_worker}", command: "INSERT", usingPredicate: "", withCheck: "true" };
    const newPolicy = { ...oldPolicy, name: "application_insert", roles: "{shipwithali_application}", withCheck: "payload_version = 1 AND payload ? 'eventId'" };
    const oldGrant = { schema: "operations", object: "jobs", objectType: "r", grantee: "shipwithali_worker", grantor: "shipwithali_migration", privilege: "INSERT", grantable: false };
    const newGrant = { ...oldGrant, grantee: "shipwithali_application" };
    phase3.policies.push(oldPolicy);
    phase3.grants.push(oldGrant);
    const operations = [
      { category: "policies", identity: "operations.jobs.worker_insert", before: oldPolicy, after: null },
      { category: "policies", identity: "operations.jobs.application_insert", before: null, after: newPolicy },
      { category: "grants", identity: "operations.jobs.r.shipwithali_worker:shipwithali_migration:INSERT", before: oldGrant, after: null },
      { category: "grants", identity: "operations.jobs.r.shipwithali_application:shipwithali_migration:INSERT", before: null, after: newGrant },
    ];
    const transformation = { migration: "synthetic-reviewed.sql", operations };
    const upgraded = structuredClone(phase3);
    upgraded.policies.splice(0, 1, newPolicy);
    upgraded.grants.splice(0, 1, newGrant);
    expect(() => assertPhase3OperationsContractPreserved(phase3, upgraded, { transformations: [transformation] })).not.toThrow();
    expect(() => assertPhase3OperationsContractPreserved(phase3, { ...upgraded, postgresMajor: 18 }, { transformations: [transformation] }))
      .toThrow("PHASE3_OPERATIONS_ENGINE_MISMATCH");
    expect(() => assertPhase3OperationsContractPreserved({ ...phase3, postgresMajor: 16 }, upgraded, { transformations: [transformation] }))
      .toThrow("PHASE3_OPERATIONS_ENGINE_UNSUPPORTED");
    const widened = structuredClone(upgraded);
    widened.policies[0]!["withCheck"] = "true";
    try {
      assertPhase3OperationsContractPreserved(phase3, widened, { transformations: [transformation] });
      throw new Error("expected policy drift rejection");
    } catch (error) {
      expect(error).toMatchObject({
        code: "PHASE3_OPERATIONS_CONTRACT_ALTERED",
        categories: ["policies"],
        paths: ["policies:operations.jobs.application_insert:withCheck"],
      });
    }
    const wrongTarget = { ...transformation, operations: operations.map((operation) =>
      operation.identity === "operations.jobs.application_insert" ? { ...operation, after: { ...newPolicy, withCheck: "true" } } : operation) };
    expect(() => assertPhase3OperationsContractPreserved(phase3, upgraded, { transformations: [wrongTarget] }))
      .toThrow("PHASE3_OPERATIONS_CONTRACT_ALTERED");
  });

  const preservationBaseline: OperationsSnapshot = {
      postgresMajor: 17,
      schemas: [{ name: "operations", owner: "shipwithali_migration", acl: "" }],
      objects: [{ schema: "operations", name: "jobs", kind: "r", owner: "shipwithali_migration", rlsEnabled: true, rlsForced: true }],
      columns: [{ schema: "operations", tableName: "jobs", name: "status", type: "text", nullable: "NO", default: null }],
      constraints: [{ schema: "operations", tableName: "jobs", name: "jobs_status_check", type: "c", validated: true, definition: "CHECK (status <> '')" }],
      policies: [{ schema: "operations", tableName: "jobs", name: "worker_select", roles: "{shipwithali_worker}", command: "SELECT", usingPredicate: "worker_scope", withCheck: "" }],
      grants: [{ schema: "operations", object: "jobs", objectType: "r", grantee: "shipwithali_worker", grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }],
      defaultPrivileges: [],
      indexes: [{ schema: "operations", table: "jobs", name: "jobs_status_idx", definition: "CREATE INDEX jobs_status_idx ON operations.jobs USING btree (status)" }],
      functions: [], triggers: [], types: [],
    };
  const expectContractDriftRejected = (name: string, mutate: (candidate: typeof preservationBaseline) => void) => {
    it(name, () => {
      const candidate = structuredClone(preservationBaseline);
      mutate(candidate);
      expect(() => assertPhase3OperationsContractPreserved(preservationBaseline, candidate, { transformations: [] }))
        .toThrow("PHASE3_OPERATIONS_CONTRACT_ALTERED");
    });
  };
  expectContractDriftRejected("rejects changed existing column types", (candidate) => { candidate.columns[0]!["type"] = "integer"; });
  expectContractDriftRejected("rejects changed existing column defaults", (candidate) => { (candidate.columns[0] as { default: string | null }).default = "1"; });
  expectContractDriftRejected("rejects changed existing column nullability", (candidate) => { candidate.columns[0]!["nullable"] = "YES"; });
  expectContractDriftRejected("rejects changed existing policy predicates", (candidate) => { candidate.policies[0]!["usingPredicate"] = "true"; });
  expectContractDriftRejected("rejects changed existing policy roles", (candidate) => { candidate.policies[0]!["roles"] = "{anon}"; });
  expectContractDriftRejected("rejects changed existing table ownership", (candidate) => { candidate.objects[0]!["owner"] = "anon"; });
  expectContractDriftRejected("rejects changed existing RLS enforcement", (candidate) => { candidate.objects[0]!["rlsForced"] = false; });
  expectContractDriftRejected("rejects changed existing grantability", (candidate) => { candidate.grants[0]!["grantable"] = true; });
  expectContractDriftRejected("rejects changed existing constraint definitions", (candidate) => { candidate.constraints[0]!["definition"] = "CHECK (true)"; });
  expectContractDriftRejected("rejects changed existing index definitions", (candidate) => { candidate.indexes[0]!["definition"] = "CREATE INDEX jobs_status_idx ON operations.jobs USING btree (status) WHERE true"; });

  it("rejects duplicate table-scoped catalog identities instead of collapsing them", () => {
    const snapshot = {
      postgresMajor: 17 as const,
      schemas: [], objects: [], columns: [], constraints: [], policies: [], grants: [], defaultPrivileges: [],
      indexes: [], functions: [], triggers: [], types: [],
    };
    const duplicate = { ...structuredClone(snapshot), columns: [
      { schema: "operations", tableName: "jobs", name: "status", type: "text" },
      { schema: "operations", tableName: "jobs", name: "status", type: "text" },
    ] };
    expect(() => assertPhase3OperationsContractPreserved(snapshot, duplicate, { transformations: [] }))
      .toThrow("PHASE3_OPERATIONS_CONTRACT_DUPLICATE_IDENTITY");
  });

  it("requires forced RLS and the intended policy roles and scope on every Phase 4 application table", () => {
    const settingsScope = "(((portfolio_id)::text = current_setting('shipwithali.portfolio_id'::text, true)) AND ((owner_id)::text = current_setting('shipwithali.owner_id'::text, true)))";
    const channelsScope = "(((portfolio_id)::text = current_setting('shipwithali.portfolio_id'::text, true)) AND (EXISTS ( SELECT 1 FROM portfolio_config.settings settings WHERE ((settings.portfolio_id = contact_channels.portfolio_id) AND ((settings.owner_id)::text = current_setting('shipwithali.owner_id'::text, true))))))";
    const workerSettingsScope = "(((portfolio_id)::text = nullif(current_setting('shipwithali.portfolio_id'::text, true), ''::text)) AND ((owner_id)::text = nullif(current_setting('shipwithali.owner_id'::text, true), ''::text)))";
    const workerChannelsScope = "(((portfolio_id)::text = nullif(current_setting('shipwithali.portfolio_id'::text, true), ''::text)) AND (EXISTS ( SELECT 1 FROM portfolio_config.settings settings WHERE ((settings.portfolio_id = contact_channels.portfolio_id) AND ((settings.owner_id)::text = nullif(current_setting('shipwithali.owner_id'::text, true), ''::text))))))";
    const policyData = [
      ["identity_access", "owner_links", "owner_links_application_select_policy", "SELECT", "{shipwithali_application}", "true", ""],
      ["identity_access", "owner_links", "owner_links_application_insert_policy", "INSERT", "{shipwithali_application}", "", "true"],
      ["identity_access", "owner_links", "owner_links_application_update_policy", "UPDATE", "{shipwithali_application}", "true", "true"],
      ["identity_access", "owner_links", "owner_links_backup_policy", "SELECT", "{shipwithali_backup}", "true", ""],
      ["portfolio_config", "settings", "portfolio_settings_application_select", "SELECT", "{shipwithali_application}", settingsScope, ""],
      ["portfolio_config", "settings", "portfolio_settings_application_insert", "INSERT", "{shipwithali_application}", "", settingsScope],
      ["portfolio_config", "settings", "portfolio_settings_application_update", "UPDATE", "{shipwithali_application}", settingsScope, settingsScope],
      ...["SELECT", "INSERT", "DELETE"].map((command) => {
        return ["portfolio_config", "contact_channels", `portfolio_channels_application_${command.toLowerCase()}`, command, "{shipwithali_application}", command === "INSERT" ? "" : channelsScope, command === "INSERT" ? channelsScope : ""];
      }),
    ];
    const snapshot = {
      objects: PHASE4_APPLICATION_TABLES.map((name) => {
        const [schema, objectName] = name.split(".");
        return { schema, name: objectName, kind: "r", rlsEnabled: true, rlsForced: true };
      }),
      policies: policyData.map(([schema, tableName, name, command, roles, usingPredicate, withCheck]) => ({
        schema, tableName, name, command, roles, permissive: "permissive", usingPredicate, withCheck,
      })),
      grants: [],
      defaultPrivileges: [],
    };
    expect(() => assertPhase4ApplicationRls(snapshot)).not.toThrow();

    expect(() => assertPhase4ApplicationRls({
      ...snapshot,
      objects: snapshot.objects.map((object, index) => index === 0 ? { ...object, rlsForced: false } : object),
    })).toThrow("PHASE4_APPLICATION_TABLE_RLS_NOT_FORCED");
    expect(() => assertPhase4ApplicationRls({
      ...snapshot,
      policies: snapshot.policies.map((policy, index) => index === 0 ? { ...policy, usingPredicate: "" } : policy),
    })).toThrow("PHASE4_APPLICATION_POLICY_PREDICATE_MISSING");
    expect(() => assertPhase4ApplicationRls({
      ...snapshot,
      policies: snapshot.policies.map((policy) => policy.name === "portfolio_settings_application_select"
        ? { ...policy, usingPredicate: "true OR true" } : policy),
    })).toThrow("PHASE4_APPLICATION_POLICY_PREDICATE_MISSING");
    expect(() => assertPhase4ApplicationRls({
      ...snapshot,
      policies: snapshot.policies.map((policy) => policy.name === "portfolio_settings_application_insert"
        ? { ...policy, withCheck: `${settingsScope} OR true` } : policy),
    })).toThrow("PHASE4_APPLICATION_POLICY_PREDICATE_MISSING");
    expect(() => assertPhase4ApplicationRls({
      ...snapshot,
      policies: snapshot.policies.map((policy) => policy.name === "portfolio_channels_application_select"
        ? { ...policy, usingPredicate: `${channelsScope} OR true` } : policy),
    })).toThrow("PHASE4_APPLICATION_POLICY_PREDICATE_MISSING");
    expect(() => assertPhase4ApplicationRls({
      ...snapshot,
      grants: [{ schema: "portfolio_config", grantee: "shipwithali_worker", privilege: "SELECT", objectType: "r" }],
    })).toThrow("PHASE4_APPLICATION_GRANT_EXPOSURE");

    const configurationExportSnapshot = {
      ...snapshot,
      migrationLedger: [{ version: "20261023100000", name: "build_configuration_owner_exports" }],
      policies: [
        ...snapshot.policies,
        { schema: "portfolio_config", tableName: "settings", name: "portfolio_settings_worker_export_select", command: "SELECT", roles: "{shipwithali_worker}", permissive: "permissive", usingPredicate: workerSettingsScope, withCheck: "" },
        { schema: "portfolio_config", tableName: "contact_channels", name: "portfolio_channels_worker_export_select", command: "SELECT", roles: "{shipwithali_worker}", permissive: "permissive", usingPredicate: workerChannelsScope, withCheck: "" },
      ],
      grants: [
        { schema: "portfolio_config", object: "portfolio_config", objectType: "n", grantee: "shipwithali_worker", privilege: "USAGE" },
        { schema: "portfolio_config", object: "settings", objectType: "r", grantee: "shipwithali_worker", privilege: "SELECT" },
        { schema: "portfolio_config", object: "contact_channels", objectType: "r", grantee: "shipwithali_worker", privilege: "SELECT" },
      ],
    };
    expect(() => assertPhase4ApplicationRls(configurationExportSnapshot)).not.toThrow();
    expect(() => assertPhase4ApplicationRls({
      ...configurationExportSnapshot,
      grants: [...configurationExportSnapshot.grants,
        { schema: "portfolio_config", object: "settings", objectType: "r", grantee: "shipwithali_worker", privilege: "UPDATE" }],
    })).toThrow("PHASE4_APPLICATION_GRANT_EXPOSURE");
    expect(() => assertPhase4ApplicationRls({
      ...configurationExportSnapshot,
      grants: [...configurationExportSnapshot.grants,
        { schema: "portfolio_config", object: "portfolio_config", objectType: "n", grantee: "shipwithali_worker", privilege: "CREATE" }],
    })).toThrow("PHASE4_APPLICATION_GRANT_EXPOSURE");
  });

  it("requires timestamped Phase 5 migrations with bounded lock timeouts and recovery notes", () => {
    const files = ["20261005001318_create_content_authoring.sql"];
    const source = "-- Rollback: restore the previous snapshot.\n-- Forward fix: add a reviewed expansion.\nset lock_timeout = '5s';\ncreate table content.items(id uuid);\n";
    expect(assertPhase5MigrationSafety(files, new Map([[files[0]!, source]]))).toEqual(files);
    expect(() => assertPhase5MigrationSafety(files, new Map([[files[0]!, source.replace("5s", "0")]])))
      .toThrow("PHASE5_MIGRATION_LOCK_TIMEOUT_MISSING");
    expect(() => assertPhase5MigrationSafety(files, new Map([[files[0]!, source.replace("-- Rollback:", "-- Recovery:")]])))
      .toThrow("PHASE5_MIGRATION_ROLLBACK_NOTE_MISSING");
  });

  it("rejects destructive Phase 5 contractions without an explicitly reviewed migration path", () => {
    const file = "20261005001318_create_content_authoring.sql";
    const source = "-- Rollback: restore the previous snapshot.\nset lock_timeout = '5s';\ndrop table content.items;\n";
    expect(() => assertPhase5MigrationSafety([file], new Map([[file, source]])))
      .toThrow("PHASE5_UNREVIEWED_DESTRUCTIVE_CONTRACTION");
  });

  it("requires an explicit expand or lockstep compatibility boundary for every audited migration", () => {
    const file = "20261005001318_create_content_authoring.sql";
    const source = "-- Rollback: restore the previous snapshot.\n-- Forward fix: add a reviewed expansion.\nset lock_timeout = '5s';\ncreate table content.items(id uuid);\n";
    expect(PHASE5_MIGRATION_COMPATIBILITY[file]?.stage).toBe("expand");
    expect(PHASE5_MIGRATION_COMPATIBILITY["20261009090000_record_taxonomy_evolution_actor_reason.sql"]?.priorWriterCompatible).toBe(false);
    expect(() => assertPhase5MigrationSafety([file], new Map([[file, source]]), {} as never))
      .toThrow("PHASE5_MIGRATION_COMPATIBILITY_UNDOCUMENTED");
  });

  it("limits Phase 5 safety checks to the Phase 5 migration window", () => {
    const phase5File = "20261005001318_create_content_authoring.sql";
    const phase7File = "20261014194925_measurement_consent.sql";
    const phase5Source = "-- Rollback: restore the previous snapshot.\n-- Forward fix: add a reviewed expansion.\nset lock_timeout = '5s';\ncreate table content.items(id uuid);\n";
    expect(assertPhase5MigrationSafety([phase5File, phase7File], new Map([
      [phase5File, phase5Source],
      [phase7File, "create table measurement.consents(id uuid);"],
    ]))).toEqual([phase5File]);

    const unclassifiedPhase5File = "20261008140000_add_content_projection.sql";
    expect(() => assertPhase5MigrationSafety([phase5File, unclassifiedPhase5File], new Map([
      [phase5File, phase5Source],
      [unclassifiedPhase5File, phase5Source],
    ]))).toThrow("PHASE5_MIGRATION_COMPATIBILITY_UNDOCUMENTED");
  });
});
