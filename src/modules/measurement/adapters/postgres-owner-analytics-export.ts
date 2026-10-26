import { sql } from "kysely";
import { err, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import { createOwnerAnalyticsExportSnapshotService, type OwnerAnalyticsExportSnapshotReaderPort } from "../application/owner-analytics-export.js";
import { createPostgresDailyAggregateRepository } from "./postgres-daily-aggregates.js";
import { createPostgresOwnerAnalyticsGoalRepository } from "./postgres-goals.js";

function unavailable(): Result<never, Rejection> {
  return err({ kind: "temporarily_unavailable", code: "ANALYTICS_EXPORT_UNAVAILABLE" });
}

export function createPostgresOwnerAnalyticsExportSnapshotReader(): OwnerAnalyticsExportSnapshotReaderPort {
  const service = createOwnerAnalyticsExportSnapshotService({
    goals: createPostgresOwnerAnalyticsGoalRepository(),
    aggregates: createPostgresDailyAggregateRepository(),
  });
  return {
    async readOwnerAnalyticsExportSnapshot(input) {
      const db = resolvePostgresTransaction(input.transaction);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${input.ownerId}, true),
                         set_config('shipwithali.worker_purpose', 'measurement.owner-export', true)`.execute(db);
        const timestamp = await sql<{ captured_at: Date | string }>`select transaction_timestamp() as captured_at`.execute(db);
        const capturedAt = timestamp.rows[0]?.captured_at;
        if (capturedAt === undefined) return unavailable();
        const instant = capturedAt instanceof Date ? capturedAt.toISOString() : new Date(capturedAt).toISOString();
        return await service.readOwnerAnalyticsExportSnapshot({
          portfolioId: input.portfolioId as StableId<"Portfolio">,
          ownerId: input.ownerId as StableId<"Owner">,
          capturedAt: instant,
          transaction: input.transaction as TransactionContext,
        });
      } catch {
        return unavailable();
      }
    },
  };
}
