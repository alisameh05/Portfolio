/**
 * idempotency-key.test.ts
 *
 * Tests for the IdempotencyKey shared domain contract.
 *
 * Covers (per spec §Testing Decisions):
 *   - Accepts 1-char and 128-char visible ASCII
 *   - Rejects empty string (length 0)
 *   - Rejects 129-char string (one over the limit)
 *   - Rejects non-visible-ASCII characters (space, tab, null, 0x7F)
 *   - Error shape: kind="validation", code="INVALID_IDEMPOTENCY_KEY"
 *   - Constants are exported and match the validation rules
 */

import { describe, it, expect } from "vitest";
import {
  parseIdempotencyKey,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from "../../src/shared/domain/idempotency-key.js";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("MIN_LENGTH is 1", () => {
    expect(IDEMPOTENCY_KEY_MIN_LENGTH).toBe(1);
  });

  it("MAX_LENGTH is 128", () => {
    expect(IDEMPOTENCY_KEY_MAX_LENGTH).toBe(128);
  });
});

// ── Valid inputs ──────────────────────────────────────────────────────────────

describe("parseIdempotencyKey — valid inputs", () => {
  it("accepts a single visible ASCII character", () => {
    const result = parseIdempotencyKey("a");
    expect(result.ok).toBe(true);
  });

  it("accepts exactly 128 visible ASCII characters", () => {
    const key = "a".repeat(128);
    const result = parseIdempotencyKey(key);
    expect(result.ok).toBe(true);
  });

  it("accepts a typical UUID-shaped key", () => {
    const result = parseIdempotencyKey(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a key with all visible ASCII characters (0x21–0x7E)", () => {
    // Build a string covering the full visible ASCII range
    const visibleAscii = Array.from({ length: 94 }, (_, i) =>
      String.fromCharCode(0x21 + i),
    ).join("");
    const result = parseIdempotencyKey(visibleAscii);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(visibleAscii);
  });

  it("accepts an alphanumeric key", () => {
    const result = parseIdempotencyKey("req-2026-09-16-abc123");
    expect(result.ok).toBe(true);
  });

  it("accepts special visible ASCII characters like !#$%&", () => {
    const result = parseIdempotencyKey("!#$%&'()*+,-./:;<=>?@");
    expect(result.ok).toBe(true);
  });

  it("returns the original string as the typed key value", () => {
    const raw = "my-idempotency-key-01";
    const result = parseIdempotencyKey(raw);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(raw);
  });
});

// ── Invalid inputs: length ────────────────────────────────────────────────────

describe("parseIdempotencyKey — invalid: length", () => {
  it("rejects an empty string", () => {
    const result = parseIdempotencyKey("");
    expect(result.ok).toBe(false);
  });

  it("rejects a 129-character string", () => {
    const key = "a".repeat(129);
    const result = parseIdempotencyKey(key);
    expect(result.ok).toBe(false);
  });

  it("rejects a very long string", () => {
    const key = "x".repeat(1000);
    const result = parseIdempotencyKey(key);
    expect(result.ok).toBe(false);
  });

  it("returns length reason in details on empty input", () => {
    const result = parseIdempotencyKey("");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
    }
  });
});

// ── Invalid inputs: non-visible ASCII ────────────────────────────────────────

describe("parseIdempotencyKey — invalid: non-visible-ASCII characters", () => {
  it("rejects a space character (0x20)", () => {
    const result = parseIdempotencyKey("hello world");
    expect(result.ok).toBe(false);
  });

  it("rejects a tab character (0x09)", () => {
    const result = parseIdempotencyKey("hello\tworld");
    expect(result.ok).toBe(false);
  });

  it("rejects a null character (0x00)", () => {
    const result = parseIdempotencyKey("hello\x00world");
    expect(result.ok).toBe(false);
  });

  it("rejects the DEL character (0x7F)", () => {
    const result = parseIdempotencyKey("hello\x7Fworld");
    expect(result.ok).toBe(false);
  });

  it("rejects a newline character", () => {
    const result = parseIdempotencyKey("hello\nworld");
    expect(result.ok).toBe(false);
  });

  it("rejects a carriage return", () => {
    const result = parseIdempotencyKey("hello\rworld");
    expect(result.ok).toBe(false);
  });

  it("rejects a Unicode character (beyond ASCII)", () => {
    const result = parseIdempotencyKey("key-\u00e9");
    expect(result.ok).toBe(false);
  });

  it("returns non-visible-ascii reason in details", () => {
    const result = parseIdempotencyKey("key with space");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
      expect(result.error.details).toBeDefined();
      expect((result.error.details as Record<string, unknown>)["reason"]).toBe(
        "non-visible-ascii",
      );
    }
  });
});

// ── Error shape ───────────────────────────────────────────────────────────────

describe("parseIdempotencyKey — error shape", () => {
  it("error.kind is 'validation'", () => {
    const result = parseIdempotencyKey("");
    if (!result.ok) expect(result.error.kind).toBe("validation");
  });

  it("error.code is 'INVALID_IDEMPOTENCY_KEY'", () => {
    const result = parseIdempotencyKey("");
    if (!result.ok) expect(result.error.code).toBe("INVALID_IDEMPOTENCY_KEY");
  });

  it("error.details is defined", () => {
    const result = parseIdempotencyKey("");
    if (!result.ok) expect(result.error.details).toBeDefined();
  });
});
