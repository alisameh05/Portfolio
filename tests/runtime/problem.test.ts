/**
 * problem.test.ts — Phase 2 #26
 *
 * Seam under test (pre-agreed): the shared HTTP error boundary observed
 * through standard Response objects.
 *
 * Acceptance (issue #26):
 * - One exhaustive HTTP mapper distinguishes transport failures as 400 and
 *   typed business validation as 422, and maps unauthenticated, forbidden,
 *   not found, conflict, failed precondition, rate limiting with Retry-After,
 *   and temporary unavailability to their declared responses.
 * - Unexpected exceptions are logged with correlation and returned as
 *   generic 500 Problem Details without stacks, paths, SQL-like text,
 *   tokens, cookies, provider payloads, or secret values.
 * - Every Problem Details response carries the required RFC 9457 fields,
 *   stable code, and the same trace identifier used by request and error logs.
 */

import { describe, expect, it } from "vitest";

import { zProblem as zOwnerProblem } from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { zProblem as zPublicProblem } from "../../src/contracts/http/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "../../src/runtime/http/problem.js";

const TRACE_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f";
const INSTANCE = "/api/v1/projects/0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f/reaction";

async function readProblem(response: Response) {
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = (await response.json()) as Record<string, unknown>;
  return body;
}

describe("HTTP problem boundary (#26)", () => {
  it("maps transport failures to 400 with stable validation code", async () => {
    const response = transportProblem("Malformed JSON body.", TRACE_ID, INSTANCE);
    expect(response.status).toBe(400);
    const body = await readProblem(response);
    expect(body["status"]).toBe(400);
    expect(body["code"]).toBe("validation");
    expect(body["traceId"]).toBe(TRACE_ID);
    expect(body["instance"]).toBe(INSTANCE);
    expect(zOwnerProblem.safeParse(body).success).toBe(true);
    expect(zPublicProblem.safeParse(body).success).toBe(true);
  });

  it("maps typed business validation to 422 rather than 400", async () => {
    const response = rejectionToProblem(
      { kind: "validation", code: "REACTION_FORBIDDEN" },
      TRACE_ID,
      INSTANCE,
    );
    expect(response.status).toBe(422);
    const body = await readProblem(response);
    expect(body["code"]).toBe("unprocessable");
    expect(body["traceId"]).toBe(TRACE_ID);
    expect(zOwnerProblem.safeParse(body).success).toBe(true);
    expect(zPublicProblem.safeParse(body).success).toBe(true);
  });

  it.each([
    ["unauthenticated", "AUTH_REQUIRED", 401, "unauthenticated"],
    ["forbidden", "REACTION_FORBIDDEN", 403, "forbidden"],
    ["not_found", "PROJECT_NOT_FOUND", 404, "not_found"],
    ["conflict", "IDEMPOTENCY_CONFLICT", 409, "conflict"],
    ["precondition_failed", "VERSION_MISMATCH", 412, "failed_precondition"],
    ["temporarily_unavailable", "RUNTIME_NOT_IMPLEMENTED", 503, "temporarily_unavailable"],
  ] as const)(
    "maps %s to %i with stable code %s",
    async (kind, code, status, problemCode) => {
      const rejection =
        kind === "conflict" || kind === "precondition_failed"
          ? { kind, code, currentVersion: 3 }
          : { kind, code };
      const response = rejectionToProblem(
        rejection as Parameters<typeof rejectionToProblem>[0],
        TRACE_ID,
        INSTANCE,
      );
      expect(response.status).toBe(status);
      const body = await readProblem(response);
      expect(body["code"]).toBe(problemCode);
      expect(body["traceId"]).toBe(TRACE_ID);
      expect(zOwnerProblem.safeParse(body).success).toBe(true);
    },
  );

  it.each([
    [{ kind: "conflict", code: "MEDIA_IN_USE" }, 409, "MEDIA_IN_USE"],
    [{ kind: "not_found", code: "CURRENT_CV_NOT_FOUND" }, 404, "CURRENT_CV_NOT_FOUND"],
  ] as const)("preserves required Media/CV code %s", async (rejection, status, code) => {
    const response = rejectionToProblem(
      rejection as Parameters<typeof rejectionToProblem>[0],
      TRACE_ID,
      INSTANCE,
    );
    expect(response.status).toBe(status);
    expect((await readProblem(response))["code"]).toBe(code);
  });

  it("maps rate limiting to 429 with a Retry-After header", async () => {
    const response = rejectionToProblem(
      { kind: "rate_limited", code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: 45 },
      TRACE_ID,
      INSTANCE,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("45");
    const body = await readProblem(response);
    expect(body["code"]).toBe("rate_limited");
    expect(body["traceId"]).toBe(TRACE_ID);
    expect(zOwnerProblem.safeParse(body).success).toBe(true);
  });

  it("returns generic 500 without leaking internals and logs with correlation", async () => {
    const logger = createTestLogger();
    const nasty = new Error(
      "boom postgres://user:pass@host/db stack at /app/secret.ts token=tok_123 cookie=session=abc",
    );
    const response = internalErrorProblem(nasty, TRACE_ID, INSTANCE, logger);
    expect(response.status).toBe(500);
    const body = await readProblem(response);
    expect(body["code"]).toBe("internal_error");
    expect(body["traceId"]).toBe(TRACE_ID);
    expect(zOwnerProblem.safeParse(body).success).toBe(true);
    const serialized = JSON.stringify(body);
    for (const leak of [
      "postgres://",
      "/app/secret.ts",
      "tok_123",
      "session=abc",
      "boom",
    ]) {
      expect(serialized).not.toContain(leak);
    }
    const logs = JSON.stringify(logger.records);
    expect(logs).toContain(TRACE_ID);
    for (const leak of ["postgres://", "/app/secret.ts", "tok_123", "session=abc"]) {
      expect(logs).not.toContain(leak);
    }
  });

  it("carries RFC 9457 fields and the request trace identifier on every response", async () => {
    for (const response of [
      transportProblem("Bad input.", TRACE_ID, INSTANCE),
      rejectionToProblem({ kind: "not_found", code: "PROJECT_NOT_FOUND" }, TRACE_ID, INSTANCE),
      internalErrorProblem(new Error("x"), TRACE_ID, INSTANCE, createTestLogger()),
    ]) {
      const body = await readProblem(response);
      for (const field of ["type", "title", "status", "detail", "instance", "code", "traceId"]) {
        expect(body[field], `field ${field}`).toBeDefined();
      }
      expect(body["traceId"]).toBe(TRACE_ID);
      expect(typeof body["type"]).toBe("string");
      expect(body["type"] as string).toMatch(/^urn:shipwithali:problem:[a-z0-9-]+$/);
    }
  });
});
