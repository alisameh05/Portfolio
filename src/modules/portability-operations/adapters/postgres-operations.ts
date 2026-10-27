import { createHash, randomBytes } from "node:crypto";
import { sql, type Kysely } from "kysely";

import {
  InputValidationError,
  parseIdempotencyKey,
  parseStableId,
  type IdempotencyKey,
  type StableId,
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
  type Phase7ScheduleCursorAdvance,
  type Phase7ScheduleStatusQuery,
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
  semantic_scope_id: string | null;
  semantic_period: string | null;
}

interface Phase7ScheduleRow {
  job_type: string;
  semantic_period: string;
  status: "available" | "leased" | "completed" | "failed" | "dead";
  work_incomplete: boolean;
}

interface Phase7ProgressRow {
  first_policy_period: string;
  required_through_period: string;
  retention_scheduled_through: string;
  retention_complete_through: string;
  aggregate_scheduled_through: string;
  aggregate_finished_through: string;
  last_complete_period: string;
  phase: "retention" | "aggregate";
}

interface Phase7KeyCountRow {
  policy_period: string;
  present_count: number;
  complete_count: number;
}

interface BoundedRetryProbeRow {
  bounded: boolean;
}

// Databases upgraded through the Phase 3 release still run the unbounded-retry
// schema; claim and failure paths must therefore stay executable on it while
// the bounded retry surface remains active on the full current schema.
const boundedRetrySchemas = new WeakMap<Kysely<DB>, Promise<boolean>>();
const phase7ScheduleSchemas = new WeakMap<Kysely<DB>, Promise<boolean>>();
const PHASE7_RETENTION_TYPES = ["measurement.detail-retention.v1", "measurement.aggregate-retention.v1",
  "measurement.withdrawal-cleanup.v1", "interaction.feedback-retention.v1"] as const;
const PHASE7_JOB_TYPES = ["measurement.daily-aggregate.v1", ...PHASE7_RETENTION_TYPES] as const;
const PHASE7_AGGREGATE_TYPE = "measurement.daily-aggregate.v1";

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

function phase7ScheduleSchema(database: Kysely<DB>): Promise<boolean> {
  const cached = phase7ScheduleSchemas.get(database);
  if (cached !== undefined) return cached;
  const probe = (async () => {
    try {
      const result = await sql<{ enabled: boolean }>`select count(*) = 3
          and to_regclass('operations.phase7_schedule_progress') is not null as enabled from information_schema.columns
        where table_schema = 'operations' and table_name = 'jobs'
          and column_name = any(array['semantic_scope_id','semantic_period','work_incomplete'])`.execute(database);
      if (result.rows[0] === undefined) throw new Error("Phase 7 scheduling schema probe returned no rows");
      return result.rows[0].enabled;
    } catch {
      throw new PostgresInfrastructureError();
    }
  })();
  phase7ScheduleSchemas.set(database, probe);
  return probe;
}

function utcPeriodOffset(period: string, offset: number): string {
  return new Date(Date.parse(`${period}T00:00:00.000Z`) + offset * 86_400_000).toISOString().slice(0, 10);
}

function boundedPeriodsAfter(watermark: string, through: string): string[] {
  const periods: string[] = [];
  for (let period = utcPeriodOffset(watermark, 1); period <= through && periods.length < 15;
    period = utcPeriodOffset(period, 1)) periods.push(period);
  return periods;
}

function retentionScheduleKeys(periods: readonly string[]) {
  return {
    jobTypes: periods.flatMap(() => PHASE7_RETENTION_TYPES),
    semanticPeriods: periods.flatMap(period => PHASE7_RETENTION_TYPES.map(() => period)),
    policyPeriods: periods.flatMap(period => PHASE7_RETENTION_TYPES.map(() => period)),
  };
}

function completePolicyScheduleKeys(periods: readonly string[]) {
  const jobTypes: string[] = [];
  const semanticPeriods: string[] = [];
  const policyPeriods: string[] = [];
  for (const policyPeriod of periods) {
    for (const type of PHASE7_RETENTION_TYPES) {
      jobTypes.push(type);
      semanticPeriods.push(policyPeriod);
      policyPeriods.push(policyPeriod);
    }
    for (let offset = -14; offset <= 0; offset += 1) {
      jobTypes.push(PHASE7_AGGREGATE_TYPE);
      semanticPeriods.push(`${policyPeriod}:${utcPeriodOffset(policyPeriod, offset)}`);
      policyPeriods.push(policyPeriod);
    }
  }
  return { jobTypes, semanticPeriods, policyPeriods };
}

function aggregateScheduleKeys(periods: readonly string[]) {
  const jobTypes: string[] = [];
  const semanticPeriods: string[] = [];
  const policyPeriods: string[] = [];
  for (const policyPeriod of periods) {
    for (let offset = -14; offset <= 0; offset += 1) {
      jobTypes.push(PHASE7_AGGREGATE_TYPE);
      semanticPeriods.push(`${policyPeriod}:${utcPeriodOffset(policyPeriod, offset)}`);
      policyPeriods.push(policyPeriod);
    }
  }
  return { jobTypes, semanticPeriods, policyPeriods };
}

function phase7ProgressBounds(progress: Phase7ProgressRow, through: string) {
  const oldest = [
    utcPeriodOffset(progress.retention_scheduled_through, 1),
    utcPeriodOffset(progress.retention_complete_through, 1),
    utcPeriodOffset(progress.aggregate_scheduled_through, 1),
    utcPeriodOffset(progress.last_complete_period, 1),
  ].filter(period => period <= through).sort()[0] ?? null;
  const detailFrom = oldest ?? utcPeriodOffset(progress.last_complete_period, 1);
  return { oldest, detailFrom, detailThrough: [utcPeriodOffset(detailFrom, 14), through].sort()[0]! };
}

async function phase7KeyCounts(input: {
  readonly executor: PostgresExecutor;
  readonly portfolioId: string;
  readonly jobTypes: readonly string[];
  readonly semanticPeriods: readonly string[];
  readonly policyPeriods: readonly string[];
  readonly includeCoverageIncomplete?: boolean;
}): Promise<ReadonlyMap<string, { readonly present: number; readonly complete: number }>> {
  if (input.jobTypes.length !== input.semanticPeriods.length || input.jobTypes.length !== input.policyPeriods.length) {
    throw new PostgresInfrastructureError();
  }
  if (input.jobTypes.length === 0) return new Map();
  const result = await sql<Phase7KeyCountRow>`
    select expected.policy_period,
           count(job.job_id)::integer as present_count,
           count(job.job_id) filter (where job.status = 'completed'
             and (${input.includeCoverageIncomplete ?? false}::boolean or coalesce(job.work_incomplete, false) = false))::integer as complete_count
      from unnest(${input.jobTypes}::text[], ${input.semanticPeriods}::text[], ${input.policyPeriods}::text[])
        as expected(job_type, semantic_period, policy_period)
      left join operations.jobs job
        on job.semantic_scope_id = ${input.portfolioId}::uuid
       and job.job_type = expected.job_type
       and job.semantic_period = expected.semantic_period
     group by expected.policy_period
  `.execute(input.executor);
  return new Map(result.rows.map(row => [row.policy_period, { present: row.present_count, complete: row.complete_count }]));
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

function isoTimestamp(value: Date | string): string {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(milliseconds)) throw new PostgresInfrastructureError();
  return new Date(milliseconds).toISOString();
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
      if (job.semanticSchedule !== undefined && (!parseStableId("Portfolio", job.semanticSchedule.portfolioId).ok ||
          !validSchedulePeriod(job.semanticSchedule.period))) {
        throw new InputValidationError("Job semantic schedule is invalid.");
      }
    } catch (error) {
      if (error instanceof InputValidationError) safeInputErrors.add(error);
      throw error;
    }
  }

  function validSchedulePeriod(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}(?::\d{4}-\d{2}-\d{2})?$/.test(value)) return false;
    return value.split(":").every(day => {
      const parsed = new Date(`${day}T00:00:00.000Z`);
      return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === day;
    });
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
        const expiry = updated.rows[0]?.lease_expires_at;
        if (expiry === undefined) throw new PostgresInfrastructureError();
        leased.push({
          eventId: row.event_id,
          payload: safePayload(row),
          leaseToken,
          leaseExpiresAt: isoTimestamp(expiry),
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
    if (input.semanticScopeId !== undefined && !parseStableId("Portfolio", input.semanticScopeId).ok) {
      throw new TypeError("Job semantic scope is invalid.");
    }
    const scheduleEnabled = await phase7ScheduleSchema(database);
    if (input.semanticScopeId !== undefined && !scheduleEnabled) throw new PostgresInfrastructureError();
    return transactions.run(async (context) => {
      const executor = resolvePostgresTransaction(context);
      if (scheduleEnabled && (input.jobTypes === undefined || input.jobTypes.includes(PHASE7_AGGREGATE_TYPE))) {
        // Serialize aggregate admission against required-horizon updates.
        // The claim query below uses a fresh statement snapshot after locks.
        const scopeFilter = input.semanticScopeId === undefined
          ? sql`` : sql`where portfolio_id = ${input.semanticScopeId}::uuid`;
        await sql`select portfolio_id from operations.phase7_schedule_progress ${scopeFilter} for share`.execute(executor);
      }
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
      const jobTypeFilter = input.jobTypes === undefined ? sql`` : sql`and candidate.job_type = any(${input.jobTypes}::text[])`;
      const semanticScopeFilter = input.semanticScopeId === undefined ? sql`` :
        sql`and candidate.semantic_scope_id = ${input.semanticScopeId}::uuid`;
      const semanticScheduleSelect = scheduleEnabled
        ? sql`candidate.semantic_scope_id::text, candidate.semantic_period`
        : sql`null::text as semantic_scope_id, null::text as semantic_period`;
      const aggregateAdmissionFilter = scheduleEnabled ? sql`
        and (candidate.job_type <> ${PHASE7_AGGREGATE_TYPE} or (
          candidate.semantic_scope_id is not null and candidate.semantic_period is not null
          and exists (
            select 1 from operations.phase7_schedule_progress progress
             where progress.portfolio_id = candidate.semantic_scope_id
               and progress.retention_complete_through >= progress.required_through_period
               and progress.retention_complete_through >= split_part(candidate.semantic_period, ':', 1)::date
          )
          and not exists (
            select required.job_type
              from unnest(${PHASE7_RETENTION_TYPES}::text[]) as required(job_type)
              left join operations.jobs retention
                on retention.semantic_scope_id = candidate.semantic_scope_id
               and retention.job_type = required.job_type
               and retention.semantic_period = split_part(candidate.semantic_period, ':', 1)
             where retention.job_id is null or retention.status <> 'completed'
          )
        ))` : sql``;
      const due = await sql<JobLeaseRow>`
        select candidate.job_id::text, candidate.job_type, candidate.payload_version, candidate.payload, candidate.attempt_count,
               ${semanticScheduleSelect}
          from operations.jobs candidate
         where candidate.completed_at is null
           and candidate.available_at <= clock_timestamp()
           ${bounded ? sql`and candidate.attempt_count < ${JOB_MAX_ATTEMPTS}` : sql``}
           and (candidate.status = 'available' or (candidate.status = 'leased' and candidate.lease_expires_at <= clock_timestamp()))
           ${jobTypeFilter}
           ${semanticScopeFilter}
           ${aggregateAdmissionFilter}
         order by candidate.available_at, candidate.job_id
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
        const expiry = updated.rows[0]?.lease_expires_at;
        if (expiry === undefined) throw new PostgresInfrastructureError();
        leased.push({
          jobId: row.job_id,
          payload: safePayload(row),
          leaseToken,
          leaseExpiresAt: isoTimestamp(expiry),
          attemptCount: row.attempt_count + 1,
          ...(row.semantic_scope_id === null || row.semantic_period === null ? {} : {
            semanticSchedule: { portfolioId: requiredStablePortfolio(row.semantic_scope_id), period: row.semantic_period },
          }),
        });
      }
      return leased;
    });
  }

  function requiredStablePortfolio(value: string) {
    const parsed = parseStableId("Portfolio", value);
    if (!parsed.ok) throw new PostgresInfrastructureError();
    return parsed.value;
  }

  async function guardedTransition(
    table: "outbox_events" | "jobs",
    idColumn: "event_id" | "job_id",
    id: string,
    leaseToken: string,
    transition: "complete" | "fail" | "release",
    value?: string,
    coverageIncomplete?: boolean,
    successfulCheckpoint = false,
  ): Promise<boolean> {
    const tableRef = sql.raw(`operations.${table}`);
    const idRef = sql.raw(idColumn);
    const assignment =
      transition === "complete"
        ? sql`completed_at = ${value}::timestamptz${
            table === "jobs" ? sql`, status = 'completed'${coverageIncomplete === undefined ? sql`` : sql`, work_incomplete = ${coverageIncomplete}`}` : sql``
          }, lease_owner = null, lease_token = null, lease_expires_at = null`
        : transition === "fail"
          ? sql`last_error_code = ${parseSafeErrorCode(value ?? "")}, lease_owner = null, lease_token = null,
                lease_expires_at = null${table === "jobs" ? sql`, status = 'available'` : sql``}`
          : sql`lease_owner = null, lease_token = null, lease_expires_at = null${
              table === "jobs" ? sql`, status = 'available'${successfulCheckpoint ? sql`, attempt_count = 0` : sql``}` : sql``
            }`;
    try {
      const result = await sql<{ changed: boolean }>`
        update ${tableRef} set ${assignment}
         where ${idRef} = ${id}::uuid and lease_token = ${leaseToken}
           and lease_expires_at > clock_timestamp()
           ${table === "jobs" ? sql`and status = 'leased'` : sql``}
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

  async function advancePhase7ScheduleCursor(input: Phase7ScheduleCursorAdvance, stage: "retention" | "aggregate"): Promise<boolean> {
    if (!parseStableId("Portfolio", input.portfolioId).ok || !validSchedulePeriod(input.expectedNextPeriod) ||
        !validSchedulePeriod(input.scheduledThroughPeriod) || input.expectedNextPeriod.includes(":") ||
        input.scheduledThroughPeriod.includes(":") || input.expectedNextPeriod > input.scheduledThroughPeriod) {
      throw new TypeError("Phase 7 schedule cursor advance is invalid.");
    }
    if (!(await phase7ScheduleSchema(database))) throw new PostgresInfrastructureError();
    try {
      return await transactions.run(async context => {
        const executor = resolvePostgresTransaction(context);
        const selected = await sql<Phase7ProgressRow>`
          select to_char(first_policy_period, 'YYYY-MM-DD') as first_policy_period,
                 to_char(required_through_period, 'YYYY-MM-DD') as required_through_period,
                 to_char(retention_scheduled_through, 'YYYY-MM-DD') as retention_scheduled_through,
                 to_char(retention_complete_through, 'YYYY-MM-DD') as retention_complete_through,
                 to_char(aggregate_scheduled_through, 'YYYY-MM-DD') as aggregate_scheduled_through,
                 to_char(aggregate_finished_through, 'YYYY-MM-DD') as aggregate_finished_through,
                 to_char(last_complete_period, 'YYYY-MM-DD') as last_complete_period, phase
            from operations.phase7_schedule_progress
           where portfolio_id = ${input.portfolioId}::uuid
           for update
        `.execute(executor);
        const progress = selected.rows[0];
        if (!progress) return false;
        const currentThrough = stage === "retention" ? progress.retention_scheduled_through : progress.aggregate_scheduled_through;
        if (currentThrough >= input.scheduledThroughPeriod) return true;
        const expectedNext = utcPeriodOffset(currentThrough, 1);
        const periods = boundedPeriodsAfter(currentThrough, input.scheduledThroughPeriod);
        if (expectedNext !== input.expectedNextPeriod || periods.length === 0 ||
            periods.at(-1) !== input.scheduledThroughPeriod || periods.length > 15 ||
            input.scheduledThroughPeriod > progress.required_through_period) return false;
        if (stage === "aggregate" && (progress.retention_complete_through < progress.required_through_period ||
            progress.retention_complete_through < input.scheduledThroughPeriod)) return false;
        const keys = stage === "retention" ? retentionScheduleKeys(periods) : aggregateScheduleKeys(periods);
        const counts = await phase7KeyCounts({ executor, portfolioId: input.portfolioId, ...keys });
        const expectedCount = stage === "retention" ? PHASE7_RETENTION_TYPES.length : 15;
        if (periods.some(period => (counts.get(period)?.present ?? 0) !== expectedCount)) return false;
        const advance = stage === "retention"
          ? sql`retention_scheduled_through = ${input.scheduledThroughPeriod}::date`
          : sql`aggregate_scheduled_through = ${input.scheduledThroughPeriod}::date`;
        const changed = await sql<{ advanced: boolean }>`
          update operations.phase7_schedule_progress
             set ${advance}, updated_at = clock_timestamp()
           where portfolio_id = ${input.portfolioId}::uuid
           returning true as advanced
        `.execute(executor);
        return changed.rows.length === 1;
      });
    } catch {
      throw new PostgresInfrastructureError();
    }
  }

  const outbox: OutboxPersistencePort = {
    append: appendOutbox,
    claimDue: claimOutbox,
    complete: (id, token, at) => guardedTransition("outbox_events", "event_id", id, token, "complete", at),
    fail: (id, token, code) => transitionOutboxFailure(id, token, code, null),
    scheduleRetry: (id, token, code, delay) => transitionOutboxFailure(id, token, code, delay),
    release: (id, token) => guardedTransition("outbox_events", "event_id", id, token, "release"),
  };

  async function readPhase7ScheduleStatus(input: Phase7ScheduleStatusQuery, useDatabaseCurrentPeriod = false) {
    if (!parseStableId("Portfolio", input.portfolioId).ok || !validSchedulePeriod(input.fromPeriod) ||
        !validSchedulePeriod(input.throughPeriod) || input.fromPeriod.includes(":") || input.throughPeriod.includes(":") ||
        input.fromPeriod > input.throughPeriod) throw new TypeError("Phase 7 schedule status query is invalid.");
    if (!(await phase7ScheduleSchema(database))) throw new PostgresInfrastructureError();
    try {
      return await transactions.run(async context => {
        const executor = resolvePostgresTransaction(context);
        let throughPeriod = input.throughPeriod;
        const initialPrior = utcPeriodOffset(input.fromPeriod, -1);
        await sql`
          insert into operations.phase7_schedule_progress (
            portfolio_id, first_policy_period, required_through_period,
            retention_scheduled_through, retention_complete_through,
            aggregate_scheduled_through, aggregate_finished_through, last_complete_period, phase
          ) values (
            ${input.portfolioId}::uuid, ${input.fromPeriod}::date, ${throughPeriod}::date,
            ${initialPrior}::date, ${initialPrior}::date, ${initialPrior}::date, ${initialPrior}::date,
            ${initialPrior}::date, 'retention'
          ) on conflict (portfolio_id) do nothing
        `.execute(executor);
        await sql`
          update operations.phase7_schedule_progress
             set required_through_period = greatest(required_through_period, ${input.throughPeriod}::date),
                 phase = case when retention_complete_through < greatest(required_through_period, ${input.throughPeriod}::date)
                   then 'retention' else phase end,
                 updated_at = clock_timestamp()
           where portfolio_id = ${input.portfolioId}::uuid
        `.execute(executor);
        if (useDatabaseCurrentPeriod) {
          // The UPDATE above owns the progress-row lock before reading database time;
          // a caller waiting across UTC midnight must observe the new policy day.
          const current = await sql<{ current_period: string }>`
            select to_char((clock_timestamp() at time zone 'UTC')::date, 'YYYY-MM-DD') as current_period
          `.execute(executor);
          const databaseCurrentPeriod = current.rows[0]?.current_period;
          if (!databaseCurrentPeriod) throw new PostgresInfrastructureError();
          throughPeriod = [input.throughPeriod, databaseCurrentPeriod].sort().at(-1)!;
          await sql`
            update operations.phase7_schedule_progress
               set required_through_period = greatest(required_through_period, ${throughPeriod}::date),
                   phase = case when retention_complete_through < greatest(required_through_period, ${throughPeriod}::date)
                     then 'retention' else phase end,
                   updated_at = clock_timestamp()
             where portfolio_id = ${input.portfolioId}::uuid
          `.execute(executor);
        }
        const selected = await sql<Phase7ProgressRow>`
          select to_char(first_policy_period, 'YYYY-MM-DD') as first_policy_period,
                 to_char(required_through_period, 'YYYY-MM-DD') as required_through_period,
                 to_char(retention_scheduled_through, 'YYYY-MM-DD') as retention_scheduled_through,
                 to_char(retention_complete_through, 'YYYY-MM-DD') as retention_complete_through,
                 to_char(aggregate_scheduled_through, 'YYYY-MM-DD') as aggregate_scheduled_through,
                 to_char(aggregate_finished_through, 'YYYY-MM-DD') as aggregate_finished_through,
                 to_char(last_complete_period, 'YYYY-MM-DD') as last_complete_period, phase
            from operations.phase7_schedule_progress
           where portfolio_id = ${input.portfolioId}::uuid
           for update
        `.execute(executor);
        let progress = selected.rows[0];
        if (!progress) throw new PostgresInfrastructureError();

        const retentionThrough = [progress.retention_scheduled_through, progress.required_through_period,
          throughPeriod].sort()[0]!;
        const retentionPeriods = boundedPeriodsAfter(progress.retention_complete_through, retentionThrough);
        const retentionKeys = retentionScheduleKeys(retentionPeriods);
        const retentionCounts = await phase7KeyCounts({ executor, portfolioId: input.portfolioId, ...retentionKeys,
          includeCoverageIncomplete: true });
        let retentionCompleteThrough = progress.retention_complete_through;
        for (const period of retentionPeriods) {
          if ((retentionCounts.get(period)?.complete ?? 0) !== PHASE7_RETENTION_TYPES.length) break;
          retentionCompleteThrough = period;
        }

        const aggregateThrough = [progress.aggregate_scheduled_through, retentionCompleteThrough,
          progress.required_through_period, throughPeriod].sort()[0]!;
        const aggregatePeriods = boundedPeriodsAfter(progress.aggregate_finished_through, aggregateThrough);
        const aggregateKeys = completePolicyScheduleKeys(aggregatePeriods);
        const aggregateCounts = await phase7KeyCounts({ executor, portfolioId: input.portfolioId, ...aggregateKeys,
          includeCoverageIncomplete: true });
        let aggregateFinishedThrough = progress.aggregate_finished_through;
        for (const period of aggregatePeriods) {
          if ((aggregateCounts.get(period)?.complete ?? 0) !== 19) break;
          aggregateFinishedThrough = period;
        }

        const policyThrough = [progress.aggregate_scheduled_through, retentionCompleteThrough,
          progress.required_through_period, throughPeriod].sort()[0]!;
        const policyPeriods = boundedPeriodsAfter(progress.last_complete_period, policyThrough);
        const policyKeys = completePolicyScheduleKeys(policyPeriods);
        const policyCounts = await phase7KeyCounts({ executor, portfolioId: input.portfolioId, ...policyKeys });
        let lastCompletePeriod = progress.last_complete_period;
        for (const period of policyPeriods) {
          if ((policyCounts.get(period)?.complete ?? 0) !== 19) break;
          lastCompletePeriod = period;
        }

        const phase = retentionCompleteThrough < progress.required_through_period
          ? "retention"
          : aggregateFinishedThrough < progress.required_through_period ? "aggregate" : "retention";
        if (retentionCompleteThrough !== progress.retention_complete_through ||
            aggregateFinishedThrough !== progress.aggregate_finished_through || lastCompletePeriod !== progress.last_complete_period ||
            phase !== progress.phase) {
          await sql`
            update operations.phase7_schedule_progress
               set retention_complete_through = ${retentionCompleteThrough}::date,
                   aggregate_finished_through = ${aggregateFinishedThrough}::date,
                   last_complete_period = ${lastCompletePeriod}::date,
                   phase = ${phase},
                   updated_at = clock_timestamp()
             where portfolio_id = ${input.portfolioId}::uuid
          `.execute(executor);
        }
        const refreshed = await sql<Phase7ProgressRow>`
          select to_char(first_policy_period, 'YYYY-MM-DD') as first_policy_period,
                 to_char(required_through_period, 'YYYY-MM-DD') as required_through_period,
                 to_char(retention_scheduled_through, 'YYYY-MM-DD') as retention_scheduled_through,
                 to_char(retention_complete_through, 'YYYY-MM-DD') as retention_complete_through,
                 to_char(aggregate_scheduled_through, 'YYYY-MM-DD') as aggregate_scheduled_through,
                 to_char(aggregate_finished_through, 'YYYY-MM-DD') as aggregate_finished_through,
                 to_char(last_complete_period, 'YYYY-MM-DD') as last_complete_period, phase
            from operations.phase7_schedule_progress
           where portfolio_id = ${input.portfolioId}::uuid
        `.execute(executor);
        progress = refreshed.rows[0];
        if (!progress) throw new PostgresInfrastructureError();
        const bounds = phase7ProgressBounds(progress, throughPeriod);
        const recent = await sql<Phase7ScheduleRow>`
          select job_type, semantic_period, status, coalesce(work_incomplete, false) as work_incomplete
            from operations.jobs
           where semantic_scope_id = ${input.portfolioId}::uuid and job_type = any(${PHASE7_JOB_TYPES}::text[])
             and ((job_type = ${PHASE7_AGGREGATE_TYPE}
                   and semantic_period >= ${`${bounds.detailFrom}:`}
                   and semantic_period <= ${`${bounds.detailThrough}:9999-99-99`})
               or (job_type <> ${PHASE7_AGGREGATE_TYPE}
                   and semantic_period between ${bounds.detailFrom} and ${bounds.detailThrough}))
           order by semantic_period, job_type
        `.execute(executor);
        const oldestCoverageIncompletePeriod = recent.rows
          .filter(row => row.work_incomplete)
          .map(row => row.semantic_period.split(":")[0]!)
          .sort()[0] ?? null;
        const oldestUnfinishedPeriod = bounds.oldest;
        const overdue = [oldestUnfinishedPeriod, oldestCoverageIncompletePeriod]
          .filter((period): period is string => period !== null).sort()[0] ?? null;
        return {
          jobs: recent.rows.map(row => ({ jobType: row.job_type, period: row.semantic_period,
            status: row.status, coverageIncomplete: row.work_incomplete })),
          firstPolicyPeriod: progress.first_policy_period,
          requiredThroughPeriod: progress.required_through_period,
          retentionScheduledThrough: progress.retention_scheduled_through,
          retentionCompleteThrough: progress.retention_complete_through,
          aggregateScheduledThrough: progress.aggregate_scheduled_through,
          lastCompletePolicyPeriod: progress.last_complete_period < progress.first_policy_period
            ? null : progress.last_complete_period,
          phase: progress.phase,
          oldestOverduePeriod: overdue,
          oldestUnfinishedPeriod,
          oldestCoverageIncompletePeriod,
          failedCount: recent.rows.filter(row => row.status === "dead" || row.status === "failed").length,
        };
      });
    } catch {
      throw new PostgresInfrastructureError();
    }
  }

  const jobs: LeasedJobStorePort = {
    async enqueue(context: TransactionContext, job: JobInput): Promise<boolean> {
      const executor = resolvePostgresTransaction(context);
      validateJobEnqueueInput(job);
      const payload = validateInputPayload(job.payload);
      try {
        if (job.semanticSchedule === undefined) {
          if (payload.type === PHASE7_AGGREGATE_TYPE) return false;
          await sql`
            insert into operations.jobs (job_id, job_type, payload_version, payload, available_at)
            values (${job.jobId}::uuid, ${payload.type}, ${payload.version},
              ${JSON.stringify(payload.value)}::jsonb, ${job.availableAt}::timestamptz)
          `.execute(executor);
          return true;
        }
        if (!(await phase7ScheduleSchema(database))) throw new PostgresInfrastructureError();
        if (payload.type === PHASE7_AGGREGATE_TYPE) {
          const [policyPeriod, aggregatePeriod, ...extra] = job.semanticSchedule.period.split(":");
          if (!policyPeriod || !aggregatePeriod || extra.length > 0) return false;
          const progress = await sql<Phase7ProgressRow>`
            select to_char(first_policy_period, 'YYYY-MM-DD') as first_policy_period,
                   to_char(required_through_period, 'YYYY-MM-DD') as required_through_period,
                   to_char(retention_scheduled_through, 'YYYY-MM-DD') as retention_scheduled_through,
                   to_char(retention_complete_through, 'YYYY-MM-DD') as retention_complete_through,
                   to_char(aggregate_scheduled_through, 'YYYY-MM-DD') as aggregate_scheduled_through,
                   to_char(aggregate_finished_through, 'YYYY-MM-DD') as aggregate_finished_through,
                   to_char(last_complete_period, 'YYYY-MM-DD') as last_complete_period, phase
              from operations.phase7_schedule_progress
             where portfolio_id = ${job.semanticSchedule.portfolioId}::uuid
             for share
          `.execute(executor);
          const current = progress.rows[0];
          if (!current || current.retention_complete_through < current.required_through_period ||
              current.retention_complete_through < policyPeriod) return false;
          const retentionKeys = retentionScheduleKeys([policyPeriod]);
          const counts = await phase7KeyCounts({ executor, portfolioId: job.semanticSchedule.portfolioId,
            ...retentionKeys, includeCoverageIncomplete: true });
          if ((counts.get(policyPeriod)?.complete ?? 0) !== PHASE7_RETENTION_TYPES.length) return false;
        }
        const inserted = await sql<{ job_id: string }>`
          insert into operations.jobs (
            job_id, job_type, payload_version, payload, available_at, semantic_scope_id, semantic_period
          ) values (
            ${job.jobId}::uuid, ${payload.type}, ${payload.version},
            ${JSON.stringify(payload.value)}::jsonb, ${job.availableAt}::timestamptz,
            ${job.semanticSchedule?.portfolioId ?? null}::uuid, ${job.semanticSchedule?.period ?? null}
          )
          on conflict (semantic_scope_id, job_type, semantic_period)
            where semantic_scope_id is not null do nothing
          returning job_id::text
        `.execute(executor);
        return inserted.rows.length === 1;
      } catch {
        throw new PostgresInfrastructureError();
      }
    },
    claimDue: claimJobs,
    complete: (id, token, at, coverageIncomplete) =>
      guardedTransition("jobs", "job_id", id, token, "complete", at, coverageIncomplete),
    fail: (id, token, code) => transitionJobFailure(id, token, code, null),
    scheduleRetry: (id, token, code, delay) => transitionJobFailure(id, token, code, delay),
    async getDeadForRedrive(id: string) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        throw new TypeError("Job identity is invalid.");
      }
      const scheduleEnabled = await phase7ScheduleSchema(database);
      const scheduleSelect = scheduleEnabled
        ? sql`semantic_scope_id::text, semantic_period`
        : sql`null::text as semantic_scope_id, null::text as semantic_period`;
      const result = await sql<{ job_id: string; job_type: string; payload_version: number; payload: Readonly<Record<string, never>>; attempt_count: number; last_error_code: string | null; semantic_scope_id: string | null; semantic_period: string | null }>`
        select job_id::text, job_type, payload_version, payload, attempt_count, last_error_code,
               ${scheduleSelect}
          from operations.jobs where job_id = ${id}::uuid and status = 'dead'
      `.execute(database);
      const row = result.rows[0];
      if (!row || !row.last_error_code) return null;
      return { jobId: row.job_id, payload: validateVersionedPayload({ type: row.job_type, version: row.payload_version, value: row.payload }),
        attemptCount: row.attempt_count, safeErrorCode: parseSafeErrorCode(row.last_error_code),
        ...(row.semantic_scope_id === null || row.semantic_period === null ? {} : {
          semanticSchedule: { portfolioId: requiredStablePortfolio(row.semantic_scope_id), period: row.semantic_period },
        }) };
    },
    async redriveDead(input: JobRedriveAuditInput): Promise<RedrivenJobRecord | null> {
      if (![input.originalJobId, input.replacementJobId].every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) ||
          input.originalJobId === input.replacementJobId || !/^[0-9a-f]{64}$/i.test(input.operatorScopeHash) ||
          !/^[a-z][a-z0-9-]{0,63}$/.test(input.policyVersion) || !/^[0-9a-f]{64}$/i.test(input.payloadSha256)) {
        throw new TypeError("Job re-drive audit input is invalid.");
      }
      const scheduleEnabled = await phase7ScheduleSchema(database);
      const scheduleSelect = scheduleEnabled
        ? sql`j.semantic_scope_id::text, j.semantic_period`
        : sql`null::text as semantic_scope_id, null::text as semantic_period`;
      return transactions.run(async (context) => {
        const executor = resolvePostgresTransaction(context);
        const found = await sql<{ job_id: string; job_type: string; payload_version: number; payload: Readonly<Record<string, never>>; semantic_scope_id: string | null; semantic_period: string | null }>`
          select j.job_id::text, j.job_type, j.payload_version, j.payload,
                 ${scheduleSelect} from operations.jobs j
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
        if (scheduleEnabled && original.semantic_scope_id !== null && original.semantic_period !== null) {
          await sql`update operations.jobs set semantic_scope_id = null, semantic_period = null
            where job_id = ${input.originalJobId}::uuid`.execute(executor);
        }
        if (scheduleEnabled) {
          await sql`
            insert into operations.jobs(job_id, job_type, payload_version, payload, available_at, semantic_scope_id, semantic_period)
            values (${input.replacementJobId}::uuid, ${payload.type}, ${payload.version}, ${JSON.stringify(payload.value)}::jsonb,
              clock_timestamp(), ${original.semantic_scope_id}::uuid, ${original.semantic_period})
          `.execute(executor);
        } else {
          await sql`
            insert into operations.jobs(job_id, job_type, payload_version, payload, available_at)
            values (${input.replacementJobId}::uuid, ${payload.type}, ${payload.version}, ${JSON.stringify(payload.value)}::jsonb,
              clock_timestamp())
          `.execute(executor);
        }
        await sql`
          insert into operations.job_redrive_audit(original_job_id, replacement_job_id, operator_scope_hash, policy_version, payload_sha256)
          values (${input.originalJobId}::uuid, ${input.replacementJobId}::uuid, ${input.operatorScopeHash}, ${input.policyVersion}, ${input.payloadSha256})
        `.execute(executor);
        return { jobId: input.replacementJobId, payload };
      });
    },
    release: (id, token, successfulCheckpoint) => guardedTransition("jobs", "job_id", id, token, "release",
      undefined, undefined, successfulCheckpoint === true),
    async admitPhase7DependentWork(input: { readonly portfolioId: StableId<"Portfolio"> }) {
      if (!parseStableId("Portfolio", input.portfolioId).ok) throw new TypeError("Phase 7 admission scope is invalid.");
      if (!(await phase7ScheduleSchema(database))) throw new PostgresInfrastructureError();
      try {
        return await transactions.run(async context => {
          const executor = resolvePostgresTransaction(context);
          const selected = await sql<{ required_through_period: string; retention_complete_through: string }>`
            select to_char(required_through_period, 'YYYY-MM-DD') as required_through_period,
                   to_char(retention_complete_through, 'YYYY-MM-DD') as retention_complete_through
              from operations.phase7_schedule_progress
             where portfolio_id = ${input.portfolioId}::uuid
             for update
          `.execute(executor);
          const progress = selected.rows[0];
          if (!progress) return false;
          const current = await sql<{ database_current_period: string }>`
            select to_char((clock_timestamp() at time zone 'UTC')::date, 'YYYY-MM-DD') as database_current_period
          `.execute(executor);
          const databaseCurrentPeriod = current.rows[0]?.database_current_period;
          if (!databaseCurrentPeriod) throw new PostgresInfrastructureError();
          const requiredThroughPeriod = [progress.required_through_period, databaseCurrentPeriod].sort().at(-1)!;
          if (requiredThroughPeriod !== progress.required_through_period) {
            await sql`
              update operations.phase7_schedule_progress
                 set required_through_period = ${requiredThroughPeriod}::date,
                     phase = 'retention',
                     updated_at = clock_timestamp()
               where portfolio_id = ${input.portfolioId}::uuid
            `.execute(executor);
          }
          return progress.retention_complete_through >= requiredThroughPeriod;
        });
      } catch {
        throw new PostgresInfrastructureError();
      }
    },
    getPhase7ScheduleStatus: input => readPhase7ScheduleStatus(input),
    getPhase7ScheduleStatusAtDatabaseCurrentPeriod: input => readPhase7ScheduleStatus(input, true),
    async advancePhase7RetentionSchedule(input: Phase7ScheduleCursorAdvance) {
      return advancePhase7ScheduleCursor(input, "retention");
    },
    async advancePhase7AggregateSchedule(input: Phase7ScheduleCursorAdvance) {
      return advancePhase7ScheduleCursor(input, "aggregate");
    },
  };

  return { transactions, idempotency, outbox, jobs };
}
