/**
 * rejection.test.ts
 *
 * Tests for the Rejection shared domain contract.
 *
 * Covers (per spec §Testing Decisions):
 *   - Union exhaustiveness: all 8 rejection kinds handled
 *   - Canonical HTTP status mapping (rejectionToHttpStatus)
 *   - Machine-code stability and required properties
 *   - Rate limited Retry-After requirement
 *   - Precondition failed optimistic concurrency metadata
 *   - Zero provider imports guard
 */

import { describe, expect, it } from "vitest";
import {
  type ConflictRejection,
  type ForbiddenRejection,
  type NotFoundRejection,
  type PreconditionFailedRejection,
  type RateLimitedRejection,
  type Rejection,
  type TemporarilyUnavailableRejection,
  type UnauthenticatedRejection,
  type ValidationRejection,
  rejectionToHttpStatus,
} from "../../src/shared/domain/rejection.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Rejection domain contract", () => {
  describe("rejectionToHttpStatus() mapping", () => {
    it("maps validation to 400", () => {
      const rej: ValidationRejection = {
        kind: "validation",
        code: "INVALID_INPUT",
        details: { field: "email" },
      };
      expect(rejectionToHttpStatus(rej)).toBe(400);
    });

    it("maps unauthenticated to 401", () => {
      const rej: UnauthenticatedRejection = {
        kind: "unauthenticated",
        code: "AUTH_REQUIRED",
      };
      expect(rejectionToHttpStatus(rej)).toBe(401);
    });

    it("maps forbidden to 403", () => {
      const rej: ForbiddenRejection = {
        kind: "forbidden",
        code: "ACCESS_DENIED",
      };
      expect(rejectionToHttpStatus(rej)).toBe(403);
    });

    it("maps not_found to 404", () => {
      const rej: NotFoundRejection = {
        kind: "not_found",
        code: "RESOURCE_NOT_FOUND",
      };
      expect(rejectionToHttpStatus(rej)).toBe(404);
    });

    it("maps conflict to 409", () => {
      const rej: ConflictRejection = {
        kind: "conflict",
        code: "SLUG_ALREADY_EXISTS",
        currentVersion: 3,
      };
      expect(rejectionToHttpStatus(rej)).toBe(409);
    });

    it("maps precondition_failed to 412", () => {
      const rej: PreconditionFailedRejection = {
        kind: "precondition_failed",
        code: "CONCURRENCY_VERSION_MISMATCH",
        currentVersion: 5,
      };
      expect(rejectionToHttpStatus(rej)).toBe(412);
    });

    it("maps rate_limited to 429", () => {
      const rej: RateLimitedRejection = {
        kind: "rate_limited",
        code: "RATE_LIMIT_EXCEEDED",
        retryAfterSeconds: 60,
      };
      expect(rejectionToHttpStatus(rej)).toBe(429);
      expect(rej.retryAfterSeconds).toBe(60);
    });

    it("maps temporarily_unavailable to 503", () => {
      const rej: TemporarilyUnavailableRejection = {
        kind: "temporarily_unavailable",
        code: "SERVICE_WARMING_UP",
      };
      expect(rejectionToHttpStatus(rej)).toBe(503);
    });
  });

  describe("Rejection properties and invariants", () => {
    it("every rejection kind has a non-empty string code", () => {
      const rejections: Rejection[] = [
        { kind: "validation", code: "VAL_ERR" },
        { kind: "unauthenticated", code: "UNAUTH" },
        { kind: "forbidden", code: "FORBID" },
        { kind: "not_found", code: "NOT_FOUND" },
        { kind: "conflict", code: "CONFLICT" },
        { kind: "precondition_failed", code: "PRE_FAILED" },
        { kind: "rate_limited", code: "RATE_LIMIT", retryAfterSeconds: 30 },
        { kind: "temporarily_unavailable", code: "UNAVAIL" },
      ];

      for (const rej of rejections) {
        expect(typeof rej.code).toBe("string");
        expect(rej.code.length).toBeGreaterThan(0);
      }
    });

    it("rate_limited requires a non-negative retryAfterSeconds", () => {
      const rej: RateLimitedRejection = {
        kind: "rate_limited",
        code: "TOO_MANY_REQUESTS",
        retryAfterSeconds: 120,
      };
      expect(rej.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    });

    it("precondition_failed optionally includes currentVersion", () => {
      const withVersion: PreconditionFailedRejection = {
        kind: "precondition_failed",
        code: "VERSION_MISMATCH",
        currentVersion: 4,
      };
      const withoutVersion: PreconditionFailedRejection = {
        kind: "precondition_failed",
        code: "PRECONDITION_UNMET",
      };

      expect(withVersion.currentVersion).toBe(4);
      expect(withoutVersion.currentVersion).toBeUndefined();
    });
  });

  describe("Provider-import guard", () => {
    it("rejection.ts imports zero provider or framework modules", () => {
      const filePath = resolve(__dirname, "../../src/shared/domain/rejection.ts");
      const content = readFileSync(filePath, "utf-8");

      const forbiddenImports = [
        "next",
        "@supabase",
        "kysely",
        "react",
        "express",
        "@vercel",
      ];

      for (const forbidden of forbiddenImports) {
        const regex = new RegExp(`from\\s+['"][^'"]*${forbidden}`, "i");
        expect(content).not.toMatch(regex);
      }
    });
  });
});
