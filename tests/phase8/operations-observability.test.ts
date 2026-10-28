import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { createOperationsSummaryService, evaluateBackupRpo, OPERATIONS_SUMMARY_PURPOSE, recordOperationsSignal,
  type OperationsSummarySnapshot, type RetentionFailureLogWindow, type RetentionFailureLogWindowQuery,
  type RetentionFailureLogWindowReaderPort } from "../../src/modules/portability-operations/application/operations-observability.js";
import type { OperationsSignalObservation } from "../../src/modules/portability-operations/application/service.js";
import { handlePostPublicEvent } from "../../src/runtime/http/public-event.js";
import { handleGetCurrentCv } from "../../src/runtime/http/current-cv.js";
import { handleGetOwnerCvPortfolio } from "../../src/runtime/http/owner-cv.js";
import { handleDownloadOwnerExport, handleGetOwnerExport, type OwnerExportAdapterDeps } from "../../src/runtime/http/owner-export.js";
import { createSupabaseOwnerExportStorage } from "../../src/runtime/adapters/supabase-owner-export-storage.js";
import { createSystemIdGenerator, createTestLogger } from "../../src/runtime/ports.js";
import { createStableId, type StableId } from "../../src/shared/domain/index.js";
import { parseOperationsSummaryArguments } from "../../scripts/operations-summary-args.js";
import { buildConfigurationOwnerExportPackage } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { createOwnerExportAssemblyService, type OwnerExportAssemblyDependencies } from "../../src/modules/portability-operations/application/owner-export-assembly.js";
import { OWNER_EXPORT_ASSEMBLY_JOB_TYPE } from "../../src/modules/portability-operations/application/service.js";
import { createConsentApplicationService } from "../../src/modules/measurement/application/consent.js";
import { createCurrentCvTestFake } from "../../src/runtime/fakes/current-cv.js";
import { createOwnerCvTestFake } from "../../src/runtime/fakes/owner-cv.js";
import { ownerTestSecurity, withOwnerTestAuth } from "../runtime/owner-test-auth.js";
import { createOwnerExportService } from "../../src/modules/portability-operations/application/owner-export-service.js";
import { OwnerExportReadIntegrityError, type OperationsObservationPort, type OwnerExportObjectReadPort } from "../../src/modules/portability-operations/application/service.js";
import type { OwnerExportStorePort, PersistedOwnerExport } from "../../src/modules/portability-operations/application/owner-export-store.js";
import { createLoggerOperationsObservationPort, emitOperationsSignal, type OwnerExportIntegrityLogWindowReaderPort } from "../../src/modules/portability-operations/application/operations-observability.js";
import { evaluateOperationsLogQuery, isOperationsLogQueryDefinition, OPERATIONS_LOG_QUERIES } from "../../src/modules/portability-operations/application/operations-log-queries.js";
import { makeFixture, otherPortfolioId } from "./resumable-retention-passes.fixture.js";

const portfolioId = "0196a1b2-7c3d-7e11-9f22-000000000001" as StableId<"Portfolio">;
const jobId = "0196a1b2-7c3d-7e11-9f22-000000000002" as StableId<"Job">;
const observedAt = "2026-10-27T12:00:00.000Z";
const count = (value: number) => ({ value, capped: false, sampleLimit: 1_000 });
const ownerExportId = "0196a1b2-7c3d-7e11-9f22-000000000081" as StableId<"OwnerExport">;
const ownerExportArtifactId = "0196a1b2-7c3d-7e11-9f22-000000000082" as StableId<"OwnerExportArtifact">;
const exportOwnerId = "0196a1b2-7c3d-7e11-9f22-000000000083" as StableId<"Owner">;
const downloadBytes = Uint8Array.of(1);
const downloadSha256 = createHash("sha256").update(downloadBytes).digest("hex");

function makeOwnerExportDownloadService(
  objectRead: OwnerExportObjectReadPort,
  observations: OperationsSignalObservation[],
  observationPort?: Pick<OperationsObservationPort, "recordSignal">,
  artifact: { readonly contentLength: number; readonly sha256: string } = {
    contentLength: downloadBytes.byteLength, sha256: downloadSha256,
  },
) {
  const record: PersistedOwnerExport = {
    exportId: ownerExportId,
    portfolioId,
    ownerId: exportOwnerId,
    includedScopes: ["analytics-reports"],
    status: "ready",
    schemaVersion: "1.0",
    aggregateVersion: 1,
    requestedAt: observedAt,
    completedAt: observedAt,
    artifactId: ownerExportArtifactId,
    artifactSha256: artifact.sha256,
    artifactContentLength: artifact.contentLength,
    expiresAt: "2026-11-27T12:00:00.000Z",
  };
  const exports = { async findOwnerExport() { return record; } } as unknown as OwnerExportStorePort;
  return createOwnerExportService({ operations: {} as never, exports, clock: { now: () => observedAt },
    ids: createSystemIdGenerator(), objectRead, observations: observationPort ?? { async recordSignal(observation) { observations.push(observation); } } });
}

const snapshot: OperationsSummarySnapshot = {
  observedAt,
  outbox: {
    eligibleDepth: count(0), oldestEligibleAgeSeconds: null, eligibleOldestKnown: true, futureDelayedDepth: count(0), retryDepth: count(0),
    deadDepth: count(0), activeLeaseDepth: count(0), expiredLeaseDepth: count(0),
  },
  jobs: { availableDepth: count(0), leasedDepth: count(0), activeLeaseDepth: count(0), deadDepth: count(0), expiredLeaseDepth: count(0) },
  leases: { ageSeconds: null, ageKnown: true },
  exports: {
    windowSeconds: 86_400,
    states: { requested: count(0), building: count(0), ready: count(0), failed: count(0), expired: count(0) },
    completedBuilds: 0, maxBuildDurationMs: null, verifiedArtifacts: 0, artifactBytes: 0, sampleCount: 0, capped: false,
  },
  policyProgress: {
    firstPolicyPeriod: "2026-10-01", requiredThroughPeriod: "2026-10-27", retentionCompleteThrough: "2026-10-26",
    aggregateFinishedThrough: "2026-10-25", lastCompletePeriod: "2026-10-24", phase: "retention",
  },
};

describe("Phase 8 operations observability", () => {
  it("requires the fixed system purpose and returns durable zero, watermark, and explicit unknown values", async () => {
    const reader = { readOperationsSummary: vi.fn(async () => snapshot) };
    const retentionQueries: RetentionFailureLogWindowQuery[] = [];
    const retentionFailureLogReader: RetentionFailureLogWindowReaderPort = { async readRetentionFailureWindow(query) {
      retentionQueries.push(query);
      return { sourceInstalled: true, sourceComplete: true, serializedRecords: [] };
    } };
    const service = createOperationsSummaryService({ reader, retentionFailureLogReader, clock: { now: () => observedAt } });

    const denied = await service.readOperationsSummary({ actor: { kind: "system", jobId, purpose: "operations.jobs.read" }, portfolioId });
    expect(denied).toMatchObject({ ok: false, error: { kind: "forbidden", code: "OPERATIONS_SUMMARY_ACCESS_DENIED" } });
    expect(reader.readOperationsSummary).not.toHaveBeenCalled();
    expect(retentionQueries).toHaveLength(0);

    const result = await service.readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outbox.eligibleDepth).toEqual(count(0));
      expect(result.value.retention.backlogPeriods).toMatchObject({ state: "measured", value: 1 });
      expect(result.value.retention.failures).toMatchObject({ state: "measured", value: { value: 0, capped: false, sampleLimit: 1_000 } });
      expect(result.value.aggregates.completeness).toMatchObject({ state: "measured", value: { backlogPeriods: 2 } });
      expect(result.value.backup.relationalSourceWatermarkAgeHours).toEqual({ state: "unknown", reason: "producer-not-installed" });
      expect(result.value.backup.objectSourceWatermarkAgeHours).toEqual({ state: "unknown", reason: "producer-not-installed" });
      expect(result.value.exports.artifactBytes).toMatchObject({ state: "measured", value: 0 });
      expect(result.value.database.poolLimit).toEqual({ state: "unknown", reason: "not-collected" });
      expect(result.value.database.providerLimit).toEqual({ state: "unknown", reason: "provider-limit-unknown" });
      expect(result.value.capacity.usedPercent).toEqual({ state: "unknown", reason: "provider-limit-unknown" });
      expect(result.value.scope).toEqual({ portfolio: "one-authorized-portfolio", queues: "system-wide-operations",
        runtimeObservations: "system-wide-restricted-operator-log-source" });
      expect(result.value.outbox.oldestEligibleAgeSeconds).toMatchObject({ state: "measured", value: null });
    }
    expect(reader.readOperationsSummary).toHaveBeenCalledWith({ portfolioId, observedAt, windowSeconds: 900, maxRows: 1_000 });
    expect(retentionQueries).toEqual([{ metricId: "retention.failures", observedAt, windowSeconds: 900,
      maxCandidates: 1_000, scope: "system-wide" }]);
  });

  it("does not call failed summary reads healthy and validates the clock", async () => {
    const unavailable = createOperationsSummaryService({
      reader: { async readOperationsSummary() { throw new Error("PRIVATE_SQL_OR_PROVIDER_MARKER"); } },
      clock: { now: () => observedAt },
    });
    const invalidClock = createOperationsSummaryService({
      reader: { readOperationsSummary: vi.fn(async () => snapshot) }, clock: { now: () => "not-a-time" },
    });
    expect(await unavailable.readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId }))
      .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "OPERATIONS_SUMMARY_UNAVAILABLE" } });
    expect(await invalidClock.readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId }))
      .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "OPERATIONS_SUMMARY_CLOCK_INVALID" } });
  });

  it("marks age unknown when bounded queue or lease samples cannot establish coverage", async () => {
    const incomplete = createOperationsSummaryService({
      reader: { async readOperationsSummary() { return { ...snapshot,
        outbox: { ...snapshot.outbox, eligibleDepth: { ...count(10), capped: true }, eligibleOldestKnown: false },
        leases: { ageSeconds: 60, ageKnown: false } }; } },
      clock: { now: () => observedAt },
    });
    const result = await incomplete.readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outbox.eligibleDepth.capped).toBe(true);
      expect(result.value.outbox.oldestEligibleAgeSeconds).toEqual({ state: "unknown", reason: "incomplete-sample" });
      expect(result.value.leases.ageSeconds).toEqual({ state: "unknown", reason: "incomplete-sample" });
    }
  });

  it("documents every operational signal with a bounded source, query, and explicit unknown rule", () => {
    const dashboard = JSON.parse(readFileSync(new URL("../../docs/operations/phase8-dashboard.json", import.meta.url), "utf8")) as {
      operatorRead: { productRoute: boolean; publicMetricsApi: boolean; command: string; authorization: string };
      downstream: { operatorCli: string };
      signals: readonly Record<string, unknown>[];
      alerts: readonly { readonly id: string; readonly condition: string; readonly metricInputs: readonly {
        readonly metricId: string; readonly sourceState: string; readonly ownerIssue?: string;
      }[] }[];
    };
    const signals = new Map(dashboard.signals.map((signal) => [signal["id"], signal]));
    const required = ["http.request_count", "http.latency_ms", "http.status_class", "database.pool_used", "database.pool_limit",
      "database.transaction_failures", "database.rls_denials", "database.pool_failures", "outbox.eligible_depth", "outbox.oldest_eligible_age_seconds",
      "outbox.future_delayed_depth", "outbox.retry_depth", "outbox.dead_depth", "outbox.active_lease_depth", "outbox.expired_lease_depth",
      "jobs.available_depth", "jobs.leased_depth", "jobs.dead_depth", "jobs.expired_lease_depth",
      "leases.age_seconds", "leases.expired_depth", "leases.reclaim_count", "leases.stale_write_rejections", "export.state",
      "export.duration_ms", "export.bytes", "export.integrity", "export.integrity_failures", "publication.safe_failures", "event.accepted", "event.dropped",
      "aggregate.completeness", "retention.last_complete", "retention.backlog_periods", "retention.failures", "storage.failures", "storage.readiness",
      "backup.relational_source_watermark_age_hours", "backup.object_source_watermark_age_hours",
      "backup.count", "backup.bytes", "backup.state", "recovery.stage", "recovery.outcome", "recovery.duration_ms",
      "readiness.core", "capacity.used_percent"];
    expect([...signals.keys()]).toEqual(expect.arrayContaining(required));
    for (const id of required) expect(signals.get(id), id).toEqual(expect.objectContaining({
      unit: expect.any(String), meaning: expect.any(String), source: expect.any(String), access: expect.any(String),
      window: expect.any(String), query: expect.anything(), bounds: expect.any(String), unknown: expect.any(String), drilldown: expect.any(String),
    }));
    expect(dashboard.operatorRead).toMatchObject({ productRoute: false, publicMetricsApi: false });
    expect(JSON.stringify(dashboard)).not.toContain("No current executable value");
    expect(dashboard.operatorRead.command).toContain("--portfolio-id <Portfolio UUID>");
    expect(dashboard.operatorRead.authorization).toContain("queue summaries and retention failure logs are separately labeled system-wide");
    expect(dashboard.downstream.operatorCli).toContain("unscoped runtime log observations");
    expect(signals.get("export.integrity")?.["scope"]).toBe("one-authorized-portfolio");
    expect(signals.get("export.state")?.["bounds"]).toContain("sampleCount sums all five bounded state buckets (0..5000)");
    expect(signals.get("export.bytes")?.["bounds"]).toContain("sampleCount sums all five per-state buckets (0..5000)");
    expect(signals.get("leases.age_seconds")?.["query"]).toContain("lease_acquired_at");
    expect(signals.get("backup.relational_source_watermark_age_hours")?.["source"]).toContain("#253");
    expect(signals.get("backup.object_source_watermark_age_hours")?.["source"]).toContain("#254");
    const alerts = new Map(dashboard.alerts.map((alert) => [alert["id"], alert]));
    expect(alerts.get("relational-backup-age")?.["condition"]).toBe("backup.relational_source_watermark_age_hours > 24");
    expect(alerts.get("object-backup-age")?.["condition"]).toBe("backup.object_source_watermark_age_hours > 168");
    expect(signals.get("storage.readiness")?.["query"]).toMatchObject({ source: "operations.signal", signalField: "signal",
      aggregation: { kind: "storage-readiness", field: "outcome" } });
    expect(signals.get("export.integrity")?.["meaning"]).toMatch(/assembly.*verification.*not.*download|download.*not.*assembly/iu);
    expect(signals.get("export.integrity_failures")).toMatchObject({ scope: "system-wide", query: OPERATIONS_LOG_QUERIES["export.integrity_failures"] });
    expect(signals.get("event.dropped")).toMatchObject({ producerAvailability: "not-installed", query: OPERATIONS_LOG_QUERIES["event.dropped"] });
    expect(signals.get("retention.failures")).toMatchObject({ scope: "system-wide", query: OPERATIONS_LOG_QUERIES["retention.failures"] });
    expect(signals.get("retention.backlog_periods")?.["scope"]).toBe("one-authorized-portfolio");
    expect(signals.get("aggregate.completeness")?.["meaning"]).toContain("lastFinishedPeriod is null until");
    expect(signals.get("aggregate.completeness")?.["unknown"]).toContain("aggregateFinishedThrough is before firstPolicyPeriod");
    expect(signals.get("retention.last_complete")?.["unknown"]).toContain("before firstPolicyPeriod");
    expect(signals.get("retention.failures")?.["source"]).toContain("no Portfolio attribution");
    expect(alerts.get("retention-withdrawal")?.condition).toBe("retention.backlog_periods > 0 or retention.failures > 0");
    expect(alerts.get("dead-work")?.condition).toBe("outbox.dead_depth > 0 or jobs.dead_depth > 0");
    expect(alerts.get("publication-failure")?.condition).toBe("publication.safe_failures > 0");
    expect([...alerts.keys()]).toEqual(["outbox-oldest-eligible", "dead-work", "retention-withdrawal", "publication-failure",
      "relational-backup-age", "object-backup-age", "recovery-rto", "capacity"]);
    for (const alert of dashboard.alerts) {
      const declared = alert.metricInputs.map((input) => input.metricId);
      expect(new Set(declared).size, alert.id).toBe(declared.length);
      const referenced = [...alert.condition.matchAll(/[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_]*)+/giu)].map(([id]) => id).sort();
      expect(referenced, alert.id).toEqual([...declared].sort());
      for (const input of alert.metricInputs) {
        const signal = signals.get(input.metricId);
        expect(signal, `${alert.id}:${input.metricId}`).toBeDefined();
        if (input.sourceState === "defined") {
          expect(signal?.["query"], `${alert.id}:${input.metricId}`).toBeTruthy();
          expect(signal?.["bounds"], `${alert.id}:${input.metricId}`).toEqual(expect.any(String));
          expect(signal?.["unknown"], `${alert.id}:${input.metricId}`).toEqual(expect.any(String));
        } else {
          expect(input.sourceState).toBe("uninstalled");
          expect(["#253", "#254", "#255"]).toContain(input.ownerIssue);
          expect(input.metricId).toMatch(/^(?:backup|recovery)\./u);
          expect(signal?.["source"]).toContain(`${input.ownerIssue}; not wired`);
        }
      }
    }
    for (const signal of dashboard.signals) {
      expect(signal["source"], String(signal["id"])).not.toMatch(/not yet (?:configured|collected|installed|wired)/i);
      expect(JSON.stringify(signal["query"]), String(signal["id"])).not.toContain("No current");
      if (typeof signal["query"] === "object" && signal["query"] !== null) {
        expect(isOperationsLogQueryDefinition(String(signal["id"]), signal["query"]), String(signal["id"])).toBe(true);
      }
    }
  });

  it("evaluates bounded dashboard definitions over serialized safe producer records and rejects field drift and inherited metric IDs", async () => {
    const logger = createTestLogger();
    const observationPort = createLoggerOperationsObservationPort(logger);
    const record = (observation: OperationsSignalObservation) => emitOperationsSignal(logger, observationPort, observation);
    const privateMarker = "PRIVATE-SIGNED-URL-AND-EXPORT-MANIFEST-7f2a";
    await record({ kind: "http-request", route: "public-event", statusClass: "2xx", durationMs: 45 });
    await record({ kind: "http-request", route: "owner-export-status", statusClass: "4xx", durationMs: 91 });
    await record({ kind: "database-pool", usedConnections: 1, configuredLimit: 4 });
    await record({ kind: "database-pool", usedConnections: 0, configuredLimit: 4 });
    await record({ kind: "database-failure", category: "transaction" });
    await record({ kind: "database-failure", category: "pool" });
    await record({ kind: "storage-operation", operation: "write", outcome: "failed", bytes: 0,
      privateMarker } as unknown as OperationsSignalObservation);
    await record({ kind: "storage-operation", operation: "read", outcome: "succeeded", bytes: 16 });
    const serializedRecords = logger.records.filter((entry) => entry.event === "operations.signal")
      .map((entry) => JSON.stringify({ event: entry.event, ...entry.fields }));
    const serialized = serializedRecords.join("\n");
    expect(serialized).not.toContain(privateMarker);
    const observedAt = new Date().toISOString();
    const evaluate = (metricId: keyof typeof OPERATIONS_LOG_QUERIES, records = serializedRecords,
      sourceInstalled = true, sourceComplete = true) => evaluateOperationsLogQuery({ metricId,
      definition: OPERATIONS_LOG_QUERIES[metricId], serializedRecords: records, observedAt, sourceInstalled, sourceComplete });

    expect(evaluate("http.latency_ms")).toMatchObject({ state: "measured", value: { maximum: 91, sampleCount: 2 } });
    expect(evaluate("http.status_class")).toMatchObject({ state: "measured", value: { "2xx": 1, "3xx": 0, "4xx": 1, "5xx": 0 } });
    expect(evaluate("database.pool_used")).toMatchObject({ state: "measured", value: 0, sampleCount: 1 });
    expect(evaluate("database.transaction_failures")).toMatchObject({ state: "measured", value: 1 });
    expect(evaluate("database.pool_failures")).toMatchObject({ state: "measured", value: 1 });
    expect(evaluate("storage.failures")).toMatchObject({ state: "measured", value: 1 });
    expect(evaluate("storage.readiness")).toMatchObject({ state: "measured", value: "degraded" });
    const successfulStorage = serializedRecords.filter((line) => JSON.parse(line).signal === "storage-operation" &&
      JSON.parse(line).outcome === "succeeded");
    expect(evaluate("storage.readiness", successfulStorage)).toMatchObject({ state: "measured", value: "ready" });
    expect(evaluate("storage.readiness", [], true, true)).toEqual({ state: "unknown", reason: "not-collected" });
    expect(evaluate("storage.readiness", [], false)).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(evaluate("storage.readiness", serializedRecords, true, false)).toEqual({ state: "unknown", reason: "not-collected" });
    expect(evaluate("storage.readiness", Array.from({ length: 1_001 }, () => serializedRecords[0]!)))
      .toEqual({ state: "unknown", reason: "incomplete-sample" });

    const wrongField = { ...OPERATIONS_LOG_QUERIES["database.pool_failures"], signalField: "kind" };
    expect(isOperationsLogQueryDefinition("database.pool_failures", wrongField)).toBe(false);
    expect(evaluateOperationsLogQuery({ metricId: "database.pool_failures", definition: wrongField, serializedRecords,
      observedAt, sourceInstalled: true, sourceComplete: true })).toEqual({ state: "unknown", reason: "invalid-query" });
    for (const metricId of ["__proto__", "constructor", "toString", "unknown.metric"]) {
      expect(isOperationsLogQueryDefinition(metricId, {})).toBe(false);
      expect(evaluateOperationsLogQuery({ metricId, definition: {}, serializedRecords, observedAt,
        sourceInstalled: true, sourceComplete: true })).toEqual({ state: "unknown", reason: "invalid-query" });
    }
    for (const [metricId, definition] of Object.entries(OPERATIONS_LOG_QUERIES)) {
      expect(isOperationsLogQueryDefinition(metricId, definition)).toBe(true);
      expect(evaluateOperationsLogQuery({ metricId, definition, serializedRecords: [], observedAt,
        sourceInstalled: true, sourceComplete: true })).not.toEqual({ state: "unknown", reason: "invalid-query" });
    }
    const expired = JSON.parse(serializedRecords[0]!) as Record<string, unknown>;
    expired["observedAt"] = new Date(Date.parse(observedAt) - 901_000).toISOString();
    expect(evaluate("http.latency_ms", [JSON.stringify(expired)])).toEqual({ state: "unknown", reason: "not-collected" });
  });

  it("keeps event drops unknown while measuring accepted intake without an owning drop producer", async () => {
    const logger = createTestLogger();
    const event = { action: "page-viewed", context: { occurredAt: observedAt, locale: "en", consentVersion: "2026-10",
      pageRouteIdentity: createStableId("PublicRoute") } };
    const request = (key: string) => new Request("https://example.test/api/v1/events", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key,
        cookie: "sw_analytics_consent=safe-token" }, body: JSON.stringify(event),
    });
    const approved = { async verifyEvidence() { return { ok: true as const, value: { purpose: "measurement" as const, portfolioId,
      subject: createStableId("MeasurementVisitor"), consentId: createStableId("Consent"), noticeVersion: "2026-10", revision: 1,
      issuedAt: observedAt, expiresAt: "2026-11-27T12:00:00.000Z" } }; } };
    const acceptedResponse = await handlePostPublicEvent(request("accepted-intake"), {
      scope: { kind: "portfolio", portfolioId }, consent: approved, logger,
      service: { async ingestEvent() { return { ok: true as const,
        value: { eventId: createStableId("PublicEvent"), acceptedAt: observedAt } }; } },
    });
    const rejectedResponse = await handlePostPublicEvent(request("rejected-intake"), {
      scope: { kind: "portfolio", portfolioId }, logger,
      consent: { async verifyEvidence() { return { ok: false as const,
        error: { kind: "forbidden" as const, code: "CONSENT_REQUIRED" } }; } },
    });
    expect(acceptedResponse.status).toBe(202);
    expect(rejectedResponse.status).toBe(403);

    const serializedRecords = logger.records.filter((record) => record.event === "operations.signal")
      .map((record) => JSON.stringify({ event: record.event, ...record.fields }));
    const intakeOutcomes = serializedRecords.map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record["signal"] === "event-intake").map((record) => record["outcome"]).sort();
    expect(intakeOutcomes).toEqual(["accepted", "rejected"]);
    expect(intakeOutcomes).not.toContain("dropped");

    const queryObservedAt = new Date().toISOString();
    const evaluate = (metricId: "event.accepted" | "event.dropped", records = serializedRecords,
      sourceInstalled = true, sourceComplete = true) => evaluateOperationsLogQuery({ metricId,
      definition: OPERATIONS_LOG_QUERIES[metricId], serializedRecords: records, observedAt: queryObservedAt, sourceInstalled, sourceComplete });
    expect(evaluate("event.accepted")).toMatchObject({ state: "measured", value: 1 });
    expect(evaluate("event.dropped")).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(evaluate("event.accepted", [], true, true)).toMatchObject({ state: "measured", value: 0 });
    expect(evaluate("event.dropped", [], true, true)).toEqual({ state: "unknown", reason: "producer-not-installed" });

    const fabricatedDrop = JSON.stringify({ event: "operations.signal", observedAt: queryObservedAt,
      signal: "event-intake", outcome: "dropped" });
    expect(evaluate("event.dropped", [fabricatedDrop], true, true))
      .toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(evaluate("event.dropped", [], false, true)).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(evaluate("event.dropped", [], true, false)).toEqual({ state: "unknown", reason: "not-collected" });
  });

  it("evaluates relational and object backup RPOs from separate source watermarks and leaves absent producers unknown", () => {
    const observedAt = "2026-10-28T00:00:00.000Z";
    const relationalBreached = evaluateBackupRpo("relational", "2026-10-26T23:00:00.000Z", observedAt);
    const objectWithin = evaluateBackupRpo("object", "2026-10-23T20:00:00.000Z", observedAt);
    expect(relationalBreached).toEqual({ state: "measured", sourceWatermarkAgeHours: 25, thresholdHours: 24, exceeded: true });
    expect(objectWithin).toEqual({ state: "measured", sourceWatermarkAgeHours: 100, thresholdHours: 168, exceeded: false });

    const relationalWithin = evaluateBackupRpo("relational", "2026-10-27T23:00:00.000Z", observedAt);
    const objectBreached = evaluateBackupRpo("object", "2026-10-20T23:00:00.000Z", observedAt);
    expect(relationalWithin).toMatchObject({ state: "measured", sourceWatermarkAgeHours: 1, thresholdHours: 24, exceeded: false });
    expect(objectBreached).toMatchObject({ state: "measured", sourceWatermarkAgeHours: 169, thresholdHours: 168, exceeded: true });
    expect(evaluateBackupRpo("relational", null, observedAt)).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(evaluateBackupRpo("object", "2026-10-29T00:00:00.000Z", observedAt)).toEqual({ state: "unknown", reason: "not-collected" });
  });

  it("records consent rejection separately from HTTP status without leaking request markers", async () => {
    const observations: OperationsSignalObservation[] = [];
    const marker = "PRIVATE-FEEDBACK-CV-VISITOR-CREDENTIAL-SIGNED-URL-1934";
    const logger = createTestLogger();
    const request = new Request(`https://example.test/api/v1/events?marker=${marker}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "synthetic-idempotency-key",
        cookie: "sw_analytics_consent=synthetic-consent-token" },
      body: JSON.stringify({ action: "page-viewed", context: { occurredAt: observedAt, locale: "en", consentVersion: "2026-10",
        pageRouteIdentity: createStableId("PublicRoute"), referrerClass: "direct", deviceClass: "desktop" } }),
    });
    const response = await handlePostPublicEvent(request, {
      logger,
      operationsObservations: { async recordSignal(observation) { observations.push(observation); } },
      consent: { async verifyEvidence() { return { ok: false as const, error: { kind: "forbidden" as const, code: "CONSENT_REQUIRED" } }; } },
    });

    expect(response.status).toBe(403);
    expect(observations).toHaveLength(2);
    expect(observations).toContainEqual({ kind: "http-request", route: "public-event", statusClass: "4xx", durationMs: expect.any(Number) });
    expect(observations).toContainEqual({ kind: "event-intake", outcome: "rejected" });
    expect(JSON.stringify({ observations, logs: logger.records })).not.toContain(marker);
    expect(JSON.stringify(observations)).not.toMatch(/url|token|projectId|visitor|payload/i);
  });

  it("records a real consent database outage as unavailable rather than rejected", async () => {
    const requestMarker = "PRIVATE_CONSENT_DATABASE_MARKER";
    const consent = createConsentApplicationService({
      transactions: { async run() { throw new Error(requestMarker); } } as never,
      repository: { async lock() { throw new Error(requestMarker); }, async save() { throw new Error(requestMarker); } },
      crypto: {} as never,
      clock: { now: () => observedAt },
      ids: createSystemIdGenerator(),
      supportedNoticeVersions: ["2026-10"],
      ttlSeconds: 3_600,
    });
    const observations: OperationsSignalObservation[] = [];
    const logger = createTestLogger();
    const event = { action: "page-viewed", context: { occurredAt: observedAt, locale: "en", consentVersion: "2026-10",
      pageRouteIdentity: createStableId("PublicRoute") } };
    const response = await handlePostPublicEvent(new Request("https://example.test/api/v1/events", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "consent-outage-key",
        cookie: "sw_analytics_consent=sealed-evidence" },
      body: JSON.stringify(event),
    }), {
      consent,
      scope: { kind: "portfolio", portfolioId },
      logger,
      operationsObservations: { async recordSignal(observation) { observations.push(observation); } },
    });

    expect(response.status).toBe(503);
    expect(observations).toContainEqual({ kind: "event-intake", outcome: "unavailable" });
    expect(observations).not.toContainEqual({ kind: "event-intake", outcome: "rejected" });
    expect(JSON.stringify({ observations, logs: logger.records })).not.toContain(requestMarker);
  });

  it("records unavailable, committed acceptance, and indeterminate commit acknowledgement as distinct outcomes", async () => {
    const route = createStableId("PublicRoute");
    const event = { action: "page-viewed", context: { occurredAt: observedAt, locale: "en", consentVersion: "2026-10", pageRouteIdentity: route } };
    const makeRequest = () => new Request("https://example.test/api/v1/events", { method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "safe-key", cookie: "sw_analytics_consent=safe-token" }, body: JSON.stringify(event) });
    const approved = { async verifyEvidence() { return { ok: true as const, value: { purpose: "measurement" as const, portfolioId,
      subject: createStableId("MeasurementVisitor"), consentId: createStableId("Consent"), noticeVersion: "2026-10", revision: 1,
      issuedAt: observedAt, expiresAt: "2026-11-27T12:00:00.000Z" } }; } };

    const unavailable: OperationsSignalObservation[] = [];
    const noService = await handlePostPublicEvent(makeRequest(), { consent: approved, operationsObservations: { async recordSignal(item) { unavailable.push(item); } } });
    expect(noService.status).toBe(503);
    expect(unavailable).toContainEqual({ kind: "event-intake", outcome: "unavailable" });

    const accepted: OperationsSignalObservation[] = [];
    const acceptedResponse = await handlePostPublicEvent(makeRequest(), { consent: approved,
      service: { async ingestEvent() { return { ok: true as const, value: { eventId: createStableId("PublicEvent"), acceptedAt: observedAt } }; } },
      operationsObservations: { async recordSignal(item) { accepted.push(item); } } });
    expect(acceptedResponse.status).toBe(202);
    expect(accepted).toContainEqual({ kind: "event-intake", outcome: "accepted" });

    const committed = { value: false };
    const indeterminate: OperationsSignalObservation[] = [];
    const uncertainLogger = createTestLogger();
    const uncertainResponse = await handlePostPublicEvent(makeRequest(), { consent: approved,
      service: { async ingestEvent() { committed.value = true; throw new Error("PRIVATE_COMMIT_ACK_MARKER"); } },
      logger: uncertainLogger,
      operationsObservations: { async recordSignal(item) { indeterminate.push(item); } } });
    expect(committed.value).toBe(true);
    expect(uncertainResponse.status).toBe(500);
    expect(indeterminate).toContainEqual({ kind: "event-intake", outcome: "indeterminate" });
    expect(indeterminate).not.toContainEqual({ kind: "event-intake", outcome: "dropped" });
    expect(JSON.stringify({ indeterminate, logs: uncertainLogger.records, body: await uncertainResponse.text() })).not.toContain("PRIVATE_COMMIT_ACK_MARKER");
  });

  it("accepts only the documented Portfolio CLI flag and rejects missing, extra, conflicting, and oversized scope", () => {
    const validId = "0196a1b2-7c3d-7e11-9f22-000000000001";
    expect(parseOperationsSummaryArguments(["--portfolio-id", validId], undefined)?.portfolioId).toBe(validId);
    expect(parseOperationsSummaryArguments([], validId)).toBeNull();
    expect(parseOperationsSummaryArguments(["--portfolio-id", "not-a-uuid"], undefined)).toBeNull();
    expect(parseOperationsSummaryArguments(["--portfolio-id", `${validId}${"x".repeat(65)}`], undefined)).toBeNull();
    expect(parseOperationsSummaryArguments(["--portfolio-id", validId], "0196a1b2-7c3d-7e11-9f22-000000000002")).toBeNull();
    expect(parseOperationsSummaryArguments(["--portfolio-id", validId, "--extra"], undefined)).toBeNull();
  });

  it("observes the existing private Owner export status route without recording URL or session markers", async () => {
    const observations: OperationsSignalObservation[] = [];
    const exportId = "0196a1b2-7c3d-7e11-9f22-000000000008" as StableId<"OwnerExport">;
    const marker = "PRIVATE-CV-VISITOR-CREDENTIAL-SIGNED-URL-STATUS";
    const logger = createTestLogger();
    const response = await handleGetOwnerExport(new Request(`https://example.test/api/owner/v1/exports/${exportId}?marker=${marker}`),
      { exportId }, {
        service: {} as OwnerExportAdapterDeps["service"],
        security: { appOrigin: "https://example.test", identity: {} } as OwnerExportAdapterDeps["security"],
        portfolioId,
        logger,
        operationsObservations: { async recordSignal(observation) { observations.push(observation); } },
      });

    expect(response.status).toBe(401);
    expect(observations).toEqual([{ kind: "http-request", route: "owner-export-status", statusClass: "4xx", durationMs: expect.any(Number) }]);
    expect(JSON.stringify({ body: await response.text(), observations, logs: logger.records })).not.toContain(marker);
  });

  it("observes otherwise-uninstrumented public and Owner adapters with safe status classes", async () => {
    const publicLogger = createTestLogger();
    const cvFake = createCurrentCvTestFake({ type: "redirect" });
    const currentCv = await handleGetCurrentCv(new Request("https://example.test/api/v1/cv/current?locale=en&disposition=inline"), {
      service: cvFake, rateLimit: { async check() { return { allowed: true }; } },
      allowedRedirectOrigins: ["https://storage.example"], logger: publicLogger,
    });
    const privateMarker = "PRIVATE-CV-FEEDBACK-OWNER-SESSION-QUERY-2048";
    const rejectedCv = await handleGetCurrentCv(new Request(`https://example.test/api/v1/cv/current?marker=${privateMarker}`), {
      service: cvFake, rateLimit: { async check() { return { allowed: true }; } }, logger: publicLogger,
    });
    expect(currentCv.status).toBe(307);
    expect(rejectedCv.status).toBe(400);
    const publicSignals = publicLogger.records.filter((record) => record.event === "operations.signal").map((record) => record.fields);
    expect(publicSignals).toContainEqual({ observedAt: expect.any(String), signal: "http-request", route: "public-current-cv",
      statusClass: "3xx", durationMs: expect.any(Number) });
    expect(publicSignals).toContainEqual({ observedAt: expect.any(String), signal: "http-request", route: "public-current-cv",
      statusClass: "4xx", durationMs: expect.any(Number) });
    expect(JSON.stringify(publicLogger.records)).not.toContain(privateMarker);

    const ownerLogger = createTestLogger();
    const ownerRequest = () => new Request(`https://example.test/api/owner/v1/cv?marker=${privateMarker}`, {
      headers: withOwnerTestAuth({}),
    });
    const ownerSuccess = await handleGetOwnerCvPortfolio(ownerRequest(), {
      service: createOwnerCvTestFake({ type: "success" }), security: ownerTestSecurity(), logger: ownerLogger,
    });
    const ownerFailure = await handleGetOwnerCvPortfolio(ownerRequest(), {
      service: createOwnerCvTestFake({ type: "rejection", rejection: { kind: "temporarily_unavailable", code: "DEPENDENCY_UNAVAILABLE" } }),
      security: ownerTestSecurity(), logger: ownerLogger,
    });
    expect(ownerSuccess.status).toBe(200);
    expect(ownerFailure.status).toBe(503);
    const ownerSignals = ownerLogger.records.filter((record) => record.event === "operations.signal").map((record) => record.fields);
    expect(ownerSignals).toContainEqual({ observedAt: expect.any(String), signal: "http-request", route: "owner-cv",
      statusClass: "2xx", durationMs: expect.any(Number) });
    expect(ownerSignals).toContainEqual({ observedAt: expect.any(String), signal: "http-request", route: "owner-cv",
      statusClass: "5xx", durationMs: expect.any(Number) });
    expect(JSON.stringify(ownerLogger.records)).not.toContain(privateMarker);
  });

  it("keeps a successful adapter response when its telemetry logger throws", async () => {
    const response = await handleGetCurrentCv(new Request("https://example.test/api/v1/cv/current?locale=en"), {
      service: createCurrentCvTestFake({ type: "redirect" }),
      rateLimit: { async check() { return { allowed: true }; } },
      allowedRedirectOrigins: ["https://storage.example"],
      logger: { debug() {}, info(event) { if (event === "operations.signal") throw new Error("PRIVATE_SINK_MARKER"); }, warn() {}, error() {} },
    });
    expect(response.status).toBe(307);
  });

  it("source-inventories every active handwritten HTTP handler and its fixed observer wrapper", () => {
    const expected: Readonly<Record<string, ReadonlyArray<string>>> = {
      "current-cv.ts": ["handleGetCurrentCv"],
      "feedback.ts": ["handlePostProjectFeedback"],
      "owner-analytics.ts": ["handleGetOwnerAnalyticsGoal", "handleCreateOwnerAnalyticsGoalVersion", "handleActivateOwnerAnalyticsGoalVersion"],
      "owner-configuration.ts": ["handleUpdateOwnerProfileConfiguration", "handleUpdateOwnerContactChannels", "handleUpdateOwnerGlobalProjectCta"],
      "owner-content-authoring.ts": ["handleCreateOwnerContent"],
      "owner-content-review.ts": ["handlePreviewOwnerContentRevision", "handleReviewOwnerContentRevision", "handleGetOwnerContentHistory"],
      "owner-cv.ts": ["handleGetOwnerCvPortfolio", "handleRegisterOwnerCvVersion", "handleAcceptOwnerCvVersion", "handleActivateOwnerCvVersion"],
      "owner-export.ts": ["handleRequestOwnerExport", "handleGetOwnerExport", "handleDownloadOwnerExport"],
      "owner-media.ts": ["handleGetOwnerMediaAggregate", "handleCreateOwnerMediaUploadIntent", "handleRecordOwnerMediaProcessing", "handleAcceptOwnerMediaAsset", "handleRejectOwnerMediaAsset"],
      "owner-moderation.ts": ["handleGetOwnerFeedbackModeration", "handleApproveOwnerFeedback", "handleRejectOwnerFeedback", "handleSuppressOwnerFeedback"],
      "owner-project-status.ts": ["handleListOwnerProjectStatusValues", "handleCreateOwnerProjectStatusValue", "handleRenameOwnerProjectStatusValue", "handleRetireOwnerProjectStatusValue"],
      "owner-project.ts": ["handleGetOwnerProjectAggregate", "handleChangeOwnerProjectStatus", "handleSetOwnerProjectFeatured", "handleChangeOwnerProjectPublicSlug", "handleCorrectOwnerProjectCandidateSlug", "handleRelateOwnerProjects", "handleAssignOwnerProjectTaxonomyValue"],
      "owner-publication.ts": ["handleGetOwnerContentAggregate", "handleSaveOwnerContentRevision", "handlePublishOwnerContentLanguage", "handleHideOwnerContent", "handleArchiveOwnerContent", "handleRestoreOwnerContent"],
      "owner-taxonomy.ts": ["handleGetOwnerTaxonomyAggregate", "handleCreateOwnerTaxonomyValue", "handleRenameOwnerTaxonomyValue", "handleRetireOwnerTaxonomyValue", "handleMergeOwnerTaxonomyValue"],
      "public-event.ts": ["handlePostPublicEvent"], "rating.ts": ["handlePutProjectRating"], "reaction.ts": ["handlePutProjectReaction"],
    };
    const httpDirectory = path.resolve(process.cwd(), "src/runtime/http");
    const files = readdirSync(httpDirectory).filter((file) => file.endsWith(".ts") && file !== "observe-request.ts").sort();
    for (const file of files) {
      const sourceText = readFileSync(path.join(httpDirectory, file), "utf8");
      const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
      const handlers = sourceFile.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
        node.name?.text.startsWith("handle") === true && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true);
      expect(handlers.map((handler) => handler.name!.text).sort(), file).toEqual([...(expected[file] ?? [])].sort());
      for (const handler of handlers) {
        const body = handler.body?.getText(sourceFile) ?? "";
        const observed = file === "public-event.ts" ? body.includes('route: "public-event"')
          : file === "owner-export.ts" ? body.includes("observeOwnerExportRequest")
            : /observeHttpRequest\("[a-z-]+"/u.test(body);
        expect(observed, `${file}:${handler.name!.text} must use a fixed safe observation wrapper`).toBe(true);
      }
    }
  });

  it("records one Owner export download read success only after verified stream completion", async () => {
    const observations: OperationsSignalObservation[] = [];
    const objectRead: OwnerExportObjectReadPort = { async readOwnerExport() {
      return { ok: true as const, value: { contentLength: 1, sha256: downloadSha256,
        content: (async function* () { yield downloadBytes; })() } };
    } };
    const service = makeOwnerExportDownloadService(objectRead, observations);
    const result = await service.downloadOwnerExport({ actor: { kind: "owner", ownerId: exportOwnerId, sessionId: "owner-r5-test-session" }, portfolioId, exportId: ownerExportId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(observations).toEqual([]);
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.value.content) chunks.push(chunk);
    expect(chunks).toEqual([downloadBytes]);
    expect(observations).toEqual([
      { kind: "owner-export-integrity", outcome: "verified" },
      { kind: "storage-operation", operation: "read", outcome: "succeeded", bytes: 1 },
    ]);
  });

  it("records one failed Owner export download read without provider or identity details", async () => {
    const observations: OperationsSignalObservation[] = [];
    const objectRead: OwnerExportObjectReadPort = { async readOwnerExport() {
      return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
    } };
    const service = makeOwnerExportDownloadService(objectRead, observations);
    const result = await service.downloadOwnerExport({ actor: { kind: "owner", ownerId: exportOwnerId, sessionId: "owner-r5-test-session" }, portfolioId, exportId: ownerExportId });
    expect(result.ok).toBe(false);
    expect(observations).toEqual([{ kind: "storage-operation", operation: "read", outcome: "failed" }]);
    expect(JSON.stringify(observations)).not.toMatch(/0196a1b2|artifact|ownerId|signed|PRIVATE/i);
  });

  it("records a safe Storage failure when the content iterator cannot be initialized", async () => {
    const providerMarker = "private-provider-iterator-init-marker";
    const observations: OperationsSignalObservation[] = [];
    const objectRead: OwnerExportObjectReadPort = { async readOwnerExport() {
      return { ok: true as const, value: { contentLength: 1, sha256: downloadSha256,
        content: { [Symbol.asyncIterator]() { throw new Error(providerMarker); } } } };
    } };
    const service = makeOwnerExportDownloadService(objectRead, observations);
    const logger = createTestLogger();
    const response = await handleDownloadOwnerExport(
      new Request(`https://example.test/api/owner/v1/exports/${ownerExportId}/download`, { headers: withOwnerTestAuth({}) }),
      { exportId: ownerExportId },
      { service, security: ownerTestSecurity(), portfolioId, logger },
    );
    const body = response.body?.getReader();
    if (body === undefined) throw new Error("expected streamed response body");
    let streamError: unknown;
    try { await body.read(); } catch (error) { streamError = error; }
    expect(streamError).toBeInstanceOf(Error);
    if (!(streamError instanceof Error)) throw new Error("expected sanitized iterator initialization failure");
    expect(streamError.message).toBe("Owner export download failed.");
    expect(observations).toEqual([{ kind: "storage-operation", operation: "read", outcome: "failed" }]);
    expect(JSON.stringify({ observations, records: logger.records, message: streamError.message,
      stack: streamError.stack })).not.toContain(providerMarker);
  });

  it("records streamed integrity mismatch and read failure once without buffering or consuming twice", async () => {
    const integrityObservations: OperationsSignalObservation[] = [];
    const integrityRead: OwnerExportObjectReadPort = { async readOwnerExport() {
      return { ok: true as const, value: { contentLength: 1, sha256: downloadSha256,
        content: (async function* () { yield Uint8Array.of(2); })() } };
    } };
    const integrityService = makeOwnerExportDownloadService(integrityRead, integrityObservations);
    const integrityResult = await integrityService.downloadOwnerExport({ actor: { kind: "owner", ownerId: exportOwnerId, sessionId: "owner-r5-test-session" }, portfolioId, exportId: ownerExportId });
    if (!integrityResult.ok) throw new Error("expected streamed integrity fixture");
    await expect((async () => { for await (const _chunk of integrityResult.value.content) { /* observe stream once */ } })())
      .rejects.toBeInstanceOf(OwnerExportReadIntegrityError);
    expect(integrityObservations).toEqual([
      { kind: "storage-operation", operation: "read", outcome: "failed" },
      { kind: "owner-export-integrity", outcome: "failed" },
    ]);

    const streamMarker = "PRIVATE_STORAGE_STREAM_PROVIDER_MARKER";
    const streamObservations: OperationsSignalObservation[] = [];
    const streamRead: OwnerExportObjectReadPort = { async readOwnerExport() {
      return { ok: true as const, value: { contentLength: 1, sha256: downloadSha256,
        content: (async function* () { throw new Error(streamMarker); })() } };
    } };
    const streamService = makeOwnerExportDownloadService(streamRead, streamObservations);
    const streamLogger = createTestLogger();
    const streamResponse = await handleDownloadOwnerExport(
      new Request("https://example.test/api/owner/v1/exports/" + ownerExportId + "/download", {
        headers: withOwnerTestAuth({}),
      }),
      { exportId: ownerExportId },
      { service: streamService, security: ownerTestSecurity(), portfolioId, logger: streamLogger },
    );
    expect(streamResponse.status).toBe(200);
    const streamReader = streamResponse.body?.getReader();
    if (streamReader === undefined) throw new Error("expected streamed response body");
    let streamError: unknown;
    try {
      await streamReader.read();
    } catch (error) {
      streamError = error;
    }
    expect(streamError).toBeInstanceOf(Error);
    if (!(streamError instanceof Error)) throw new Error("expected sanitized stream failure");
    expect(streamError.message).toBe("Owner export download failed.");
    expect(streamError.stack).not.toContain(streamMarker);
    expect(streamObservations).toEqual([{ kind: "storage-operation", operation: "read", outcome: "failed" }]);
    expect(JSON.stringify({
      integrityObservations, streamObservations, records: streamLogger.records,
      error: { name: streamError.name, message: streamError.message, stack: streamError.stack },
    })).not.toContain(streamMarker);

    const injectedMarker = "PRIVATE_INJECTED_OWNER_EXPORT_STREAM_MARKER";
    const injectedBase = makeOwnerExportDownloadService({
      async readOwnerExport() {
        return { ok: true as const, value: { contentLength: 1, sha256: downloadSha256, content: (async function* () {
          yield downloadBytes;
        })() } };
      },
    }, []);
    const injectedService = {
      ...injectedBase,
      async downloadOwnerExport(query: Parameters<typeof injectedBase.downloadOwnerExport>[0]) {
        const result = await injectedBase.downloadOwnerExport(query);
        if (!result.ok) return result;
        return {
          ...result,
          value: { ...result.value, content: (async function* () { throw new Error(injectedMarker); })() },
        };
      },
    };
    const injectedLogger = createTestLogger();
    const injectedResponse = await handleDownloadOwnerExport(
      new Request("https://example.test/api/owner/v1/exports/" + ownerExportId + "/download", {
        headers: withOwnerTestAuth({}),
      }),
      { exportId: ownerExportId },
      { service: injectedService, security: ownerTestSecurity(), portfolioId, logger: injectedLogger },
    );
    expect(injectedResponse.status).toBe(200);
    const injectedReader = injectedResponse.body?.getReader();
    if (injectedReader === undefined) throw new Error("expected injected streamed response body");
    let injectedError: unknown;
    try {
      await injectedReader.read();
    } catch (error) {
      injectedError = error;
    }
    expect(injectedError).toBeInstanceOf(Error);
    if (!(injectedError instanceof Error)) throw new Error("expected sanitized injected stream failure");
    expect(injectedError.message).toBe("Owner export download failed.");
    expect(JSON.stringify({
      records: injectedLogger.records,
      error: { name: injectedError.name, message: injectedError.message, stack: injectedError.stack },
    })).not.toContain(injectedMarker);
  });

  it("keeps a cancelled Owner export HTTP read out of Storage failures without claiming readiness", async () => {
    const chunks = [Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)];
    const expectedLength = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
    const expectedSha256 = createHash("sha256").update(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))).digest("hex");
    let providerPullCalls = 0;
    let providerChunksDelivered = 0;
    let providerCancelCalls = 0;
    let releaseBlockedPull: (() => void) | undefined;
    let notifyBlockedPull: (() => void) | undefined;
    const blockedPullStarted = new Promise<void>((resolve) => { notifyBlockedPull = resolve; });
    const providerBody = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const index = providerPullCalls++;
        if (index === 0) {
          const firstChunk = chunks[index];
          if (firstChunk === undefined) throw new Error("expected first provider chunk");
          providerChunksDelivered += 1;
          controller.enqueue(firstChunk);
          return;
        }
        if (index === 1) {
          notifyBlockedPull?.();
          await new Promise<void>((resolve) => { releaseBlockedPull = resolve; });
          return;
        }
        const chunk = chunks[index];
        if (chunk === undefined) controller.close();
        else {
          providerChunksDelivered += 1;
          controller.enqueue(chunk);
        }
      },
      cancel() {
        providerCancelCalls += 1;
        releaseBlockedPull?.();
      },
    }, { highWaterMark: 0 });
    const storage = createSupabaseOwnerExportStorage({
      storageUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "synthetic-key",
      fetcher: async () => new Response(providerBody, { status: 200, headers: { "content-length": String(expectedLength) } }),
    });
    const logger = createTestLogger();
    const service = makeOwnerExportDownloadService(storage, [], createLoggerOperationsObservationPort(logger), {
      contentLength: expectedLength, sha256: expectedSha256,
    });
    const response = await handleDownloadOwnerExport(
      new Request(`https://example.test/api/owner/v1/exports/${ownerExportId}/download`, { headers: withOwnerTestAuth({}) }),
      { exportId: ownerExportId },
      { service, security: ownerTestSecurity(), portfolioId, logger },
    );
    expect(response.status).toBe(200);
    const body = response.body?.getReader();
    if (body === undefined) throw new Error("expected streamed response body");
    const first = await body.read();
    expect(first).toEqual({ done: false, value: chunks[0] });
    const pendingRead = body.read();
    await blockedPullStarted;
    await body.cancel();
    expect(await pendingRead).toEqual({ done: true, value: undefined });

    expect(providerPullCalls).toBe(2);
    expect(providerChunksDelivered).toBe(1);
    expect(providerCancelCalls).toBe(1);
    const serializedRecords = logger.records.filter((record) => record.event === "operations.signal")
      .map((record) => JSON.stringify({ event: record.event, ...record.fields }));
    const storageReadRecords = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "storage-operation" && record["operation"] === "read";
    });
    const integrityRecords = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "owner-export-integrity";
    });
    expect(storageReadRecords).toEqual([]);
    expect(integrityRecords).toEqual([]);
    const summaryObservedAt = new Date().toISOString();
    const queryContext = { serializedRecords, observedAt: summaryObservedAt, sourceInstalled: true, sourceComplete: true };
    expect(evaluateOperationsLogQuery({ metricId: "storage.failures", definition: OPERATIONS_LOG_QUERIES["storage.failures"],
      ...queryContext })).toEqual({ state: "measured", value: 0, sampleCount: 0 });
    expect(evaluateOperationsLogQuery({ metricId: "storage.readiness", definition: OPERATIONS_LOG_QUERIES["storage.readiness"],
      ...queryContext })).toEqual({ state: "unknown", reason: "not-collected" });
  });

  it("records a provider read failure when cancellation races with its rejection", async () => {
    const chunks = [Uint8Array.of(1), Uint8Array.of(2)];
    const expectedLength = chunks.reduce((length, chunk) => length + chunk.byteLength, 0);
    const expectedSha256 = createHash("sha256").update(Uint8Array.from(chunks.flatMap((chunk) => [...chunk]))).digest("hex");
    const providerMarker = "private-provider-interruption-marker";
    let providerPullCalls = 0;
    let providerReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let clientCancellation: Promise<void> | undefined;
    let notifyCancellationStarted: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolve) => { notifyCancellationStarted = resolve; });
    const providerBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        const index = providerPullCalls++;
        if (index === 0) {
          const firstChunk = chunks[index];
          if (firstChunk === undefined) throw new Error("expected first provider chunk");
          controller.enqueue(firstChunk);
          return;
        }
        queueMicrotask(() => {
          clientCancellation = providerReader?.cancel();
          notifyCancellationStarted?.();
        });
        controller.error(new Error(providerMarker));
      },
    }, { highWaterMark: 0 });
    const storage = createSupabaseOwnerExportStorage({
      storageUrl: "http://127.0.0.1:54321",
      serviceRoleKey: "synthetic-key",
      fetcher: async () => new Response(providerBody, { status: 200, headers: { "content-length": String(expectedLength) } }),
    });
    const logger = createTestLogger();
    const service = makeOwnerExportDownloadService(storage, [], createLoggerOperationsObservationPort(logger), {
      contentLength: expectedLength, sha256: expectedSha256,
    });
    const response = await handleDownloadOwnerExport(
      new Request(`https://example.test/api/owner/v1/exports/${ownerExportId}/download`, { headers: withOwnerTestAuth({}) }),
      { exportId: ownerExportId },
      { service, security: ownerTestSecurity(), portfolioId, logger },
    );
    const body = response.body?.getReader();
    if (body === undefined) throw new Error("expected streamed response body");
    providerReader = body;
    expect(await body.read()).toEqual({ done: false, value: chunks[0] });
    const pendingRead = body.read();
    await cancellationStarted;
    await Promise.allSettled([pendingRead, clientCancellation]);

    const serializedRecords = logger.records.filter((record) => record.event === "operations.signal")
      .map((record) => JSON.stringify({ event: record.event, ...record.fields }));
    const storageReadRecords = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "storage-operation" && record["operation"] === "read";
    });
    const integrityRecords = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "owner-export-integrity";
    });
    expect(storageReadRecords).toHaveLength(1);
    expect(storageReadRecords[0]).toContain('"outcome":"failed"');
    expect(integrityRecords).toEqual([]);
    expect(serializedRecords.join("\n")).not.toContain(providerMarker);
  });

  it("retains integrity classification when cancellation races with a proven mismatch", async () => {
    let pendingNextCalls = 0;
    let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancellation: Promise<void> | undefined;
    let notifyCancellationStarted: (() => void) | undefined;
    const cancellationStarted = new Promise<void>((resolve) => { notifyCancellationStarted = resolve; });
    const content: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (pendingNextCalls++ === 0) return Promise.resolve({ done: false as const, value: downloadBytes });
            queueMicrotask(() => {
              cancellation = responseReader?.cancel();
              notifyCancellationStarted?.();
            });
            return Promise.reject(new OwnerExportReadIntegrityError());
          },
        };
      },
    };
    const objectRead: OwnerExportObjectReadPort = { async readOwnerExport() {
      return { ok: true as const, value: { contentLength: downloadBytes.byteLength, sha256: downloadSha256, content } };
    } };
    const logger = createTestLogger();
    const service = makeOwnerExportDownloadService(objectRead, [], createLoggerOperationsObservationPort(logger));
    const response = await handleDownloadOwnerExport(
      new Request(`https://example.test/api/owner/v1/exports/${ownerExportId}/download`, { headers: withOwnerTestAuth({}) }),
      { exportId: ownerExportId },
      { service, security: ownerTestSecurity(), portfolioId, logger },
    );
    const body = response.body?.getReader();
    if (body === undefined) throw new Error("expected streamed response body");
    responseReader = body;
    expect(await body.read()).toEqual({ done: false, value: downloadBytes });
    const pendingRead = body.read();
    await cancellationStarted;
    await Promise.allSettled([pendingRead, cancellation]);

    const serializedRecords = logger.records.filter((record) => record.event === "operations.signal")
      .map((record) => JSON.stringify({ event: record.event, ...record.fields }));
    const storageReadRecords = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "storage-operation" && record["operation"] === "read";
    });
    const integrityRecords = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "owner-export-integrity";
    });
    expect(storageReadRecords).toHaveLength(1);
    expect(storageReadRecords[0]).toContain('"outcome":"failed"');
    expect(integrityRecords).toHaveLength(1);
    expect(integrityRecords[0]).toContain('"outcome":"failed"');
  });

  it("queries and summarizes an actual streamed Owner export integrity mismatch from a complete bounded system log window", async () => {
    const logger = createTestLogger();
    const integrityRead: OwnerExportObjectReadPort = { async readOwnerExport() {
      return { ok: true as const, value: { contentLength: 1, sha256: downloadSha256,
        content: (async function* () { yield Uint8Array.of(2); })() } };
    } };
    const service = makeOwnerExportDownloadService(integrityRead, [], createLoggerOperationsObservationPort(logger));
    const response = await handleDownloadOwnerExport(
      new Request(`https://example.test/api/owner/v1/exports/${ownerExportId}/download`, { headers: withOwnerTestAuth({}) }),
      { exportId: ownerExportId },
      { service, security: ownerTestSecurity(), portfolioId, logger },
    );
    expect(response.status).toBe(200);
    const body = response.body?.getReader();
    if (body === undefined) throw new Error("expected streamed response body");
    let streamError: unknown;
    try {
      while (!(await body.read()).done) { /* consume the response once through the integrity failure */ }
    } catch (error) { streamError = error; }
    expect(streamError).toBeInstanceOf(Error);
    if (!(streamError instanceof Error)) throw new Error("expected sanitized integrity error");
    expect(streamError.message).toBe("Owner export download failed.");

    const serializedRecords = logger.records.filter((record) => record.event === "operations.signal")
      .map((record) => JSON.stringify({ event: record.event, ...record.fields }));
    const integrityFailures = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "owner-export-integrity" && record["outcome"] === "failed";
    });
    const failedStorageReads = serializedRecords.filter((line) => {
      const record = JSON.parse(line) as Record<string, unknown>;
      return record["signal"] === "storage-operation" && record["operation"] === "read" && record["outcome"] === "failed";
    });
    expect(integrityFailures).toHaveLength(1);
    expect(failedStorageReads).toHaveLength(1);
    expect(JSON.parse(integrityFailures[0]!)).toEqual({ event: "operations.signal", observedAt: expect.any(String),
      signal: "owner-export-integrity", outcome: "failed" });

    const summaryObservedAt = new Date().toISOString();
    const snapshotAtWindow = { ...snapshot, observedAt: summaryObservedAt,
      exports: { ...snapshot.exports, states: { ...snapshot.exports.states, ready: count(1) }, verifiedArtifacts: 1 } };
    const summaryReader = { readOperationsSummary: vi.fn(async () => snapshotAtWindow) };
    const integrityLogReader: OwnerExportIntegrityLogWindowReaderPort = { readOwnerExportIntegrityWindow: vi.fn(async (query) => {
      expect(query).toEqual({ metricId: "export.integrity_failures", observedAt: summaryObservedAt,
        windowSeconds: 900, maxCandidates: 1_000, scope: "system-wide" });
      return { sourceInstalled: true, sourceComplete: true, serializedRecords };
    }) };
    const summaryService = createOperationsSummaryService({ reader: summaryReader, integrityLogReader,
      clock: { now: () => summaryObservedAt } });
    const summary = await summaryService.readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;

    const queryResult = evaluateOperationsLogQuery({ metricId: "export.integrity_failures",
      definition: OPERATIONS_LOG_QUERIES["export.integrity_failures"], serializedRecords, observedAt: summaryObservedAt,
      sourceInstalled: true, sourceComplete: true });
    expect(queryResult).toEqual({ state: "measured", value: 1, sampleCount: 1 });
    expect(summary.value.exports.integrityFailures).toEqual({ state: "measured",
      value: { value: 1, capped: false, sampleLimit: 1_000 }, observedAt: summaryObservedAt,
      windowSeconds: 900, source: "restricted-worker-log" });
    expect(summary.value.exports.verifiedArtifacts).toBe(1);
    expect(summary.value.scope).toEqual({ portfolio: "one-authorized-portfolio", queues: "system-wide-operations",
      runtimeObservations: "system-wide-restricted-operator-log-source" });
    expect(integrityLogReader.readOwnerExportIntegrityWindow).toHaveBeenCalledTimes(1);
    const logQuery = vi.mocked(integrityLogReader.readOwnerExportIntegrityWindow).mock.calls[0]?.[0];
    expect(logQuery).not.toHaveProperty("portfolioId");
    expect(JSON.stringify({ records: serializedRecords, summary: summary.value, error: streamError.message }))
      .not.toMatch(/0196a1b2|signed|PRIVATE_STORAGE|PRIVATE_|artifactId|exportId|sessionId/i);
  });

  it("keeps export integrity unknown for absent, incomplete, malformed, capped or unavailable log windows and measures a complete zero", async () => {
    const readSummary = (integrityLogReader?: OwnerExportIntegrityLogWindowReaderPort) => createOperationsSummaryService({
      reader: { async readOperationsSummary() { return snapshot; } },
      ...(integrityLogReader === undefined ? {} : { integrityLogReader }), clock: { now: () => observedAt },
    }).readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
    const getIntegrity = async (integrityLogReader?: OwnerExportIntegrityLogWindowReaderPort) => {
      const result = await readSummary(integrityLogReader);
      if (!result.ok) throw new Error("expected summary result");
      return result.value.exports.integrityFailures;
    };
    const verified = JSON.stringify({ event: "operations.signal", observedAt, signal: "owner-export-integrity", outcome: "verified" });
    const reader = (source: { sourceInstalled: boolean; sourceComplete: boolean; serializedRecords: readonly string[] }) =>
      ({ readOwnerExportIntegrityWindow: async () => source }) as OwnerExportIntegrityLogWindowReaderPort;

    expect(await getIntegrity()).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(await getIntegrity(reader({ sourceInstalled: true, sourceComplete: false, serializedRecords: [] })))
      .toEqual({ state: "unknown", reason: "not-collected" });
    expect(await getIntegrity(reader({ sourceInstalled: false, sourceComplete: true, serializedRecords: [] })))
      .toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(await getIntegrity(reader({ sourceInstalled: true, sourceComplete: true, serializedRecords: ["{malformed"] })))
      .toEqual({ state: "unknown", reason: "incomplete-sample" });
    expect(await getIntegrity(reader({ sourceInstalled: true, sourceComplete: true, serializedRecords: Array.from({ length: 1_001 }, () => verified) })))
      .toEqual({ state: "unknown", reason: "incomplete-sample" });
    expect(await getIntegrity({ readOwnerExportIntegrityWindow: async () => { throw new Error("PRIVATE_LOG_PROVIDER_MARKER"); } }))
      .toEqual({ state: "unknown", reason: "incomplete-sample" });
    expect(await getIntegrity(reader({ sourceInstalled: true, sourceComplete: true, serializedRecords: [verified] })))
      .toEqual({ state: "measured", value: { value: 0, capped: false, sampleLimit: 1_000 }, observedAt,
        windowSeconds: 900, source: "restricted-worker-log" });
  });

  it("queries actual terminal retention failures through a bounded system-wide query and summary", async () => {
    const logger = createTestLogger();
    const observations = createLoggerOperationsObservationPort(logger);
    const failedFixture = makeFixture({ observations, expireDetail: () => ({ ok: false,
      error: { kind: "validation", code: "PRIVATE_RETENTION_REJECTION_MARKER" } }) });
    const failureRun = await failedFixture.makeService(portfolioId).runDueWork({ workerId: "retention-terminal-failure", maxClaimsPerPhase: 1 });
    expect(failureRun).toMatchObject({ ok: true, value: { failed: 1 } });
    expect(failedFixture.effects.some((effect) => effect.kind === "detail-retention")).toBe(true);
    expect([...failedFixture.rows.values()].some((row) => row.status === "dead")).toBe(true);

    const completedFixture = makeFixture({ observations });
    expect(await completedFixture.makeService(portfolioId).runDueWork({ workerId: "retention-completed", maxClaimsPerPhase: 1 }))
      .toMatchObject({ ok: true, value: { completed: 1 } });
    const incompleteFixture = makeFixture({ observations, expireDetail: () => ({ processedCount: 1,
      nextCursor: "bounded-cursor", incomplete: true }) });
    expect(await incompleteFixture.makeService(portfolioId).runDueWork({ workerId: "retention-incomplete", maxClaimsPerPhase: 1 }))
      .toMatchObject({ ok: true, value: { released: 1 } });

    const serializedRecords = logger.records.filter((record) => record.event === "operations.signal")
      .map((record) => JSON.stringify({ event: record.event, ...record.fields }));
    const emitted = serializedRecords.map((record) => JSON.parse(record) as Record<string, unknown>);
    expect(emitted.map((record) => record["outcome"]).sort()).toEqual(["completed", "failed", "incomplete"]);
    expect(JSON.stringify(emitted)).not.toContain("PRIVATE_RETENTION_REJECTION_MARKER");
    const summaryObservedAt = new Date().toISOString();
    const completeWindow: RetentionFailureLogWindow = { sourceInstalled: true, sourceComplete: true, serializedRecords };
    const queries: RetentionFailureLogWindowQuery[] = [];
    const summarize = async (selectedPortfolio: StableId<"Portfolio">, window: RetentionFailureLogWindow,
      policyProgress: OperationsSummarySnapshot["policyProgress"] = snapshot.policyProgress) => {
      const retentionFailureLogReader: RetentionFailureLogWindowReaderPort = { async readRetentionFailureWindow(query) {
        queries.push(query);
        return window;
      } };
      const reader = { async readOperationsSummary() { return { ...snapshot, observedAt: summaryObservedAt, policyProgress }; } };
      const service = createOperationsSummaryService({ reader, retentionFailureLogReader, clock: { now: () => summaryObservedAt } });
      const result = await service.readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE },
        portfolioId: selectedPortfolio });
      if (!result.ok) throw new Error("expected operations summary");
      return result.value;
    };

    const firstSummary = await summarize(portfolioId, completeWindow);
    expect(firstSummary.retention.failures).toMatchObject({ state: "measured", value: { value: 1, capped: false, sampleLimit: 1_000 },
      observedAt: summaryObservedAt, windowSeconds: 900, source: "restricted-worker-log" });
    expect(firstSummary.retention.backlogPeriods).toMatchObject({ state: "measured", value: 1, source: "operations-database" });
    const secondProgress = { ...snapshot.policyProgress!, retentionCompleteThrough: "2026-10-24" };
    const secondSummary = await summarize(otherPortfolioId, completeWindow, secondProgress);
    expect(secondSummary.retention.failures).toMatchObject({ state: "measured", value: { value: 1 } });
    expect(secondSummary.retention.backlogPeriods).toMatchObject({ state: "measured", value: 3 });
    expect(firstSummary.scope.runtimeObservations).toBe("system-wide-restricted-operator-log-source");
    expect(queries).toEqual([1, 2].map(() => ({ metricId: "retention.failures", observedAt: summaryObservedAt,
      windowSeconds: 900, maxCandidates: 1_000, scope: "system-wide" })));

    const metricFor = async (window: RetentionFailureLogWindow | undefined, failReader = false) => {
      const retentionFailureLogReader = window === undefined ? undefined : { async readRetentionFailureWindow() {
        if (failReader) throw new Error("PRIVATE_RETENTION_LOG_READER_MARKER");
        return window;
      } };
      const service = createOperationsSummaryService({ reader: { async readOperationsSummary() { return { ...snapshot, observedAt: summaryObservedAt }; } },
        ...(retentionFailureLogReader === undefined ? {} : { retentionFailureLogReader }), clock: { now: () => summaryObservedAt } });
      const result = await service.readOperationsSummary({ actor: { kind: "system", jobId, purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
      if (!result.ok) throw new Error("expected operations summary");
      return result.value.retention.failures;
    };
    expect(await metricFor(undefined)).toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(await metricFor({ sourceInstalled: true, sourceComplete: false, serializedRecords: [] }))
      .toEqual({ state: "unknown", reason: "not-collected" });
    expect(await metricFor({ sourceInstalled: false, sourceComplete: true, serializedRecords: [] }))
      .toEqual({ state: "unknown", reason: "producer-not-installed" });
    expect(await metricFor({} as unknown as RetentionFailureLogWindow))
      .toEqual({ state: "unknown", reason: "incomplete-sample" });
    const readerFailure = await metricFor({ sourceInstalled: true, sourceComplete: true, serializedRecords: [] }, true);
    expect(readerFailure).toEqual({ state: "unknown", reason: "incomplete-sample" });
    expect(JSON.stringify(readerFailure)).not.toContain("PRIVATE_RETENTION_LOG_READER_MARKER");
    expect(await metricFor({ sourceInstalled: true, sourceComplete: true, serializedRecords: [] }))
      .toMatchObject({ state: "measured", value: { value: 0 } });
    for (const invalidRecord of ["{malformed", ...[
      { domain: "other", outcome: "failed", processed: 0 },
      { domain: "measurement", outcome: "unknown", processed: 0 },
      { domain: "feedback", outcome: "failed", processed: -1 },
      { domain: "measurement", outcome: "failed", processed: 1, privateMarker: "PRIVATE_RETENTION_FIELD_MARKER" },
    ].map((fields) => JSON.stringify({ event: "operations.signal", observedAt: summaryObservedAt, signal: "retention-work", ...fields }))]) {
      const invalidMetric = await metricFor({ sourceInstalled: true, sourceComplete: true, serializedRecords: [invalidRecord] });
      expect(invalidMetric).toEqual({ state: "unknown", reason: "incomplete-sample" });
      expect(JSON.stringify(invalidMetric)).not.toMatch(/PRIVATE_RETENTION_FIELD_MARKER|PRIVATE_RETENTION_REJECTION_MARKER/u);
    }
    let scanned = 0;
    const capped = new Proxy(Array.from({ length: 1_001 }, () => serializedRecords[0]!), { get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/u.test(property)) scanned += 1;
      return Reflect.get(target, property, receiver);
    } });
    expect(await metricFor({ sourceInstalled: true, sourceComplete: true, serializedRecords: capped }))
      .toEqual({ state: "unknown", reason: "incomplete-sample" });
    expect(scanned).toBe(0);
  });

  it("ignores sink failures and rejects out-of-contract observations without throwing", async () => {
    const failingSink = { async recordSignal() { throw new Error("PRIVATE_SINK_MARKER"); } };
    await expect(recordOperationsSignal(failingSink, { kind: "event-intake", outcome: "accepted" })).resolves.toBeUndefined();
    await expect(recordOperationsSignal(failingSink, { kind: "http-request", route: "private-route" as never,
      statusClass: "4xx", durationMs: 1 })).resolves.toBeUndefined();
  });

  it("records an export assembly Storage write failure from a fixture adapter without private values", async () => {
    const exportId = "0196a1b2-7c3d-7e11-9f22-000000000003" as StableId<"OwnerExport">;
    const ownerId = "0196a1b2-7c3d-7e11-9f22-000000000004" as StableId<"Owner">;
    const artifactId = "0196a1b2-7c3d-7e11-9f22-000000000005" as StableId<"OwnerExportArtifact">;
    const candidateId = "0196a1b2-7c3d-7e11-9f22-000000000006" as StableId<"OwnerExportArtifact">;
    const recordSnapshot = {
      snapshotId: artifactId, capturedAt: observedAt, configurationVersion: null, settings: null,
      capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false },
    };
    const built = await buildConfigurationOwnerExportPackage({ exportId, snapshot: recordSnapshot });
    const record = {
      exportId, portfolioId, ownerId, includedScopes: ["portfolio-configuration"] as const,
      status: "building" as const, schemaVersion: "1.9", aggregateVersion: 2, requestedAt: observedAt,
      snapshot: recordSnapshot, candidateArtifactId: candidateId, candidateSha256: built.sha256,
      candidateContentLength: built.contentLength,
    };
    const jobId = "0196a1b2-7c3d-7e11-9f22-000000000007";
    const observations: OperationsSignalObservation[] = [];
    const dependencies: OwnerExportAssemblyDependencies = {
      operations: { jobs: {
        async claimDue() { return [{ jobId, payload: { type: OWNER_EXPORT_ASSEMBLY_JOB_TYPE, version: 1,
          value: { exportId, portfolioId, ownerId, includedScopes: record.includedScopes } }, leaseToken: "fixture-lease", leaseExpiresAt: observedAt, attemptCount: 1 }]; },
        async scheduleRetry() { return true; },
      } } as unknown as OwnerExportAssemblyDependencies["operations"],
      exports: { async findOwnerExport() { return record; } } as unknown as OwnerExportAssemblyDependencies["exports"],
      snapshots: { async capture() { throw new Error("unexpected snapshot capture"); } },
      storage: {
        async writeOwnerExport() { throw new Error("PRIVATE_STORAGE_PROVIDER_MARKER"); },
        async readOwnerExport() { throw new Error("write failure must stop verification read"); },
      },
      artifacts: {
        async uploadCandidate(_input: unknown, upload: () => Promise<boolean>) { return upload(); },
        async listOwnerExportCleanup() { return []; },
        async revokeOwnerExportArtifact() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const } }; },
      } as unknown as OwnerExportAssemblyDependencies["artifacts"],
      clock: { now: () => observedAt },
      ids: { generate: () => candidateId } as unknown as OwnerExportAssemblyDependencies["ids"],
      observations: { async recordSignal(observation) { observations.push(observation); } },
    };
    const result = await createOwnerExportAssemblyService(dependencies).runOwnerExportAssembly({ workerId: "storage-failure-fixture" });

    expect(result).toMatchObject({ ok: true, value: { claimed: 1, retried: 1, completed: 0 } });
    expect(observations).toContainEqual({ kind: "storage-operation", operation: "write", outcome: "failed" });
    expect(observations).toContainEqual({ kind: "owner-export-build", outcome: "retried", durationMs: 0 });
    expect(JSON.stringify(observations)).not.toContain("PRIVATE_STORAGE_PROVIDER_MARKER");
  });

  it("distinguishes Owner export assembly read interruption from completed integrity mismatch", async () => {
    const exportId = "0196a1b2-7c3d-7e11-9f22-000000000013" as StableId<"OwnerExport">;
    const ownerId = "0196a1b2-7c3d-7e11-9f22-000000000014" as StableId<"Owner">;
    const artifactId = "0196a1b2-7c3d-7e11-9f22-000000000015" as StableId<"OwnerExportArtifact">;
    const candidateId = "0196a1b2-7c3d-7e11-9f22-000000000016" as StableId<"OwnerExportArtifact">;
    const recordSnapshot = { snapshotId: artifactId, capturedAt: observedAt, configurationVersion: null, settings: null,
      capabilities: { currentCvAvailable: false, externalLinksAvailable: false, globalProjectCtaAvailable: false } };
    const built = await buildConfigurationOwnerExportPackage({ exportId, snapshot: recordSnapshot });
    const record = { exportId, portfolioId, ownerId, includedScopes: ["portfolio-configuration"] as const, status: "building" as const,
      schemaVersion: "1.9", aggregateVersion: 2, requestedAt: observedAt, snapshot: recordSnapshot, candidateArtifactId: candidateId,
      candidateSha256: built.sha256, candidateContentLength: built.contentLength };
    const runAssemblyWithReadContent = async (content: AsyncIterable<Uint8Array>, workerId: string) => {
      const observations: OperationsSignalObservation[] = [];
      const dependencies: OwnerExportAssemblyDependencies = {
        operations: { jobs: { async claimDue() { return [{ jobId: "0196a1b2-7c3d-7e11-9f22-000000000017", payload: { type: OWNER_EXPORT_ASSEMBLY_JOB_TYPE,
          version: 1, value: { exportId, portfolioId, ownerId, includedScopes: record.includedScopes } }, leaseToken: "fixture-lease",
          leaseExpiresAt: observedAt, attemptCount: 1 }]; }, async scheduleRetry() { return true; } } } as unknown as OwnerExportAssemblyDependencies["operations"],
        exports: { async findOwnerExport() { return record; } } as unknown as OwnerExportAssemblyDependencies["exports"],
        snapshots: { async capture() { throw new Error("unexpected snapshot capture"); } },
        storage: { async writeOwnerExport() { return { ok: true as const, value: undefined }; }, async readOwnerExport() {
          return { ok: true as const, value: { contentLength: built.contentLength, sha256: built.sha256, content } };
        } },
        artifacts: { async uploadCandidate(_input: unknown, upload: () => Promise<boolean>) { return upload(); }, async listOwnerExportCleanup() { return []; },
          async revokeOwnerExportArtifact() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const } }; } } as unknown as OwnerExportAssemblyDependencies["artifacts"],
        clock: { now: () => observedAt }, ids: { generate: () => candidateId } as unknown as OwnerExportAssemblyDependencies["ids"],
        observations: { async recordSignal(item) { observations.push(item); } },
      };
      const result = await createOwnerExportAssemblyService(dependencies).runOwnerExportAssembly({ workerId });
      expect(result).toMatchObject({ ok: true, value: { claimed: 1, retried: 1, completed: 0 } });
      return observations;
    };

    const mismatchObservations = await runAssemblyWithReadContent(
      (async function* () { yield new Uint8Array(built.contentLength); })(), "integrity-mismatch-fixture",
    );
    expect(mismatchObservations.filter((item) => item.kind === "owner-export-integrity" && item.outcome === "failed"))
      .toHaveLength(1);
    expect(mismatchObservations.filter((item) => item.kind === "storage-operation" && item.operation === "read"))
      .toEqual([{ kind: "storage-operation", operation: "read", outcome: "failed" }]);

    const privateReadMarker = "PRIVATE_STORAGE_READ_INTERRUPTION_MARKER";
    const interruptedReadObservations = await runAssemblyWithReadContent(
      (async function* () { yield Uint8Array.of(1); throw new Error(privateReadMarker); })(), "read-interruption-fixture",
    );
    expect(interruptedReadObservations.filter((item) => item.kind === "owner-export-integrity" && item.outcome === "failed"))
      .toHaveLength(0);
    expect(interruptedReadObservations.filter((item) => item.kind === "storage-operation" && item.operation === "read"))
      .toEqual([{ kind: "storage-operation", operation: "read", outcome: "failed" }]);
    expect(JSON.stringify(interruptedReadObservations)).not.toContain(privateReadMarker);

    const typedIntegrityObservations = await runAssemblyWithReadContent(
      (async function* () { yield Uint8Array.of(1); throw new OwnerExportReadIntegrityError(); })(), "typed-integrity-fixture",
    );
    expect(typedIntegrityObservations.filter((item) => item.kind === "owner-export-integrity" && item.outcome === "failed"))
      .toHaveLength(1);
    expect(typedIntegrityObservations.filter((item) => item.kind === "storage-operation" && item.operation === "read"))
      .toEqual([{ kind: "storage-operation", operation: "read", outcome: "failed" }]);
  });
});
