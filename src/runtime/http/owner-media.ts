/**
 * owner-media.ts — Phase 2 #31 Owner Media HTTP adapter.
 *
 * Thin handwritten adapter for the five Owner Media operations:
 * `GET /api/owner/v1/media/{mediaId}`,
 * `POST /api/owner/v1/media/upload-intents`,
 * `POST /api/owner/v1/media/{mediaId}/commands/record-processing`,
 * `POST /api/owner/v1/media/{mediaId}/commands/accept`, and
 * `POST /api/owner/v1/media/{mediaId}/commands/reject`.
 *
 * Ordered behavior per operation: establish request context; validate path,
 * headers (Idempotency-Key alone for upload intents, plus If-Match
 * concurrency where declared), and body with the generated strict validators;
 * construct one operation-specific command or query; call one injected
 * application interface once; validate and serialize the declared response;
 * complete request logging.
 *
 * Upload-intent creation carries no expected version: the receipt always
 * starts a new aggregate at version 1. Record, accept, and reject carry
 * optimistic-concurrency versions parsed from the declared If-Match header.
 *
 * The Owner actor is resolved through the shared Phase 4 verified-actor
 * boundary (`./owner-security.js`): every operation requires a verified
 * Owner session, owner-scoped authorization, and (for mutations) exact
 * origin plus CSRF proof before dispatch. Unauthenticated and forbidden
 * translation is exercised through fakes. Storage, scanning, processing,
 * acceptance, and delivery rules remain unimplemented provider-neutral
 * application behavior. Declared upload and delivery references stay
 * provider-neutral opaque HTTPS URLs; signed secrets never appear in logs
 * or errors.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, storage, or provider types.
 */

import {
  zAcceptOwnerMediaAssetBody,
  zAcceptOwnerMediaAssetHeaders,
  zAcceptOwnerMediaAssetPath,
  zAcceptOwnerMediaAssetResponse,
  zCreateOwnerMediaUploadIntentBody,
  zCreateOwnerMediaUploadIntentHeaders,
  zCreateOwnerMediaUploadIntentResponse,
  zGetOwnerMediaAggregatePath,
  zGetOwnerMediaAggregateResponse,
  zRecordOwnerMediaProcessingBody,
  zRecordOwnerMediaProcessingHeaders,
  zRecordOwnerMediaProcessingPath,
  zRecordOwnerMediaProcessingResponse,
  zRejectOwnerMediaAssetBody,
  zRejectOwnerMediaAssetHeaders,
  zRejectOwnerMediaAssetPath,
  zRejectOwnerMediaAssetResponse,
} from "../../contracts/http/owner/v1/generated/zod.gen.js";
import type {
  ActorContext,
  IdempotencyKey,
  Rejection,
  Result,
  StableId,
} from "../../shared/domain/index.js";
import type {
  AcceptOwnerMediaAssetApplicationCommand,
  CreateOwnerMediaUploadIntentApplicationCommand,
  GetOwnerMediaAggregateQuery,
  OwnerMediaAccessibility,
  OwnerMediaAggregateView,
  OwnerMediaApplicationService,
  OwnerMediaCommandReceipt,
  OwnerMediaDecisionView,
  OwnerMediaProcessingView,
  OwnerMediaUploadIntentView,
  RecordOwnerMediaProcessingApplicationCommand,
  RejectOwnerMediaAssetApplicationCommand,
} from "../../modules/media/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import {
  guardOwnerRequest,
  type OwnerRequestSecurity,
} from "./owner-security.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

// Public compatibility exports keep existing adapter consumers stable while
// the module barrel owns the application contract.
export type {
  AcceptOwnerMediaAssetApplicationCommand,
  CreateOwnerMediaUploadIntentApplicationCommand,
  GetOwnerMediaAggregateQuery,
  OwnerMediaAccessibility,
  OwnerMediaAggregateView,
  OwnerMediaApplicationService,
  OwnerMediaCommandReceipt,
  OwnerMediaDecisionView,
  OwnerMediaProcessingView,
  OwnerMediaUploadIntentView,
  RecordOwnerMediaProcessingApplicationCommand,
  RejectOwnerMediaAssetApplicationCommand,
} from "../../modules/media/index.js";

export interface OwnerMediaAdapterDeps {
  service: OwnerMediaApplicationService;
  security: OwnerRequestSecurity;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "media", "{mediaId}"].join("/");
  }
}

function parseExpectedVersion(ifMatch: string): number | null {
  const match = /^"([1-9][0-9]*)"$/.exec(ifMatch);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
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

export async function handleGetOwnerMediaAggregate(
  request: Request,
  params: { mediaId: string },
  deps: OwnerMediaAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "getOwnerMediaAggregate",
      mode: "read",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const pathResult = zGetOwnerMediaAggregatePath.safeParse({
      mediaId: params.mediaId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const query: GetOwnerMediaAggregateQuery = {
      actor: guard.actor,
      mediaId: pathResult.data.mediaId as StableId<string>,
    };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerMediaAggregate>>;
    try {
      result = await deps.service.getOwnerMediaAggregate(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      mediaId: result.value.mediaId,
      aggregateVersion: result.value.aggregateVersion,
      kind: result.value.kind,
      originalFileName: result.value.originalFileName,
      declaredMediaType: result.value.declaredMediaType,
      byteLength: result.value.byteLength,
      state: result.value.state,
      processingHistory: [...result.value.processingHistory],
      processingHistoryTruncated: result.value.processingHistoryTruncated,
      decisionHistory: [...result.value.decisionHistory],
      decisionHistoryTruncated: result.value.decisionHistoryTruncated,
    };
    const parsed = zGetOwnerMediaAggregateResponse.safeParse(payload);
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

export async function handleCreateOwnerMediaUploadIntent(
  request: Request,
  deps: OwnerMediaAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "createOwnerMediaUploadIntent",
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const headersResult = zCreateOwnerMediaUploadIntentHeaders.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
    });
    if (!headersResult.success) {
      return reject(logger, traceId, instance, "Missing or invalid idempotency header.");
    }
    const raw = await readJsonBody(request);
    if (!raw.ok) {
      return reject(logger, traceId, instance, "Malformed JSON body.");
    }
    const bodyResult = zCreateOwnerMediaUploadIntentBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const command: CreateOwnerMediaUploadIntentApplicationCommand = {
      actor: guard.actor,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      kind: bodyResult.data.kind,
      originalFileName: bodyResult.data.originalFileName,
      declaredMediaType: bodyResult.data.declaredMediaType,
      byteLength: bodyResult.data.byteLength,
      sha256: bodyResult.data.sha256,
    };
    let result: Awaited<ReturnType<typeof deps.service.createOwnerMediaUploadIntent>>;
    try {
      result = await deps.service.createOwnerMediaUploadIntent(command);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      mediaId: result.value.mediaId,
      aggregateVersion: result.value.aggregateVersion,
      outcome: result.value.outcome,
      uploadIntentId: result.value.uploadIntentId,
      uploadTarget: result.value.uploadTarget,
      expiresAt: result.value.expiresAt,
    };
    const parsed = zCreateOwnerMediaUploadIntentResponse.safeParse(payload);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 201 });
    return Response.json(parsed.data, {
      status: 201,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

async function handleMediaCommand(
  request: Request,
  params: { mediaId: string },
  deps: OwnerMediaAdapterDeps,
  operation: string,
  validators: {
    readonly path: { safeParse(value: unknown): { success: boolean; data?: { mediaId: string } } };
    readonly headers: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly body: { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };
    readonly response: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  },
  buildCommand: (args: {
    readonly actor: ActorContext;
    readonly mediaId: StableId<string>;
    readonly idempotencyKey: IdempotencyKey;
    readonly expectedVersion: number;
    readonly body: Record<string, unknown>;
  }) => unknown,
  call: (command: never) => Promise<Result<OwnerMediaCommandReceipt, Rejection>>,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation,
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const pathResult = validators.path.safeParse({ mediaId: params.mediaId });
    if (!pathResult.success || pathResult.data === undefined) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const headersResult = validators.headers.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
      "If-Match": request.headers.get("if-match") ?? undefined,
    });
    if (!headersResult.success || headersResult.data === undefined) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const raw = await readJsonBody(request);
    if (!raw.ok) {
      return reject(logger, traceId, instance, "Malformed JSON body.");
    }
    const bodyResult = validators.body.safeParse(raw.value);
    if (!bodyResult.success || bodyResult.data === undefined) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"] ?? "");
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const command = buildCommand({
      actor: guard.actor,
      mediaId: pathResult.data.mediaId as StableId<string>,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      body: bodyResult.data,
    });
    let result: Result<OwnerMediaCommandReceipt, Rejection>;
    try {
      result = await call(command as never);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      aggregateId: result.value.aggregateId,
      aggregateVersion: result.value.aggregateVersion,
      outcome: result.value.outcome,
    };
    const parsed = validators.response.safeParse(payload);
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

export async function handleRecordOwnerMediaProcessing(
  request: Request,
  params: { mediaId: string },
  deps: OwnerMediaAdapterDeps,
): Promise<Response> {
  return await handleMediaCommand(
    request,
    params,
    deps,
    "recordOwnerMediaProcessing",
    {
      path: zRecordOwnerMediaProcessingPath,
      headers: zRecordOwnerMediaProcessingHeaders,
      body: zRecordOwnerMediaProcessingBody,
      response: zRecordOwnerMediaProcessingResponse,
    },
    ({ actor, mediaId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      mediaId,
      result: body["result"] as "passed" | "failed",
      detectedMediaType: body["detectedMediaType"] as string,
      detectedByteLength: body["detectedByteLength"] as number,
      sha256: body["sha256"] as string,
      ...(Array.isArray(body["findings"])
        ? { findings: body["findings"] as ReadonlyArray<string> }
        : {}),
    }) as RecordOwnerMediaProcessingApplicationCommand,
    (command) => deps.service.recordOwnerMediaProcessing(command),
  );
}

export async function handleAcceptOwnerMediaAsset(
  request: Request,
  params: { mediaId: string },
  deps: OwnerMediaAdapterDeps,
): Promise<Response> {
  return await handleMediaCommand(
    request,
    params,
    deps,
    "acceptOwnerMediaAsset",
    {
      path: zAcceptOwnerMediaAssetPath,
      headers: zAcceptOwnerMediaAssetHeaders,
      body: zAcceptOwnerMediaAssetBody,
      response: zAcceptOwnerMediaAssetResponse,
    },
    ({ actor, mediaId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      mediaId,
      accessibility: body["accessibilityMetadata"] as OwnerMediaAccessibility,
    }) as AcceptOwnerMediaAssetApplicationCommand,
    (command) => deps.service.acceptOwnerMediaAsset(command),
  );
}

export async function handleRejectOwnerMediaAsset(
  request: Request,
  params: { mediaId: string },
  deps: OwnerMediaAdapterDeps,
): Promise<Response> {
  return await handleMediaCommand(
    request,
    params,
    deps,
    "rejectOwnerMediaAsset",
    {
      path: zRejectOwnerMediaAssetPath,
      headers: zRejectOwnerMediaAssetHeaders,
      body: zRejectOwnerMediaAssetBody,
      response: zRejectOwnerMediaAssetResponse,
    },
    ({ actor, mediaId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      mediaId,
      reason: body["reason"] as string,
    }) as RejectOwnerMediaAssetApplicationCommand,
    (command) => deps.service.rejectOwnerMediaAsset(command),
  );
}
