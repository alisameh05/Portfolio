import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPhase4ApplicationRls,
  assertPhase4SnapshotsEquivalent,
  assertPhase5MigrationSafety,
  PHASE5_MIGRATION_COMPATIBILITY,
  PHASE4_APPLICATION_TABLES,
  validatePhase3MigrationSnapshot,
} from "../../scripts/phase4-migration-integrity.mjs";

const phase3Files = [
  "20260922170000_prepare_migration_capability.sql",
  "20260922171906_establish_database_security_baseline.sql",
  "20260922203000_create_operations_primitives.sql",
];
const contents = new Map(phase3Files.map((name) => [name, `-- ${name}\n`]));
const sha256 = (text: string) => createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");

describe("Phase 4 migration integrity", () => {
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

  it("requires forced RLS and the intended policy roles and scope on every Phase 4 application table", () => {
    const settingsScope = "(((portfolio_id)::text = current_setting('shipwithali.portfolio_id'::text, true)) AND ((owner_id)::text = current_setting('shipwithali.owner_id'::text, true)))";
    const channelsScope = "(((portfolio_id)::text = current_setting('shipwithali.portfolio_id'::text, true)) AND (EXISTS ( SELECT 1 FROM portfolio_config.settings settings WHERE ((settings.portfolio_id = contact_channels.portfolio_id) AND ((settings.owner_id)::text = current_setting('shipwithali.owner_id'::text, true))))))";
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
