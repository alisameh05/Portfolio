import {
  zCreateOwnerContentBody,
  zCreateOwnerContentHeaders,
  zCreateOwnerContentResponse,
} from "../../contracts/http/owner/v1/generated/zod.gen.js";
import { observeHttpRequest } from "./observe-request.js";
import { readBoundedJson } from "./read-bounded-json.js";

import type { CreateDraftPayload } from "../../modules/content-publishing/domain/index.js";
import type { ContentAuthoringService } from "../../modules/content-publishing/application/authoring.js";
import type { IdempotencyKey, Rejection } from "../../shared/domain/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import { guardOwnerRequest, OWNER_PRIVATE_RESPONSE_HEADERS, type OwnerRequestSecurity } from "./owner-security.js";
import { internalErrorProblem, rejectionToProblem, transportProblem } from "./problem.js";

export interface OwnerContentAuthoringAdapterDeps {
  readonly service: ContentAuthoringService;
  readonly security: OwnerRequestSecurity;
  readonly logger?: Logger;
}

function instanceOf(request: Request): string {
  try { return new URL(request.url).pathname; } catch { return "/api/owner/v1/content"; }
}

function badRequest(logger: Logger | undefined, traceId: string, instance: string, detail: string): Response {
  logger?.warn("request.rejected", { traceId, status: 400 });
  return transportProblem(detail, traceId, instance);
}

function rejected(error: Rejection, logger: Logger | undefined, traceId: string, instance: string): Response {
  const response = rejectionToProblem(error, traceId, instance);
  logger?.warn("request.rejected", { traceId, status: response.status, code: error.code });
  return response;
}

 async function handleCreateOwnerContentUnobserved(
  request: Request,
  deps: OwnerContentAuthoringAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  const instance = instanceOf(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "createOwnerContent", mode: "mutation", security: deps.security, traceId, instance, logger,
    });
    if (!guard.ok) return guard.response;
    const headers = zCreateOwnerContentHeaders.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
    });
    if (!headers.success) return badRequest(logger, traceId, instance, "Missing or invalid Idempotency-Key.");
    const raw = await readBoundedJson(request);
    if (!raw.ok) return badRequest(logger, traceId, instance, "Malformed JSON body.");
    const body = zCreateOwnerContentBody.safeParse(raw.value);
    if (!body.success) return badRequest(logger, traceId, instance, "Invalid content creation body.");
    let result: Awaited<ReturnType<ContentAuthoringService["createContent"]>>;
    try {
      result = await deps.service.createContent({
        actor: guard.actor,
        idempotencyKey: headers.data["Idempotency-Key"] as IdempotencyKey,
        correlationId: traceId,
        payload: body.data as unknown as CreateDraftPayload,
      });
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) return rejected(result.error, logger, traceId, instance);
    const response = zCreateOwnerContentResponse.safeParse(result.value);
    if (!response.success) return internalErrorProblem(new Error("Invalid application result"), traceId, instance, logger);
    logger?.info("request.completed", { traceId, status: 201 });
    return Response.json(response.data, { status: 201 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}


export function handleCreateOwnerContent(request: Request, deps: OwnerContentAuthoringAdapterDeps): Promise<Response> {
  return observeHttpRequest("owner-content-authoring", async () => {
    const response = await handleCreateOwnerContentUnobserved(request, deps);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(OWNER_PRIVATE_RESPONSE_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }, deps.logger);
}
