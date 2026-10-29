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
 * The download operation consumes a bounded provider-neutral byte stream
 * with its versioned filename and schema version, and the adapter returns it
 * as the declared `application/vnd.shipwithali.owner-export+zip` binary
 * response with `Content-Disposition` and
 * `X-ShipWithAli-Export-Schema-Version` headers. The adapter never accesses
 * storage and never emits signed URLs;
 * export generation, storage, delivery, retention, identity, and
 * authorization behavior remain later-phase work behind provider-neutral
 * application interfaces.
 *
 * The Owner actor is resolved through the shared Phase 4 verified-actor
 * boundary (`./owner-security.js`): every operation requires a verified
 * Owner session, owner-scoped authorization, and (for the request mutation)
 * exact origin plus CSRF proof before dispatch. Unauthenticated and
 * forbidden translation is exercised through fakes.
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
import { parseStableId } from "../../shared/domain/index.js";
import { MAX_OWNER_EXPORT_ARTIFACT_BYTES } from "../../modules/portability-operations/index.js";
import type {
  DownloadOwnerExportQuery,
  ExportScope,
  GetOwnerExportQuery,
  OwnerExportApplicationService,
  OwnerExportAuthorizationContext,
  OwnerExportDownloadView,
  RequestOwnerExportApplicationCommand,
} from "../../modules/portability-operations/index.js";
import { emitOperationsSignal, type OperationsObservationPort } from "../../modules/portability-operations/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import {
  guardOwnerRequest,
  OWNER_PRIVATE_RESPONSE_HEADERS,
  type OwnerRequestSecurity,
} from "./owner-security.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

export interface OwnerExportAdapterDeps {
  service: OwnerExportApplicationService;
  security: OwnerRequestSecurity;
  portfolioId: StableId<"Portfolio">;
  logger?: Logger;
  operationsObservations?: Pick<OperationsObservationPort, "recordSignal">;
}

export const OWNER_EXPORT_MEDIA_TYPE = "application/vnd.shipwithali.owner-export+zip";
const SCHEMA_VERSION_PATTERN = /^[1-9][0-9]*\.[0-9]+$/;
const FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;

function ownerAuthorizationContext(
  actor: ActorContext,
  portfolioId: StableId<"Portfolio">,
): OwnerExportAuthorizationContext | undefined {
  return actor.kind === "owner" ? { actor, portfolioId } : undefined;
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

async function handleRequestOwnerExportUnobserved(
  request: Request,
  deps: OwnerExportAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "requestOwnerExport",
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const authorization = ownerAuthorizationContext(guard.actor, deps.portfolioId);
    if (authorization === undefined) {
      return toRejection({ kind: "forbidden", code: "OWNER_REQUIRED" }, traceId, instance, logger);
    }
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
    const body = bodyResult.data as { includedScopes: ExportScope[] };
    const command: RequestOwnerExportApplicationCommand = {
      ...authorization,
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
    const parsed = zRequestOwnerExportResponse.safeParse(result.value);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 202 });
    return Response.json(parsed.data, { status: 202, headers: OWNER_PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

async function handleGetOwnerExportUnobserved(
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
    const guard = await guardOwnerRequest(request, {
      operation: "getOwnerExport",
      mode: "read",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const authorization = ownerAuthorizationContext(guard.actor, deps.portfolioId);
    if (authorization === undefined) {
      return toRejection({ kind: "forbidden", code: "OWNER_REQUIRED" }, traceId, instance, logger);
    }
    const pathResult = zGetOwnerExportPath.safeParse({
      exportId: params.exportId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const exportId = parseStableId("OwnerExport", pathResult.data.exportId);
    if (!exportId.ok) return reject(logger, traceId, instance, "Invalid path parameters.");
    const query: GetOwnerExportQuery = { ...authorization, exportId: exportId.value };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerExport>>;
    try {
      result = await deps.service.getOwnerExport(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const parsed = zGetOwnerExportResponse.safeParse(result.value);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(parsed.data, { status: 200, headers: OWNER_PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

function isValidDownloadView(
  value: OwnerExportDownloadView,
  exportId: StableId<"OwnerExport">,
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
  if (!Number.isSafeInteger(value.contentLength) || value.contentLength <= 0 || value.contentLength > MAX_OWNER_EXPORT_ARTIFACT_BYTES) {
    return false;
  }
  if (value.content === null || typeof value.content[Symbol.asyncIterator] !== "function") {
    return false;
  }
  return true;
}

function createBoundedDownloadStream(
  content: AsyncIterable<Uint8Array>,
  expectedLength: number,
): ReadableStream<Uint8Array> {
  const iterator = content[Symbol.asyncIterator]();
  let observedLength = 0;
  const safeStreamError = () => new Error("Owner export download failed.");
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await iterator.next();
        if (item.done) {
          if (observedLength !== expectedLength) {
            controller.error(safeStreamError());
            return;
          }
          controller.close();
          return;
        }
        if (!(item.value instanceof Uint8Array) || observedLength + item.value.byteLength > expectedLength) {
          controller.error(safeStreamError());
          return;
        }
        observedLength += item.value.byteLength;
        controller.enqueue(item.value.slice());
      } catch {
        controller.error(safeStreamError());
      }
    },
    async cancel() {
      try {
        await iterator.return?.();
      } catch {
        throw safeStreamError();
      }
    },
  });
}

async function handleDownloadOwnerExportUnobserved(
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
    const guard = await guardOwnerRequest(request, {
      operation: "downloadOwnerExport",
      mode: "read",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const authorization = ownerAuthorizationContext(guard.actor, deps.portfolioId);
    if (authorization === undefined) {
      return toRejection({ kind: "forbidden", code: "OWNER_REQUIRED" }, traceId, instance, logger);
    }
    const pathResult = zDownloadOwnerExportPath.safeParse({
      exportId: params.exportId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const exportIdResult = parseStableId("OwnerExport", pathResult.data.exportId);
    if (!exportIdResult.ok) return reject(logger, traceId, instance, "Invalid path parameters.");
    const exportId = exportIdResult.value;
    const query: DownloadOwnerExportQuery = { ...authorization, exportId };
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
    // version, and bounded byte-stream descriptor) before emitting the response.
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
    return new Response(createBoundedDownloadStream(result.value.content, result.value.contentLength), {
      status: 200,
      headers: {
        "content-type": OWNER_EXPORT_MEDIA_TYPE,
        "content-disposition": `attachment; filename="${result.value.filename}"`,
        "x-shipwithali-export-schema-version": result.value.schemaVersion,
        ...OWNER_PRIVATE_RESPONSE_HEADERS,
      },
    });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

async function observeOwnerExportRequest(
  route: "owner-export-request" | "owner-export-status" | "owner-export-download",
  deps: OwnerExportAdapterDeps,
  action: () => Promise<Response>,
): Promise<Response> {
  const startedAt = performance.now();
  let response: Response | undefined;
  try {
    response = await action();
    return response;
  } finally {
    const durationMs = Math.max(0, Math.min(86_400_000, Math.floor(performance.now() - startedAt)));
    const status = response?.status ?? 500;
    const statusClass = `${Math.floor(status / 100)}xx` as "2xx" | "3xx" | "4xx" | "5xx";
    await emitOperationsSignal(deps.logger, deps.operationsObservations, {
      kind: "http-request", route, statusClass, durationMs,
    });
  }
}

export function handleRequestOwnerExport(request: Request, deps: OwnerExportAdapterDeps): Promise<Response> {
  return observeOwnerExportRequest("owner-export-request", deps, () => handleRequestOwnerExportUnobserved(request, deps));
}

export function handleGetOwnerExport(
  request: Request,
  params: { exportId: string },
  deps: OwnerExportAdapterDeps,
): Promise<Response> {
  return observeOwnerExportRequest("owner-export-status", deps, () => handleGetOwnerExportUnobserved(request, params, deps));
}

export function handleDownloadOwnerExport(
  request: Request,
  params: { exportId: string },
  deps: OwnerExportAdapterDeps,
): Promise<Response> {
  return observeOwnerExportRequest("owner-export-download", deps, () => handleDownloadOwnerExportUnobserved(request, params, deps));
}
