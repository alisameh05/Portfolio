import { sql } from "kysely";
import type { Rejection, Result, StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { AnalyticsGoalScopeFactsPort } from "../application/goal-versions.js";

export function createPostgresAnalyticsGoalScopeFacts(scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }): AnalyticsGoalScopeFactsPort {
  async function configure(transaction: TransactionContext): Promise<void> {
    await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
      set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(resolvePostgresTransaction(transaction));
  }
  return {
    async hasRetainedRoute(input, transaction): Promise<Result<boolean, Rejection>> {
      if (input.portfolioId !== scope.portfolioId) return { ok: true, value: false };
      const db = resolvePostgresTransaction(transaction);
      await configure(transaction);
      const rows = await sql<{ retained: boolean }>`select exists (
        select 1 from content.public_routes where portfolio_id = ${scope.portfolioId}::uuid and route_identity = ${input.routeId}::uuid
      ) as retained`.execute(db);
      return { ok: true, value: rows.rows[0]?.retained === true };
    },
    async hasRetainedProject(input, transaction): Promise<Result<boolean, Rejection>> {
      if (input.portfolioId !== scope.portfolioId) return { ok: true, value: false };
      const db = resolvePostgresTransaction(transaction);
      await configure(transaction);
      const rows = await sql<{ retained: boolean }>`select exists (
        select 1 from content.items i join content.public_routes r
          on r.portfolio_id = i.portfolio_id and r.content_id = i.content_id
        where i.portfolio_id = ${scope.portfolioId}::uuid and i.content_id = ${input.projectId}::uuid and i.content_type = 'project'
      ) as retained`.execute(db);
      return { ok: true, value: rows.rows[0]?.retained === true };
    },
  };
}
