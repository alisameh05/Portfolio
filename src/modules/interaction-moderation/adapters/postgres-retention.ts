import { sql } from "kysely";
import type { BoundedWorkResult } from "@shared/application";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { FeedbackRetentionBatch, FeedbackRetentionRepositoryPort } from "../ports/retention.js";

interface RetentionCheckpoint { stage: string; requested_at: Date | string }
interface FeedbackId { feedback_id: string }

async function configure(tx: TransactionContext, portfolioId: string, now: string) {
  const db = resolvePostgresTransaction(tx);
  await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true),
    set_config('shipwithali.system_purpose', 'feedback.retention', true),
    set_config('shipwithali.feedback_access', 'retention', true),
    set_config('shipwithali.retention_now', ${now}, true)`.execute(db);
  return db;
}

function asInstant(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}

async function processPendingRejected(db: ReturnType<typeof resolvePostgresTransaction>, input: FeedbackRetentionBatch): Promise<number> {
  const rows = await sql<FeedbackId>`with page as materialized (
    select f.feedback_id from interaction.feedback f
    where f.portfolio_id = ${input.portfolioId}::uuid and f.moderation_state in ('pending','rejected')
      and ((f.submitted_at at time zone 'UTC') + interval '90 days') at time zone 'UTC' <= ${input.now}::timestamptz
    order by f.submitted_at, f.feedback_id limit ${input.batchSize * 4}
  ) select feedback_id from page where pg_try_advisory_xact_lock(hashtextextended(feedback_id::text, 205))
    order by feedback_id limit ${input.batchSize}`.execute(db);
  if (!rows.rows.length) return 0;
  const deleted = await sql`delete from interaction.feedback
    where portfolio_id = ${input.portfolioId}::uuid and feedback_id = any(${rows.rows.map(row => row.feedback_id)}::uuid[])
      and moderation_state in ('pending','rejected') and ((submitted_at at time zone 'UTC') + interval '90 days') at time zone 'UTC' <= ${input.now}::timestamptz`.execute(db);
  return Number(deleted.numAffectedRows ?? 0n);
}

async function hasPendingRejected(db: ReturnType<typeof resolvePostgresTransaction>, input: FeedbackRetentionBatch): Promise<boolean> {
  const rows = await sql<{ exists: boolean }>`select exists (
    select 1 from interaction.feedback f where f.portfolio_id = ${input.portfolioId}::uuid
      and f.moderation_state in ('pending','rejected')
      and ((f.submitted_at at time zone 'UTC') + interval '90 days') at time zone 'UTC' <= ${input.now}::timestamptz
  ) as exists`.execute(db);
  return rows.rows[0]?.exists === true;
}

async function eraseSuppressedText(db: ReturnType<typeof resolvePostgresTransaction>, input: FeedbackRetentionBatch): Promise<number> {
  const rows = await sql<FeedbackId>`with page as materialized (
    select f.feedback_id from interaction.feedback f
    join lateral (select d.decided_at from interaction.moderation_decisions d
      where d.portfolio_id = f.portfolio_id and d.feedback_id = f.feedback_id and d.decision = 'suppressed'
      order by d.sequence desc limit 1) suppression on true
    where f.portfolio_id = ${input.portfolioId}::uuid and f.moderation_state = 'suppressed'
      and f.text_erased_at is null and ((suppression.decided_at at time zone 'UTC') + interval '12 months') at time zone 'UTC' <= ${input.now}::timestamptz
    order by suppression.decided_at, f.feedback_id limit ${input.batchSize * 4}
  ) select feedback_id from page where pg_try_advisory_xact_lock(hashtextextended(feedback_id::text, 205))
    order by feedback_id limit ${input.batchSize}`.execute(db);
  if (!rows.rows.length) return 0;
  const ids = rows.rows.map(row => row.feedback_id);
  await sql`update interaction.moderation_decisions set reason = null, owner_id = null where portfolio_id = ${input.portfolioId}::uuid
    and feedback_id = any(${ids}::uuid[])`.execute(db);
  const updated = await sql`update interaction.feedback f set author_name = null, paragraph = null, text_erased_at = ${input.now}::timestamptz
    where f.portfolio_id = ${input.portfolioId}::uuid and f.feedback_id = any(${ids}::uuid[])
      and f.moderation_state = 'suppressed' and f.text_erased_at is null
      and exists (select 1 from interaction.moderation_decisions d where d.portfolio_id = f.portfolio_id
        and d.feedback_id = f.feedback_id and d.decision = 'suppressed'
        and ((d.decided_at at time zone 'UTC') + interval '12 months') at time zone 'UTC' <= ${input.now}::timestamptz)`.execute(db);
  return Number(updated.numAffectedRows ?? 0n);
}

async function hasSuppressedText(db: ReturnType<typeof resolvePostgresTransaction>, input: FeedbackRetentionBatch): Promise<boolean> {
  const rows = await sql<{ exists: boolean }>`select exists (
    select 1 from interaction.feedback f
    join lateral (select d.decided_at from interaction.moderation_decisions d
      where d.portfolio_id = f.portfolio_id and d.feedback_id = f.feedback_id and d.decision = 'suppressed'
      order by d.sequence desc limit 1) suppression on true
    where f.portfolio_id = ${input.portfolioId}::uuid and f.moderation_state = 'suppressed'
      and f.text_erased_at is null and ((suppression.decided_at at time zone 'UTC') + interval '12 months') at time zone 'UTC' <= ${input.now}::timestamptz
  ) as exists`.execute(db);
  return rows.rows[0]?.exists === true;
}

export function createPostgresFeedbackRetentionRepository(): FeedbackRetentionRepositoryPort {
  return {
    async processBatch(input, transaction): Promise<BoundedWorkResult> {
      const db = await configure(transaction, input.portfolioId, input.now);
      await sql`insert into interaction.feedback_retention_checkpoints (portfolio_id, job_id, requested_at, stage, updated_at)
        values (${input.portfolioId}::uuid, ${input.jobId}::uuid, ${input.now}::timestamptz, 'pending-rejected', ${input.now}::timestamptz)
        on conflict (portfolio_id, job_id) do nothing`.execute(db);
      const rows = await sql<RetentionCheckpoint>`select stage, requested_at from interaction.feedback_retention_checkpoints
        where portfolio_id = ${input.portfolioId}::uuid and job_id = ${input.jobId}::uuid for update`.execute(db);
      const checkpoint = rows.rows[0];
      if (!checkpoint || asInstant(checkpoint.requested_at) !== input.now) throw new Error("FEEDBACK_RETENTION_CHECKPOINT_MISMATCH");
      if (checkpoint.stage !== "pending-rejected" && checkpoint.stage !== "suppressed-text") throw new Error("FEEDBACK_RETENTION_STAGE_INVALID");
      const count = checkpoint.stage === "pending-rejected"
        ? await processPendingRejected(db, input)
        : await eraseSuppressedText(db, input);
      const hasRemaining = checkpoint.stage === "pending-rejected"
        ? await hasPendingRejected(db, input)
        : await hasSuppressedText(db, input);
      if (hasRemaining) {
        await sql`update interaction.feedback_retention_checkpoints set updated_at = ${input.now}::timestamptz
          where portfolio_id = ${input.portfolioId}::uuid and job_id = ${input.jobId}::uuid`.execute(db);
        return { processedCount: count, nextCursor: input.jobId, incomplete: true };
      }
      if (checkpoint.stage === "pending-rejected") {
        await sql`update interaction.feedback_retention_checkpoints set stage = 'suppressed-text', updated_at = ${input.now}::timestamptz
          where portfolio_id = ${input.portfolioId}::uuid and job_id = ${input.jobId}::uuid`.execute(db);
        return { processedCount: count, nextCursor: input.jobId, incomplete: true };
      }
      await sql`delete from interaction.feedback_retention_checkpoints where portfolio_id = ${input.portfolioId}::uuid and job_id = ${input.jobId}::uuid`.execute(db);
      return { processedCount: count, nextCursor: null, incomplete: false };
    },
  };
}
