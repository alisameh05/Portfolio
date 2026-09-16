/**
 * idempotency-key.ts — Shared Domain Contract
 *
 * Defines the opaque IdempotencyKey type and its validation rule.
 *
 * INVARIANTS (from spec §Shared domain contracts):
 *   - An IdempotencyKey is an OPAQUE client-supplied value of 1–128 visible
 *     ASCII characters (codepoints 0x21–0x7E, i.e. printable, non-space).
 *   - The server scopes the key by operation and actor, stores a canonical
 *     request hash, and returns the original result on an exact replay.
 *   - Reuse with a different canonical request hash is a `conflict` rejection.
 *   - The key value itself carries no semantic meaning inside the domain.
 *
 * This module imports ONLY from ./result.ts and ./rejection.ts within this
 * same shared/domain directory.
 * It MUST NOT import Next.js, Supabase, Kysely, Vercel, OpenAPI, or any other
 * provider or framework type.
 */

import type { Result } from "./result.js";
import type { ValidationRejection } from "./rejection.js";

// ── Brand ────────────────────────────────────────────────────────────────────

declare const _idempotencyKeyBrand: unique symbol;

/**
 * An opaque string carrying a validated idempotency key.
 *
 * Must be constructed only via `parseIdempotencyKey`.
 */
export type IdempotencyKey = string & {
  readonly [_idempotencyKeyBrand]: "IdempotencyKey";
};

// ── Validation constants ──────────────────────────────────────────────────────

/** Minimum length of a valid IdempotencyKey (inclusive). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;

/** Maximum length of a valid IdempotencyKey (inclusive). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * Matches visible ASCII only (0x21–0x7E: printable non-whitespace characters).
 * Spaces (0x20) and control characters (0x00–0x1F, 0x7F) are rejected.
 */
const VISIBLE_ASCII_RE = /^[\x21-\x7E]+$/;

// ── Parsing / validation ─────────────────────────────────────────────────────

/**
 * Validate and parse an untrusted string as an IdempotencyKey.
 *
 * Returns `ok(key)` when the value is 1–128 visible ASCII characters.
 * Returns `err(rejection)` with code `"INVALID_IDEMPOTENCY_KEY"` otherwise.
 *
 * Transport adapters call this on incoming `Idempotency-Key` header values
 * before passing them to application code.
 *
 * @example
 * const result = parseIdempotencyKey(req.headers["idempotency-key"] ?? "");
 * if (!result.ok) { return transportError(result.error); }
 */
export function parseIdempotencyKey(
  value: string,
): Result<IdempotencyKey, ValidationRejection> {
  if (
    typeof value !== "string" ||
    value.length < IDEMPOTENCY_KEY_MIN_LENGTH ||
    value.length > IDEMPOTENCY_KEY_MAX_LENGTH
  ) {
    return {
      ok: false,
      error: {
        kind: "validation",
        code: "INVALID_IDEMPOTENCY_KEY",
        details: {
          reason: "length",
          minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
          maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
          received: typeof value === "string" ? value.length : typeof value,
        },
      },
    };
  }

  if (!VISIBLE_ASCII_RE.test(value)) {
    return {
      ok: false,
      error: {
        kind: "validation",
        code: "INVALID_IDEMPOTENCY_KEY",
        details: {
          reason: "non-visible-ascii",
          description:
            "IdempotencyKey must contain only visible ASCII characters (0x21–0x7E)",
        },
      },
    };
  }

  return { ok: true, value: value as IdempotencyKey };
}
