/**
 * rejection.test.ts — Phase 2 #26
 *
 * Tests for the Rejection shared domain contract.
 *
 * Covers (per spec §Testing Decisions):
 *   - Union exhaustiveness: all 8 rejection kinds handled
 *   - Transport neutrality: no HTTP status mapping lives in shared domain
 *     (mapping moved to the runtime HTTP boundary in #26)
 *   - Machine-code stability and required properties
 *   - Rate limited Retry-After requirement
 *   - Precondition failed optimistic concurrency metadata
 *   - Zero provider imports guard
 */

import { describe, expect, it } from "vitest";
import type {
  ConflictRejection,
  ForbiddenRejection,
  NotFoundRejection,
  PreconditionFailedRejection,
  RateLimitedRejection,
  Rejection,
  TemporarilyUnavailableRejection,
  UnauthenticatedRejection,
  ValidationRejection,
} from "../../src/shared/domain/rejection.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Rejection domain contract", () => {
  describe("transport neutrality (#26)", () => {
    it("owns no HTTP status mapping", () => {
      const filePath = resolve(__dirname, "../../src/shared/domain/rejection.ts");
      const content = readFileSync(filePath, "utf-8");
      expect(content).not.toMatch(/rejectionToHttpStatus/);
      expect(content).not.toMatch(/return\s+40\d|return\s+41\d|return\s+42\d|return\s+50\d/);
      expect(content).not.toMatch(/→\s*40\d|→\s*50\d/);
    });

    it("is not re-exported with an HTTP helper from the barrel", () => {
      const barrelPath = resolve(__dirname, "../../src/shared/domain/index.ts");
      const content = readFileSync(barrelPath, "utf-8");
      expect(content).not.toMatch(/rejectionToHttpStatus/);
    });

    it("keeps the closed 8-kind union", () => {
      const kinds: Array<Rejection["kind"]> = [
        "validation",
        "unauthenticated",
        "forbidden",
        "not_found",
        "conflict",
        "precondition_failed",
        "rate_limited",
        "temporarily_unavailable",
      ];
      expect(new Set(kinds).size).toBe(8);
      // Compile-time exhaustiveness: adding a ninth kind breaks this switch.
      for (const kind of kinds) {
        switch (kind) {
          case "validation":
          case "unauthenticated":
          case "forbidden":
          case "not_found":
          case "conflict":
          case "precondition_failed":
          case "rate_limited":
          case "temporarily_unavailable":
            break;
          default: {
            const exhaustive: never = kind;
            throw new Error(`Unhandled rejection kind: ${String(exhaustive)}`);
          }
        }
      }
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

    it("validation rejects without carrying HTTP semantics", () => {
      const rej: ValidationRejection = {
        kind: "validation",
        code: "INVALID_INPUT",
        details: { field: "email" },
      };
      expect(rej.kind).toBe("validation");
      expect(rej).not.toHaveProperty("status");
      expect(rej).not.toHaveProperty("title");
    });

    it("unauthenticated and forbidden stay distinct without HTTP status", () => {
      const unauth: UnauthenticatedRejection = {
        kind: "unauthenticated",
        code: "AUTH_REQUIRED",
      };
      const forbid: ForbiddenRejection = {
        kind: "forbidden",
        code: "ACCESS_DENIED",
      };
      expect(unauth.kind).not.toBe(forbid.kind);
    });

    it("not_found carries no HTTP status", () => {
      const rej: NotFoundRejection = {
        kind: "not_found",
        code: "RESOURCE_NOT_FOUND",
      };
      expect(rej).not.toHaveProperty("status");
    });

    it("conflict optionally includes currentVersion", () => {
      const rej: ConflictRejection = {
        kind: "conflict",
        code: "SLUG_ALREADY_EXISTS",
        currentVersion: 3,
      };
      expect(rej.currentVersion).toBe(3);
    });

    it("maps precondition_failed to optimistic-concurrency metadata only", () => {
      const withVersion: PreconditionFailedRejection = {
        kind: "precondition_failed",
        code: "CONCURRENCY_VERSION_MISMATCH",
        currentVersion: 5,
      };
      const withoutVersion: PreconditionFailedRejection = {
        kind: "precondition_failed",
        code: "PRECONDITION_UNMET",
      };

      expect(withVersion.currentVersion).toBe(5);
      expect(withoutVersion.currentVersion).toBeUndefined();
    });

    it("rate_limited requires a non-negative retryAfterSeconds", () => {
      const rej: RateLimitedRejection = {
        kind: "rate_limited",
        code: "TOO_MANY_REQUESTS",
        retryAfterSeconds: 120,
      };
      expect(rej.retryAfterSeconds).toBeGreaterThanOrEqual(0);
    });

    it("temporarily_unavailable carries a stable machine code", () => {
      const rej: TemporarilyUnavailableRejection = {
        kind: "temporarily_unavailable",
        code: "RUNTIME_NOT_IMPLEMENTED",
      };
      expect(rej.code).toBe("RUNTIME_NOT_IMPLEMENTED");
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
