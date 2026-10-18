import type {
  OwnerActor,
  IdempotencyKey,
  Rejection,
  Result,
  StableId,
  SystemActor,
} from "@shared/domain";
import { err, ok, parseStableId } from "@shared/domain";
import type { SafeErrorCode, LeasedJobRecord } from "./persistence.js";
import { OWNER_EXPORT_SCOPES, type ExportScope, type ScopedWorkerPurpose } from "../domain/index.js";

export interface OwnerExportAuthorizationContext {
  readonly actor: OwnerActor;
  readonly portfolioId: StableId<"Portfolio">;
}

export interface RequestOwnerExportApplicationCommand extends OwnerExportAuthorizationContext {
  readonly idempotencyKey: IdempotencyKey;
  readonly includedScopes: readonly ExportScope[];
}

export interface GetOwnerExportQuery extends OwnerExportAuthorizationContext {
  readonly exportId: StableId<"OwnerExport">;
}

export interface DownloadOwnerExportQuery extends OwnerExportAuthorizationContext {
  readonly exportId: StableId<"OwnerExport">;
}

export interface OwnerExportRequestReceipt {
  readonly exportId: StableId<"OwnerExport">;
  readonly outcome: "owner-export-requested";
  readonly state: "requested";
}

export interface OwnerExportEntryDescriptor<TScope extends ExportScope = ExportScope> {
  readonly path: string;
  readonly scope: TScope;
  readonly mediaType: "application/x-ndjson" | "application/json";
  readonly recordSchema: `urn:shipwithali:owner-export-schema:${TScope}:1.0`;
  readonly schemaPath: `schemas/${TScope}.schema.json`;
  readonly schemaVersion: "1.0";
  readonly digest: string;
  readonly recordCount: number;
}

export interface OwnerExportPackageManifest {
  readonly packageFormat: "shipwithali-owner-export";
  readonly schemaVersion: "1.0";
  readonly createdAt: string;
  readonly algorithm: "sha-256";
  readonly digest: string;
  readonly includedScopes: readonly ExportScope[];
  readonly publicEventDataCoverage: { readonly mode: "excluded" };
  readonly entries: readonly OwnerExportEntryDescriptor[];
}

interface OwnerExportViewBase {
  readonly exportId: StableId<"OwnerExport">;
  readonly schemaVersion: string;
  readonly requestedAt: string;
  readonly includedScopes: readonly ExportScope[];
  readonly publicEventDataCoverage: { readonly mode: "excluded" };
}

export type OwnerExportView =
  | (OwnerExportViewBase & {
      readonly state: "requested" | "building";
      readonly downloadAvailable: false;
    })
  | (OwnerExportViewBase & {
      readonly state: "ready";
      readonly completedAt: string;
      readonly integrityManifest: OwnerExportPackageManifest;
      readonly downloadAvailable: true;
    })
  | (OwnerExportViewBase & {
      readonly state: "failed";
      readonly failedAt: string;
      readonly failureCode: string;
      readonly downloadAvailable: false;
    })
  | (OwnerExportViewBase & {
      readonly state: "expired";
      readonly completedAt: string;
      readonly expiredAt: string;
      readonly integrityManifest: OwnerExportPackageManifest;
      readonly downloadAvailable: false;
    });

export interface OwnerExportDownloadView {
  readonly exportId: StableId<"OwnerExport">;
  readonly schemaVersion: string;
  readonly filename: string;
  readonly contentLength: number;
  readonly content: AsyncIterable<Uint8Array>;
}

/** The sole provider-neutral business interface for the existing three Owner operations. */
export interface OwnerExportApplicationService {
  requestOwnerExport(
    command: RequestOwnerExportApplicationCommand,
  ): Promise<Result<OwnerExportRequestReceipt, Rejection>>;
  getOwnerExport(
    query: GetOwnerExportQuery,
  ): Promise<Result<OwnerExportView, Rejection>>;
  downloadOwnerExport(
    query: DownloadOwnerExportQuery,
  ): Promise<Result<OwnerExportDownloadView, Rejection>>;
}

export type SnapshotPageLimit = number & { readonly __snapshotPageLimit: unique symbol };
export const MAX_EXPORT_SNAPSHOT_PAGE_SIZE = 250;

export function parseScopedWorkerPurpose(
  value: unknown,
): Result<ScopedWorkerPurpose, Extract<Rejection, { kind: "validation" }>> {
  if (
    typeof value !== "string" ||
    !/^(operations|content|taxonomy|media|cv|interaction|measurement|feedback)\.[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value)
  ) {
    return err({ kind: "validation", code: "OPERATIONS_WORKER_PURPOSE_INVALID" });
  }
  return ok(value as ScopedWorkerPurpose);
}

export function parseSnapshotPageLimit(value: number): Result<SnapshotPageLimit, Extract<Rejection, { kind: "validation" }>> {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_EXPORT_SNAPSHOT_PAGE_SIZE) {
    return err({ kind: "validation", code: "EXPORT_SNAPSHOT_PAGE_SIZE_INVALID" });
  }
  return ok(value as SnapshotPageLimit);
}

export type SnapshotCursor = string & { readonly __snapshotCursor: unique symbol };
export const MAX_EXPORT_SNAPSHOT_CURSOR_LENGTH = 2048;

export function parseSnapshotCursor(
  value: unknown,
): Result<SnapshotCursor, Extract<Rejection, { kind: "validation" }>> {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EXPORT_SNAPSHOT_CURSOR_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
    return err({ kind: "validation", code: "EXPORT_SNAPSHOT_CURSOR_INVALID" });
  }
  return ok(value as SnapshotCursor);
}

export interface OwnerExportSnapshotContext<TScope extends ExportScope = ExportScope> {
  readonly actor: ScopedSystemActor;
  readonly ownerId: StableId<"Owner">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly scope: TScope;
  readonly snapshotAt: string;
  readonly pageSize: SnapshotPageLimit;
  readonly cursor?: SnapshotCursor;
}

type ExportJsonObject = Readonly<Record<string, import("./persistence.js").JsonValue>>;
type AnalyticsExportStep = {
  readonly action: string;
  readonly publicRouteIds?: readonly string[];
  readonly projectIds?: readonly string[];
};
type AnalyticsExportDefinition = { readonly name: string; readonly steps: readonly AnalyticsExportStep[] };
type AnalyticsExportGoal = {
  readonly goalId: string; readonly aggregateVersion: number; readonly activeVersionId: string | null;
  readonly versions: readonly { readonly versionId: string; readonly versionNumber: number; readonly definition: AnalyticsExportDefinition; readonly createdAt: string }[];
  readonly activationHistory: readonly { readonly versionId: string; readonly activatedAt: string }[];
};
type AnalyticsExportReport = {
  readonly goalVersionId: string; readonly periodStart: string; readonly periodEnd: string;
  readonly sampleState: "sufficient" | "low-sample" | "suppressed"; readonly aggregateCount: number;
};
type ExportRecordValueByScope = {
  readonly "portfolio-content": {
    readonly contentId: string; readonly contentType: "project" | "achievement" | "testimonial";
    readonly lifecycle: string; readonly revisions: readonly ExportJsonObject[]; readonly publicRouteIdentity: string | null;
    readonly routeHistory: readonly ExportJsonObject[]; readonly relatedProjectIds: readonly string[];
    readonly taxonomyValueIds: readonly string[]; readonly mediaAssetIds: readonly string[]; readonly evidenceItems: readonly ExportJsonObject[];
  };
  readonly taxonomy: {
    readonly taxonomyId: string; readonly aggregateVersion: number; readonly kind: string;
    readonly values: readonly ExportJsonObject[]; readonly renameHistory: readonly ExportJsonObject[]; readonly assignments: readonly ExportJsonObject[];
  };
  readonly "media-metadata": {
    readonly mediaId: string; readonly kind: string; readonly state: string; readonly accessibilityMetadata: ExportJsonObject | null;
    readonly processingHistory: readonly ExportJsonObject[]; readonly decisionHistory: readonly ExportJsonObject[];
    readonly publicationState: string; readonly portableReference: string;
  };
  readonly "cv-metadata": {
    readonly aggregateVersion: number; readonly currentVersionId: string | null;
    readonly versions: readonly ExportJsonObject[]; readonly activationHistory: readonly ExportJsonObject[];
  };
  readonly "moderation-history": {
    readonly feedbackId: string; readonly projectId: string; readonly locale: string; readonly aggregateVersion: number;
    readonly state: string; readonly authorName: string; readonly paragraph: string; readonly submittedAt: string;
    readonly decisionHistory: readonly ExportJsonObject[];
  };
  readonly "analytics-reports": { readonly goal: AnalyticsExportGoal; readonly reports: readonly AnalyticsExportReport[] };
  readonly "portfolio-configuration": {
    readonly profile: ExportJsonObject; readonly contactChannels: ExportJsonObject; readonly projectCta: ExportJsonObject;
  };
};

export interface OwnerExportRecord<TScope extends ExportScope = ExportScope> {
  readonly scope: TScope;
  readonly value: ExportRecordValueByScope[TScope];
}

export interface OwnerExportSnapshotPage<TScope extends ExportScope = ExportScope> {
  readonly descriptor: OwnerExportEntryDescriptor<TScope>;
  readonly records: readonly OwnerExportRecord<TScope>[];
  readonly nextCursor?: SnapshotCursor;
}

export interface ModuleOwnedSnapshotReader<TScope extends ExportScope> {
  readonly scope: TScope;
  readExportableSnapshot(
    context: OwnerExportSnapshotContext<TScope>,
  ): Promise<Result<OwnerExportSnapshotPage<TScope>, Rejection>>;
}

/** Static scope-to-reader mapping prevents request strings selecting a module. */
export type OwnerExportSnapshotReaders = {
  readonly [TScope in ExportScope]: ModuleOwnedSnapshotReader<TScope>;
};

export function isExportScope(value: unknown): value is ExportScope {
  return typeof value === "string" && (OWNER_EXPORT_SCOPE_SET as ReadonlySet<string>).has(value);
}

const OWNER_EXPORT_SCOPE_SET: ReadonlySet<string> = new Set(OWNER_EXPORT_SCOPES);
const ANALYTICS_ACTIONS = new Set([
  "page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened",
  "contact-channel-opened", "external-project-link-opened", "testimonial-engaged", "global-project-cta-opened",
]);
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key));
}
function isStableIdArray(kind: string, value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && parseStableId(kind, item).ok);
}
function isAnalyticsDefinition(value: unknown): boolean {
  return hasOnlyKeys(value, ["name", "steps"]) && typeof value["name"] === "string" &&
    Array.isArray(value["steps"]) && value["steps"].length > 0 && value["steps"].length <= 10 &&
    value["steps"].every((step) => hasOnlyKeys(step, ["action", "publicRouteIds", "projectIds"]) &&
      typeof step["action"] === "string" && ANALYTICS_ACTIONS.has(step["action"]) &&
      (step["publicRouteIds"] === undefined || isStableIdArray("PublicRoute", step["publicRouteIds"])) &&
      (step["projectIds"] === undefined || isStableIdArray("Project", step["projectIds"])));
}
function isAnalyticsGoal(value: unknown): boolean {
  return hasOnlyKeys(value, ["goalId", "aggregateVersion", "activeVersionId", "versions", "activationHistory"]) &&
    typeof value["goalId"] === "string" && parseStableId("AnalyticsGoal", value["goalId"]).ok &&
    Number.isSafeInteger(value["aggregateVersion"]) &&
    (value["activeVersionId"] === null || (typeof value["activeVersionId"] === "string" && parseStableId("AnalyticsGoalVersion", value["activeVersionId"]).ok)) &&
    Array.isArray(value["versions"]) && value["versions"].length > 0 && value["versions"].every((version) =>
      hasOnlyKeys(version, ["versionId", "versionNumber", "definition", "createdAt"]) &&
      typeof version["versionId"] === "string" && parseStableId("AnalyticsGoalVersion", version["versionId"]).ok &&
      Number.isSafeInteger(version["versionNumber"]) &&
      isAnalyticsDefinition(version["definition"]) && typeof version["createdAt"] === "string") &&
    Array.isArray(value["activationHistory"]) && value["activationHistory"].every((entry) =>
      hasOnlyKeys(entry, ["versionId", "activatedAt"]) && typeof entry["versionId"] === "string" &&
      parseStableId("AnalyticsGoalVersion", entry["versionId"]).ok &&
      typeof entry["activatedAt"] === "string");
}
function isAnalyticsReport(value: unknown): boolean {
  return hasOnlyKeys(value, ["goalVersionId", "periodStart", "periodEnd", "sampleState", "aggregateCount"]) &&
    typeof value["goalVersionId"] === "string" && parseStableId("AnalyticsGoalVersion", value["goalVersionId"]).ok &&
    typeof value["periodStart"] === "string" &&
    typeof value["periodEnd"] === "string" && ["sufficient", "low-sample", "suppressed"].includes(String(value["sampleState"])) &&
    Number.isSafeInteger(value["aggregateCount"]) && Number(value["aggregateCount"]) >= 0;
}
function isSafeAnalyticsExportRecord(value: unknown): boolean {
  return hasOnlyKeys(value, ["goal", "reports"]) && isAnalyticsGoal(value["goal"]) &&
    Array.isArray(value["reports"]) && value["reports"].every(isAnalyticsReport);
}

export function validateOwnerExportSnapshotPage<TScope extends ExportScope>(
  context: OwnerExportSnapshotContext<TScope>,
  page: OwnerExportSnapshotPage<TScope>,
): Result<OwnerExportSnapshotPage<TScope>, Extract<Rejection, { kind: "validation" }>> {
  const expectedSchema = `urn:shipwithali:owner-export-schema:${context.scope}:1.0`;
  if (page === null || typeof page !== "object" || page.descriptor === null || typeof page.descriptor !== "object") {
    return err({ kind: "validation", code: "EXPORT_SNAPSHOT_PAGE_INVALID" });
  }
  const descriptor = page.descriptor;
  const safePath = (value: string) =>
    /^[a-z0-9][a-z0-9._/-]*$/.test(value) &&
    !value.split("/").some((part) => part === "." || part === "..");
  if (
    !Array.isArray(page.records) ||
    descriptor.scope !== context.scope ||
    descriptor.recordSchema !== expectedSchema ||
    descriptor.schemaPath !== `schemas/${context.scope}.schema.json` ||
    descriptor.schemaVersion !== "1.0" ||
    !["application/x-ndjson", "application/json"].includes(descriptor.mediaType) ||
    !safePath(descriptor.path) ||
    !/^[a-f0-9]{64}$/.test(descriptor.digest) ||
    !Number.isSafeInteger(descriptor.recordCount) || descriptor.recordCount < 0 ||
    !parseSnapshotPageLimit(context.pageSize).ok ||
    page.records.length > context.pageSize ||
    descriptor.recordCount !== page.records.length ||
    page.records.some((record) =>
      record === null || typeof record !== "object" || record.scope !== context.scope ||
      (context.scope === "analytics-reports" && !isSafeAnalyticsExportRecord(record.value)),
    ) ||
    (page.nextCursor !== undefined && !parseSnapshotCursor(page.nextCursor).ok)
  ) {
    return err({ kind: "validation", code: "EXPORT_SNAPSHOT_PAGE_INVALID" });
  }
  return ok(page);
}

export async function readOwnerExportSnapshot<TScope extends ExportScope>(
  readers: OwnerExportSnapshotReaders,
  context: OwnerExportSnapshotContext<TScope>,
): Promise<Result<OwnerExportSnapshotPage<TScope>, Rejection>> {
  if (!isExportScope(context.scope)) {
    return err({ kind: "validation", code: "EXPORT_SCOPE_INVALID" });
  }
  if (
    context.actor.kind !== "system" ||
    !parseStableId("Job", context.actor.jobId).ok ||
    !parseScopedWorkerPurpose(context.actor.purpose).ok
  ) {
    return err({ kind: "validation", code: "OPERATIONS_WORKER_PURPOSE_INVALID" });
  }
  const pageSize = parseSnapshotPageLimit(context.pageSize);
  if (!pageSize.ok) return pageSize;
  const reader = readers[context.scope];
  if (reader === undefined || reader.scope !== context.scope) {
    return err({ kind: "temporarily_unavailable", code: "EXPORT_SNAPSHOT_READER_UNAVAILABLE" });
  }
  let result: Result<OwnerExportSnapshotPage<TScope>, Rejection>;
  try {
    result = await reader.readExportableSnapshot(context);
  } catch {
    return err({ kind: "temporarily_unavailable", code: "EXPORT_SNAPSHOT_READER_FAILED" });
  }
  if (!result.ok) return result;
  return validateOwnerExportSnapshotPage(context, result.value);
}

export interface OwnerExportObjectReadRequest {
  readonly portfolioId: StableId<"Portfolio">;
  readonly exportId: StableId<"OwnerExport">;
  readonly artifactId: StableId<"OwnerExportArtifact">;
}

export interface OwnerExportObjectRead {
  readonly contentLength: number;
  readonly sha256: string;
  readonly content: AsyncIterable<Uint8Array>;
}

export const MAX_OWNER_EXPORT_ARTIFACT_BYTES = 25_000_000;

export function validateOwnerExportObjectRead(
  value: OwnerExportObjectRead,
): Result<OwnerExportObjectRead, Extract<Rejection, { kind: "validation" }>> {
  if (
    value === null ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.contentLength) ||
    value.contentLength <= 0 ||
    value.contentLength > MAX_OWNER_EXPORT_ARTIFACT_BYTES ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.content === null ||
    typeof value.content[Symbol.asyncIterator] !== "function"
  ) {
    return err({ kind: "validation", code: "EXPORT_OBJECT_READ_INVALID" });
  }
  return ok(value);
}

/** Provider-neutral seam for bounded private artifact reads. */
export interface OwnerExportObjectReadPort {
  readOwnerExport(input: OwnerExportObjectReadRequest): Promise<Result<OwnerExportObjectRead, Rejection>>;
}

export type ScopedSystemActor = Omit<SystemActor, "purpose"> & { readonly purpose: ScopedWorkerPurpose };

export interface ClaimJobCommand {
  readonly workerId: string;
  readonly purpose: ScopedWorkerPurpose;
  readonly leaseDurationSeconds: number;
  readonly limit: number;
}

export interface CompleteJobCommand {
  readonly actor: ScopedSystemActor;
  readonly leaseToken: string;
  readonly completedAt: string;
}

export interface FailJobCommand {
  readonly actor: ScopedSystemActor;
  readonly leaseToken: string;
  readonly safeErrorCode: SafeErrorCode;
  readonly failedAt: string;
}

export interface OperationsJobApplicationService {
  claimJobs(command: ClaimJobCommand): Promise<Result<readonly LeasedJobRecord[], Rejection>>;
  completeJob(command: CompleteJobCommand): Promise<Result<void, Rejection>>;
  failJob(command: FailJobCommand): Promise<Result<void, Rejection>>;
}

export interface OperationsIncidentObservation {
  readonly incidentId: StableId<"OperationsIncident">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly category: "export" | "outbox" | "retention" | "backup" | "recovery";
  readonly code: SafeErrorCode;
  readonly severity: "info" | "warning" | "critical";
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly occurrences: number;
  readonly resolvedAt?: string;
}

export interface RecoveryObservation {
  readonly rehearsalId: StableId<"RecoveryRehearsal">;
  readonly stage: "backup" | "database-restore" | "object-restore" | "verification" | "cleanup";
  readonly outcome: "started" | "succeeded" | "failed";
  readonly observedAt: string;
  readonly durationMs?: number;
  readonly safeErrorCode?: SafeErrorCode;
}

export interface OperationsObservationPort {
  recordIncident(observation: OperationsIncidentObservation): Promise<void>;
  recordRecovery(observation: RecoveryObservation): Promise<void>;
}
