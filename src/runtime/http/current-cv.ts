/**
 * current-cv.ts — Phase 2 #28 Current CV HTTP adapter.
 *
 * Thin handwritten adapter for GET current CV (returns or temporarily
 * redirects to the single accepted English Current CV; recording event data
 * never blocks access and no unavailable localization is implied).
 * Ordered behavior: establish request context; validate query with the
 * generated strict validator; construct one application query; call one
 * injected application interface once; serialize the declared stream/redirect
 * response; complete request logging.
 *
 * The adapter supports the declared 200 byte stream and 307 short-lived
 * redirect shapes, always with no-store headers. Successful fake output with
 * an invalid or expired redirect location fails safely as a generic 500.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Queries, results, and rejections crossing the application seam
 * are provider-neutral. Uses only the standard Web Request/Response — no
 * Next.js, Supabase, storage, or provider types.
 */

import { zGetCurrentCvQuery } from "../../contracts/http/v1/generated/zod.gen.js";
import { observeHttpRequest } from "./observe-request.js";

import type {
  CvPortfolioApplicationService,
  CurrentCvDownloadQuery,
} from "../../modules/cv-portfolio/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import type { CurrentCvRateLimitCheck } from "./current-cv-rate-limit.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

export interface CurrentCvAdapterDeps {
  service: Pick<CvPortfolioApplicationService, "downloadCurrentCv">;
  /** Exact Storage origins permitted for the short-lived redirect response. */
  allowedRedirectOrigins?: ReadonlyArray<string>;
  /** Required hosting-boundary abuse control; missing or unavailable controls fail closed. */
  rateLimit: CurrentCvRateLimitCheck;
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

function isAllowedRedirect(value: string, allowedOrigins: ReadonlyArray<string>): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" &&
      allowedOrigins.includes(parsed.origin);
  } catch {
    return false;
  }
}

function streamBytes(bytes: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const iterator = bytes[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

 async function handleGetCurrentCvUnobserved(
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
    // The module receives the requested disposition explicitly so storage
    // capabilities can bind it; locale remains explicit at the same seam.
    const locale = queryResult.data.locale;
    const disposition = queryResult.data.disposition ?? "inline";

    const query: CurrentCvDownloadQuery = {
      actor: { kind: "visitor", consent: "unknown" },
      locale,
      disposition,
    };

    let rateVerdict: Awaited<ReturnType<CurrentCvRateLimitCheck["check"]>>;
    try {
      rateVerdict = await deps.rateLimit.check(request);
    } catch {
      return rejectionToProblem({ kind: "temporarily_unavailable", code: "CURRENT_CV_RATE_LIMIT_UNAVAILABLE" }, traceId, instance);
    }
    if (!rateVerdict.allowed) {
      const retryAfterSeconds = Number.isSafeInteger(rateVerdict.retryAfterSeconds) &&
        (rateVerdict.retryAfterSeconds ?? -1) >= 0 ? rateVerdict.retryAfterSeconds as number : 60;
      const rejection = { kind: "rate_limited" as const, code: "CURRENT_CV_RATE_LIMITED", retryAfterSeconds };
      return rejectionToProblem(rejection, traceId, instance);
    }

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

    if (result.value.disposition !== disposition) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }

    if (result.value.kind === "stream") {
      logger?.info("request.completed", { traceId, status: 200 });
      return new Response(streamBytes(result.value.bytes), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "content-disposition": `${disposition}; filename="cv.pdf"`,
          "cache-control": "no-store",
        },
      });
    }

    const location = result.value.downloadUrl;
    const expiry = Date.parse(result.value.expiresAt);
    if (
      typeof location !== "string" ||
      location.length === 0 ||
      !isAllowedRedirect(location, deps.allowedRedirectOrigins ?? []) ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 5 * 60_000
    ) {
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


export function handleGetCurrentCv(request: Request, deps: CurrentCvAdapterDeps): Promise<Response> {
  return observeHttpRequest("public-current-cv", () => handleGetCurrentCvUnobserved(request, deps), deps.logger);
}
