import { describe, expect, it } from "vitest";

import {
  canonicalizeRequest,
  hashCanonicalRequest,
} from "../../src/shared/application/idempotency.js";
import {
  createPhase2TransactionFake,
  requestTransactionRollback,
} from "../../src/runtime/fakes/transaction.js";
import {
  parseSafeErrorCode,
  validateVersionedPayload,
} from "../../src/modules/portability-operations/application/persistence.js";

describe("Phase 3 provider-neutral persistence contracts (#48-#52)", () => {
  it("passes one opaque transaction context and honors explicit rollback outcomes", async () => {
    const runner = createPhase2TransactionFake();
    let observed: unknown;
    const result = await runner.run((context) => {
      observed = context;
      return requestTransactionRollback("rolled-back");
    });

    expect(result).toBe("rolled-back");
    expect(observed).toEqual({ kind: "transaction" });
    expect(Object.isFrozen(observed)).toBe(true);
  });

  it("canonicalizes validated request objects deterministically", async () => {
    const left = {
      z: [3, { b: true, a: null }],
      a: "مرحبا",
    };
    const right = {
      a: "مرحبا",
      z: [3, { a: null, b: true }],
    };

    expect(canonicalizeRequest(left)).toBe(
      '{"a":"مرحبا","z":[3,{"a":null,"b":true}]}',
    );
    expect(await hashCanonicalRequest(left)).toBe(await hashCanonicalRequest(right));
    expect(await hashCanonicalRequest({ value: null })).not.toBe(
      await hashCanonicalRequest({}),
    );
  });

  it("validates versioned payloads and rejects secret-bearing fields", () => {
    expect(
      validateVersionedPayload({
        type: "portfolio.cache.refresh",
        version: 1,
        value: { projectId: "018f4f7d-0000-7000-8000-000000000001" },
      }),
    ).toEqual({
      type: "portfolio.cache.refresh",
      version: 1,
      value: { projectId: "018f4f7d-0000-7000-8000-000000000001" },
    });

    expect(() =>
      validateVersionedPayload({
        type: "unsafe.payload",
        version: 1,
        value: { accessToken: "secret" },
      }),
    ).toThrow(/sensitive/i);
    expect(() =>
      validateVersionedPayload({ type: "unsafe.payload", version: 0, value: {} }),
    ).toThrow(/version/i);
  });

  it("accepts only bounded machine-safe operational error codes", () => {
    expect(parseSafeErrorCode("DELIVERY_TIMEOUT")).toBe("DELIVERY_TIMEOUT");
    for (const unsafe of [
      "password=hunter2",
      "postgres connection failed",
      "Bearer secret-token",
      "x".repeat(65),
    ]) {
      expect(() => parseSafeErrorCode(unsafe)).toThrow(/safe error code/i);
    }
  });
});
