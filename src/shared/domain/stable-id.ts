/**
 * stable-id.ts — Shared Domain Contract
 *
 * Defines opaque, immutable, UUIDv7-backed stable identities.
 *
 * INVARIANTS (from spec §Shared domain contracts):
 *   - A StableId is generated before persistence, never after.
 *   - Slugs, URLs, email addresses, provider keys, and storage paths
 *     are NEVER used as a domain identity.
 *   - StableId values are immutable after creation.
 *
 * This module imports ONLY the uuidv7 package and the Result/Rejection
 * contracts from this same shared/domain directory.
 * It MUST NOT import Next.js, Supabase, Kysely, Vercel, OpenAPI, or any
 * other provider or framework type.
 */

import { uuidv7, uuidv7obj } from "uuidv7";
import type { Result } from "./result.js";
import type { Rejection } from "./rejection.js";

// ── Brand ────────────────────────────────────────────────────────────────────

declare const _stableIdBrand: unique symbol;

/**
 * An opaque, branded string carrying a UUIDv7 value.
 *
 * The type parameter `TKind` encodes the aggregate kind so that, for example,
 * a `StableId<"Project">` cannot be accidentally passed where a
 * `StableId<"Owner">` is expected.
 */
export type StableId<TKind extends string> = string & {
  readonly [_stableIdBrand]: TKind;
};

// ── UUIDv7 regex ─────────────────────────────────────────────────────────────

/**
 * Matches the canonical lowercase UUIDv7 string format:
 *   xxxxxxxx-xxxx-7xxx-yxxx-xxxxxxxxxxxx
 * where y is 8, 9, a, or b (variant bits).
 */
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Generate a new opaque StableId for the given aggregate kind.
 *
 * Use this BEFORE writing to persistence. Never construct a StableId from
 * an existing slug, URL, email, provider key, or storage path.
 *
 * @example
 * const projectId = createStableId("Project");
 */
export function createStableId<TKind extends string>(
  _kind: TKind,
): StableId<TKind> {
  return uuidv7() as StableId<TKind>;
}

// ── Parsing / validation ─────────────────────────────────────────────────────

/**
 * Parse and validate an untrusted string as a StableId of the given kind.
 *
 * Returns `ok(stableId)` when the input is a canonical lowercase UUIDv7.
 * Returns `err(rejection)` with code `"INVALID_STABLE_ID"` otherwise.
 *
 * Transport adapters use this to convert raw request strings into typed
 * identities before passing them to application or domain code.
 *
 * @example
 * const result = parseStableId("Project", rawId);
 * if (!result.ok) { ... }
 */
export function parseStableId<TKind extends string>(
  kind: TKind,
  value: string,
): Result<StableId<TKind>, Extract<Rejection, { kind: "validation" }>> {
  if (typeof value !== "string" || !UUID_V7_RE.test(value)) {
    return {
      ok: false,
      error: {
        kind: "validation",
        code: "INVALID_STABLE_ID",
        details: { expectedKind: kind, received: typeof value },
      },
    };
  }
  return { ok: true, value: value as StableId<TKind> };
}

/**
 * Type-level helper: assert that a string is a StableId without runtime cost.
 *
 * Use ONLY in tests or trusted composition roots where the value has already
 * been validated. Never use in production domain or application code.
 */
export function unsafeStableId<TKind extends string>(
  value: string,
): StableId<TKind> {
  return value as StableId<TKind>;
}

// ── Introspection (no provider dependency) ───────────────────────────────────

/**
 * Extract the millisecond timestamp embedded in a UUIDv7 StableId.
 *
 * Returns undefined if the id is not a valid UUIDv7 (should not happen in
 * practice after parseStableId succeeds).
 */
export function stableIdTimestampMs(id: StableId<string>): number | undefined {
  try {
    const obj = uuidv7obj();
    // uuidv7obj parses from the string representation
    void obj;
    // Parse manually: first 48 bits = ms timestamp
    const hex = id.replace(/-/g, "").slice(0, 12);
    const ms = parseInt(hex, 16);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}
