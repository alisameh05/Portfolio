/**
 * owner-export.ts — Phase 2 #32 Owner export HTTP adapter.
 *
 * Thin handwritten adapter for the three Owner Portability operations:
 * `POST /api/owner/v1/exports`,
 * `GET /api/owner/v1/exports/{exportId}`, and
 * `GET /api/owner/v1/exports/{exportId}/download`.
 *
 * Ordered behavior per operation: establish request context; validate every
 * declared path, header, and body input with the generated strict
 * validators (including the Idempotency-Key header where required);
 * construct one operation-specific command or query; call one injected
 * application interface once; validate and serialize the declared response;
 * complete request logging.
 *
 * The download operation exercises only the declared response shape: the
 * injected fake supplies an in-memory package payload with its versioned
 * filename and export schema version, and the adapter returns it as the
 * declared `application/vnd.shipwithali.owner-export+zip` binary response
 * with `Content-Disposition` and `X-ShipWithAli-Export-Schema-Version`
 * headers. The adapter never accesses storage and never emits signed URLs;
 * export generation, storage, delivery, retention, identity, and
 * authorization behavior remain later-phase work behind provider-neutral
 * application interfaces.
 *
 * The Owner actor is a deterministic Phase 2 placeholder. Real Supabase
 * session, cookie, and Owner allowlist enforcement remain Phase 4 work;
 * unauthenticated and forbidden translation is exercised through fakes.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, storage, or provider types.
 */

import {
  zDownloadOwnerExportPath,
  zGetOwnerExportPath,
  zGetOwnerExportResponse,
  zRequestOwnerExportBody,
  zRequestOwnerExportHeaders,
  zRequestOwnerExportResponse,
} from "../../contracts/http/owner/v1/generated/zod.gen.js";
import type {
  ActorContext,
  IdempotencyKey,
  Rejection,
  Result,
  StableId,
} from "../../shared/domain/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

// ── Provider-neutral application seam ─────────────────────────────────────────

export type OwnerExportScope =
  | "portfolio-content"
  | "taxonomy"
  | "media-metadata"
  | "cv-metadata"
  | "moderation-history"
  | "analytics-reports"
  | "portfolio-configuration";

export interface RequestOwnerExportApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly includedScopes: ReadonlyArray<OwnerExportScope>;
}

export interface GetOwnerExportQuery {
  readonly actor: ActorContext;
  readonly exportId: StableId<string>;
}

export interface DownloadOwnerExportQuery {
  readonly actor: ActorContext;
  readonly exportId: StableId<string>;
}

export interface OwnerExportRequestReceipt {
  readonly exportId: StableId<string>;
  readonly outcome: "owner-export-requested";
  readonly state: "requested";
}

export interface RequestedOwnerExportView {
  readonly exportId: StableId<string>;
  readonly state: "requested";
  readonly schemaVersion: string;
  readonly requestedAt: string;
  readonly includedScopes: ReadonlyArray<OwnerExportScope>;
  readonly publicEventDataCoverage: { readonly mode: "excluded" };
  readonly downloadAvailable: false;
}

export type OwnerExportView = RequestedOwnerExportView;

/**
 * Provider-neutral download payload.
 *
 * The package content is an in-memory byte sequence supplied by the
 * application fake; the adapter never touches storage and never produces
 * signed URLs. `schemaVersion` follows the documented package-schema
 * version pattern and `filename` is a safe attachment name.
 */
export interface OwnerExportDownloadView {
  readonly exportId: StableId<string>;
  readonly schemaVersion: string;
  readonly filename: string;
  readonly content: Uint8Array;
}

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

export interface OwnerExportAdapterDeps {
  service: OwnerExportApplicationService;
  logger?: Logger;
}

export const OWNER_EXPORT_MEDIA_TYPE = "application/vnd.shipwithali.owner-export+zip";

const PHASE2_OWNER_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0";
const SCHEMA_VERSION_PATTERN = /^[1-9][0-9]*\.[0-9]+$/;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;
const MAX_DOWNLOAD_BYTES = 25_000_000;

function ownerActor(): ActorContext {
  return {
    kind: "owner",
    ownerId: PHASE2_OWNER_ID as StableId<"Owner">,
    sessionId: "phase2-owner-session",
  };
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "exports", "{exportId}"].join("/");
  }
}

async function readJsonBody(request: Request): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }
> {
  try {
    return { ok: true, value: (await request.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

function reject(
  logger: Logger | undefined,
  traceId: string,
  instance: string,
  detail: string,
): Response {
  logger?.warn("request.rejected", { traceId, status: 400 });
  return transportProblem(detail, traceId, instance);
}

function toRejection(
  error: Rejection,
  traceId: string,
  instance: string,
  logger: Logger | undefined,
): Response {
  const rejection = rejectionToProblem(error, traceId, instance);
  logger?.warn("request.rejected", {
    traceId,
    status: rejection.status,
    code: error.code,
  });
  return rejection;
}

export async function handleRequestOwnerExport(
  request: Request,
  deps: OwnerExportAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const headersResult = zRequestOwnerExportHeaders.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
    });
    if (!headersResult.success) {
      return reject(logger, traceId, instance, "Missing or invalid idempotency header.");
    }
    const raw = await readJsonBody(request);
    if (!raw.ok) {
      return reject(logger, traceId, instance, "Malformed JSON body.");
    }
    const bodyResult = zRequestOwnerExportBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const body = bodyResult.data as { includedScopes: OwnerExportScope[] };
    const command: RequestOwnerExportApplicationCommand = {
      actor: ownerActor(),
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      includedScopes: [...body.includedScopes],
    };
    let result: Awaited<ReturnType<typeof deps.service.requestOwnerExport>>;
    try {
      result = await deps.service.requestOwnerExport(command);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      exportId: result.value.exportId,
      outcome: result.value.outcome,
      state: result.value.state,
    };
    const parsed = zRequestOwnerExportResponse.safeParse(payload);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 202 });
    return Response.json(parsed.data, { status: 202 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleGetOwnerExport(
  request: Request,
  params: { exportId: string },
  deps: OwnerExportAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const pathResult = zGetOwnerExportPath.safeParse({
      exportId: params.exportId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const query: GetOwnerExportQuery = {
      actor: ownerActor(),
      exportId: pathResult.data.exportId as StableId<string>,
    };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerExport>>;
    try {
      result = await deps.service.getOwnerExport(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      exportId: result.value.exportId,
      state: result.value.state,
      schemaVersion: result.value.schemaVersion,
      requestedAt: result.value.requestedAt,
      includedScopes: [...result.value.includedScopes],
      publicEventDataCoverage: { mode: result.value.publicEventDataCoverage.mode },
      downloadAvailable: result.value.downloadAvailable,
    };
    const parsed = zGetOwnerExportResponse.safeParse(payload);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(parsed.data, { status: 200 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

function isValidDownloadView(
  value: OwnerExportDownloadView,
  exportId: StableId<string>,
): boolean {
  if (value.exportId !== exportId) {
    return false;
  }
  if (!SCHEMA_VERSION_PATTERN.test(value.schemaVersion)) {
    return false;
  }
  if (!FILENAME_PATTERN.test(value.filename)) {
    return false;
  }
  if (!(value.content instanceof Uint8Array)) {
    return false;
  }
  if (value.content.byteLength === 0 || value.content.byteLength > MAX_DOWNLOAD_BYTES) {
    return false;
  }
  return true;
}

export async function handleDownloadOwnerExport(
  request: Request,
  params: { exportId: string },
  deps: OwnerExportAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const pathResult = zDownloadOwnerExportPath.safeParse({
      exportId: params.exportId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const exportId = pathResult.data.exportId as StableId<string>;
    const query: DownloadOwnerExportQuery = {
      actor: ownerActor(),
      exportId,
    };
    let result: Awaited<ReturnType<typeof deps.service.downloadOwnerExport>>;
    try {
      result = await deps.service.downloadOwnerExport(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    // The generated binary schema carries no structural validator, so the
    // adapter enforces the declared shape (versioned filename, schema
    // version, non-empty in-memory payload) before emitting the response.
    // An invalid fake result fails safely instead of emitting an
    // undeclared payload.
    if (!isValidDownloadView(result.value, exportId)) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 200 });
    const payload = result.value.content.slice();
    return new Response(payload, {
      status: 200,
      headers: {
        "content-type": OWNER_EXPORT_MEDIA_TYPE,
        "content-disposition": `attachment; filename="${result.value.filename}"`,
        "x-shipwithali-export-schema-version": result.value.schemaVersion,
      },
    });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}
