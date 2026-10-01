/**
 * actor.ts — Shared Domain Contract
 *
 * Defines the provider-neutral ActorContext union.
 *
 * INVARIANTS (from spec §Shared domain contracts):
 *   - ActorContext is constructed ONLY by an identity adapter.
 *   - Domain and application code ACCEPTS ActorContext but NEVER parses:
 *       cookies, JWTs, IP addresses, Supabase claims, or request headers.
 *   - The union is CLOSED. A new actor kind requires a spec change.
 *   - No Supabase user type, no Next.js Request type, no JWT library type
 *     may appear in this file or in any type reachable from it.
 *
 * This module imports ONLY from ./stable-id.ts within this shared/domain
 * directory. It MUST NOT import Next.js, Supabase, Kysely, Vercel, OpenAPI,
 * or any other provider or framework type.
 */

import type { StableId } from "./stable-id.js";

// ── Actor union ──────────────────────────────────────────────────────────────

/**
 * The authenticated portfolio owner.
 *
 * `ownerId` is the stable domain identity of the owner (not a Supabase user ID).
 * `sessionId` is an opaque string from the identity adapter — domain code must
 * not parse, decode, or validate it.
 */
export type OwnerActor = {
  readonly kind: "owner";
  readonly ownerId: StableId<"Owner">;
  /** Opaque session reference — domain code must not parse this. */
  readonly sessionId: string;
};

/**
 * An anonymous or pseudonymous visitor.
 *
 * `functionalId` is present only when needed for a permitted interaction
 * (reaction, rating, feedback) and the identity adapter has issued or
 * recognized a purpose-limited functional ID. It is independent of
 * Measurement consent per ADR-0015: declining Measurement does not disable
 * functional identity, and ordinary reads create no functional ID.
 * Domain code must not derive it from cookies, headers, or IP addresses.
 *
 * `consent` reflects the visitor's current Measurement consent
 * (`granted` enables Measurement identity issuance/use; `denied`/`unknown`
 * yield no usable Measurement identity). It never gates functional identity.
 */
export type VisitorActor = {
  readonly kind: "visitor";
  readonly functionalId?: StableId<"FunctionalVisitor">;
  readonly consent: "granted" | "denied" | "unknown";
};

/**
 * A scheduled or background system job.
 *
 * `jobId` is the stable identity of the job claim from the operations module.
 * `purpose` is a human-readable description of the job for logging only.
 */
export type SystemActor = {
  readonly kind: "system";
  readonly jobId: StableId<"Job">;
  readonly purpose: string;
};

/**
 * Provider-neutral actor context.
 *
 * This is the ONLY actor representation permitted in domain and application
 * code. Identity adapters construct it; no other code may.
 *
 * @example
 * function authorizeOwner(actor: ActorContext): Result<void, ForbiddenRejection> {
 *   if (actor.kind !== "owner") {
 *     return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
 *   }
 *   return ok(undefined);
 * }
 */
export type ActorContext = OwnerActor | VisitorActor | SystemActor;

// ── Narrowing helpers ─────────────────────────────────────────────────────────

/** Type guard: is this actor the portfolio owner? */
export function isOwner(actor: ActorContext): actor is OwnerActor {
  return actor.kind === "owner";
}

/** Type guard: is this actor a visitor? */
export function isVisitor(actor: ActorContext): actor is VisitorActor {
  return actor.kind === "visitor";
}

/** Type guard: is this actor a system job? */
export function isSystem(actor: ActorContext): actor is SystemActor {
  return actor.kind === "system";
}

// ── Exhaustiveness helper ─────────────────────────────────────────────────────

/**
 * Compile-time exhaustiveness check for ActorContext switches.
 *
 * Call this in the `default` branch of a switch on `actor.kind`.
 * TypeScript will error if any union member is not handled.
 *
 * @example
 * switch (actor.kind) {
 *   case "owner": ...
 *   case "visitor": ...
 *   case "system": ...
 *   default: assertNeverActor(actor);
 * }
 */
export function assertNeverActor(actor: never): never {
  throw new Error(
    `Unhandled actor kind: ${JSON.stringify(actor satisfies never)}`,
  );
}
