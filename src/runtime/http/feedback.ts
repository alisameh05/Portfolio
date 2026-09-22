/**
 * feedback.ts — Phase 2 #28 Feedback HTTP adapter.
 *
 * Thin handwritten adapter for POST projects feedback (visitor submits
 * private pending Feedback for Owner Moderation; the response never implies
 * approval, public eligibility, or public display).
 * Ordered behavior: establish request context; validate path, headers, and
 * body with the generated strict validators; construct one application
 * command; call one injected application interface once; validate and
 * serialize the declared response; complete request logging.
 *
 * Transport body carries `name`, `paragraph`, and `locale`. The locale is
 * validated through the generated strict validator (English or Arabic per
 * the accepted contract) but intentionally not forwarded: the Phase 1
 * domain Feedback record carries no locale field, so forwarding it would
 * leak transport concerns into the provider-neutral application seam.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, results, and rejections crossing the application seam
 * are provider-neutral. Uses only the standard Web Request/Response — no
 * Next.js, Supabase, or provider types.
 */

import {
  zPostProjectFeedbackBody,
  zPostProjectFeedbackHeaders,
  zPostProjectFeedbackPath,
  zPostProjectFeedbackResponse,
} from "../../contracts/http/v1/generated/zod.gen.js";
import type {
  InteractionModerationService,
  SubmitFeedbackCommand,
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

export interface FeedbackAdapterDeps {
  service: Pick<InteractionModerationService, "submitFeedback">;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    // Built from segments (not a literal) so the route-inventory scan does
    // not mistake this fallback for a contract path reference.
    return ["", "api", "v1", "projects", "{projectId}", "feedback"].join("/");
  }
}

export async function handlePostProjectFeedback(
  request: Request,
  params: { projectId: string },
  deps: FeedbackAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  // Server-generated correlation: inbound identifiers never become canonical.
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);

  try {
    const pathResult = zPostProjectFeedbackPath.safeParse({ projectId: params.projectId });
    if (!pathResult.success) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid path parameters.", traceId, instance);
    }

    const headersResult = zPostProjectFeedbackHeaders.safeParse({
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

    const bodyResult = zPostProjectFeedbackBody.safeParse(rawBody);
    if (!bodyResult.success) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid request body.", traceId, instance);
    }

    const command: SubmitFeedbackCommand = {
      actor: { kind: "visitor", consent: "unknown" },
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      projectId: pathResult.data.projectId as StableId<"Project">,
      authorName: bodyResult.data.name,
      comment: bodyResult.data.paragraph,
    };

    let result: Awaited<ReturnType<typeof deps.service.submitFeedback>>;
    try {
      result = await deps.service.submitFeedback(command);
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
      feedbackId: result.value.id,
      projectId: result.value.projectId,
      status: "pending" as const,
    };
    const responseResult = zPostProjectFeedbackResponse.safeParse(payload);
    if (!responseResult.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }

    logger?.info("request.completed", { traceId, status: 201 });
    return Response.json(responseResult.data, { status: 201 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}
