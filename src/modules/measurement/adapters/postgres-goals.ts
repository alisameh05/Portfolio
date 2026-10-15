import { sql } from "kysely";
import type { StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { AnalyticsGoalDefinition } from "../application/owner-analytics.js";
import type { AnalyticsGoalRootRecord, AnalyticsGoalVersionRecord, AnalyticsGoalActivationRecord, OwnerAnalyticsGoalRepositoryPort } from "../ports/repository.js";

interface GoalRootRow {
  goal_id: StableId<"AnalyticsGoal">;
  aggregate_version: number;
  active_version_id: StableId<"AnalyticsGoalVersion"> | null;
}
interface GoalVersionRow {
  version_id: StableId<"AnalyticsGoalVersion">;
  version_number: number;
  definition: AnalyticsGoalDefinition;
  created_at: string;
}
interface GoalActivationRow {
  version_id: StableId<"AnalyticsGoalVersion">;
  activated_at: string;
  activation_sequence: number;
}

async function setScope(transaction: TransactionContext, portfolioId: StableId<"Portfolio">): Promise<void> {
  await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true)`.execute(resolvePostgresTransaction(transaction));
}

export function createPostgresOwnerAnalyticsGoalRepository(): OwnerAnalyticsGoalRepositoryPort {
  return {
    async lockGoal(goalId, portfolioId, transaction) {
      const db = resolvePostgresTransaction(transaction);
      await setScope(transaction, portfolioId);
      await sql`select pg_advisory_xact_lock(hashtextextended(${portfolioId + ":" + goalId}, 0))`.execute(db);
    },
    async getGoal(goalId, portfolioId, transaction): Promise<AnalyticsGoalRootRecord | null> {
      const db = resolvePostgresTransaction(transaction);
      await setScope(transaction, portfolioId);
      const result = await sql<GoalRootRow>`select goal_id, aggregate_version, active_version_id from measurement.analytics_goals
        where portfolio_id = ${portfolioId}::uuid and goal_id = ${goalId}::uuid`.execute(db);
      const row = result.rows[0];
      if (!row) return null;
      const aggregateVersion = Number(row.aggregate_version);
      if (!Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1) throw new Error("INVALID_ANALYTICS_GOAL_VERSION");
      return { goalId: row.goal_id, aggregateVersion, activeVersionId: row.active_version_id };
    },
    async insertGoal(goalId, portfolioId, transaction) {
      const db = resolvePostgresTransaction(transaction);
      await setScope(transaction, portfolioId);
      await sql`insert into measurement.analytics_goals (portfolio_id, goal_id, aggregate_version, active_version_id)
        values (${portfolioId}::uuid, ${goalId}::uuid, 1, null)`.execute(db);
    },
    async appendVersion(input, transaction) {
      const db = resolvePostgresTransaction(transaction);
      await setScope(transaction, input.portfolioId);
      await sql`insert into measurement.analytics_goal_versions
        (portfolio_id, goal_id, version_id, version_number, definition, created_at)
        values (${input.portfolioId}::uuid, ${input.goalId}::uuid, ${input.versionId}::uuid,
          ${input.versionNumber}, ${JSON.stringify(input.definition)}::jsonb, ${input.createdAt}::timestamptz)`.execute(db);
      const updated = await sql`update measurement.analytics_goals set aggregate_version = aggregate_version + 1
        where portfolio_id = ${input.portfolioId}::uuid and goal_id = ${input.goalId}::uuid
          and aggregate_version = ${input.expectedAggregateVersion}`.execute(db);
      if (updated.numAffectedRows !== 1n) throw new Error("ANALYTICS_GOAL_VERSION_ADVANCE_FAILED");
    },
    async activateVersion(input, transaction) {
      const db = resolvePostgresTransaction(transaction);
      await setScope(transaction, input.portfolioId);
      const order = await sql<{ next_sequence: number }>`select coalesce(max(activation_sequence), 0) + 1 as next_sequence
        from measurement.analytics_goal_activation_history
        where portfolio_id = ${input.portfolioId}::uuid and goal_id = ${input.goalId}::uuid`.execute(db);
      const activationSequence = Number(order.rows[0]?.next_sequence);
      if (!Number.isSafeInteger(activationSequence) || activationSequence < 1) throw new Error("ANALYTICS_GOAL_ACTIVATION_SEQUENCE_INVALID");
      const updated = await sql`update measurement.analytics_goals set active_version_id = ${input.versionId}::uuid,
          aggregate_version = aggregate_version + 1
        where portfolio_id = ${input.portfolioId}::uuid and goal_id = ${input.goalId}::uuid
          and aggregate_version = ${input.expectedAggregateVersion} and active_version_id is distinct from ${input.versionId}::uuid`.execute(db);
      if (updated.numAffectedRows !== 1n) throw new Error("ANALYTICS_GOAL_ACTIVATION_ADVANCE_FAILED");
      await sql`insert into measurement.analytics_goal_activation_history
        (portfolio_id, goal_id, activation_id, version_id, aggregate_version, activated_at, activation_sequence)
        values (${input.portfolioId}::uuid, ${input.goalId}::uuid, ${input.activationId}::uuid,
          ${input.versionId}::uuid, ${input.expectedAggregateVersion + 1}, ${input.activatedAt}::timestamptz, ${activationSequence})`.execute(db);
      return activationSequence;
    },
    async listVersions(goalId, portfolioId, transaction): Promise<readonly AnalyticsGoalVersionRecord[]> {
      const db = resolvePostgresTransaction(transaction);
      await setScope(transaction, portfolioId);
      const result = await sql<GoalVersionRow>`select version_id, version_number, definition,
          to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
        from measurement.analytics_goal_versions where portfolio_id = ${portfolioId}::uuid and goal_id = ${goalId}::uuid
        order by version_number`.execute(db);
      return result.rows.map(row => ({ versionId: row.version_id, versionNumber: Number(row.version_number),
        definition: row.definition, createdAt: row.created_at.replace(/(\.\d{3})000Z$/, "$1Z") }));
    },
    async listActivations(goalId, portfolioId, transaction): Promise<readonly AnalyticsGoalActivationRecord[]> {
      const db = resolvePostgresTransaction(transaction);
      await setScope(transaction, portfolioId);
      const result = await sql<GoalActivationRow>`select version_id, activation_sequence,
          to_char(activated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as activated_at
        from measurement.analytics_goal_activation_history where portfolio_id = ${portfolioId}::uuid and goal_id = ${goalId}::uuid
        order by activation_sequence`.execute(db);
      return result.rows.map(row => ({ versionId: row.version_id, activatedAt: row.activated_at.replace(/(\.\d{3})000Z$/, "$1Z"), activationSequence: Number(row.activation_sequence) }));
    },
  };
}
