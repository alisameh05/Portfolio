import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  runRecoveryRehearsal,
  validateRecoveryTarget,
  type RecoveryRehearsalPort,
  type RecoveryRehearsalReport,
} from "../../src/modules/portability-operations/application/recovery-rehearsal.js";
import { createRecoveryRehearsalIncidentRecorder } from "../../src/modules/portability-operations/application/recovery-rehearsal-incident.js";
import { RECOVERY_DOMAIN_SCOPES, recoveryDomainSnapshotSha256, verifyRecoveryDomainMeaning } from "../../src/modules/portability-operations/application/recovery-domain-verification.js";
import type { OwnerExportSnapshotReaderPort } from "../../src/modules/portability-operations/application/owner-export-assembly.js";
import { fixtureIds, snapshotFor } from "./owner-export-reference-fixture.js";
import { ok } from "../../src/shared/domain/index.js";
import type { DurableIncidentInput, DurableIncidentRecord, IncidentLifecycleStore } from "../../src/modules/portability-operations/application/incident-lifecycle.js";
import type { StableId } from "@shared/domain";

const now = "2026-10-30T12:00:00.000Z";
const target = {
  environment: "test",
  targetIdentity: "postgres://restore-user:target-secret@127.0.0.1:55432/recovery_test",
  sourceIdentity: "postgres://backup-user:source-secret@backup.example.test:5432/source",
  protectedIdentities: ["postgres://prod.example.test:5432/portfolio"],
  allowlistedTargetIdentities: ["postgres://127.0.0.1:55432/recovery_test"],
  objectTargetIdentity: "file:///isolated/recovery-target",
  sourceObjectIdentity: "https://primary.example.test/storage/portfolio",
  protectedObjectIdentities: ["s3://production/portfolio-media"],
  allowlistedObjectIdentities: ["file:///isolated/recovery-target"],
};

function ports(overrides: Partial<RecoveryRehearsalPort> = {}) {
  const calls: string[] = [];
  const base: RecoveryRehearsalPort = {
    now: () => now,
    selectCopies: async () => {
      calls.push("select");
      return {
        relational: { copyId: "relational-copy", sourceWatermarkAt: "2026-10-30T10:00:00.000Z", encryptedBytes: 8192,
          schemaCount: 5, relationCount: 20, migrationCount: 30 },
        object: null,
      };
    },
    verifyKeysAndCopies: async () => { calls.push("decrypt"); },
    verifyTarget: async () => { calls.push("target"); },
    enterQuarantine: async () => { calls.push("quarantine"); },
    restoreRelational: async () => { calls.push("relational"); },
    selectObjectCopy: async () => { calls.push("object-select"); return { copyId: "object-copy", sourceWatermarkAt: "2026-10-29T10:00:00.000Z", encryptedBytes: 4096,
      objectCount: 2, mediaBytes: 1024, exportBytes: 512, objectIds: ["media-1", "export-1"] }; },
    verifyObjectKeysAndCopies: async () => { calls.push("object-decrypt"); },
    restoreObjects: async () => { calls.push("objects"); },
    reconcileCurrentDeletionLedger: async () => { calls.push("deletions"); return { revoked: 1, acknowledgedDeleted: 1 }; },
    resetCredentialsAndReconcileGrants: async () => { calls.push("credentials"); },
    reconcileRecoveredEffects: async () => { calls.push("effects"); return { suppressed: 4, unresolved: 0 }; },
    rebuildProjections: async () => { calls.push("projections"); },
    verifyDomainMeaning: async () => {
      calls.push("domain");
      return { ids: 8, relationships: 3, hashes: 2, snapshotSha256: "a".repeat(64), expectedSnapshotSha256: "a".repeat(64), locales: true, lifecycle: true, routes: true,
        taxonomy: true, mediaAccessibility: true, cvHistory: true, moderationPrivacy: true, analyticsPrivacy: true,
        configuration: true };
    },
    verifyRestrictedRlsAndReadiness: async () => { calls.push("readiness"); return { allowCases: 3, denyCases: 5, ready: true }; },
    releaseQuarantine: async () => { calls.push("release"); },
    cleanupOwnedTargets: async () => { calls.push("cleanup"); return { databases: 1, objects: 2, temporaryFiles: 3, complete: true }; },
    recordSafeIncident: async () => { calls.push("incident"); },
    ...overrides,
  };
  return { calls, port: base };
}

describe("recovery domain verification through Owner Export snapshot API", () => {
  it("ignores capture metadata while retaining domain timestamps and values", async () => {
    const snapshot = await snapshotFor(RECOVERY_DOMAIN_SCOPES, fixtureIds.snapshot);
    const later = { ...snapshot, capturedAt: "2026-10-31T12:00:00.000Z",
      configuration: { ...snapshot.configuration!, capturedAt: "2026-10-31T12:00:00.000Z" } };
    expect(recoveryDomainSnapshotSha256(later)).toBe(recoveryDomainSnapshotSha256(snapshot));
    expect(recoveryDomainSnapshotSha256({ ...later, configuration: { ...later.configuration, configurationVersion: 999 } }))
      .not.toBe(recoveryDomainSnapshotSha256(snapshot));
    const changed = structuredClone(later);
    const value = changed.content!.records[0]!.value as Record<string, unknown>;
    value["firstPublishedAt"] = "2020-01-01T00:00:00.000Z";
    expect(recoveryDomainSnapshotSha256(changed)).not.toBe(recoveryDomainSnapshotSha256(snapshot));
  });

  it("checks the complete seven-scope snapshot, IDs, references, hashes, and privacy facts", async () => {
    const snapshot = await snapshotFor(RECOVERY_DOMAIN_SCOPES, fixtureIds.snapshot);
    const capture = vi.fn(async () => ok(snapshot));
    const reader: OwnerExportSnapshotReaderPort = { capture };
    const facts = await verifyRecoveryDomainMeaning({ snapshots: reader, portfolioId: fixtureIds.portfolio as never,
      ownerId: fixtureIds.owner as never, snapshotId: fixtureIds.snapshot as never,
      expectedSnapshotSha256: recoveryDomainSnapshotSha256(snapshot),
      currentPrivacyAndObjectChecks: { deletionApplied: true, revokedExportBytesCleared: true,
        revokedExportObjectRemoved: true, mediaObjectDigestMatches: true } });
    expect(capture).toHaveBeenCalledWith({ portfolioId: fixtureIds.portfolio, ownerId: fixtureIds.owner,
      snapshotId: fixtureIds.snapshot, includedScopes: RECOVERY_DOMAIN_SCOPES });
    expect(facts).toMatchObject({ ids: 5, locales: true, lifecycle: true, routes: true, taxonomy: true,
      mediaAccessibility: true, cvHistory: true, moderationPrivacy: true, analyticsPrivacy: true, configuration: true,
      snapshotSha256: facts.expectedSnapshotSha256 });
  });
});

describe("#255 isolated recovery rehearsal", () => {
  it.each(["postgres", "postgresql"])("rejects mixed-scheme source and protected aliases (%s)", scheme => {
    const targetIdentity = target.targetIdentity.replace("postgres:", `${scheme}:`);
    const alias = targetIdentity.replace(`${scheme}:`, scheme === "postgres" ? "postgresql:" : "postgres:");
    expect(() => validateRecoveryTarget({ ...target, targetIdentity, sourceIdentity: alias })).toThrow("RECOVERY_TARGET_PROTECTED");
    expect(() => validateRecoveryTarget({ ...target, targetIdentity,
      protectedIdentities: [alias.replace("restore-user:target-secret@", "")] })).toThrow("RECOVERY_TARGET_PROTECTED");
  });

  it("rejects a target that aliases a protected identity, is not allowlisted, or reuses source credentials", () => {
    expect(() => validateRecoveryTarget({ ...target, targetIdentity:
      "postgres://restore-user:target-secret@prod.example.test:5432/portfolio" })).toThrow("RECOVERY_TARGET_PROTECTED");
    expect(() => validateRecoveryTarget({ ...target, allowlistedTargetIdentities: [] })).toThrow("RECOVERY_TARGET_NOT_ALLOWLISTED");
    expect(() => validateRecoveryTarget({ ...target,
      targetIdentity: target.targetIdentity.replace("recovery_test", "Recovery_test") }))
      .toThrow("RECOVERY_TARGET_NOT_ALLOWLISTED");
    expect(() => validateRecoveryTarget({ ...target,
      protectedIdentities: [...target.protectedIdentities, "postgres://127.0.0.1:55432/Recovery_test"] })).not.toThrow();
    const reusedSourceCredential = target.targetIdentity.replace("target-secret", "source-secret");
    expect(() => validateRecoveryTarget({ ...target, targetIdentity: reusedSourceCredential }))
      .toThrow("RECOVERY_CREDENTIALS_NOT_SEPARATE");
    expect(() => validateRecoveryTarget({ ...target, environment: "production" })).toThrow("RECOVERY_PRODUCTION_TARGET_FORBIDDEN");
    expect(() => validateRecoveryTarget({ ...target, objectTargetIdentity: "s3://production/portfolio-media" }))
      .toThrow("RECOVERY_OBJECT_TARGET_PROTECTED");
    expect(() => validateRecoveryTarget({ ...target, allowlistedObjectIdentities: [] }))
      .toThrow("RECOVERY_OBJECT_TARGET_NOT_ALLOWLISTED");
  });

  it("keeps restored contents quarantined until current deletion, credential, queue, domain, and RLS checks pass", async () => {
    const { calls, port } = ports();
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, port);
    expect(calls).toEqual(["select", "target", "decrypt", "quarantine", "relational", "object-select", "object-decrypt", "objects", "deletions",
      "credentials", "effects", "projections", "domain", "readiness", "release", "cleanup"]);
    expect(report.status).toBe("complete");
    expect(report.accessReleased).toBe(true);
    expect(report.effects?.unresolved).toBe(0);
    expect(report.cleanup.complete).toBe(true);
    expect(report.relationalRpoHours).toBe(2);
    expect(report.mediaRpoHours).toBe(26);
    expect(report.releaseBlocker).toBe(false);
  });

  it("does not expose a bad key or corrupt copy and cleans the owned target", async () => {
    const { calls, port } = ports({ verifyKeysAndCopies: async () => { calls.push("decrypt"); throw new Error("BACKUP_KEY_MISSING"); } });
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, port);
    expect(calls).toEqual(["select", "target", "decrypt", "cleanup", "incident"]);
    expect(calls).not.toContain("relational");
    expect(report.failureCode).toBe("RECOVERY_COPY_OR_KEY_INVALID");
    expect(report.releaseBlocker).toBe(true);
  });

  it("keeps a corrupt encrypted object copy quarantined and records a safe release blocker", async () => {
    const { calls, port } = ports({ verifyObjectKeysAndCopies: async () => {
      calls.push("object-decrypt"); throw new Error("OBJECT_BACKUP_CIPHERTEXT_MISMATCH");
    } });
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, port);
    expect(report).toMatchObject({ status: "failed", failureStage: "object_download_decrypt_validate",
      failureCode: "RECOVERY_OBJECT_COPY_INVALID", releaseBlocker: true, accessReleased: false });
    expect(calls).toContain("cleanup");
    expect(calls).not.toContain("objects");
    expect(calls).not.toContain("release");
    expect(report.incident).toEqual({ code: "RECOVERY_OBJECT_COPY_INVALID", recorded: true });
  });

  it("blocks release when restored domain snapshot identities or hashes differ from the expected snapshot", async () => {
    const { calls, port } = ports({ verifyDomainMeaning: async () => ({ ids: 8, relationships: 3, hashes: 2,
      snapshotSha256: "b".repeat(64), expectedSnapshotSha256: "a".repeat(64), locales: true, lifecycle: true, routes: true,
      taxonomy: true, mediaAccessibility: true, cvHistory: true, moderationPrivacy: true, analyticsPrivacy: true, configuration: true }) });
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, port);
    expect(report).toMatchObject({ status: "failed", failureStage: "domain_verification",
      failureCode: "RECOVERY_ACCEPTANCE_TARGET_FAILED", releaseBlocker: true, accessReleased: false });
    expect(calls).not.toContain("release");
    expect(calls).toContain("cleanup");
  });

  it("records one sanitized incident and a release blocker on failed or over-target rehearsal", async () => {
    const { calls, port } = ports({
      now: (() => { let tick = 0; return () => new Date(Date.parse(now) + tick++ * 60_000).toISOString(); })(),
      verifyRestrictedRlsAndReadiness: async () => ({ allowCases: 2, denyCases: 4, ready: false }),
    });
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, port);
    expect(report.status).toBe("failed");
    expect(report.accessReleased).toBe(false);
    expect(report.releaseBlocker).toBe(true);
    expect(report.incident).toEqual({ code: "RECOVERY_READINESS_FAILED", recorded: true });
    expect(calls.filter(call => call === "incident")).toHaveLength(1);
    expect(calls.indexOf("cleanup")).toBeLessThan(calls.indexOf("incident"));
  });

  it("returns only sanitized measurements and truthful unknowns for missing volume or watermark", async () => {
    const { port } = ports({ selectCopies: async () => ({
      relational: { copyId: "relational-copy", sourceWatermarkAt: "2026-10-30T10:00:00.000Z", encryptedBytes: 8192,
        schemaCount: 5, relationCount: 20, migrationCount: 30 },
      object: null,
    }) });
    const completePort = { ...port, selectObjectCopy: async () => ({ copyId: "object-copy", sourceWatermarkAt: null, encryptedBytes: 0, objectCount: 0,
      mediaBytes: null, exportBytes: null, objectIds: [] }) };
    const report: RecoveryRehearsalReport = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24,
      mediaRpoHours: 168, rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, completePort);
    expect(report.mediaRpoHours).toBeNull();
    expect(report.mediaBytes).toBeNull();
    expect(report.status).toBe("failed");
    expect(JSON.stringify(report)).not.toContain("secret");
    expect(JSON.stringify(report)).not.toContain("recovery_test");
  });

  it("includes discovery/access and manual pause intervals in RTO exactly once", async () => {
    const startedAt = new Date(Date.parse(now) + 120_000).toISOString();
    const { port } = ports({ now: () => new Date(Date.parse(startedAt) + 9 * 3_600_000).toISOString() });
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt,
      discoveryAccessMilliseconds: 120_000, manualPauseMilliseconds: 9 * 3_600_000 }, port);
    expect(report.status).toBe("failed");
    expect(report.releaseBlocker).toBe(true);
    expect(report.failureCode).toBe("RECOVERY_ACCEPTANCE_TARGET_FAILED");
    expect(report.failureStage).toBe("timing_qualification");
    expect(report.manualPauseMilliseconds).toBe(9 * 3_600_000);
    expect(report.discoveryAccessMilliseconds).toBe(120_000);
    expect(report.measuredRtoMilliseconds).toBe(9 * 3_600_000 + 120_000);
    expect(report.stageMilliseconds).toMatchObject({ discovery_access: 120_000, manual_pauses: 9 * 3_600_000 });
    expect(Object.keys(report.stageMilliseconds)).toContain("relational_restore");
  });

  it("rejects reversed reference and verification clocks", async () => {
    const { calls, port } = ports();
    await expect(runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: new Date(Date.parse(now) - 1).toISOString(),
      discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, port)).rejects.toThrow("RECOVERY_MEASUREMENT_CONFIG_INVALID");
    const reversed = ports({ now: () => new Date(Date.parse(now) - 1).toISOString() });
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, reversed.port);
    expect(report).toMatchObject({ status: "failed", failureStage: "timing_qualification", failureCode: "RECOVERY_CLOCK_ORDER_INVALID",
      measuredRtoMilliseconds: null, releaseBlocker: true });
    expect(calls).toEqual([]);
  });

  it("keeps outbounds and queues fenced when stale effects cannot be reconciled", async () => {
    const { calls, port } = ports({ reconcileRecoveredEffects: async () => { calls.push("effects"); return { suppressed: 3, unresolved: 1 }; } });
    const report = await runRecoveryRehearsal({ target, referenceAt: now, relationalRpoHours: 24, mediaRpoHours: 168,
      rtoTargetMilliseconds: 28_800_000, startedAt: now, discoveryAccessMilliseconds: 0, manualPauseMilliseconds: 0 }, port);
    expect(report.status).toBe("failed");
    expect(report.accessReleased).toBe(false);
    expect(calls).not.toContain("projections");
    expect(calls.indexOf("cleanup")).toBeLessThan(calls.indexOf("incident"));
  });

  it("routes failed runs to the fixed backup incident rule and stable rehearsal scope", async () => {
    const recorded: DurableIncidentInput[] = [];
    const store = { upsert: async (input: DurableIncidentInput) => {
      recorded.push(input);
      return {} as DurableIncidentRecord;
    } } as Pick<IncidentLifecycleStore, "upsert">;
    const recordIncident = createRecoveryRehearsalIncidentRecorder({
      store,
      rehearsalId: "00000000-0000-4000-8000-000000000255" as StableId<"RecoveryRehearsal">,
      incidentId: "00000000-0000-4000-8000-000000000256" as StableId<"OperationsIncident">,
      environment: "test",
      now: () => now,
    });
    await recordIncident("RECOVERY_READINESS_FAILED");
    await recordIncident("RECOVERY_READINESS_FAILED");
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ scopeKey: "00000000-0000-4000-8000-000000000255",
      rule: { key: "recovery.outcome_failed", code: "RECOVERY_REHEARSAL_FAILED", severity: "critical", owner: "backup" }, value: 1 });
  });

  it("defines nightly, weekly, and monthly schedules with explicit later-phase installation handoffs", () => {
    const readSchedule = (name: string) => JSON.parse(readFileSync(resolve(process.cwd(), "docs/operations", name), "utf8")) as Record<string, unknown>;
    const nightly = readSchedule("phase8-relational-backup-nightly.json");
    const weekly = readSchedule("phase8-object-backup-weekly.json");
    const monthly = readSchedule("phase8-recovery-rehearsal-monthly.json");
    expect(nightly).toMatchObject({ frequency: "nightly", installed: false, phase: 8 });
    expect(weekly).toMatchObject({ frequency: "weekly", installed: false, phase: 8 });
    expect(monthly).toMatchObject({ frequency: "monthly", installed: false, phase: 8,
      command: "npm run test:phase8:recovery", timezone: "UTC", maximumConcurrentRuns: 1 });
    expect(monthly["phase9Handoff"]).toContain("Phase 9");
    expect(monthly["phase10Handoff"]).toContain("Phase 10");
  });
});
