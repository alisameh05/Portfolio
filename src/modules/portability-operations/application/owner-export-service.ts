/**
 * owner-export-service.ts — Phase 8 #238 request and inspect implementation.
 *
 * The provider-neutral implementation behind the three existing Owner export
 * operations. `requestOwnerExport` reserves one idempotency receipt, one
 * durable export row, and exactly one shared-queue assembly job inside one
 * transaction; any failure rolls the whole reservation back (AC05). Exact and
 * concurrent retries replay the original requested receipt — the envelope is
 * written once and never repointed — while a changed request meaning under the
 * same key conflicts without durable effects (AC03, AC04).
 *
 * Scope selection accepts every nonempty unique subset of the seven
 * documented domains. Order is normalized to the declared canonical order
 * before hashing, so any permutation of one selection carries identical
 * canonical meaning (AC01). Unknown, duplicate, or empty selections, malformed
 * identities, and invalid idempotency keys are rejected before durable
 * effects (AC02).
 *
 * `getOwnerExport` builds the truthful five-state view from only what is
 * persisted: timestamps, schema version, scopes, safe causes, and download
 * availability (AC07). A missing resource, including one owned by another
 * Owner or Portfolio, surfaces uniformly as `not_found` so protected
 * existence is never revealed. Uppercase persistence machine codes map
 * explicitly to the accepted lowercase transport code at this boundary.
 *
 * `downloadOwnerExport` stays bounded by the provider-neutral artifact read
 * seam: only a `ready` export with its artifact resolves a byte stream. No
 * selected scope is ever represented as a completed package before the module
 * assembly worker's own guarded completion applies.
 *
 * Worker transitions are an explicit seam: local validation accepts only the
 * declared lifecycle edges with exactly their required metadata, and the
 * guarded store application decides whether a attempt still wins (stale or
 * impossible transitions never win; AC07).
 */

import type {
  OwnerActor,
  Rejection,
  Result,
  StableId,
} from "@shared/domain";
import { err, ok, parseIdempotencyKey, parseStableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { Clock, StableIdGenerator } from "../../../runtime/ports.js";
import type { ExportStatus, ExportScope } from "../domain/index.js";
import { OWNER_EXPORT_SCOPES } from "../domain/index.js";
import type {
  DownloadOwnerExportQuery,
  GetOwnerExportQuery,
  OwnerExportApplicationService,
  OwnerExportAuthorizationContext,
  OwnerExportDownloadView,
  OwnerExportPackageManifest,
  OwnerExportRequestReceipt,
  OwnerExportView,
  RequestOwnerExportApplicationCommand,
} from "./service.js";
import { validateOwnerExportObjectRead } from "./service.js";
import type {
  OperationsPersistencePorts,
  SafeErrorCode,
} from "./persistence.js";
import { parseSafeErrorCode } from "./persistence.js";
import type {
  OwnerExportStorePort,
  OwnerExportTransitionInput,
  PersistedOwnerExport,
} from "./owner-export-store.js";
import type { OwnerExportObjectReadPort } from "./service.js";

export const OWNER_EXPORT_SCHEMA_VERSION = "1.1";
function artifactFilename(schemaVersion: string): string {
  return `shipwithali-owner-export-${schemaVersion}.zip`;
}
export const OWNER_EXPORT_ARTIFACT_FILENAME = artifactFilename(OWNER_EXPORT_SCHEMA_VERSION);
/** Purpose-limited receipt lifetime: exact replay stays addressable for 30 days. */
export const OWNER_EXPORT_RECEIPT_TTL_SECONDS = 30 * 86400;
const REQUEST_OPERATION_SCOPE = "portability.owner-export-request";
const ASSEMBLY_JOB_TYPE = "portability.owner-export-assembly.v1";

const EXPORT_STATUS_VALUES: readonly ExportStatus[] = [
  "requested", "building", "ready", "failed", "expired",
];

function requireOwner(
  context: OwnerExportAuthorizationContext,
): Result<OwnerActor, Rejection> {
  if (context.actor.kind !== "owner") {
    return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
  }
  return ok(context.actor);
}

function rejectionForPersistence(): Rejection {
  return { kind: "temporarily_unavailable", code: "OWNER_EXPORT_PERSISTENCE_UNAVAILABLE" };
}

/**
 * Canonical meaning of one scope selection: sorted into the declared owner
 * export scope order before any identity or hash. Input validation rejects
 * non-arrays, unknown scopes, duplicates, and empty selections first.
 */
export function canonicalizeOwnerExportScopes(
  input: readonly unknown[],
): Result<ExportScope[], Extract<Rejection, { kind: "validation" }>> {
  if (!Array.isArray(input)) {
    return err({ kind: "validation", code: "OWNER_EXPORT_SCOPES_INVALID" });
  }
  const seen = new Set<string>();
  for (const scope of input) {
    if (typeof scope !== "string" || !(OWNER_EXPORT_SCOPES as readonly string[]).includes(scope)) {
      return err({ kind: "validation", code: "OWNER_EXPORT_SCOPE_UNKNOWN" });
    }
    if (seen.has(scope)) {
      return err({ kind: "validation", code: "OWNER_EXPORT_SCOPE_DUPLICATE" });
    }
    seen.add(scope);
  }
  if (seen.size === 0) {
    return err({ kind: "validation", code: "OWNER_EXPORT_SCOPES_EMPTY" });
  }
  const canonical = OWNER_EXPORT_SCOPES.filter((scope) => seen.has(scope));
  return ok([...canonical] as ExportScope[]);
}

/** The runtime ID adapter produces canonical UUIDv7 identities; a violation is a hard fault. */
function generatedStableId<TKind extends "OwnerExport" | "Job">(
  kind: TKind,
  value: string,
): StableId<TKind> {
  const parsed = parseStableId(kind, value);
  if (!parsed.ok) throw new Error("GENERATED_IDENTITY_FAILURE");
  return parsed.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseReplayEnvelope(value: { readonly [key: string]: unknown }): OwnerExportRequestReceipt | undefined {
  const exportIdResult = value["exportId"];
  if (typeof exportIdResult !== "string") return undefined;
  const parsedExportId = parseStableId("OwnerExport", exportIdResult);
  if (!parsedExportId.ok) return undefined;
  if (value["outcome"] !== "owner-export-requested" || value["state"] !== "requested") return undefined;
  return {
    exportId: parsedExportId.value,
    outcome: "owner-export-requested",
    state: "requested",
  };
}

/** Explicit uppercase → lowercase transport mapping; persistence codes stay machine codes. */
export function transportFailureCode(failureCode: string): string {
  let parsed: SafeErrorCode;
  try {
    parsed = parseSafeErrorCode(failureCode);
  } catch {
    throw new Error("Persisted export failure code is unsafe for transport.");
  }
  const lowercase = parsed.toLowerCase();
  if (!/^[a-z0-9_]{1,64}$/.test(lowercase)) {
    throw new Error("Persisted export failure code is unsafe for transport.");
  }
  return lowercase;
}

export interface OwnerExportServiceDependencies {
  readonly operations: OperationsPersistencePorts;
  readonly exports: OwnerExportStorePort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
  /** Optional bounded private artifact read seam for the download operation. */
  readonly objectRead?: OwnerExportObjectReadPort;
}

export function createOwnerExportService(
  dependencies: OwnerExportServiceDependencies,
): OwnerExportApplicationService {
  const { operations, exports: exportStore, clock, ids, objectRead } = dependencies;

  async function loadOwnedExport(
    input: {
      readonly exportId: StableId<"OwnerExport">;
      readonly portfolioId: StableId<"Portfolio">;
      readonly ownerId: StableId<"Owner">;
    },
  ): Promise<PersistedOwnerExport | null> {
    return exportStore.findOwnerExport(input);
  }

  async function requestOwnerExport(
    command: RequestOwnerExportApplicationCommand,
  ): Promise<Result<OwnerExportRequestReceipt, Rejection>> {
    const actor = requireOwner(command);
    if (!actor.ok) return actor;
    const scopes = canonicalizeOwnerExportScopes(command.includedScopes);
    if (!scopes.ok) return scopes;
    if (!parseStableId("Owner", command.actor.ownerId).ok || !parseStableId("Portfolio", command.portfolioId).ok) {
      return err({ kind: "validation", code: "OWNER_EXPORT_IDENTITY_INVALID" });
    }
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    if (!idempotencyKey.ok) return idempotencyKey;
    const requestHash = await hashCanonicalRequest({
      operation: "owner-export-request",
      schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
      includedScopes: scopes.value,
    });
    const actorScope = await hashCanonicalRequest({
      purpose: "owner_export_requests",
      ownerId: command.actor.ownerId,
      portfolioId: command.portfolioId,
    });
    let execution;
    try {
      execution = await operations.idempotency.execute(
        {
          operationScope: `${REQUEST_OPERATION_SCOPE}:${command.portfolioId}`,
          actorScope,
          key: idempotencyKey.value,
          requestHash,
          expiresAt: new Date(
            Date.parse(clock.now()) + OWNER_EXPORT_RECEIPT_TTL_SECONDS * 1000,
          ).toISOString(),
        },
        async (context) => {
          const exportId = generatedStableId("OwnerExport", ids.generate("OwnerExport"));
          const requestedAt = clock.now();
          const jobId = generatedStableId("Job", ids.generate("Job"));
          await exportStore.reserveOwnerExport({
            exportId,
            portfolioId: command.portfolioId,
            ownerId: command.actor.ownerId,
            includedScopes: scopes.value,
            schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
            requestedAt,
          }, context);
          await operations.jobs.enqueue(context, {
            jobId,
            payload: {
              type: ASSEMBLY_JOB_TYPE,
              version: 1,
              value: {
                exportId,
                portfolioId: command.portfolioId,
                ownerId: command.actor.ownerId,
                includedScopes: [...scopes.value],
              },
            },
            availableAt: requestedAt,
          });
          return {
            exportId,
            outcome: "owner-export-requested",
            state: "requested",
            schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
            requestedAt,
          };
        },
      );
    } catch {
      return { ok: false, error: rejectionForPersistence() };
    }
    if (execution.kind === "conflict") {
      return { ok: false, error: { kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" } };
    }
    const receipt = parseReplayEnvelope(execution.result);
    if (receipt === undefined) {
      return { ok: false, error: rejectionForPersistence() };
    }
    return ok(receipt);
  }

  function viewForRecord(record: PersistedOwnerExport): Result<OwnerExportView, Rejection> {
    const base = {
      exportId: record.exportId,
      schemaVersion: record.schemaVersion,
      requestedAt: record.requestedAt,
      includedScopes: [...record.includedScopes],
      publicEventDataCoverage: { mode: "excluded" } as const,
    };
    switch (record.status) {
      case "requested":
      case "building": {
        return ok({ ...base, state: record.status, downloadAvailable: false });
      }
      case "ready": {
        if (record.completedAt === undefined || record.integrityManifest === undefined) {
          return { ok: false, error: rejectionForPersistence() };
        }
        return ok({
          ...base,
          state: "ready",
          completedAt: record.completedAt,
          integrityManifest: record.integrityManifest,
          downloadAvailable: true,
        });
      }
      case "failed": {
        if (record.failedAt === undefined || record.failureCode === undefined) {
          return { ok: false, error: rejectionForPersistence() };
        }
        return ok({
          ...base,
          state: "failed",
          failedAt: record.failedAt,
          failureCode: transportFailureCode(record.failureCode),
          downloadAvailable: false,
        });
      }
      case "expired": {
        if (record.completedAt === undefined || record.expiredAt === undefined ||
            record.integrityManifest === undefined) {
          return { ok: false, error: rejectionForPersistence() };
        }
        return ok({
          ...base,
          state: "expired",
          completedAt: record.completedAt,
          expiredAt: record.expiredAt,
          integrityManifest: record.integrityManifest,
          downloadAvailable: false,
        });
      }
      default: {
        return { ok: false, error: rejectionForPersistence() };
      }
    }
  }

  async function ownerExportView(
    query: GetOwnerExportQuery,
  ): Promise<Result<OwnerExportView, Rejection>> {
    const actor = requireOwner(query);
    if (!actor.ok) return actor;
    if (!parseStableId("Owner", query.actor.ownerId).ok || !parseStableId("Portfolio", query.portfolioId).ok) {
      return err({ kind: "validation", code: "OWNER_EXPORT_IDENTITY_INVALID" });
    }
    let record;
    try {
      record = await loadOwnedExport({
        exportId: query.exportId,
        portfolioId: query.portfolioId,
        ownerId: query.actor.ownerId,
      });
    } catch {
      return { ok: false, error: rejectionForPersistence() };
    }
    if (record === undefined || record === null) {
      return { ok: false, error: { kind: "not_found", code: "OWNER_EXPORT_NOT_FOUND" } };
    }
    return viewForRecord(record);
  }

  async function downloadOwnerExport(
    query: DownloadOwnerExportQuery,
  ): Promise<Result<OwnerExportDownloadView, Rejection>> {
    const actor = requireOwner(query);
    if (!actor.ok) return actor;
    let record;
    try {
      record = await loadOwnedExport({
        exportId: query.exportId,
        portfolioId: query.portfolioId,
        ownerId: query.actor.ownerId,
      });
    } catch {
      return { ok: false, error: rejectionForPersistence() };
    }
    if (record === undefined || record === null) {
      return { ok: false, error: { kind: "not_found", code: "OWNER_EXPORT_NOT_FOUND" } };
    }
    if (record.status !== "ready" || record.artifactId === undefined) {
      const code = record.status === "expired"
        ? "OWNER_EXPORT_DOWNLOAD_EXPIRED"
        : "OWNER_EXPORT_NOT_READY";
      return { ok: false, error: { kind: "conflict", code } };
    }
    if (objectRead === undefined) {
      return { ok: false, error: { kind: "temporarily_unavailable", code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
    }
    try {
      const read = await objectRead.readOwnerExport({
        portfolioId: query.portfolioId,
        exportId: query.exportId,
        artifactId: record.artifactId,
      });
      if (!read.ok) return read;
      const validated = validateOwnerExportObjectRead(read.value);
      if (!validated.ok) return validated;
      return ok({
        exportId: query.exportId,
        schemaVersion: record.schemaVersion,
        filename: artifactFilename(record.schemaVersion),
        contentLength: validated.value.contentLength,
        content: validated.value.content,
      });
    } catch {
      return { ok: false, error: { kind: "temporarily_unavailable", code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
    }
  }

  return { requestOwnerExport, getOwnerExport: ownerExportView, downloadOwnerExport };
}

// ── Guarded worker transitions ────────────────────────────────────────────────

export const OWNER_EXPORT_EDGES: Record<ExportStatus, readonly ExportStatus[]> = {
  requested: ["building", "failed"],
  building: ["ready", "failed"],
  ready: ["expired"],
  failed: [],
  expired: [],
};

const TRANSITION_METADATA: Record<ExportStatus, readonly ("failureCode" | "integrityManifest" | "artifactId")[]> = {
  requested: [],
  building: [],
  ready: ["integrityManifest", "artifactId"],
  failed: ["failureCode"],
  expired: ["integrityManifest", "artifactId"],
};

export function isManifestShape(value: unknown): value is OwnerExportPackageManifest {
  if (!isRecord(value)) return false;
  const scopes = value["includedScopes"];
  const entries = value["entries"];
  const commonShape = (
    value["packageFormat"] === "shipwithali-owner-export" &&
    ["1.0", OWNER_EXPORT_SCHEMA_VERSION].includes(value["schemaVersion"] as string) &&
    typeof value["createdAt"] === "string" &&
    Number.isFinite(Date.parse(value["createdAt"] as string)) &&
    value["algorithm"] === "sha-256" &&
    typeof value["digest"] === "string" && /^[a-f0-9]{64}$/.test(value["digest"]) &&
    Array.isArray(scopes) && scopes.length >= 1 &&
    scopes.every((scope) => (OWNER_EXPORT_SCOPES as readonly string[]).includes(scope as string)) &&
    new Set(scopes as string[]).size === (scopes as unknown[]).length &&
    Array.isArray(entries) && entries.length >= 1 &&
    entries.every((entry) =>
      isRecord(entry) &&
      typeof entry["path"] === "string" &&
      (OWNER_EXPORT_SCOPES as readonly string[]).includes(entry["scope"] as string) &&
      ["application/x-ndjson", "application/json"].includes(entry["mediaType"] as string) &&
      typeof entry["recordSchema"] === "string" &&
      entry["recordSchema"] === `urn:shipwithali:owner-export-schema:${String(entry["scope"])}:1.0` &&
      entry["schemaPath"] === `schemas/${String(entry["scope"])}.schema.json` &&
      entry["schemaVersion"] === "1.0" &&
      typeof entry["digest"] === "string" && /^[a-f0-9]{64}$/.test(entry["digest"] as string) &&
      Number.isSafeInteger(entry["recordCount"]) && (entry["recordCount"] as number) >= 0)
  );
  if (!commonShape) return false;
  if (value["schemaVersion"] === "1.0") return true;

  const requiredFeatures = [
    "asset-integrity-v1",
    "dependency-coverage-v1",
    "record-integrity-v1",
    "schema-integrity-v1",
    "snapshot-identity-v1",
  ];
  const declaredRequiredFeatures = value["requiredFeatures"];
  const snapshot = value["snapshot"];
  const stableId = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  return (
    value["schemaVersion"] === OWNER_EXPORT_SCHEMA_VERSION &&
    typeof value["exportId"] === "string" && stableId.test(value["exportId"]) &&
    isRecord(snapshot) && typeof snapshot["snapshotId"] === "string" && stableId.test(snapshot["snapshotId"]) &&
    typeof snapshot["capturedAt"] === "string" && Number.isFinite(Date.parse(snapshot["capturedAt"])) &&
    snapshot["consistency"] === "transactional" &&
    Array.isArray(declaredRequiredFeatures) && requiredFeatures.every((feature) => declaredRequiredFeatures.includes(feature)) &&
    declaredRequiredFeatures.length === requiredFeatures.length &&
    Array.isArray(value["dependencies"]) && Array.isArray(value["exclusions"]) &&
    Array.isArray(value["schemas"]) && Array.isArray(value["assets"])
  );
}

/** Validates only the declared edges and exactly their required metadata. */
export function validateOwnerExportTransition(
  input: OwnerExportTransitionInput,
): Result<void, Extract<Rejection, { kind: "validation" }>> {
  if (
    !EXPORT_STATUS_VALUES.includes(input.fromStatus) ||
    !EXPORT_STATUS_VALUES.includes(input.toStatus)
  ) {
    return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_UNKNOWN_STATE" });
  }
  if (!(OWNER_EXPORT_EDGES[input.fromStatus] ?? []).includes(input.toStatus)) {    return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_IMPOSSIBLE" });
  }
  if (!Number.isSafeInteger(input.expectedAggregateVersion) || input.expectedAggregateVersion < 1) {
    return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_VERSION_INVALID" });
  }
  if (!Number.isFinite(Date.parse(input.transitionedAt))) {
    return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_INSTANT_INVALID" });
  }
  if (!parseStableId("Job", input.actingJobId).ok) {
    return err({ kind: "validation", code: "OPERATIONS_WORKER_PURPOSE_INVALID" });
  }
  const required = TRANSITION_METADATA[input.toStatus] ?? [];
  for (const field of ["failureCode", "integrityManifest", "artifactId"] as const) {
    if (required.includes(field) && input[field] === undefined) {
      return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_METADATA_MISSING" });
    }
    if (!required.includes(field) && input[field] !== undefined) {
      return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_METADATA_UNEXPECTED" });
    }
  }
  if (
    input.failureCode !== undefined &&
    !(input.failureCode.length >= 1 && input.failureCode.length <= 64 && /^[A-Z][A-Z0-9_]*$/.test(input.failureCode))
  ) {
    return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_FAILURE_CODE_INVALID" });
  }
  if (input.integrityManifest !== undefined && !isManifestShape(input.integrityManifest)) {
    return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_MANIFEST_INVALID" });
  }
  if (input.artifactId !== undefined && !parseStableId("OwnerExportArtifact", input.artifactId).ok) {
    return err({ kind: "validation", code: "OWNER_EXPORT_TRANSITION_ARTIFACT_INVALID" });
  }
  return ok(undefined);
}

/** Worker dispatch: validates the declared edge locally, then applies the guarded store transition. */
export async function applyGuardedOwnerExportTransition(
  store: Pick<OwnerExportStorePort, "applyOwnerExportTransition">,
  input: OwnerExportTransitionInput,
): Promise<Result<"applied" | "stale", Rejection>> {
  const validated = validateOwnerExportTransition(input);
  if (!validated.ok) return validated;
  const applied = await store.applyOwnerExportTransition(input);
  if (!applied.ok) return applied;
  return ok(applied.value.kind);
}
