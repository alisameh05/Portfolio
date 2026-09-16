/**
 * domain-event.ts — Shared Domain Contract
 *
 * Defines versioned, immutable Domain events with full provenance metadata.
 *
 * INVARIANTS (from spec §Shared domain contracts):
 *   - Domain events are IMMUTABLE FACTS. The payload is Readonly<TPayload>.
 *   - `eventType` and `schemaVersion` evolve independently.
 *   - Consumers MUST:
 *       - Reject unknown MAJOR schema semantics.
 *       - Tolerate additive (new) fields in known schemas.
 *       - Deduplicate by `eventId`.
 *   - `occurredAt` is an RFC 3339 UTC instant supplied by a Clock port —
 *     domain code NEVER calls Date.now() or new Date() directly.
 *   - Commands that update an existing aggregate carry an `expectedVersion`.
 *     A mismatch returns `precondition_failed` and NEVER partially changes state.
 *
 * This module imports ONLY from ./stable-id.ts within this shared/domain
 * directory. It MUST NOT import Next.js, Supabase, Kysely, Vercel, OpenAPI,
 * or any other provider or framework type.
 */

import type { StableId } from "./stable-id.js";

// ── Domain event ─────────────────────────────────────────────────────────────

/**
 * An immutable, versioned Domain event.
 *
 * @typeParam TType    - Discriminant string literal for the event type.
 *                       Example: "project.published"
 * @typeParam TPayload - Shape of the event-specific data. Will be Readonly.
 *
 * @example
 * type ProjectPublishedEvent = DomainEvent<
 *   "project.published",
 *   { readonly projectId: StableId<"Project">; readonly language: string }
 * >;
 */
export interface DomainEvent<TType extends string, TPayload> {
  /**
   * Stable, globally unique identity of this event occurrence.
   * Use this for deduplication in outbox consumers.
   */
  readonly eventId: StableId<"DomainEvent">;

  /**
   * Discriminant string identifying the event kind.
   * Example: "project.published", "feedback.submitted"
   */
  readonly eventType: TType;

  /**
   * Schema version for this event type.
   *
   * Versions evolve independently of `eventType`. Consumers must reject
   * unknown major versions and tolerate additive minor fields.
   *
   * Version 1 is the initial schema; use higher integers for breaking changes.
   */
  readonly schemaVersion: number;

  /** Stable identity of the aggregate that produced this event. */
  readonly aggregateId: StableId<string>;

  /**
   * Version of the aggregate AT THE TIME this event was produced.
   * Monotonically increasing per aggregate.
   */
  readonly aggregateVersion: number;

  /**
   * RFC 3339 UTC instant when the domain action occurred.
   *
   * Supplied by a Clock port — domain code MUST NOT call Date.now() directly.
   * Example: "2026-09-16T13:30:00.000Z"
   */
  readonly occurredAt: string;

  /**
   * Opaque identifier threading a request/job through multiple events and
   * system boundaries. Set at the entrypoint and propagated unchanged.
   */
  readonly correlationId: string;

  /**
   * Identity of the event or command that caused this event.
   * Absent for root-cause events with no prior event in the chain.
   */
  readonly causationId?: string;

  /**
   * Event-specific immutable data.
   * Marked Readonly to enforce the immutability invariant at compile time.
   */
  readonly payload: Readonly<TPayload>;
}

// ── Aggregate-update command contract ────────────────────────────────────────

/**
 * Mixin for commands that update an EXISTING aggregate.
 *
 * Commands that create a new aggregate do NOT include this field.
 * Commands that update an existing aggregate MUST include it.
 *
 * A mismatch between `expectedVersion` and the stored version returns a
 * `precondition_failed` rejection and NEVER partially changes state.
 *
 * @example
 * interface PublishProjectCommand extends WithExpectedVersion {
 *   readonly projectId: StableId<"Project">;
 *   readonly language: string;
 *   readonly revisionId: StableId<"Revision">;
 * }
 */
export interface WithExpectedVersion {
  /**
   * The aggregate version the caller observed before issuing this command.
   * The server rejects the command with `precondition_failed` if the stored
   * version does not match.
   */
  readonly expectedVersion: number;
}

// ── Metadata helpers ──────────────────────────────────────────────────────────

/**
 * Base metadata shape that all DomainEvent implementations share.
 * Use this to assert metadata completeness in tests without referencing
 * a concrete payload type.
 */
export type DomainEventMetadata = Pick<
  DomainEvent<string, unknown>,
  | "eventId"
  | "eventType"
  | "schemaVersion"
  | "aggregateId"
  | "aggregateVersion"
  | "occurredAt"
  | "correlationId"
  | "causationId"
>;

/**
 * Type guard: does the value look like a DomainEvent?
 *
 * Validates the presence of all required metadata fields at runtime.
 * Does NOT validate payload shape — that is the consumer's responsibility.
 */
export function isDomainEvent(value: unknown): value is DomainEvent<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["eventId"] === "string" &&
    typeof v["eventType"] === "string" &&
    typeof v["schemaVersion"] === "number" &&
    typeof v["aggregateId"] === "string" &&
    typeof v["aggregateVersion"] === "number" &&
    typeof v["occurredAt"] === "string" &&
    typeof v["correlationId"] === "string" &&
    (v["causationId"] === undefined || typeof v["causationId"] === "string") &&
    typeof v["payload"] === "object" &&
    v["payload"] !== null
  );
}
