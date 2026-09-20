/**
 * problem.ts — Phase 2 #26 shared HTTP error boundary.
 *
 * One exhaustive Problem Details mapper for public and Owner adapters:
 * transport failures are 400, typed business validation is 422, and every
 * member of the closed transport-neutral Rejection union maps to its
 * declared response. Unexpected exceptions become generic 500 responses.
 *
 * Every response carries the RFC 9457 fields required by the accepted
 * contracts plus stable `code` and `traceId` extensions. Human detail is
 * safe and never used for branching. The same server-generated trace
 * identifier appears in the response and in request/error logs.
 *
 * This module may import generated transport validators only for
 * response-shape verification in tests; the mapper itself stays
 * provider-neutral apart from the standard Web Response.
 */

import type { Logger } from "../ports.js";
import type { Rejection } from "../../shared/domain/index.js";

export interface ProblemBody {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance: string;
  readonly code: string;
  readonly traceId: string;
}

const PROBLEM_MEDIA_TYPE = "application/problem+json";

function problemResponse(
  body: ProblemBody,
  init?: { headers?: Record<string, string> },
): Response {
  const headers: Record<string, string> = {
    "content-type": PROBLEM_MEDIA_TYPE,
    ...(init?.headers ?? {}),
  };
  return new Response(JSON.stringify(body), { status: body.status, headers });
}

/** Malformed transport input: never creates a domain Rejection. */
export function transportProblem(
  detail: string,
  traceId: string,
  instance: string,
): Response {
  return problemResponse({
    type: "urn:shipwithali:problem:bad-request",
    title: "Bad Request",
    status: 400,
    detail,
    instance,
    code: "validation",
    traceId,
  });
}

/**
 * Exhaustive typed-rejection mapper.
 *
 * TypeScript exhaustiveness (`switch` over the closed union with a `never`
 * default) makes the suite fail to compile when a new Rejection kind lacks
 * an HTTP mapping.
 */
export function rejectionToProblem(
  rejection: Rejection,
  traceId: string,
  instance: string,
): Response {
  switch (rejection.kind) {
    case "validation":
      return problemResponse({
        type: "urn:shipwithali:problem:unprocessable",
        title: "Unprocessable Content",
        status: 422,
        detail: "The request was structurally valid but rejected by a business rule.",
        instance,
        code: "unprocessable",
        traceId,
      });
    case "unauthenticated":
      return problemResponse({
        type: "urn:shipwithali:problem:unauthenticated",
        title: "Unauthorized",
        status: 401,
        detail: "Valid authentication is required to perform this operation.",
        instance,
        code: "unauthenticated",
        traceId,
      });
    case "forbidden":
      return problemResponse({
        type: "urn:shipwithali:problem:forbidden",
        title: "Forbidden",
        status: 403,
        detail: "This action is not permitted for the current actor.",
        instance,
        code: "forbidden",
        traceId,
      });
    case "not_found":
      return problemResponse({
        type: "urn:shipwithali:problem:not-found",
        title: "Not Found",
        status: 404,
        detail: "The requested resource is not available.",
        instance,
        code: "not_found",
        traceId,
      });
    case "conflict":
      return problemResponse({
        type: "urn:shipwithali:problem:conflict",
        title: "Conflict",
        status: 409,
        detail: "The request conflicts with the current state of the resource.",
        instance,
        code: "conflict",
        traceId,
      });
    case "precondition_failed":
      return problemResponse({
        type: "urn:shipwithali:problem:precondition-failed",
        title: "Precondition Failed",
        status: 412,
        detail: "An optimistic-concurrency precondition for this operation failed.",
        instance,
        code: "failed_precondition",
        traceId,
      });
    case "rate_limited":
      return problemResponse(
        {
          type: "urn:shipwithali:problem:rate-limited",
          title: "Too Many Requests",
          status: 429,
          detail: "The rate limit for this operation was exceeded. Retry later.",
          instance,
          code: "rate_limited",
          traceId,
        },
        { headers: { "retry-after": String(rejection.retryAfterSeconds) } },
      );
    case "temporarily_unavailable":
      return problemResponse({
        type: "urn:shipwithali:problem:temporarily-unavailable",
        title: "Service Unavailable",
        status: 503,
        detail: "A required dependency is temporarily unavailable. Retry later.",
        instance,
        code: "temporarily_unavailable",
        traceId,
      });
    default: {
      const exhaustive: never = rejection;
      throw new Error(
        `Unhandled rejection kind: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Unexpected exceptions: logged with correlation, returned as generic 500.
 *
 * Neither the response nor the log record carries the exception message,
 * stack, filesystem paths, SQL-like text, tokens, cookies, provider
 * payloads, or secret values — only the safe trace identifier and status.
 */
export function internalErrorProblem(
  _error: unknown,
  traceId: string,
  instance: string,
  logger?: Logger,
): Response {
  logger?.error("request.failed", { traceId, status: 500 });
  return problemResponse({
    type: "urn:shipwithali:problem:internal",
    title: "Internal Server Error",
    status: 500,
    detail: "An unexpected error occurred.",
    instance,
    code: "internal_error",
    traceId,
  });
}
