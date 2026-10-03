import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertPhase4ApplicationRls,
  assertPhase4SnapshotsEquivalent,
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

  it("requires forced RLS and complete predicates on every Phase 4 application table", () => {
    const snapshot = {
      objects: PHASE4_APPLICATION_TABLES.map((name) => {
        const [schema, objectName] = name.split(".");
        return { schema, name: objectName, kind: "r", rlsEnabled: true, rlsForced: true };
      }),
      policies: PHASE4_APPLICATION_TABLES.map((name) => {
        const [schema, tableName] = name.split(".");
        return { schema, tableName, command: "SELECT", usingPredicate: "true", withCheck: "" };
      }),
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
      grants: [{ schema: "portfolio_config", grantee: "shipwithali_worker", privilege: "SELECT", objectType: "r" }],
    })).toThrow("PHASE4_APPLICATION_GRANT_EXPOSURE");
  });
});
