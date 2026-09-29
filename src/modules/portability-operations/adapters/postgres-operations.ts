import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";

import { InputValidationError, type IdempotencyKey } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import {
  createPostgresTransactionRunner,
  PostgresInfrastructureError,
  resolvePostgresTransaction,
} from "../../../shared/adapters/postgres/runtime.js";
import {
  parseSafeErrorCode,
  validateVersionedPayload,
  type IdempotencyPort,
  type IdempotentExecutionInput,
  type IdempotentExecutionResult,
  type JobInput,
  type LeaseClaimInput,
  type LeasedJobRecord,
  type LeasedJobStorePort,
  type LeasedOutboxEvent,
  type OperationsPersistencePorts,
  type OutboxEventInput,
  type OutboxPersistencePort,
  type SafeResultEnvelope,
  type VersionedPayload,
} from "../application/persistence.js";

interface IdempotencyRow {
  request_hash: string;
  status: "reserved" | "completed";
  result_envelope: SafeResultEnvelope | null;
  expires_at: Date | string;
}

interface OutboxLeaseRow {
  event_id: string;
  event_type: string;
  schema_version: number;
  payload: Readonly<Record<string, never>>;
  attempt_count: number;
}

interface JobLeaseRow {
  job_id: string;
  job_type: string;
  payload_version: number;
  payload: Readonly<Record<string, never>>;
  attempt_count: number;
}

export interface LeaseTokenGenerator {
  generate(): string;
}

export interface OperationsPersistenceOptions {
  readonly leaseTokens?: LeaseTokenGenerator;
  readonly now?: () => string;
}

function systemLeaseTokens(): LeaseTokenGenerator {
  return { generate: () => randomBytes(32).toString("hex") };
}

function assertHexSha256(name: string, value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 value.`);
  }
}

function validateIdempotencyInput(input: IdempotentExecutionInput): void {
  if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/.test(input.operationScope)) {
    throw new TypeError("Operation scope is invalid.");
  }
  assertHexSha256("Actor scope", input.actorScope);
  assertHexSha256("Request hash", input.requestHash);
  if (!Number.isFinite(Date.parse(input.expiresAt))) {
    throw new TypeError("Idempotency expiry must be an RFC 3339 instant.");
  }
}

function validateLeaseInput(input: LeaseClaimInput): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.workerId)) {
    throw new TypeError("Worker identity is invalid.");
  }
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new TypeError("Lease batch size must be between 1 and 100.");
  }
  if (
    !Number.isSafeInteger(input.leaseDurationSeconds) ||
    input.leaseDurationSeconds < 1 ||
    input.leaseDurationSeconds > 3_600
  ) {
    throw new TypeError("Lease duration must be between 1 and 3600 seconds.");
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new TypeError("Lease clock value must be an RFC 3339 instant.");
  }
}

function leaseExpiry(now: string, seconds: number): string {
  return new Date(Date.parse(now) + seconds * 1_000).toISOString();
}

function safePayload(row: {
  event_type?: string;
  job_type?: string;
  schema_version?: number;
  payload_version?: number;
  payload: Readonly<Record<string, never>>;
}): VersionedPayload {
  try {
    return validateVersionedPayload({
      type: row.event_type ?? row.job_type ?? "unknown.payload",
      version: row.schema_version ?? row.payload_version ?? 0,
      value: row.payload,
    });
  } catch {
    throw new PostgresInfrastructureError();
  }
}

function keyHash(key: IdempotencyKey): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function assertSafeResult(result: SafeResultEnvelope): SafeResultEnvelope {
  validateVersionedPayload({ type: "operation.safe_result", version: 1, value: result });
  return result;
}

export function createPostgresOperationsPersistence(
  database: Kysely<DB>,
  options: OperationsPersistenceOptions = {},
): OperationsPersistencePorts {
  const tokens = options.leaseTokens ?? systemLeaseTokens();
  const now = options.now ?? (() => new Date().toISOString());
  const safeInputErrors = new WeakSet<InputValidationError>();
  const transactions = createPostgresTransactionRunner(database, safeInputErrors);

  function validateInputPayload(input: VersionedPayload): VersionedPayload {
    try {
      return validateVersionedPayload(input);
    } catch (error) {
      if (error instanceof InputValidationError) safeInputErrors.add(error);
      throw error;
    }
  }

  const appendOutbox = async (
    context: TransactionContext,
    event: OutboxEventInput,
  ): Promise<void> => {
    const executor = resolvePostgresTransaction(context);
    const payload = validateInputPayload(event.payload);
    try {
      await sql`
        insert into operations.outbox_events (
          event_id, event_type, schema_version, aggregate_id, aggregate_version,
          payload, correlation_id, causation_id, occurred_at, available_at
        ) values (
          ${event.eventId}::uuid, ${payload.type}, ${payload.version},
          ${event.aggregateId}::uuid, ${event.aggregateVersion},
          ${JSON.stringify(payload.value)}::jsonb, ${event.correlationId},
          ${event.causationId ?? null}, ${event.occurredAt}::timestamptz,
          ${event.availableAt}::timestamptz
        )
      `.execute(executor);
    } catch {
      throw new PostgresInfrastructureError();
    }
  };

  const idempotency: IdempotencyPort = {
    async execute(
      input: IdempotentExecutionInput,
      effect: (context: TransactionContext) => Promise<SafeResultEnvelope>,
    ): Promise<IdempotentExecutionResult> {
      validateIdempotencyInput(input);
      const hashedKey = keyHash(input.key);
      return transactions.run(async (context) => {
        const executor = resolvePostgresTransaction(context);
        const inserted = await sql<{ inserted: boolean }>`
          insert into operations.idempotency_records (
            operation_scope, actor_scope, key_hash, request_hash, status, expires_at
          ) values (
            ${input.operationScope}, ${input.actorScope}, ${hashedKey},
            ${input.requestHash}, 'reserved', ${input.expiresAt}::timestamptz
          )
          on conflict (operation_scope, actor_scope, key_hash) do nothing
          returning true as inserted
        `.execute(executor);

        let ownsReservation = inserted.rows.length === 1;
        if (!ownsReservation) {
          const existing = await sql<IdempotencyRow>`
            select request_hash, status, result_envelope, expires_at
              from operations.idempotency_records
             where operation_scope = ${input.operationScope}
               and actor_scope = ${input.actorScope}
               and key_hash = ${hashedKey}
             for update
          `.execute(executor);
          const row = existing.rows[0];
          if (row === undefined) throw new PostgresInfrastructureError();
          const expired = new Date(row.expires_at).getTime() <= Date.parse(now());
          if (expired) {
            await sql`
              update operations.idempotency_records
                 set request_hash = ${input.requestHash}, status = 'reserved',
                     result_envelope = null, completed_at = null,
                     created_at = transaction_timestamp(),
                     expires_at = ${input.expiresAt}::timestamptz
               where operation_scope = ${input.operationScope}
                 and actor_scope = ${input.actorScope}
                 and key_hash = ${hashedKey}
            `.execute(executor);
            ownsReservation = true;
          } else if (row.request_hash !== input.requestHash) {
            return { kind: "conflict" };
          } else if (row.status === "completed" && row.result_envelope !== null) {
            return { kind: "replayed", result: row.result_envelope };
          } else {
            throw new PostgresInfrastructureError();
          }
        }

        if (!ownsReservation) throw new PostgresInfrastructureError();
        const result = assertSafeResult(await effect(context));
        await sql`
          update operations.idempotency_records
             set status = 'completed', result_envelope = ${JSON.stringify(result)}::jsonb,
                 completed_at = transaction_timestamp()
           where operation_scope = ${input.operationScope}
             and actor_scope = ${input.actorScope}
             and key_hash = ${hashedKey}
             and status = 'reserved'
        `.execute(executor);
        return { kind: "executed", result };
      });
    },
  };

  async function claimOutbox(input: LeaseClaimInput): Promise<readonly LeasedOutboxEvent[]> {
    validateLeaseInput(input);
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const due = await sql<OutboxLeaseRow>`
        select event_id::text, event_type, schema_version, payload, attempt_count
          from operations.outbox_events
         where completed_at is null
           and available_at <= ${input.now}::timestamptz
           and (lease_expires_at is null or lease_expires_at <= ${input.now}::timestamptz)
         order by available_at, event_id
         for update skip locked
         limit ${input.limit}
      `.execute(executor);
      const expiry = leaseExpiry(input.now, input.leaseDurationSeconds);
      const leased: LeasedOutboxEvent[] = [];
      for (const row of due.rows) {
        const leaseToken = tokens.generate();
        await sql`
          update operations.outbox_events
             set lease_owner = ${input.workerId}, lease_token = ${leaseToken},
                 lease_expires_at = ${expiry}::timestamptz,
                 attempt_count = attempt_count + 1
           where event_id = ${row.event_id}::uuid
        `.execute(executor);
        leased.push({
          eventId: row.event_id,
          payload: safePayload(row),
          leaseToken,
          leaseExpiresAt: expiry,
          attemptCount: row.attempt_count + 1,
        });
      }
      return leased;
    });
  }

  async function claimJobs(input: LeaseClaimInput): Promise<readonly LeasedJobRecord[]> {
    validateLeaseInput(input);
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const due = await sql<JobLeaseRow>`
        select job_id::text, job_type, payload_version, payload, attempt_count
          from operations.jobs
         where completed_at is null
           and available_at <= ${input.now}::timestamptz
           and (status = 'available' or lease_expires_at <= ${input.now}::timestamptz)
         order by available_at, job_id
         for update skip locked
         limit ${input.limit}
      `.execute(executor);
      const expiry = leaseExpiry(input.now, input.leaseDurationSeconds);
      const leased: LeasedJobRecord[] = [];
      for (const row of due.rows) {
        const leaseToken = tokens.generate();
        await sql`
          update operations.jobs
             set status = 'leased', lease_owner = ${input.workerId},
                 lease_token = ${leaseToken}, lease_expires_at = ${expiry}::timestamptz,
                 attempt_count = attempt_count + 1
           where job_id = ${row.job_id}::uuid
        `.execute(executor);
        leased.push({
          jobId: row.job_id,
          payload: safePayload(row),
          leaseToken,
          leaseExpiresAt: expiry,
          attemptCount: row.attempt_count + 1,
        });
      }
      return leased;
    });
  }

  async function guardedTransition(
    table: "outbox_events" | "jobs",
    idColumn: "event_id" | "job_id",
    id: string,
    leaseToken: string,
    transition: "complete" | "fail" | "release",
    value?: string,
  ): Promise<boolean> {
    const tableRef = sql.raw(`operations.${table}`);
    const idRef = sql.raw(idColumn);
    const assignment =
      transition === "complete"
        ? sql`completed_at = ${value}::timestamptz${
            table === "jobs" ? sql`, status = 'completed'` : sql``
          }, lease_owner = null, lease_token = null, lease_expires_at = null`
        : transition === "fail"
          ? sql`last_error_code = ${parseSafeErrorCode(value ?? "")}, lease_owner = null, lease_token = null,
                lease_expires_at = null${table === "jobs" ? sql`, status = 'available'` : sql``}`
          : sql`lease_owner = null, lease_token = null, lease_expires_at = null${
              table === "jobs" ? sql`, status = 'available'` : sql``
            }`;
    try {
      const result = await sql<{ changed: boolean }>`
        update ${tableRef} set ${assignment}
         where ${idRef} = ${id}::uuid and lease_token = ${leaseToken}
         returning true as changed
      `.execute(database);
      return result.rows.length === 1;
    } catch {
      throw new PostgresInfrastructureError();
    }
  }

  const outbox: OutboxPersistencePort = {
    append: appendOutbox,
    claimDue: claimOutbox,
    complete: (id, token, at) => guardedTransition("outbox_events", "event_id", id, token, "complete", at),
    fail: (id, token, code) => guardedTransition("outbox_events", "event_id", id, token, "fail", code),
    release: (id, token) => guardedTransition("outbox_events", "event_id", id, token, "release"),
  };

  const jobs: LeasedJobStorePort = {
    async enqueue(context: TransactionContext, job: JobInput): Promise<void> {
      const executor = resolvePostgresTransaction(context);
      const payload = validateInputPayload(job.payload);
      try {
        await sql`
          insert into operations.jobs (
            job_id, job_type, payload_version, payload, available_at
          ) values (
            ${job.jobId}::uuid, ${payload.type}, ${payload.version},
            ${JSON.stringify(payload.value)}::jsonb, ${job.availableAt}::timestamptz
          )
        `.execute(executor);
      } catch {
        throw new PostgresInfrastructureError();
      }
    },
    claimDue: claimJobs,
    complete: (id, token, at) => guardedTransition("jobs", "job_id", id, token, "complete", at),
    fail: (id, token, code) => guardedTransition("jobs", "job_id", id, token, "fail", code),
    release: (id, token) => guardedTransition("jobs", "job_id", id, token, "release"),
  };

  return { transactions, idempotency, outbox, jobs };
}
