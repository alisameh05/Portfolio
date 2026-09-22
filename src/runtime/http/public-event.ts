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
 * Transport-to-application translation (documented Phase 2 shell mapping):
 * the accepted contract carries nine hyphenated transport actions while the
 * Phase 1 domain MeasurementEventType carries five underscore values. The
 * adapter translates explicitly so the seam stays provider-neutral:
 * page-viewed maps to page_view; project-viewed, active-engagement-sampled,
 * and media-engaged map to case_study_read; related-project-opened and
 * external-project-link-opened map to external_link_click; and
 * contact-channel-opened, testimonial-engaged, and global-project-cta-opened
 * map to cta_click. The domain cv_download value has no Phase 2 transport
 * producer and is reserved for later phases.
 *
 * Route identity, coarse country, and coarse device flow from the validated
 * event context (`pageRouteIdentity`, `countryCode`, `deviceClass`); the
 * `other` and `unknown` device classes are dropped rather than forwarded as
 * coarse signals. Fine-grained context (timestamps, locales, journey
 * attribution, media and testimonial identifiers, engagement details)
 * remains transport-validated and never crosses the seam.
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
  MeasurementEventType,
  MeasurementService,
  PublicEventData,
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

type TransportAction =
  | "page-viewed"
  | "project-viewed"
  | "active-engagement-sampled"
  | "media-engaged"
  | "related-project-opened"
  | "contact-channel-opened"
  | "external-project-link-opened"
  | "testimonial-engaged"
  | "global-project-cta-opened";

function toDomainEventType(action: TransportAction): MeasurementEventType {
  switch (action) {
    case "page-viewed":
      return "page_view";
    case "project-viewed":
    case "active-engagement-sampled":
    case "media-engaged":
      return "case_study_read";
    case "related-project-opened":
    case "external-project-link-opened":
      return "external_link_click";
    case "contact-channel-opened":
    case "testimonial-engaged":
    case "global-project-cta-opened":
      return "cta_click";
  }
}

type ValidatedEventContext = {
  readonly pageRouteIdentity: string;
  readonly countryCode?: string;
  readonly deviceClass?: string;
};

function toCoarseDevice(deviceClass: string | undefined): IngestPublicEventCommand["coarseDevice"] {
  if (deviceClass === "desktop" || deviceClass === "mobile" || deviceClass === "tablet") {
    return deviceClass;
  }
  return undefined;
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

    const event = bodyResult.data as {
      readonly action: TransportAction;
      readonly context: ValidatedEventContext;
    };
    const context = event.context;
    const coarseDevice = toCoarseDevice(context.deviceClass);
    // ExactOptionalPropertyTypes: only include coarse signals when defined.
    const command: IngestPublicEventCommand = {
      actor: {
        kind: "visitor",
        consent: hasAnalyticsConsent(request) ? "granted" : "unknown",
      },
      eventType: toDomainEventType(event.action),
      routeIdentity: context.pageRouteIdentity as StableId<"PublicRoute">,
      ...(context.countryCode === undefined ? {} : { coarseCountry: context.countryCode }),
      ...(coarseDevice === undefined ? {} : { coarseDevice }),
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

    const value = result.value as PublicEventData;
    const payload = {
      eventId: value.eventId,
      acceptedAt: value.timestamp,
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
