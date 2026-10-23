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

interface OwnerExportPackageManifestBase {
  readonly packageFormat: "shipwithali-owner-export";
  readonly createdAt: string;
  readonly algorithm: "sha-256";
  readonly digest: string;
  readonly includedScopes: readonly ExportScope[];
  readonly publicEventDataCoverage: { readonly mode: "excluded" };
  readonly entries: readonly OwnerExportEntryDescriptor[];
}

export interface OwnerExportPackageManifestV1_0 extends OwnerExportPackageManifestBase {
  readonly schemaVersion: "1.0";
}

export interface OwnerExportSchemaDescriptor {
  readonly kind: "manifest" | "record";
  readonly path: string;
  readonly scope?: ExportScope;
  readonly schemaUri: string;
  readonly schemaVersion: string;
  readonly digest: string;
}

export interface OwnerExportAssetDescriptor {
  readonly path: string;
  readonly scope: "media-metadata" | "cv-metadata";
  readonly assetId: string;
  readonly mediaType: "application/pdf" | "image/jpeg" | "image/png" | "image/webp" | "video/mp4";
  readonly byteLength: number;
  readonly digest: string;
}

export interface OwnerExportDependencyDescriptor {
  readonly sourceScope: ExportScope;
  readonly sourceId: string;
  readonly targetScope: ExportScope;
  readonly targetId: string;
  readonly disposition: "included" | "omitted";
  readonly reason?: "scope-not-selected" | "not-retained" | "unsupported-variant" | "external-destination";
}

export type OwnerExportRequiredFeature =
  | "asset-integrity-v1"
  | "dependency-coverage-v1"
  | "record-integrity-v1"
  | "schema-integrity-v1"
  | "snapshot-identity-v1";

export interface OwnerExportPackageManifestV1_1 extends OwnerExportPackageManifestBase {
  readonly schemaVersion: "1.1";
  readonly exportId: string;
  readonly snapshot: {
    readonly snapshotId: string;
    readonly capturedAt: string;
    readonly consistency: "transactional";
  };
  readonly requiredFeatures: readonly OwnerExportRequiredFeature[];
  readonly dependencies: readonly OwnerExportDependencyDescriptor[];
  readonly exclusions: readonly (
    | "raw-public-event-data"
    | "functional-visitor-identities"
    | "measurement-visitor-identities"
    | "sessions"
    | "credentials"
    | "lab-entries"
  )[];
  readonly schemas: readonly OwnerExportSchemaDescriptor[];
  readonly assets: readonly OwnerExportAssetDescriptor[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export type OwnerExportPackageManifest = OwnerExportPackageManifestV1_0 | OwnerExportPackageManifestV1_1;

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
type PortableContentRevision = {
  readonly revisionId: string;
  readonly locale: "en" | "ar";
  readonly sequence: number;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly reviewed: boolean;
  readonly currentlyPublished: boolean;
};
type PortableRouteRedirect = { readonly fromSlug: string; readonly toSlug: string };
type ExportRecordValueByScope = {
  readonly "portfolio-content": {
    readonly contentId: string; readonly contentType: "project" | "achievement" | "testimonial";
    readonly lifecycle: "draft" | "published" | "hidden" | "archived"; readonly projectStatus?: string | null; readonly featured?: boolean;
    readonly revisions: readonly PortableContentRevision[]; readonly publicRouteIdentity: string | null;
    readonly routeHistory: readonly PortableRouteRedirect[]; readonly relatedProjectIds: readonly string[];
    readonly taxonomyValueIds: readonly string[]; readonly mediaAssetIds: readonly string[];
    readonly evidenceItems: readonly ExportEvidenceItem[];
  };
  readonly taxonomy: {
    readonly taxonomyId: string; readonly aggregateVersion: number;
    readonly kind: "category" | "ai-ml-domain" | "technology" | "project-type";
    readonly values: readonly ExportTaxonomyValue[]; readonly renameHistory: readonly ExportTaxonomyRename[];
    readonly assignments: readonly ExportTaxonomyAssignment[];
  };
  readonly "media-metadata": {
    readonly mediaId: string; readonly kind: string; readonly state: string; readonly accessibilityMetadata: ExportJsonObject | null;
    readonly processingHistory: readonly ExportJsonObject[]; readonly decisionHistory: readonly ExportJsonObject[];
    readonly processingHistoryTruncated?: boolean; readonly decisionHistoryTruncated?: boolean;
    readonly publicationState: string; readonly portableReference?: string;
  };
  readonly "cv-metadata": {
    readonly aggregateVersion: number; readonly currentVersionId: string | null;
    readonly versionsTruncated?: boolean; readonly activationHistoryTruncated?: boolean;
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

type ExportEvidenceItem = {
  readonly claim: string;
  readonly state: "unreviewed" | "supported" | "unsupported";
  readonly supportingArtifactIds: readonly string[];
  readonly mediaAssetId?: string;
};
type ExportTaxonomyValue =
  | { readonly valueId: string; readonly name: string; readonly state: "active" }
  | { readonly valueId: string; readonly name: string; readonly state: "retired" }
  | { readonly valueId: string; readonly name: string; readonly state: "merged"; readonly mergedIntoId: string };
type ExportTaxonomyRename = {
  readonly valueId: string;
  readonly previousName: string;
  readonly newName: string;
  readonly renamedAt: string;
};
type ExportTaxonomyAssignment = { readonly targetId: string; readonly taxonomyValueId: string };

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
function hasRequiredKeys(value: Record<string, unknown>, required: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key));
}
const PORTABLE_STABLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function isPortableStableId(value: unknown): value is string {
  return typeof value === "string" && PORTABLE_STABLE_ID.test(value);
}
function isBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}
function isUniquePortableIdArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isPortableStableId) && new Set(value).size === value.length;
}
function isPortableContentRevision(value: unknown): boolean {
  return hasOnlyKeys(value, ["revisionId", "locale", "sequence", "title", "summary", "body", "reviewed", "currentlyPublished"]) &&
    hasRequiredKeys(value, ["revisionId", "locale", "sequence", "title", "summary", "body", "reviewed", "currentlyPublished"]) &&
    isPortableStableId(value["revisionId"]) && ["en", "ar"].includes(String(value["locale"])) &&
    Number.isSafeInteger(value["sequence"]) && Number(value["sequence"]) >= 1 &&
    isBoundedString(value["title"], 1, 160) && isBoundedString(value["summary"], 1, 500) &&
    isBoundedString(value["body"], 1, 50_000) && typeof value["reviewed"] === "boolean" &&
    typeof value["currentlyPublished"] === "boolean";
}
function isPortableRouteRedirect(value: unknown): boolean {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  return hasOnlyKeys(value, ["fromSlug", "toSlug"]) && hasRequiredKeys(value, ["fromSlug", "toSlug"]) &&
    typeof value["fromSlug"] === "string" && slug.test(value["fromSlug"]) &&
    typeof value["toSlug"] === "string" && slug.test(value["toSlug"]);
}
function isPortableEvidenceItem(value: unknown): boolean {
  return hasOnlyKeys(value, ["claim", "state", "supportingArtifactIds", "mediaAssetId"]) &&
    hasRequiredKeys(value, ["claim", "state", "supportingArtifactIds"]) &&
    isBoundedString(value["claim"], 1, 1_000) &&
    ["unreviewed", "supported", "unsupported"].includes(String(value["state"])) &&
    isUniquePortableIdArray(value["supportingArtifactIds"]) &&
    (value["mediaAssetId"] === undefined || isPortableStableId(value["mediaAssetId"]));
}
function isSafePortfolioContentExportValue(value: unknown): boolean {
  const keys = ["contentId", "contentType", "lifecycle", "projectStatus", "featured", "revisions", "publicRouteIdentity", "routeHistory", "relatedProjectIds", "taxonomyValueIds", "mediaAssetIds", "evidenceItems"];
  const required = ["contentId", "contentType", "lifecycle", "revisions", "publicRouteIdentity", "routeHistory", "relatedProjectIds", "taxonomyValueIds", "mediaAssetIds", "evidenceItems"];
  return hasOnlyKeys(value, keys) && hasRequiredKeys(value, required) &&
    isPortableStableId(value["contentId"]) && ["project", "achievement", "testimonial"].includes(String(value["contentType"])) &&
    ["draft", "published", "hidden", "archived"].includes(String(value["lifecycle"])) &&
    (value["projectStatus"] === undefined || value["projectStatus"] === null || typeof value["projectStatus"] === "string") &&
    (value["featured"] === undefined || typeof value["featured"] === "boolean") &&
    Array.isArray(value["revisions"]) && value["revisions"].length >= 1 && value["revisions"].every(isPortableContentRevision) &&
    (value["publicRouteIdentity"] === null || isPortableStableId(value["publicRouteIdentity"])) &&
    Array.isArray(value["routeHistory"]) && value["routeHistory"].every(isPortableRouteRedirect) &&
    isUniquePortableIdArray(value["relatedProjectIds"]) && isUniquePortableIdArray(value["taxonomyValueIds"]) &&
    isUniquePortableIdArray(value["mediaAssetIds"]) && Array.isArray(value["evidenceItems"]) && value["evidenceItems"].every(isPortableEvidenceItem);
}
function isPortableTaxonomyValue(value: unknown): boolean {
  if (!isRecord(value) || !isPortableStableId(value["valueId"]) || !isBoundedString(value["name"], 1, 100)) return false;
  if (value["state"] === "active" || value["state"] === "retired") {
    return hasOnlyKeys(value, ["valueId", "name", "state"]) && hasRequiredKeys(value, ["valueId", "name", "state"]);
  }
  return value["state"] === "merged" && hasOnlyKeys(value, ["valueId", "name", "state", "mergedIntoId"]) &&
    hasRequiredKeys(value, ["valueId", "name", "state", "mergedIntoId"]) && isPortableStableId(value["mergedIntoId"]);
}
function isPortableTaxonomyRename(value: unknown): boolean {
  const utcInstant = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
  return hasOnlyKeys(value, ["valueId", "previousName", "newName", "renamedAt"]) &&
    hasRequiredKeys(value, ["valueId", "previousName", "newName", "renamedAt"]) &&
    isPortableStableId(value["valueId"]) && isBoundedString(value["previousName"], 1, 100) &&
    isBoundedString(value["newName"], 1, 100) && typeof value["renamedAt"] === "string" && utcInstant.test(value["renamedAt"]);
}
function isSafeTaxonomyExportValue(value: unknown): boolean {
  return hasOnlyKeys(value, ["taxonomyId", "aggregateVersion", "kind", "values", "renameHistory", "assignments"]) &&
    hasRequiredKeys(value, ["taxonomyId", "aggregateVersion", "kind", "values", "renameHistory", "assignments"]) &&
    isPortableStableId(value["taxonomyId"]) && Number.isSafeInteger(value["aggregateVersion"]) && Number(value["aggregateVersion"]) >= 1 &&
    ["category", "ai-ml-domain", "technology", "project-type"].includes(String(value["kind"])) &&
    Array.isArray(value["values"]) && value["values"].every(isPortableTaxonomyValue) &&
    Array.isArray(value["renameHistory"]) && value["renameHistory"].every(isPortableTaxonomyRename) &&
    Array.isArray(value["assignments"]) && value["assignments"].every((assignment) =>
      hasOnlyKeys(assignment, ["targetId", "taxonomyValueId"]) && hasRequiredKeys(assignment, ["targetId", "taxonomyValueId"]) &&
      isPortableStableId(assignment["targetId"]) && isPortableStableId(assignment["taxonomyValueId"]));
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
      !hasOnlyKeys(record, ["scope", "value"]) || record["scope"] !== context.scope ||
      (context.scope === "portfolio-content" && !isSafePortfolioContentExportValue(record["value"])) ||
      (context.scope === "taxonomy" && !isSafeTaxonomyExportValue(record["value"])) ||
      (context.scope === "analytics-reports" && !isSafeAnalyticsExportRecord(record["value"])),
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
