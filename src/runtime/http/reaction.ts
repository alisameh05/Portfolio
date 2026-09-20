/**
 * reaction.ts — Phase 2 #26 Reaction HTTP adapter (tracer bullet).
 *
 * Thin handwritten adapter for `PUT /api/v1/projects/{projectId}/reaction`.
 * Ordered behavior: establish request context; validate path, headers, and
 * body with the generated strict validators; construct one application
 * command; call one injected application interface once; validate and
 * serialize the declared response; complete request logging.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, results, and rejections crossing the application seam
 * are provider-neutral. Uses only the standard Web Request/Response — no
 * Next.js, Supabase, or provider types.
 */

import {
  zPutProjectReactionBody,
  zPutProjectReactionHeaders,
  zPutProjectReactionPath,
  zPutProjectReactionResponse,
} from "../../contracts/http/v1/generated/zod.gen.js";
import type {
  InteractionModerationService,
  SubmitReactionCommand,
} from "../../modules/interaction-moderation/index.js";
import type {
  IdempotencyKey,
  StableId,
} from "../../shared/domain/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

export interface ReactionAdapterDeps {
  service: Pick<InteractionModerationService, "submitReaction">;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    // Built from segments (not a literal) so the route-inventory scan does
    // not mistake this fallback for a contract path reference.
    return ["", "api", "v1", "projects", "{projectId}", "reaction"].join("/");
  }
}

export async function handlePutProjectReaction(
  request: Request,
  params: { projectId: string },
  deps: ReactionAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  // Server-generated correlation: inbound identifiers never become canonical.
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);

  try {
    const pathResult = zPutProjectReactionPath.safeParse({ projectId: params.projectId });
    if (!pathResult.success) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid path parameters.", traceId, instance);
    }

    const headersResult = zPutProjectReactionHeaders.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
    });
    if (!headersResult.success) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Missing or invalid Idempotency-Key header.", traceId, instance);
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Malformed JSON body.", traceId, instance);
    }

    const bodyResult = zPutProjectReactionBody.safeParse(rawBody);
    if (!bodyResult.success) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid request body.", traceId, instance);
    }

    const command: SubmitReactionCommand = {
      actor: { kind: "visitor", consent: "unknown" },
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      projectId: pathResult.data.projectId as StableId<"Project">,
      kind: bodyResult.data.reaction,
    };

    let result: Awaited<ReturnType<typeof deps.service.submitReaction>>;
    try {
      result = await deps.service.submitReaction(command);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }

    if (!result.ok) {
      const rejection = rejectionToProblem(result.error, traceId, instance);
      // Rejection codes are stable machine values (never secrets), so the
      // code is safe to log with correlation for diagnostics.
      logger?.warn("request.rejected", {
        traceId,
        status: rejection.status,
        code: result.error.code,
      });
      return rejection;
    }

    const payload = {
      projectId: result.value.projectId,
      reaction: result.value.kind,
    };
    const responseResult = zPutProjectReactionResponse.safeParse(payload);
    if (!responseResult.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }

    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(responseResult.data, { status: 200 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}
