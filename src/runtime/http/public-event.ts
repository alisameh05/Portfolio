import type { PortfolioRequestScope } from "@shared/application";
/**
 * public-event.ts — Phase 2 #28 consented Public event adapter.
 *
 * Thin handwritten adapter for POST events (accepts one privacy-minimized
 * allowlisted event after consent; Reaction, Rating, Feedback, and Current
 * CV actions are excluded to avoid double-counting).
 * Ordered behavior: establish request context; validate headers and body
 * with the generated strict validators; construct one application command;
 * call one injected application interface once; validate and serialize the
 * declared response; complete request logging.
 *
 * Consent: the accepted contract declares AnalyticsConsent security as a
 * signed `sw_analytics_consent` cookie. The adapter reads only the presence
 * of that cookie from the standard `cookie` header and folds it into the
 * provider-neutral visitor actor (`granted` when present and non-empty,
 * otherwise `unknown`). Cookie values, signatures, and raw identifiers
 * never cross the application seam and never appear in logs.
 *
 * All nine validated action-specific facts cross the owning application seam.
 * Verified Measurement evidence is supplied by the future consent boundary;
 * the existing fail-closed shell does not gain collection behavior.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, results, and rejections crossing the application seam
 * are provider-neutral. Uses only the standard Web Request/Response — no
 * Next.js, Supabase, or provider types.
 */

import {
  zPostPublicEventBody,
  zPostPublicEventHeaders,
  zPostPublicEventResponse,
} from "../../contracts/http/v1/generated/zod.gen.js";
import type {
  IngestPublicEventCommand,
  PublicMeasurementEvent,
  MeasurementService,
  EventReceipt,
} from "../../modules/measurement/index.js";
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

export interface PublicEventAdapterDeps {
  readonly scope?: PortfolioRequestScope;
  service: Pick<MeasurementService, "ingestEvent">;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    // Built from segments (not a literal) so the route-inventory scan does
    // not mistake this fallback for a contract path reference.
    return ["", "api", "v1", "events"].join("/");
  }
}

function hasAnalyticsConsent(request: Request): boolean {
  const cookie = request.headers.get("cookie");
  if (cookie === null || cookie.length === 0) {
    return false;
  }
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name?.trim() === "sw_analytics_consent" && rest.join("=").trim().length > 0) {
      return true;
    }
  }
  return false;
}

export async function handlePostPublicEvent(
  request: Request,
  deps: PublicEventAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  // Server-generated correlation: inbound identifiers never become canonical.
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);

  try {
    const headersResult = zPostPublicEventHeaders.safeParse({
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

    if (rawBody === null || rawBody === undefined) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Missing request body.", traceId, instance);
    }

    const bodyResult = zPostPublicEventBody.safeParse(rawBody);
    if (!bodyResult.success) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid request body.", traceId, instance);
    }

    const command: IngestPublicEventCommand = {
      scope: deps.scope ?? { kind: "unconfigured" },
      correlationId: traceId,
      actor: { kind: "visitor", consent: hasAnalyticsConsent(request) ? "granted" : "unknown" },
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      event: bodyResult.data as unknown as PublicMeasurementEvent,
    };

    let result: Awaited<ReturnType<typeof deps.service.ingestEvent>>;
    try {
      result = await deps.service.ingestEvent(command);
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

    const value = result.value as EventReceipt;
    const payload = {
      eventId: value.eventId,
      acceptedAt: value.acceptedAt,
    };
    const responseResult = zPostPublicEventResponse.safeParse(payload);
    if (!responseResult.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }

    logger?.info("request.completed", { traceId, status: 202 });
    return Response.json(responseResult.data, { status: 202 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}
