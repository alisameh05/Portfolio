export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface VersionedPayload {
  readonly type: string;
  readonly version: number;
  readonly value: Readonly<Record<string, JsonValue>>;
}

import type {
  TransactionContext,
  TransactionRunner,
} from "../../../runtime/ports.js";
import type { IdempotencyKey } from "@shared/domain";
import { InputValidationError } from "@shared/domain";

export type SafeResultEnvelope = Readonly<Record<string, JsonValue>>;
declare const SAFE_ERROR_CODE: unique symbol;
export type SafeErrorCode = string & { readonly [SAFE_ERROR_CODE]: true };

export interface IdempotentExecutionInput {
  readonly operationScope: string;
  /** Purpose-limited SHA-256 value; never a raw provider or personal identity. */
  readonly actorScope: string;
  readonly key: IdempotencyKey;
  readonly requestHash: string;
  readonly expiresAt: string;
}

export type IdempotentExecutionResult =
  | { readonly kind: "executed" | "replayed"; readonly result: SafeResultEnvelope }
  | { readonly kind: "conflict" };

export interface IdempotencyPort {
  execute(
    input: IdempotentExecutionInput,
    effect: (context: TransactionContext) => Promise<SafeResultEnvelope>,
    transaction?: TransactionContext,
  ): Promise<IdempotentExecutionResult>;
}

export interface OutboxEventInput {
  readonly eventId: string;
  readonly payload: VersionedPayload;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: string;
  readonly availableAt: string;
}

export interface LeasedOutboxEvent {
  readonly eventId: string;
  readonly payload: VersionedPayload;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
}

export interface OutboxPersistencePort {
  append(context: TransactionContext, event: OutboxEventInput): Promise<void>;
  claimDue(input: LeaseClaimInput): Promise<readonly LeasedOutboxEvent[]>;
  complete(id: string, leaseToken: string, completedAt: string): Promise<boolean>;
  fail(id: string, leaseToken: string, safeErrorCode: SafeErrorCode): Promise<boolean>;
  release(id: string, leaseToken: string): Promise<boolean>;
}

export interface JobInput {
  readonly jobId: string;
  readonly payload: VersionedPayload;
  readonly availableAt: string;
}

export interface LeasedJobRecord {
  readonly jobId: string;
  readonly payload: VersionedPayload;
  readonly leaseToken: string;
  readonly leaseExpiresAt: string;
  readonly attemptCount: number;
}

export interface LeaseClaimInput {
  readonly workerId: string;
  readonly now: string;
  readonly leaseDurationSeconds: number;
  readonly limit: number;
}

export interface LeasedJobStorePort {
  enqueue(context: TransactionContext, job: JobInput): Promise<void>;
  claimDue(input: LeaseClaimInput): Promise<readonly LeasedJobRecord[]>;
  complete(id: string, leaseToken: string, completedAt: string): Promise<boolean>;
  fail(id: string, leaseToken: string, safeErrorCode: SafeErrorCode): Promise<boolean>;
  release(id: string, leaseToken: string): Promise<boolean>;
}

export interface OperationsPersistencePorts {
  readonly transactions: TransactionRunner;
  readonly idempotency: IdempotencyPort;
  readonly outbox: OutboxPersistencePort;
  readonly jobs: LeasedJobStorePort;
}

const SENSITIVE_KEYS = /(?:password|secret|token|authorization|cookie|feedback|email|ipaddress)/i;

/** Bounded non-sensitive machine code suitable for durable operational state. */
export function parseSafeErrorCode(value: string): SafeErrorCode {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(value)) {
    throw new InputValidationError("Safe error code must be 1-64 uppercase letters, digits, or underscores.");
  }
  return value as SafeErrorCode;
}

function assertSafe(value: JsonValue, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafe(entry, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(key)) {
        throw new InputValidationError(`Versioned payload contains a sensitive field at ${path}.`);
      }
      assertSafe(entry, `${path}.${key}`);
    }
  }
}

/** Minimal adapter-boundary validation shared by outbox and job ports. */
export function validateVersionedPayload(input: VersionedPayload): VersionedPayload {
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(input.type)) {
    throw new InputValidationError("Versioned payload type is invalid.");
  }
  if (!Number.isSafeInteger(input.version) || input.version < 1) {
    throw new InputValidationError("Versioned payload version must be a positive integer.");
  }
  assertSafe(input.value);
  return Object.freeze({
    type: input.type,
    version: input.version,
    value: Object.freeze({ ...input.value }),
  });
}
