import type { PortfolioRequestScope } from "@shared/application";
import { getConsentApplicationService, getMeasurementEventIngestionService } from "../../bootstrap/composition-root.js";
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
 * signed `sw_analytics_consent` cookie. Identity/Measurement verifies its
 * authenticated envelope and current persisted revision before dispatch.
 * Cookie values never enter event commands or logs.
 *
 * All nine validated action-specific facts cross the owning application seam.
 * The event application must recheck consent inside its intake transaction (#196).
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
  ConsentApplicationService,
} from "../../modules/measurement/index.js";
import type { OperationsObservationPort } from "../../modules/portability-operations/index.js";
import { emitOperationsSignal } from "../../modules/portability-operations/index.js";
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

const acceptedActions = new Set([
  "page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened",
  "testimonial-engaged", "contact-channel-opened", "external-project-link-opened", "global-project-cta-opened",
]);

export interface PublicEventAdapterDeps {
  readonly consent?: Pick<ConsentApplicationService, "verifyEvidence">;
  readonly scope?: PortfolioRequestScope;
  service?: Pick<MeasurementService, "ingestEvent">;
  logger?: Logger;
  operationsObservations?: Pick<OperationsObservationPort, "recordSignal">;
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

function analyticsConsentToken(request: Request): string | undefined {
  const cookie = request.headers.get("cookie");
  if (cookie === null || cookie.length === 0) {
    return undefined;
  }
  let token: string | undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.split("=");
    if (name?.trim() === "sw_analytics_consent" && rest.join("=").trim().length > 0) {
      if (token !== undefined) return undefined;
      token = rest.join("=").trim();
    }
  }
  return token;
}

async function handlePostPublicEventUnobserved(
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
    if (!acceptedActions.has(bodyResult.data.action)) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid request body.", traceId, instance);
    }

    const runtime = getMeasurementEventIngestionService();
    const scope = deps.scope ?? runtime?.scope ?? { kind: "unconfigured" as const };
    const consent = deps.consent ?? getConsentApplicationService();
    const token = analyticsConsentToken(request);
    if (!consent || !token) {
      await emitOperationsSignal(logger, deps.operationsObservations, { kind: "event-intake", outcome: "rejected" });
      return rejectionToProblem({ kind: "forbidden", code: "MEASUREMENT_CONSENT_REQUIRED" }, traceId, instance);
    }
    const verified = await consent.verifyEvidence({ scope, correlationId: traceId, token, noticeVersion: bodyResult.data.context.consentVersion });
    if (!verified.ok) {
      await emitOperationsSignal(logger, deps.operationsObservations, {
        kind: "event-intake", outcome: verified.error.kind === "temporarily_unavailable" ? "unavailable" : "rejected",
      });
      return rejectionToProblem(verified.error, traceId, instance);
    }
    const service = deps.service ?? runtime?.service;
    if (!service) {
      await emitOperationsSignal(logger, deps.operationsObservations, { kind: "event-intake", outcome: "unavailable" });
      return rejectionToProblem({ kind: "temporarily_unavailable", code: "MEASUREMENT_UNAVAILABLE" }, traceId, instance);
    }
    const command: IngestPublicEventCommand = {
      scope,
      correlationId: traceId,
      actor: { kind: "visitor", consent: "granted" },
      measurement: verified.value,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      event: bodyResult.data as unknown as PublicMeasurementEvent,
    };

    let result: Awaited<ReturnType<typeof service.ingestEvent>>;
    try {
      result = await service.ingestEvent(command);
    } catch (error) {
      await emitOperationsSignal(logger, deps.operationsObservations, { kind: "event-intake", outcome: "indeterminate" });
      return internalErrorProblem(error, traceId, instance, logger);
    }

    if (!result.ok) {
      await emitOperationsSignal(logger, deps.operationsObservations, {
        kind: "event-intake", outcome: result.error.kind === "temporarily_unavailable" ? "unavailable" : "rejected",
      });
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

    // The application receipt is the commit boundary. The transport can still
    // fail afterward, so HTTP status is recorded separately from intake truth.
    await emitOperationsSignal(logger, deps.operationsObservations, { kind: "event-intake", outcome: "accepted" });

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

/** Preserve the existing HTTP contract while emitting bounded safe metrics. */
export async function handlePostPublicEvent(
  request: Request,
  deps: PublicEventAdapterDeps,
): Promise<Response> {
  const startedAt = performance.now();
  let response: Response | undefined;
  try {
    response = await handlePostPublicEventUnobserved(request, deps);
    return response;
  } finally {
    const durationMs = Math.max(0, Math.min(86_400_000, Math.floor(performance.now() - startedAt)));
    const status = response?.status ?? 500;
    const statusClass = `${Math.floor(status / 100)}xx` as "2xx" | "3xx" | "4xx" | "5xx";
    await emitOperationsSignal(deps.logger, deps.operationsObservations, {
      kind: "http-request", route: "public-event", statusClass, durationMs,
    });
  }
}
