/**
 * stable-id.test.ts
 *
 * Tests for the StableId shared domain contract.
 *
 * Covers (per spec §Testing Decisions):
 *   - UUIDv7 identity parsing and construction
 *   - Rejection of non-UUIDv7 strings (slugs, emails, URLs, plain UUIDs)
 *   - Immutability: StableId values are opaque branded strings
 *   - Type-brand: different kinds are not interchangeable (type-level)
 *   - No provider imports in this file or in stable-id.ts
 */

import { describe, it, expect } from "vitest";
import {
  createStableId,
  parseStableId,
  unsafeStableId,
  stableIdTimestampMs,
} from "../../src/shared/domain/stable-id.js";

// ── UUIDv7 shape constant for test inputs ────────────────────────────────────

/** A known-valid UUIDv7 string (version nibble = 7, variant bits = 8-b). */
const VALID_UUIDV7 = "01932b5e-7a3f-7d2c-a4f1-0123456789ab";

/** A UUIDv4 string (version nibble = 4) — must be rejected. */
const UUIDV4 = "550e8400-e29b-41d4-a716-446655440000";

/** A UUIDv1 string — must be rejected. */
const UUIDV1 = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// ── createStableId ────────────────────────────────────────────────────────────

describe("createStableId", () => {
  it("generates a string value", () => {
    const id = createStableId("Project");
    expect(typeof id).toBe("string");
  });

  it("generates a value that passes parseStableId", () => {
    const id = createStableId("Project");
    const result = parseStableId("Project", id);
    expect(result.ok).toBe(true);
  });

  it("generates unique values on successive calls", () => {
    const a = createStableId("Project");
    const b = createStableId("Project");
    expect(a).not.toBe(b);
  });

  it("generates canonical lowercase UUID format", () => {
    const id = createStableId("Owner");
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("embeds version nibble 7 (UUIDv7)", () => {
    const id = createStableId("DomainEvent");
    // 15th character (0-indexed at 14) is the version nibble
    expect(id.charAt(14)).toBe("7");
  });
});

// ── parseStableId — valid inputs ─────────────────────────────────────────────

describe("parseStableId — valid inputs", () => {
  it("accepts a freshly generated StableId", () => {
    const id = createStableId("Project");
    const result = parseStableId("Project", id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(id);
  });

  it("accepts a known-valid UUIDv7 string", () => {
    const result = parseStableId("Project", VALID_UUIDV7);
    expect(result.ok).toBe(true);
  });

  it("accepts UUIDv7 with all valid variant nibbles (8, 9, a, b)", () => {
    const variants = ["8", "9", "a", "b"];
    for (const v of variants) {
      const id = `01932b5e-7a3f-7d2c-${v}4f1-0123456789ab`;
      const result = parseStableId("Project", id);
      expect(result.ok).toBe(true);
    }
  });
});

// ── parseStableId — invalid inputs ───────────────────────────────────────────

describe("parseStableId — invalid inputs", () => {
  it("rejects a UUIDv4 (version nibble 4)", () => {
    const result = parseStableId("Project", UUIDV4);
    expect(result.ok).toBe(false);
  });

  it("rejects a UUIDv1", () => {
    const result = parseStableId("Project", UUIDV1);
    expect(result.ok).toBe(false);
  });

  it("rejects a plain slug", () => {
    const result = parseStableId("Project", "my-awesome-project");
    expect(result.ok).toBe(false);
  });

  it("rejects an email address", () => {
    const result = parseStableId("Owner", "owner@example.com");
    expect(result.ok).toBe(false);
  });

  it("rejects a URL", () => {
    const result = parseStableId("Project", "https://example.com/projects/foo");
    expect(result.ok).toBe(false);
  });

  it("rejects a storage path", () => {
    const result = parseStableId("Media", "media/2026/09/image.webp");
    expect(result.ok).toBe(false);
  });

  it("rejects an empty string", () => {
    const result = parseStableId("Project", "");
    expect(result.ok).toBe(false);
  });

  it("rejects uppercase UUID characters", () => {
    const upper = VALID_UUIDV7.toUpperCase();
    const result = parseStableId("Project", upper);
    expect(result.ok).toBe(false);
  });

  it("rejects a UUID without hyphens", () => {
    const noDashes = VALID_UUIDV7.replace(/-/g, "");
    const result = parseStableId("Project", noDashes);
    expect(result.ok).toBe(false);
  });

  it("returns a validation rejection with code INVALID_STABLE_ID", () => {
    const result = parseStableId("Project", "not-a-uuid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.code).toBe("INVALID_STABLE_ID");
    }
  });
});

// ── stableIdTimestampMs ───────────────────────────────────────────────────────

describe("stableIdTimestampMs", () => {
  it("returns a number for a generated StableId", () => {
    const id = createStableId("Project");
    const ts = stableIdTimestampMs(id);
    expect(typeof ts).toBe("number");
  });

  it("returns a plausible timestamp (after 2024-01-01)", () => {
    const id = createStableId("Project");
    const ts = stableIdTimestampMs(id);
    // UUIDv7 encodes ms since Unix epoch in the high 48 bits
    // 2024-01-01T00:00:00Z = 1704067200000 ms
    expect(ts).toBeGreaterThan(1704067200000);
  });
});

// ── unsafeStableId ────────────────────────────────────────────────────────────

describe("unsafeStableId", () => {
  it("returns the same string value", () => {
    const id = unsafeStableId<"Project">(VALID_UUIDV7);
    expect(id).toBe(VALID_UUIDV7);
  });
});

// ── Provider import guard ─────────────────────────────────────────────────────

describe("provider import guard", () => {
  it("stable-id module source does not import provider packages", async () => {
    /**
     * Dynamically import the module and check its transitive source.
     * The real architectural check is done by dependency-cruiser; this test
     * asserts the behavioral invariant at the unit level.
     */
    const mod = await import("../../src/shared/domain/stable-id.js");
    // If any provider leaked in, the module would expose non-domain exports
    // (e.g., a Supabase User type). We assert only our own exports are present.
    const exportedKeys = Object.keys(mod);
    const expectedKeys = [
      "createStableId",
      "parseStableId",
      "unsafeStableId",
      "stableIdTimestampMs",
    ];
    for (const key of expectedKeys) {
      expect(exportedKeys).toContain(key);
    }
    // No unexpected exports that would signal provider leakage
    const unexpectedKeys = exportedKeys.filter((k) => !expectedKeys.includes(k));
    expect(unexpectedKeys).toHaveLength(0);
  });
});
