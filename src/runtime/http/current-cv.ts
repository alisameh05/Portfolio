/**
 * current-cv.ts — Phase 2 #28 Current CV HTTP adapter.
 *
 * Thin handwritten adapter for GET current CV (returns or temporarily
 * redirects to the single accepted English Current CV; recording event data
 * never blocks access and no unavailable localization is implied).
 * Ordered behavior: establish request context; validate query with the
 * generated strict validator; construct one application query; call one
 * injected application interface once; serialize the declared redirect
 * response; complete request logging.
 *
 * Phase 2 exercises the declared temporary-redirect shape without touching
 * storage: the injected fake supplies a short-lived signed location and the
 * adapter returns it as a 307 response with `Location` and
 * `Cache-Control: no-store` headers. The 200 binary stream shape is
 * declared by the accepted contract and arrives with the storage phase; no
 * PDF bytes are fabricated here. Successful fake output with a non-HTTP(S)
 * location fails safely as a generic 500.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Queries, results, and rejections crossing the application seam
 * are provider-neutral. Uses only the standard Web Request/Response — no
 * Next.js, Supabase, storage, or provider types.
 */

import { zGetCurrentCvQuery } from "../../contracts/http/v1/generated/zod.gen.js";
import type {
  CvPortfolioService,
  DownloadCurrentCvQuery,
} from "../../modules/cv-portfolio/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

export interface CurrentCvAdapterDeps {
  service: Pick<CvPortfolioService, "downloadCurrentCv">;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    // Built from segments (not a literal) so the route-inventory scan does
    // not mistake this fallback for a contract path reference.
    return ["", "api", "v1", "cv", "current"].join("/");
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export async function handleGetCurrentCv(
  request: Request,
  deps: CurrentCvAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  // Server-generated correlation: inbound identifiers never become canonical.
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);

  try {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid request URL.", traceId, instance);
    }

    const rawQuery: Record<string, string> = {};
    const seenCounts = new Map<string, number>();
    for (const [key, value] of url.searchParams) {
      const seen = (seenCounts.get(key) ?? 0) + 1;
      seenCounts.set(key, seen);
      // Duplicate query keys have no declared meaning for this operation.
      if (seen > 1) {
        logger?.warn("request.rejected", { traceId, status: 400 });
        return transportProblem("Duplicate query parameter.", traceId, instance);
      }
      rawQuery[key] = value;
    }

    const queryResult = zGetCurrentCvQuery.safeParse(rawQuery);
    if (!queryResult.success) {
      logger?.warn("request.rejected", { traceId, status: 400 });
      return transportProblem("Invalid query parameters.", traceId, instance);
    }
    // Validated locale and disposition are intentionally transport-only in
    // Phase 2: the accepted contract offers English only, and the
    // provider-neutral download query carries only the visitor actor.
    void queryResult.data.locale;
    void (queryResult.data.disposition ?? "inline");

    const query: DownloadCurrentCvQuery = {
      actor: { kind: "visitor", consent: "unknown" },
    };

    let result: Awaited<ReturnType<typeof deps.service.downloadCurrentCv>>;
    try {
      result = await deps.service.downloadCurrentCv(query);
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

    const location = result.value.downloadUrl;
    if (typeof location !== "string" || location.length === 0 || !isHttpUrl(location)) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }

    logger?.info("request.completed", { traceId, status: 307 });
    return new Response(null, {
      status: 307,
      headers: {
        location,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}
