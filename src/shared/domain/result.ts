/**
 * result.ts — Shared Domain Contract
 *
 * Typed result union for expected business outcomes and rejections.
 *
 * INVARIANTS (from spec §Shared domain contracts):
 *   - Result<T> carries expected business rejection; it is NOT for exceptions.
 *   - Programmer defects and infrastructure faults remain exceptions at the
 *     adapter boundary, are logged with a correlation ID, and become generic
 *     Problem Details without leaking internals.
 *   - The Ok and Err branches are discriminated by the `ok` boolean flag.
 *
 * This module has NO imports (it is a primitive dependency).
 */

// ── Result union ─────────────────────────────────────────────────────────────

/** A successful result carrying a value of type T. */
export type Ok<T> = { readonly ok: true; readonly value: T };

/** A failed result carrying a rejection of type E. */
export type Err<E> = { readonly ok: false; readonly error: E };

/**
 * Discriminated union representing an expected business outcome.
 *
 * `E` defaults to `Rejection` (imported by callers); callers can narrow it to
 * a subset of the rejection union when only certain failure kinds are possible.
 *
 * @example
 * function submit(cmd: SubmitFeedbackCommand): Result<FeedbackId> { ... }
 */
export type Result<T, E = never> = Ok<T> | Err<E>;

// ── Constructors ─────────────────────────────────────────────────────────────

/**
 * Construct an Ok result.
 *
 * @example
 * return ok(feedbackId);
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Construct an Err result.
 *
 * @example
 * return err({ kind: "not_found", code: "PROJECT_NOT_FOUND" });
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

// ── Narrowing helpers ─────────────────────────────────────────────────────────

/** Type guard: is the result a success? */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok === true;
}

/** Type guard: is the result a failure? */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return result.ok === false;
}
