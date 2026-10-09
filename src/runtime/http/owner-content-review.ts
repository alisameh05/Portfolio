import {
  zGetOwnerContentHistoryPath,
  zGetOwnerContentHistoryQuery,
  zGetOwnerContentHistoryResponse,
  zPreviewOwnerContentRevisionPath,
  zPreviewOwnerContentRevisionResponse,
  zReviewOwnerContentRevisionBody,
  zReviewOwnerContentRevisionHeaders,
  zReviewOwnerContentRevisionPath,
  zReviewOwnerContentRevisionResponse,
} from "../../contracts/http/owner/v1/generated/zod.gen.js";
import type { ContentAuthoringService } from "../../modules/content-publishing/application/authoring.js";
import type { IdempotencyKey, Rejection, StableId } from "../../shared/domain/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import { guardOwnerRequest, OWNER_PRIVATE_RESPONSE_HEADERS, type OwnerRequestSecurity } from "./owner-security.js";
import { internalErrorProblem, rejectionToProblem, transportProblem } from "./problem.js";

export interface OwnerContentReviewAdapterDeps {
  readonly service: ContentAuthoringService;
  readonly security: OwnerRequestSecurity;
  readonly logger?: Logger;
}

function instanceOf(request: Request): string {
  try { return new URL(request.url).pathname; } catch { return "/api/owner/v1/content"; }
}

function rejected(error: Rejection, logger: Logger | undefined, traceId: string, instance: string): Response {
  const response = rejectionToProblem(error, traceId, instance);
  logger?.warn("request.rejected", { traceId, status: response.status, code: error.code });
  return response;
}

function badRequest(logger: Logger | undefined, traceId: string, instance: string, detail: string): Response {
  logger?.warn("request.rejected", { traceId, status: 400 });
  return transportProblem(detail, traceId, instance);
}

function versionFromHeader(value: string): number | null {
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (match === null) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) ? version : null;
}

export async function handlePreviewOwnerContentRevision(
  request: Request,
  params: { readonly contentId: string; readonly revisionId: string },
  deps: OwnerContentReviewAdapterDeps,
): Promise<Response> {
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  const instance = instanceOf(request);
  const logger = deps.logger;
  try {
    const guard = await guardOwnerRequest(request, { operation: "previewOwnerContentRevision", mode: "read", security: deps.security, traceId, instance, logger });
    if (!guard.ok) return guard.response;
    const path = zPreviewOwnerContentRevisionPath.safeParse(params);
    if (!path.success) return badRequest(logger, traceId, instance, "Invalid content or Revision identifier.");
    const result = await deps.service.previewRevision({
      actor: guard.actor,
      contentId: path.data.contentId as StableId<string>,
      revisionId: path.data.revisionId as StableId<"Revision">,
    });
    if (!result.ok) return rejected(result.error, logger, traceId, instance);
    const response = zPreviewOwnerContentRevisionResponse.safeParse(result.value);
    if (!response.success) return internalErrorProblem(new Error("Invalid application result"), traceId, instance, logger);
    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(response.data, { status: 200, headers: OWNER_PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleReviewOwnerContentRevision(
  request: Request,
  params: { readonly contentId: string; readonly revisionId: string },
  deps: OwnerContentReviewAdapterDeps,
): Promise<Response> {
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  const instance = instanceOf(request);
  const logger = deps.logger;
  try {
    const guard = await guardOwnerRequest(request, { operation: "reviewOwnerContentRevision", mode: "mutation", security: deps.security, traceId, instance, logger });
    if (!guard.ok) return guard.response;
    const path = zReviewOwnerContentRevisionPath.safeParse(params);
    if (!path.success) return badRequest(logger, traceId, instance, "Invalid content or Revision identifier.");
    const headers = zReviewOwnerContentRevisionHeaders.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
      "If-Match": request.headers.get("if-match") ?? undefined,
    });
    if (!headers.success) return badRequest(logger, traceId, instance, "Missing or invalid concurrency headers.");
    let bodyValue: unknown;
    try { bodyValue = await request.json() as unknown; } catch { return badRequest(logger, traceId, instance, "Malformed JSON body."); }
    const body = zReviewOwnerContentRevisionBody.safeParse(bodyValue);
    if (!body.success) return badRequest(logger, traceId, instance, "Invalid Revision review body.");
    const expectedVersion = versionFromHeader(headers.data["If-Match"]);
    if (expectedVersion === null) return badRequest(logger, traceId, instance, "Missing or invalid concurrency headers.");
    const result = await deps.service.reviewRevision({
      actor: guard.actor,
      contentId: path.data.contentId as StableId<string>,
      revisionId: path.data.revisionId as StableId<"Revision">,
      expectedVersion,
      idempotencyKey: headers.data["Idempotency-Key"] as IdempotencyKey,
      correlationId: traceId,
      locale: body.data.locale,
      snapshotHash: body.data.snapshotHash,
      evidenceVersion: body.data.evidenceVersion,
      decision: body.data.decision,
      findings: body.data.findings,
    });
    if (!result.ok) return rejected(result.error, logger, traceId, instance);
    const response = zReviewOwnerContentRevisionResponse.safeParse(result.value);
    if (!response.success) return internalErrorProblem(new Error("Invalid application result"), traceId, instance, logger);
    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(response.data, { status: 200, headers: OWNER_PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleGetOwnerContentHistory(
  request: Request,
  params: { readonly contentId: string },
  deps: OwnerContentReviewAdapterDeps,
): Promise<Response> {
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  const instance = instanceOf(request);
  const logger = deps.logger;
  try {
    const guard = await guardOwnerRequest(request, { operation: "getOwnerContentHistory", mode: "read", security: deps.security, traceId, instance, logger });
    if (!guard.ok) return guard.response;
    const url = new URL(request.url);
    const path = zGetOwnerContentHistoryPath.safeParse(params);
    const rawQuery: Record<string, unknown> = {};
    for (const [key, value] of url.searchParams.entries()) {
      if (Object.hasOwn(rawQuery, key)) return badRequest(logger, traceId, instance, "Duplicate history query parameter.");
      rawQuery[key] = key === "limit" ? Number(value) : value;
    }
    if (!path.success) return badRequest(logger, traceId, instance, "Invalid content identifier.");
    const query = zGetOwnerContentHistoryQuery.safeParse(rawQuery);
    if (!query.success) return badRequest(logger, traceId, instance, "Invalid content history query.");
    const result = await deps.service.getContentHistory({
      actor: guard.actor,
      contentId: path.data.contentId as StableId<string>,
      ...(query.data.locale === undefined ? {} : { locale: query.data.locale }),
      limit: query.data.limit,
      ...(query.data.cursor === undefined ? {} : { cursor: query.data.cursor }),
    });
    if (!result.ok) return rejected(result.error, logger, traceId, instance);
    const response = zGetOwnerContentHistoryResponse.safeParse(result.value);
    if (!response.success) return internalErrorProblem(new Error("Invalid application result"), traceId, instance, logger);
    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(response.data, { status: 200, headers: OWNER_PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}
