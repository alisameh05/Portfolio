import type { StableId } from "@shared/domain";
import { err, ok, parseStableId, type Rejection, type Result } from "@shared/domain";
import type { Clock, Logger } from "../../../runtime/ports.js";
import type { ScopedSystemActor } from "./service.js";
import type { OperationsObservationPort, OperationsSignalObservation } from "./service.js";
import { evaluateOperationsLogQuery, OPERATIONS_LOG_QUERIES } from "./operations-log-queries.js";

export const OPERATIONS_SUMMARY_PURPOSE = "operations.observability.read" as const;
export const OPERATIONS_SUMMARY_MAX_ROWS = 1_000;
export const OPERATIONS_SUMMARY_WINDOW_SECONDS = 15 * 60;

export type BoundedCount = Readonly<{
  value: number;
  capped: boolean;
  sampleLimit: number;
}>;

export type KnownValue<T> = Readonly<{
  state: "measured";
  value: T;
  observedAt: string;
  windowSeconds: number;
  source: "operations-database" | "restricted-worker-log";
  sampleLimit?: number;
  capped?: boolean;
}>;

export type UnknownValue = Readonly<{
  state: "unknown";
  reason: "producer-not-installed" | "provider-limit-unknown" | "not-collected" | "no-durable-watermark" |
    "no-completed-policy-period" | "incomplete-sample";
}>;

export type OperationsValue<T> = KnownValue<T> | UnknownValue;

export interface OperationsSummarySnapshot {
  readonly observedAt: string;
  readonly outbox: {
    readonly eligibleDepth: BoundedCount;
    readonly oldestEligibleAgeSeconds: number | null;
    readonly eligibleOldestKnown: boolean;
    readonly futureDelayedDepth: BoundedCount;
    readonly retryDepth: BoundedCount;
    readonly deadDepth: BoundedCount;
    readonly activeLeaseDepth: BoundedCount;
    readonly expiredLeaseDepth: BoundedCount;
  };
  readonly jobs: {
    readonly availableDepth: BoundedCount;
    readonly leasedDepth: BoundedCount;
    readonly activeLeaseDepth: BoundedCount;
    readonly deadDepth: BoundedCount;
    readonly expiredLeaseDepth: BoundedCount;
  };
  readonly leases: { readonly ageSeconds: number | null; readonly ageKnown: boolean };
  readonly exports: {
    readonly windowSeconds: number;
    readonly states: Readonly<Record<"requested" | "building" | "ready" | "failed" | "expired", BoundedCount>>;
    readonly completedBuilds: number;
    readonly maxBuildDurationMs: number | null;
    readonly verifiedArtifacts: number;
    readonly artifactBytes: number | null;
    /** Sum of the five bounded export-state samples; each state contributes at most 1,000 rows (0..5,000 total). */
    readonly sampleCount: number;
    /** True when any one per-state sample reaches its 1,000-row limit. */
    readonly capped: boolean;
  };
  readonly policyProgress: null | {
    readonly firstPolicyPeriod: string;
    readonly requiredThroughPeriod: string;
    readonly retentionCompleteThrough: string;
    readonly aggregateFinishedThrough: string;
    readonly lastCompletePeriod: string;
    readonly phase: "retention" | "aggregate";
  };
}

export interface OperationsSummaryQuery {
  readonly portfolioId: StableId<"Portfolio">;
  readonly observedAt: string;
  readonly windowSeconds: typeof OPERATIONS_SUMMARY_WINDOW_SECONDS;
  readonly maxRows: typeof OPERATIONS_SUMMARY_MAX_ROWS;
}

export interface OperationsSummaryReaderPort {
  readOperationsSummary(query: OperationsSummaryQuery): Promise<OperationsSummarySnapshot>;
}

export interface OwnerExportIntegrityLogWindowQuery {
  readonly metricId: "export.integrity_failures";
  readonly observedAt: string;
  readonly windowSeconds: typeof OPERATIONS_SUMMARY_WINDOW_SECONDS;
  readonly maxCandidates: typeof OPERATIONS_SUMMARY_MAX_ROWS;
  readonly scope: "system-wide";
}

export interface OwnerExportIntegrityLogWindow {
  readonly sourceInstalled: boolean;
  readonly sourceComplete: boolean;
  readonly serializedRecords: readonly string[];
}

/** Optional restricted system-log reader. This fixed window cannot be portfolio- or query-selected. */
export interface OwnerExportIntegrityLogWindowReaderPort {
  readOwnerExportIntegrityWindow(query: OwnerExportIntegrityLogWindowQuery): Promise<OwnerExportIntegrityLogWindow>;
}

export interface RetentionFailureLogWindowQuery {
  readonly metricId: "retention.failures";
  readonly observedAt: string;
  readonly windowSeconds: typeof OPERATIONS_SUMMARY_WINDOW_SECONDS;
  readonly maxCandidates: typeof OPERATIONS_SUMMARY_MAX_ROWS;
  readonly scope: "system-wide";
}

export interface RetentionFailureLogWindow {
  readonly sourceInstalled: boolean;
  readonly sourceComplete: boolean;
  readonly serializedRecords: readonly string[];
}

/** Optional restricted system-log reader; fixed to the safe retention-failure metric and system scope. */
export interface RetentionFailureLogWindowReaderPort {
  readRetentionFailureWindow(query: RetentionFailureLogWindowQuery): Promise<RetentionFailureLogWindow>;
}

export interface OperationsSummary {
  readonly generatedAt: string;
  readonly windowSeconds: typeof OPERATIONS_SUMMARY_WINDOW_SECONDS;
  readonly scope: {
    readonly portfolio: "one-authorized-portfolio";
    readonly queues: "system-wide-operations";
    readonly runtimeObservations: "system-wide-restricted-operator-log-source";
  };
  readonly portfolio: { readonly scope: "one-authorized-portfolio" };
  readonly application: {
    readonly requestCount: OperationsValue<BoundedCount>;
    readonly latencyMs: OperationsValue<{ readonly maximum: number; readonly sampleCount: number }>;
    readonly statusClasses: OperationsValue<Readonly<Record<"2xx" | "3xx" | "4xx" | "5xx", number>>>;
  };
  readonly database: {
    readonly poolUsed: OperationsValue<number>;
    readonly poolLimit: OperationsValue<number>;
    readonly providerLimit: OperationsValue<number>;
    readonly transactionFailures: OperationsValue<BoundedCount>;
    readonly rlsDenials: OperationsValue<BoundedCount>;
  };
  readonly capacity: { readonly usedPercent: OperationsValue<number> };
  readonly outbox: Omit<OperationsSummarySnapshot["outbox"], "oldestEligibleAgeSeconds" | "eligibleOldestKnown"> & {
    readonly observedAt: string;
    readonly oldestEligibleAgeSeconds: OperationsValue<number | null>;
  };
  readonly jobs: OperationsSummarySnapshot["jobs"];
  readonly leases: {
    readonly activeJobs: BoundedCount;
    readonly expiredJobs: BoundedCount;
    readonly deadJobs: BoundedCount;
    readonly activeOutbox: BoundedCount;
    readonly expiredOutbox: BoundedCount;
    readonly ageSeconds: OperationsValue<number | null>;
    readonly reclaimed: OperationsValue<BoundedCount>;
    readonly staleWrites: OperationsValue<BoundedCount>;
  };
  readonly exports: Omit<OperationsSummarySnapshot["exports"], "artifactBytes"> & {
    readonly artifactBytes: OperationsValue<number>;
    readonly observedAt: string;
    readonly buildDurationMs: OperationsValue<{ readonly maximum: number; readonly sampleCount: number }>;
    readonly integrityFailures: OperationsValue<BoundedCount>;
  };
  readonly publication: { readonly safeFailures: OperationsValue<BoundedCount> };
  readonly events: {
    readonly accepted: OperationsValue<BoundedCount>;
    readonly dropped: OperationsValue<BoundedCount>;
  };
  readonly aggregates: {
    /** A durable backlog can be measured while no policy period has completed; in that case the date is null. */
    readonly completeness: OperationsValue<{ readonly lastFinishedPeriod: string | null; readonly backlogPeriods: number }>;
  };
  readonly retention: {
    /** Unknown until last_complete_period reaches firstPolicyPeriod; this does not hide the measured backlog or phase. */
    readonly lastCompletePolicyPeriod: OperationsValue<string>;
    readonly backlogPeriods: OperationsValue<number>;
    readonly phase: OperationsValue<"retention" | "aggregate">;
    readonly failures: OperationsValue<BoundedCount>;
  };
  readonly storage: {
    readonly failures: OperationsValue<BoundedCount>;
    readonly readiness: OperationsValue<"ready" | "degraded" | "unavailable">;
  };
  readonly backup: {
    readonly relationalSourceWatermarkAgeHours: OperationsValue<number>;
    readonly objectSourceWatermarkAgeHours: OperationsValue<number>;
    readonly count: OperationsValue<BoundedCount>;
    readonly bytes: OperationsValue<BoundedCount>;
    readonly state: OperationsValue<"complete" | "incomplete" | "failed">;
  };
  readonly recovery: {
    readonly stage: OperationsValue<"backup" | "database-restore" | "object-restore" | "verification" | "cleanup">;
    readonly durationMs: OperationsValue<number>;
  };
}

export interface OperationsSummaryCommand {
  readonly actor: ScopedSystemActor;
  readonly portfolioId: StableId<"Portfolio">;
}

export const BACKUP_RPO_THRESHOLDS_HOURS = Object.freeze({ relational: 24, object: 168 } as const);

export type BackupRpoAssessment =
  | Readonly<{ state: "unknown"; reason: "producer-not-installed" | "not-collected" }>
  | Readonly<{ state: "measured"; sourceWatermarkAgeHours: number; thresholdHours: 24 | 168; exceeded: boolean }>;

/** Evaluate each RPO only from its own source-data watermark, never upload time. */
export function evaluateBackupRpo(
  source: keyof typeof BACKUP_RPO_THRESHOLDS_HOURS,
  sourceWatermarkAt: string | null,
  observedAt: string,
): BackupRpoAssessment {
  if (sourceWatermarkAt === null) return { state: "unknown", reason: "producer-not-installed" };
  if (!isUtcInstant(sourceWatermarkAt) || !isUtcInstant(observedAt)) return { state: "unknown", reason: "not-collected" };
  const ageMs = Date.parse(observedAt) - Date.parse(sourceWatermarkAt);
  if (ageMs < 0) return { state: "unknown", reason: "not-collected" };
  const thresholdHours = BACKUP_RPO_THRESHOLDS_HOURS[source];
  const sourceWatermarkAgeHours = ageMs / 3_600_000;
  return { state: "measured", sourceWatermarkAgeHours, thresholdHours,
    exceeded: sourceWatermarkAgeHours > thresholdHours };
}

export function createOperationsSummaryService(dependencies: {
  readonly reader: OperationsSummaryReaderPort;
  readonly integrityLogReader?: OwnerExportIntegrityLogWindowReaderPort;
  readonly retentionFailureLogReader?: RetentionFailureLogWindowReaderPort;
  readonly clock: Clock;
}) {
  async function readOperationsSummary(command: OperationsSummaryCommand): Promise<Result<OperationsSummary, Rejection>> {
    if (command.actor.kind !== "system" || command.actor.purpose !== OPERATIONS_SUMMARY_PURPOSE ||
        !parseStableId("Job", command.actor.jobId).ok ||
        !parseStableId("Portfolio", command.portfolioId).ok) {
      return err({ kind: "forbidden", code: "OPERATIONS_SUMMARY_ACCESS_DENIED" });
    }

    const observedAt = dependencies.clock.now();
    if (!isUtcInstant(observedAt)) return err({ kind: "temporarily_unavailable", code: "OPERATIONS_SUMMARY_CLOCK_INVALID" });
    let snapshot: OperationsSummarySnapshot;
    try {
      snapshot = await dependencies.reader.readOperationsSummary({
        portfolioId: command.portfolioId,
        observedAt,
        windowSeconds: OPERATIONS_SUMMARY_WINDOW_SECONDS,
        maxRows: OPERATIONS_SUMMARY_MAX_ROWS,
      });
    } catch {
      return err({ kind: "temporarily_unavailable", code: "OPERATIONS_SUMMARY_UNAVAILABLE" });
    }
    if (!isUtcInstant(snapshot.observedAt)) return err({ kind: "temporarily_unavailable", code: "OPERATIONS_SUMMARY_UNAVAILABLE" });
    const integrityFailures = await readOwnerExportIntegrityFailures(dependencies.integrityLogReader, snapshot.observedAt);
    const retentionFailures = await readRetentionFailures(dependencies.retentionFailureLogReader, snapshot.observedAt);
    return ok(toOperationsSummary(snapshot, integrityFailures, retentionFailures));
  }

  return { readOperationsSummary };
}

async function readRetentionFailures(
  reader: RetentionFailureLogWindowReaderPort | undefined,
  observedAt: string,
): Promise<OperationsValue<BoundedCount>> {
  if (reader === undefined) return { state: "unknown", reason: "producer-not-installed" };
  try {
    const definition = OPERATIONS_LOG_QUERIES["retention.failures"];
    const window = await reader.readRetentionFailureWindow({
      metricId: "retention.failures",
      observedAt,
      windowSeconds: definition.windowSeconds,
      maxCandidates: definition.maxCandidates,
      scope: "system-wide",
    });
    if (typeof window?.sourceInstalled !== "boolean" || typeof window.sourceComplete !== "boolean" ||
        !Array.isArray(window.serializedRecords) || window.serializedRecords.length > definition.maxCandidates ||
        !window.serializedRecords.every((record) => typeof record === "string")) {
      return { state: "unknown", reason: "incomplete-sample" };
    }
    const result = evaluateOperationsLogQuery({ metricId: "retention.failures", definition,
      serializedRecords: window.serializedRecords, observedAt,
      sourceInstalled: window.sourceInstalled, sourceComplete: window.sourceComplete });
    if (result.state === "unknown") return { state: "unknown", reason: result.reason === "producer-not-installed"
      ? "producer-not-installed" : result.reason === "not-collected" ? "not-collected" : "incomplete-sample" };
    if (typeof result.value !== "number" || !Number.isSafeInteger(result.value) || result.value < 0 || result.value > definition.maxCandidates) {
      return { state: "unknown", reason: "incomplete-sample" };
    }
    return {
      state: "measured",
      value: { value: result.value, capped: false, sampleLimit: definition.maxCandidates },
      observedAt,
      windowSeconds: definition.windowSeconds,
      source: "restricted-worker-log",
    };
  } catch {
    return { state: "unknown", reason: "incomplete-sample" };
  }
}

async function readOwnerExportIntegrityFailures(
  reader: OwnerExportIntegrityLogWindowReaderPort | undefined,
  observedAt: string,
): Promise<OperationsValue<BoundedCount>> {
  if (reader === undefined) return { state: "unknown", reason: "producer-not-installed" };
  try {
    const definition = OPERATIONS_LOG_QUERIES["export.integrity_failures"];
    const window = await reader.readOwnerExportIntegrityWindow({
      metricId: "export.integrity_failures",
      observedAt,
      windowSeconds: definition.windowSeconds,
      maxCandidates: definition.maxCandidates,
      scope: "system-wide",
    });
    if (typeof window?.sourceInstalled !== "boolean" || typeof window.sourceComplete !== "boolean" ||
        !Array.isArray(window.serializedRecords) || window.serializedRecords.length > definition.maxCandidates ||
        !window.serializedRecords.every((record) => typeof record === "string")) {
      return { state: "unknown", reason: "incomplete-sample" };
    }
    const result = evaluateOperationsLogQuery({ metricId: "export.integrity_failures", definition,
      serializedRecords: window.serializedRecords, observedAt,
      sourceInstalled: window.sourceInstalled, sourceComplete: window.sourceComplete });
    if (result.state === "unknown") return { state: "unknown", reason: result.reason === "producer-not-installed"
      ? "producer-not-installed" : result.reason === "not-collected" ? "not-collected" : "incomplete-sample" };
    if (typeof result.value !== "number" || !Number.isSafeInteger(result.value) || result.value < 0 || result.value > definition.maxCandidates) {
      return { state: "unknown", reason: "incomplete-sample" };
    }
    return {
      state: "measured",
      value: { value: result.value, capped: false, sampleLimit: definition.maxCandidates },
      observedAt,
      windowSeconds: definition.windowSeconds,
      source: "restricted-worker-log",
    };
  } catch {
    return { state: "unknown", reason: "incomplete-sample" };
  }
}

function toOperationsSummary(snapshot: OperationsSummarySnapshot, integrityFailures: OperationsValue<BoundedCount>,
  retentionFailures: OperationsValue<BoundedCount>): OperationsSummary {
  const measured = <T>(value: T, source: KnownValue<T>["source"] = "operations-database",
    windowSeconds: number = OPERATIONS_SUMMARY_WINDOW_SECONDS): KnownValue<T> => ({
    state: "measured", value, observedAt: snapshot.observedAt, windowSeconds, source,
  });
  const unknown = (reason: UnknownValue["reason"]): UnknownValue => ({ state: "unknown", reason });
  const progress = snapshot.policyProgress;
  const backlog = progress === null ? undefined : dateDifferenceInDays(progress.requiredThroughPeriod, progress.retentionCompleteThrough);
  const aggregateBacklog = progress === null ? undefined : dateDifferenceInDays(progress.requiredThroughPeriod, progress.aggregateFinishedThrough);
  return {
    generatedAt: snapshot.observedAt,
    windowSeconds: OPERATIONS_SUMMARY_WINDOW_SECONDS,
    scope: {
      portfolio: "one-authorized-portfolio",
      queues: "system-wide-operations",
      runtimeObservations: "system-wide-restricted-operator-log-source",
    },
    portfolio: { scope: "one-authorized-portfolio" },
    application: {
      requestCount: unknown("not-collected"),
      latencyMs: unknown("not-collected"),
      statusClasses: unknown("not-collected"),
    },
    database: {
      poolUsed: unknown("not-collected"),
      poolLimit: unknown("not-collected"),
      providerLimit: unknown("provider-limit-unknown"),
      transactionFailures: unknown("not-collected"),
      rlsDenials: unknown("not-collected"),
    },
    capacity: { usedPercent: unknown("provider-limit-unknown") },
    outbox: { ...snapshot.outbox, observedAt: snapshot.observedAt,
      oldestEligibleAgeSeconds: snapshot.outbox.eligibleOldestKnown
        ? measured(snapshot.outbox.oldestEligibleAgeSeconds)
        : unknown("incomplete-sample") },
    jobs: snapshot.jobs,
    leases: {
      activeJobs: snapshot.jobs.activeLeaseDepth,
      expiredJobs: snapshot.jobs.expiredLeaseDepth,
      deadJobs: snapshot.jobs.deadDepth,
      activeOutbox: snapshot.outbox.activeLeaseDepth,
      expiredOutbox: snapshot.outbox.expiredLeaseDepth,
      ageSeconds: snapshot.leases.ageKnown ? measured(snapshot.leases.ageSeconds) : unknown("incomplete-sample"),
      reclaimed: unknown("not-collected"),
      staleWrites: unknown("not-collected"),
    },
    exports: {
      ...snapshot.exports,
      artifactBytes: snapshot.exports.artifactBytes === null
        ? unknown("incomplete-sample")
        : measured(snapshot.exports.artifactBytes, "operations-database", snapshot.exports.windowSeconds),
      observedAt: snapshot.observedAt,
      buildDurationMs: snapshot.exports.completedBuilds === 0 || snapshot.exports.maxBuildDurationMs === null
        ? unknown("not-collected")
        : measured({ maximum: snapshot.exports.maxBuildDurationMs, sampleCount: snapshot.exports.completedBuilds },
          "operations-database", snapshot.exports.windowSeconds),
      integrityFailures,
    },
    publication: { safeFailures: unknown("not-collected") },
    events: { accepted: unknown("not-collected"), dropped: unknown("not-collected") },
    aggregates: {
      completeness: progress === null || aggregateBacklog === undefined
        ? unknown("no-durable-watermark")
        : measured({ lastFinishedPeriod: periodCursorReachedStart(progress.aggregateFinishedThrough, progress.firstPolicyPeriod)
          ? progress.aggregateFinishedThrough : null, backlogPeriods: aggregateBacklog }),
    },
    retention: {
      lastCompletePolicyPeriod: progress === null ? unknown("no-durable-watermark")
        : periodCursorReachedStart(progress.lastCompletePeriod, progress.firstPolicyPeriod)
          ? measured(progress.lastCompletePeriod)
          : isCanonicalUtcPeriod(progress.lastCompletePeriod) && isCanonicalUtcPeriod(progress.firstPolicyPeriod)
            ? unknown("no-completed-policy-period") : unknown("incomplete-sample"),
      backlogPeriods: backlog === undefined ? unknown("no-durable-watermark") : measured(backlog),
      phase: progress === null ? unknown("no-durable-watermark") : measured(progress.phase),
      failures: retentionFailures,
    },
    storage: { failures: unknown("not-collected"), readiness: unknown("not-collected") },
    backup: {
      relationalSourceWatermarkAgeHours: unknown("producer-not-installed"),
      objectSourceWatermarkAgeHours: unknown("producer-not-installed"),
      count: unknown("producer-not-installed"),
      bytes: unknown("producer-not-installed"),
      state: unknown("producer-not-installed"),
    },
    recovery: { stage: unknown("producer-not-installed"), durationMs: unknown("producer-not-installed") },
  };
}

function dateDifferenceInDays(later: string, earlier: string): number {
  const delta = Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`);
  return Math.max(0, Math.floor(delta / 86_400_000));
}

function periodCursorReachedStart(cursor: string, firstPolicyPeriod: string): boolean {
  return isCanonicalUtcPeriod(cursor) && isCanonicalUtcPeriod(firstPolicyPeriod) && cursor >= firstPolicyPeriod;
}

function isCanonicalUtcPeriod(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function isUtcInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export async function recordOperationsSignal(
  observations: Pick<OperationsObservationPort, "recordSignal"> | undefined,
  observation: OperationsSignalObservation,
): Promise<void> {
  if (!isSafeSignal(observation)) return;
  if (!observations?.recordSignal) {
    safeLog(DEFAULT_OPERATIONS_LOGGER, "operations.signal", safeSignalFields(observation));
    return;
  }
  try {
    void observations.recordSignal(observation).catch(() => undefined);
  } catch { /* telemetry cannot undo the completed operation */ }
}

/** Emit a fixed-shape observation to the injected port or existing safe logger. */
export async function emitOperationsSignal(
  logger: Logger | undefined,
  observations: Pick<OperationsObservationPort, "recordSignal"> | undefined,
  observation: OperationsSignalObservation,
): Promise<void> {
  if (!isSafeSignal(observation)) return;
  if (observations?.recordSignal) {
    await recordOperationsSignal(observations, observation);
    return;
  }
  safeLog(logger ?? DEFAULT_OPERATIONS_LOGGER, "operations.signal", safeSignalFields(observation));
}

const DEFAULT_OPERATIONS_LOGGER: Logger = {
  debug() {},
  info(event, fields = {}) {
    try { console.info(JSON.stringify({ event, ...fields })); } catch { /* logging is best effort */ }
  },
  warn() {},
  error() {},
};

export function createLoggerOperationsObservationPort(logger: Logger): OperationsObservationPort {
  return {
    async recordIncident(observation) {
      safeLog(logger, "operations.incident", { category: observation.category, severity: observation.severity });
    },
    async recordRecovery(observation) {
      safeLog(logger, "operations.recovery", { stage: observation.stage, outcome: observation.outcome,
        ...(observation.durationMs === undefined ? {} : { durationMs: boundedInteger(observation.durationMs) }) });
    },
    async recordSignal(observation) {
      if (!isSafeSignal(observation)) return;
      safeLog(logger, "operations.signal", safeSignalFields(observation));
    },
  };
}

function safeLog(logger: Logger, event: string, fields: Readonly<Record<string, string | number>>): void {
  try { logger.info(event, fields); } catch { /* logging is best effort */ }
}

function safeSignalFields(observation: OperationsSignalObservation): Readonly<Record<string, string | number>> {
  const observedAt = new Date().toISOString();
  switch (observation.kind) {
    case "http-request": return { observedAt, signal: observation.kind, route: observation.route,
      statusClass: observation.statusClass, durationMs: boundedInteger(observation.durationMs) };
    case "event-intake": return { observedAt, signal: observation.kind, outcome: observation.outcome };
    case "database-pool": return { observedAt, signal: observation.kind,
      usedConnections: boundedInteger(observation.usedConnections), configuredLimit: boundedInteger(observation.configuredLimit) };
    case "database-failure": return { observedAt, signal: observation.kind, category: observation.category };
    case "lease-lifecycle": return { observedAt, signal: observation.kind, outcome: observation.outcome,
      count: boundedInteger(observation.count), ...(observation.ageSeconds === undefined ? {} : { ageSeconds: boundedInteger(observation.ageSeconds) }) };
    case "publication-failure": return { observedAt, signal: observation.kind, category: observation.category };
    case "owner-export-integrity": return { observedAt, signal: observation.kind, outcome: observation.outcome };
    case "owner-export-build": return { observedAt, signal: observation.kind, outcome: observation.outcome,
      durationMs: boundedInteger(observation.durationMs) };
    case "storage-operation": return { observedAt, signal: observation.kind, operation: observation.operation,
      outcome: observation.outcome, ...(observation.bytes === undefined ? {} : { bytes: boundedInteger(observation.bytes) }) };
    case "retention-work": return { observedAt, signal: observation.kind, domain: observation.domain,
      outcome: observation.outcome, processed: boundedInteger(observation.processed) };
  }
}

function isSafeSignal(observation: OperationsSignalObservation): boolean {
  switch (observation.kind) {
    case "http-request": return ["public-event", "public-current-cv", "public-feedback", "public-rating", "public-reaction",
      "owner-content-authoring", "owner-content-review", "owner-cv", "owner-analytics", "owner-export-request",
      "owner-export-status", "owner-export-download", "owner-media", "owner-moderation", "owner-project-status",
      "owner-project", "owner-publication", "owner-taxonomy", "owner-configuration"].includes(observation.route) &&
      ["2xx", "3xx", "4xx", "5xx"].includes(observation.statusClass) && Number.isFinite(observation.durationMs) && observation.durationMs >= 0 && observation.durationMs <= 86_400_000;
    case "event-intake": return ["accepted", "dropped", "rejected", "unavailable", "indeterminate"].includes(observation.outcome);
    case "database-pool": return Number.isSafeInteger(observation.usedConnections) && observation.usedConnections >= 0 && observation.usedConnections <= 1_000 &&
      Number.isSafeInteger(observation.configuredLimit) && observation.configuredLimit >= 1 && observation.configuredLimit <= 1_000;
    case "database-failure": return observation.category === "transaction" || observation.category === "authorization" || observation.category === "pool";
    case "lease-lifecycle": return ["reclaimed", "stale-write"].includes(observation.outcome) && Number.isSafeInteger(observation.count) &&
      observation.count > 0 && observation.count <= 1_000_000 && (observation.ageSeconds === undefined ||
        Number.isFinite(observation.ageSeconds) && observation.ageSeconds >= 0 && observation.ageSeconds <= 31_536_000);
    case "publication-failure": return observation.category === "dependency" || observation.category === "transaction";
    case "owner-export-integrity": return observation.outcome === "verified" || observation.outcome === "failed";
    case "owner-export-build": return ["completed", "retried", "failed", "stale"].includes(observation.outcome) &&
      Number.isFinite(observation.durationMs) && observation.durationMs >= 0 && observation.durationMs <= 86_400_000;
    case "storage-operation": return ["read", "write", "delete"].includes(observation.operation) &&
      ["succeeded", "failed"].includes(observation.outcome) && (observation.bytes === undefined ||
        Number.isSafeInteger(observation.bytes) && observation.bytes >= 0 && observation.bytes <= 1_000_000_000);
    case "retention-work": return ["measurement", "feedback"].includes(observation.domain) &&
      ["completed", "incomplete", "failed"].includes(observation.outcome) &&
      Number.isSafeInteger(observation.processed) && observation.processed >= 0 && observation.processed <= 1_000_000;
  }
}

function boundedInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1_000_000_000, Math.floor(value)));
}
