import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";

import {
  InputValidationError,
  parseIdempotencyKey,
  parseStableId,
  type IdempotencyKey,
} from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import {
  createPostgresTransactionRunner,
  PostgresInfrastructureError,
  resolvePostgresTransaction,
  type PostgresExecutor,
} from "../../../shared/adapters/postgres/runtime.js";
import {
  parseSafeErrorCode,
  validateVersionedPayload,
  type IdempotencyPort,
  type IdempotentExecutionInput,
  type IdempotentExecutionResult,
  type JobInput,
  type JobRedriveAuditInput,
  type LeaseClaimInput,
  type LeasedJobRecord,
  type LeasedJobStorePort,
  type LeasedOutboxEvent,
  type OperationsPersistencePorts,
  type OutboxEventInput,
  type OutboxPersistencePort,
  type SafeErrorCode,
  type RedrivenJobRecord,
  type SafeResultEnvelope,
  type VersionedPayload,
} from "../application/persistence.js";
import { JOB_MAX_ATTEMPTS } from "../application/retry-policy.js";

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

interface BoundedRetryProbeRow {
  bounded: boolean;
}

// Databases upgraded through the Phase 3 release still run the unbounded-retry
// schema; claim and failure paths must therefore stay executable on it while
// the bounded retry surface remains active on the full current schema.
const boundedRetrySchemas = new WeakMap<Kysely<DB>, Promise<boolean>>();

function boundedRetrySchema(database: Kysely<DB>): Promise<boolean> {
  const cached = boundedRetrySchemas.get(database);
  if (cached !== undefined) return cached;
  const probe = (async () => {
    try {
      const result = await sql<BoundedRetryProbeRow>`
        select to_regclass('operations.incidents') is not null
               and exists (
                 select 1 from information_schema.columns
                  where table_schema = 'operations'
                    and table_name = 'outbox_events'
                    and column_name = 'dead_at'
               ) as bounded
      `.execute(database);
      if (result.rows[0] === undefined) throw new Error("bounded retry schema probe returned no rows");
      return result.rows[0].bounded;
    } catch {
      throw new PostgresInfrastructureError();
    }
  })();
  boundedRetrySchemas.set(database, probe);
  return probe;
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

function isRfc3339Instant(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):([0-5]\d):([0-5]\d)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const daysInMonth = [
    31,
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1];

  return day >= 1 && day <= (daysInMonth ?? 0) && Number.isFinite(Date.parse(value));
}

function validateIdempotencyInput(input: IdempotentExecutionInput): void {
  if (!/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)+$/.test(input.operationScope)) {
    throw new TypeError("Operation scope is invalid.");
  }
  assertHexSha256("Actor scope", input.actorScope);
  assertHexSha256("Request hash", input.requestHash);
  if (typeof input.key !== "string" || !parseIdempotencyKey(input.key).ok) {
    throw new TypeError("Idempotency key is invalid.");
  }
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

function databaseInstant(value: Date | string | undefined): string {
  const instant = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (!instant || !Number.isFinite(instant.getTime())) throw new PostgresInfrastructureError();
  return instant.toISOString();
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

  function validateJobEnqueueInput(job: JobInput): void {
    try {
      if (parseStableId("Job", job.jobId).ok === false) {
        throw new InputValidationError("Job identity must be a stable UUIDv7.");
      }
      if (!isRfc3339Instant(job.availableAt)) {
        throw new InputValidationError("Job availability must be an RFC 3339 instant.");
      }
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
      transaction?: TransactionContext,
    ): Promise<IdempotentExecutionResult> {
      validateIdempotencyInput(input);
      const hashedKey = keyHash(input.key);
      const execute = async (context: TransactionContext): Promise<IdempotentExecutionResult> => {
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
      };
      return transaction === undefined ? transactions.run(execute) : execute(transaction);
    },
  };

  async function claimOutbox(input: LeaseClaimInput): Promise<readonly LeasedOutboxEvent[]> {
    validateLeaseInput(input);
    const bounded = await boundedRetrySchema(database);
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const exhausted = bounded
        ? await sql<{ event_id: string; last_error_code: string | null }>`
        update operations.outbox_events
           set dead_at = clock_timestamp(), last_error_code = coalesce(last_error_code, 'OUTBOX_ATTEMPTS_EXHAUSTED'),
               lease_owner = null, lease_token = null, lease_expires_at = null
         where completed_at is null and dead_at is null and attempt_count >= ${JOB_MAX_ATTEMPTS}
           and ((lease_token is null and available_at <= clock_timestamp())
             or (lease_token is not null and lease_expires_at <= clock_timestamp()))
         returning event_id::text, last_error_code
      `.execute(executor)
        : { rows: [] as Array<{ event_id: string; last_error_code: string | null }> };
      for (const row of exhausted.rows) await recordOperationalIncident(executor, "outbox", row.event_id, row.last_error_code ?? "OUTBOX_ATTEMPTS_EXHAUSTED");
      const due = await sql<OutboxLeaseRow>`
        select event_id::text, event_type, schema_version, payload, attempt_count
          from operations.outbox_events
         where completed_at is null
           ${bounded ? sql`and dead_at is null and attempt_count < ${JOB_MAX_ATTEMPTS}` : sql``}
           and available_at <= clock_timestamp()
           and (lease_expires_at is null or lease_expires_at <= clock_timestamp())
         order by available_at, event_id
         for update skip locked
         limit ${input.limit}
      `.execute(executor);
      const leased: LeasedOutboxEvent[] = [];
      for (const row of due.rows) {
        const leaseToken = tokens.generate();
        const updated = await sql<{ lease_expires_at: Date | string }>`
          update operations.outbox_events
             set lease_owner = ${input.workerId}, lease_token = ${leaseToken},
                 lease_expires_at = clock_timestamp() + (${input.leaseDurationSeconds} * interval '1 second'),
                 attempt_count = attempt_count + 1
           where event_id = ${row.event_id}::uuid
         returning lease_expires_at
        `.execute(executor);
        const expiry = databaseInstant(updated.rows[0]?.lease_expires_at);
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
    if (input.jobTypes !== undefined && (input.jobTypes.length < 1 || input.jobTypes.length > 20 ||
        new Set(input.jobTypes).size !== input.jobTypes.length ||
        input.jobTypes.some(type => !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(type)))) {
      throw new TypeError("Job type filter is invalid.");
    }
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const bounded = await boundedRetrySchema(database);
      const exhausted = bounded
        ? await sql<{ job_id: string; last_error_code: string | null }>`
        update operations.jobs
           set status = 'dead', last_error_code = coalesce(last_error_code, 'JOB_ATTEMPTS_EXHAUSTED'),
               lease_owner = null, lease_token = null, lease_expires_at = null
         where status in ('available', 'leased') and attempt_count >= ${JOB_MAX_ATTEMPTS}
           and ((status = 'available' and available_at <= clock_timestamp())
             or (status = 'leased' and lease_expires_at <= clock_timestamp()))
         returning job_id::text, last_error_code
      `.execute(executor)
        : { rows: [] as Array<{ job_id: string; last_error_code: string | null }> };
      for (const row of exhausted.rows) await recordOperationalIncident(executor, "job", row.job_id, row.last_error_code ?? "JOB_ATTEMPTS_EXHAUSTED");
      const jobTypeFilter = input.jobTypes === undefined ? sql`` : sql`and job_type = any(${input.jobTypes}::text[])`;
      const due = await sql<JobLeaseRow>`
        select job_id::text, job_type, payload_version, payload, attempt_count
          from operations.jobs
         where completed_at is null
           and available_at <= clock_timestamp()
           ${bounded ? sql`and attempt_count < ${JOB_MAX_ATTEMPTS}` : sql``}
           and (status = 'available' or (status = 'leased' and lease_expires_at <= clock_timestamp()))
           ${jobTypeFilter}
         order by available_at, job_id
         for update skip locked
         limit ${input.limit}
      `.execute(executor);
      const leased: LeasedJobRecord[] = [];
      for (const row of due.rows) {
        const leaseToken = tokens.generate();
        const updated = await sql<{ lease_expires_at: Date | string }>`
          update operations.jobs
             set status = 'leased', lease_owner = ${input.workerId},
                 lease_token = ${leaseToken},
                 lease_expires_at = clock_timestamp() + (${input.leaseDurationSeconds} * interval '1 second'),
                 attempt_count = attempt_count + 1
           where job_id = ${row.job_id}::uuid
         returning lease_expires_at
        `.execute(executor);
        const expiry = databaseInstant(updated.rows[0]?.lease_expires_at);
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
           and lease_expires_at > clock_timestamp()
         returning true as changed
      `.execute(database);
      return result.rows.length === 1;
    } catch {
      throw new PostgresInfrastructureError();
    }
  }

  async function recordOperationalIncident(executor: PostgresExecutor, category: "job" | "outbox", sourceId: string, code: string): Promise<void> {
    await sql`
      insert into operations.incidents (
        incident_key, category, source_id, safe_error_code, severity
      ) values (
        ${`${category}:${sourceId}`}, ${category}, ${sourceId}::uuid, ${parseSafeErrorCode(code)}, 'critical'
      )
      on conflict (incident_key) do update
        set safe_error_code = excluded.safe_error_code,
            last_observed_at = transaction_timestamp(),
            occurrences = operations.incidents.occurrences + 1,
            resolved_at = null
    `.execute(executor);
  }

  async function transitionJobFailure(
    id: string,
    leaseToken: string,
    safeErrorCode: SafeErrorCode,
    delayMilliseconds: number | null,
  ): Promise<boolean> {
    if (!parseStableId("Job", id).ok) throw new TypeError("Job identity is invalid.");
    parseSafeErrorCode(safeErrorCode);
    if (delayMilliseconds !== null && (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0 || delayMilliseconds > 1_125_000)) {
      throw new TypeError("Retry delay is outside the allowed policy range.");
    }
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const changed = await sql<{ job_id: string; status: "available" | "dead" }>`
        update operations.jobs
           set status = case when ${delayMilliseconds === null} or attempt_count >= ${JOB_MAX_ATTEMPTS} then 'dead' else 'available' end,
               available_at = case when ${delayMilliseconds === null} or attempt_count >= ${JOB_MAX_ATTEMPTS}
                 then available_at
                 else clock_timestamp() + (${delayMilliseconds ?? 0} * interval '1 millisecond') end,
               last_error_code = ${safeErrorCode},
               lease_owner = null, lease_token = null, lease_expires_at = null
         where job_id = ${id}::uuid and status = 'leased' and lease_token = ${leaseToken}
           and lease_expires_at > clock_timestamp()
         returning job_id::text, status
      `.execute(executor);
      const row = changed.rows[0];
      if (!row) return false;
      if (row.status === "dead") await recordOperationalIncident(executor, "job", row.job_id, safeErrorCode);
      return true;
    });
  }

  async function transitionOutboxFailure(
    id: string,
    leaseToken: string,
    safeErrorCode: SafeErrorCode,
    delayMilliseconds: number | null,
  ): Promise<boolean> {
    if (!parseStableId("DomainEvent", id).ok && !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) {
      throw new TypeError("Outbox event identity is invalid.");
    }
    parseSafeErrorCode(safeErrorCode);
    if (delayMilliseconds !== null && (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0 || delayMilliseconds > 1_125_000)) {
      throw new TypeError("Retry delay is outside the allowed policy range.");
    }
    if (!(await boundedRetrySchema(database))) {
      return guardedTransition("outbox_events", "event_id", id, leaseToken, "fail", safeErrorCode);
    }
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      const changed = await sql<{ event_id: string; dead_at: Date | string | null }>`
        update operations.outbox_events
           set dead_at = case when ${delayMilliseconds === null} or attempt_count >= ${JOB_MAX_ATTEMPTS}
                 then clock_timestamp() else null end,
               available_at = case when ${delayMilliseconds === null} or attempt_count >= ${JOB_MAX_ATTEMPTS}
                 then available_at else clock_timestamp() + (${delayMilliseconds ?? 0} * interval '1 millisecond') end,
               last_error_code = ${safeErrorCode},
               lease_owner = null, lease_token = null, lease_expires_at = null
         where event_id = ${id}::uuid and completed_at is null and dead_at is null
           and lease_token = ${leaseToken} and lease_expires_at > clock_timestamp()
         returning event_id::text, dead_at
      `.execute(executor);
      const row = changed.rows[0];
      if (!row) return false;
      if (row.dead_at !== null) await recordOperationalIncident(executor, "outbox", row.event_id, safeErrorCode);
      return true;
    });
  }

  const outbox: OutboxPersistencePort = {
    append: appendOutbox,
    claimDue: claimOutbox,
    complete: (id, token, at) => guardedTransition("outbox_events", "event_id", id, token, "complete", at),
    fail: (id, token, code) => transitionOutboxFailure(id, token, code, null),
    scheduleRetry: (id, token, code, delay) => transitionOutboxFailure(id, token, code, delay),
    release: (id, token) => guardedTransition("outbox_events", "event_id", id, token, "release"),
  };

  const jobs: LeasedJobStorePort = {
    async enqueue(context: TransactionContext, job: JobInput): Promise<void> {
      const executor = resolvePostgresTransaction(context);
      validateJobEnqueueInput(job);
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
    fail: (id, token, code) => transitionJobFailure(id, token, code, null),
    scheduleRetry: (id, token, code, delay) => transitionJobFailure(id, token, code, delay),
    async getDeadForRedrive(id: string) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new TypeError("Job identity is invalid.");
      }
      const result = await sql<{ job_id: string; job_type: string; payload_version: number; payload: Readonly<Record<string, never>>; attempt_count: number; last_error_code: string | null }>`
        select job_id::text, job_type, payload_version, payload, attempt_count, last_error_code
          from operations.jobs where job_id = ${id}::uuid and status = 'dead'
      `.execute(database);
      const row = result.rows[0];
      if (!row || !row.last_error_code) return null;
      return { jobId: row.job_id, payload: validateVersionedPayload({ type: row.job_type, version: row.payload_version, value: row.payload }),
        attemptCount: row.attempt_count, safeErrorCode: parseSafeErrorCode(row.last_error_code) };
    },
    async redriveDead(input: JobRedriveAuditInput): Promise<RedrivenJobRecord | null> {
      if (![input.originalJobId, input.replacementJobId].every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ||
          input.originalJobId === input.replacementJobId || !/^[0-9a-f]{64}$/i.test(input.operatorScopeHash) ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(input.policyVersion) || !/^[0-9a-f]{64}$/i.test(input.payloadSha256)) {
        throw new TypeError("Job re-drive audit input is invalid.");
      }
      return transactions.run(async (context) => {
        const executor = resolvePostgresTransaction(context);
        const found = await sql<{ job_id: string; job_type: string; payload_version: number; payload: Readonly<Record<string, never>> }>`
          select j.job_id::text, j.job_type, j.payload_version, j.payload from operations.jobs j
           where j.job_id = ${input.originalJobId}::uuid and j.status = 'dead'
             and not exists (select 1 from operations.job_redrive_audit a where a.original_job_id = j.job_id)
           for update of j
        `.execute(executor);
        const original = found.rows[0];
        if (!original) return null;
        const payload = validateVersionedPayload({ type: original.job_type, version: original.payload_version, value: original.payload });
        const actualPayloadHash = createHash("sha256")
          .update(JSON.stringify({ type: payload.type, version: payload.version, value: payload.value }))
          .digest("hex");
        if (actualPayloadHash !== input.payloadSha256) return null;
        await sql`
          insert into operations.jobs(job_id, job_type, payload_version, payload, available_at)
          values (${input.replacementJobId}::uuid, ${payload.type}, ${payload.version}, ${JSON.stringify(payload.value)}::jsonb, clock_timestamp())
        `.execute(executor);
        await sql`
          insert into operations.job_redrive_audit(original_job_id, replacement_job_id, operator_scope_hash, policy_version, payload_sha256)
          values (${input.originalJobId}::uuid, ${input.replacementJobId}::uuid, ${input.operatorScopeHash}, ${input.policyVersion}, ${input.payloadSha256})
        `.execute(executor);
        return { jobId: input.replacementJobId, payload };
      });
    },
    release: (id, token) => guardedTransition("jobs", "job_id", id, token, "release"),
  };

  return { transactions, idempotency, outbox, jobs };
}
