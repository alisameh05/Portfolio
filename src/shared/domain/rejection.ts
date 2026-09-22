/**
 * rejection.ts — Shared Domain Contract
 *
 * Closed union of expected business rejection kinds.
 *
 * INVARIANTS (from spec §Shared domain contracts):
 *   - The rejection union is CLOSED. Adding a rejection kind without a
 *     corresponding adapter mapping must fail contract verification
 *     (the exhaustive HTTP mapper lives at the transport seam).
 *   - `code` is a STABLE MACHINE VALUE. Human detail is produced at the
 *     transport seam and MUST NOT be used for control flow.
 *   - Rejection represents EXPECTED business outcomes only. Infrastructure
 *     faults and programmer defects propagate as exceptions.
 *
 * The union is transport-neutral: HTTP status, headers, titles, detail, and
 * Problem types are adapter concerns (see `src/runtime/http/problem.ts`).
 * No HTTP mapping lives in this module.
 *
 * This module imports ONLY from ./result.ts within this shared/domain directory.
 * It MUST NOT import Next.js, Supabase, Kysely, Vercel, OpenAPI, or any other
 * provider or framework type.
 */

// ── Rejection union ──────────────────────────────────────────────────────────

/** Input failed structural or business validation. */
export type ValidationRejection = {
  readonly kind: "validation";
  /** Stable machine code. Example: "IDEMPOTENCY_KEY_TOO_LONG" */
  readonly code: string;
  /** Optional field-level details — safe, no internal paths or stack traces. */
  readonly details?: Readonly<Record<string, unknown>>;
};

/** No valid authentication credential was provided. */
export type UnauthenticatedRejection = {
  readonly kind: "unauthenticated";
  readonly code: string;
};

/** Authenticated actor lacks authorization for this operation. */
export type ForbiddenRejection = {
  readonly kind: "forbidden";
  readonly code: string;
};

/** The requested aggregate or resource does not exist. */
export type NotFoundRejection = {
  readonly kind: "not_found";
  readonly code: string;
};

/**
 * An idempotency, identity, slug, or invalid-transition conflict.
 *
 * `currentVersion` is present when the conflict is an optimistic-concurrency
 * version mismatch surfaced at the application layer before the DB write.
 */
export type ConflictRejection = {
  readonly kind: "conflict";
  readonly code: string;
  readonly currentVersion?: number;
};

/**
 * Optimistic concurrency or If-Match failure on an existing aggregate.
 *
 * Commands that update an existing aggregate carry an `expectedVersion`.
 * A mismatch returns `precondition_failed` and NEVER partially changes state.
 */
export type PreconditionFailedRejection = {
  readonly kind: "precondition_failed";
  readonly code: string;
  readonly currentVersion?: number;
};

/**
 * The actor has exceeded an operation rate limit.
 *
 * `retryAfterSeconds` MUST be present and MUST be forwarded as a `Retry-After`
 * header at the transport seam.
 */
export type RateLimitedRejection = {
  readonly kind: "rate_limited";
  readonly code: string;
  readonly retryAfterSeconds: number;
};

/** A transient dependency or readiness failure; safe to retry later. */
export type TemporarilyUnavailableRejection = {
  readonly kind: "temporarily_unavailable";
  readonly code: string;
};

/**
 * Closed union of all expected business rejection kinds.
 *
 * TypeScript's exhaustiveness checks (`switch (rejection.kind)`) enforce that
 * every transport adapter handles every branch.
 */
export type Rejection =
  | ValidationRejection
  | UnauthenticatedRejection
  | ForbiddenRejection
  | NotFoundRejection
  | ConflictRejection
  | PreconditionFailedRejection
  | RateLimitedRejection
  | TemporarilyUnavailableRejection;
