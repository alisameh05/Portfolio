/**
 * index.ts — Shared Domain Contracts barrel
 *
 * The ONLY import surface for shared domain contracts in the ShipWithAli
 * backend. All modules must import from this barrel, never from individual
 * files, to maintain a stable public surface.
 *
 * WHAT IS EXPORTED:
 *   - StableId type, createStableId, parseStableId, unsafeStableId
 *   - IdempotencyKey type, parseIdempotencyKey, constants
 *   - ActorContext union (OwnerActor, VisitorActor, SystemActor), guards
 *   - Result<T, E>, ok(), err(), isOk(), isErr()
 *   - Rejection union (all 8 kinds), individual types, rejectionToHttpStatus
 *   - DomainEvent<TType, TPayload>, WithExpectedVersion, isDomainEvent
 *
 * WHAT IS NOT EXPORTED:
 *   - Any provider, framework, database, authentication, or generated type.
 *   - Internal implementation details.
 */

// Stable identity
export type { StableId } from "./stable-id.js";
export {
  createStableId,
  parseStableId,
  unsafeStableId,
  stableIdTimestampMs,
} from "./stable-id.js";

// Idempotency keys
export type { IdempotencyKey } from "./idempotency-key.js";
export {
  parseIdempotencyKey,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from "./idempotency-key.js";

// Actor context
export type {
  ActorContext,
  OwnerActor,
  VisitorActor,
  SystemActor,
} from "./actor.js";
export { isOwner, isVisitor, isSystem, assertNeverActor } from "./actor.js";

// Result
export type { Result, Ok, Err } from "./result.js";
export { ok, err, isOk, isErr } from "./result.js";

// Rejection
export type {
  Rejection,
  ValidationRejection,
  UnauthenticatedRejection,
  ForbiddenRejection,
  NotFoundRejection,
  ConflictRejection,
  PreconditionFailedRejection,
  RateLimitedRejection,
  TemporarilyUnavailableRejection,
} from "./rejection.js";
export { rejectionToHttpStatus } from "./rejection.js";

// Domain events
export type {
  DomainEvent,
  DomainEventMetadata,
  WithExpectedVersion,
} from "./domain-event.js";
export { isDomainEvent } from "./domain-event.js";
