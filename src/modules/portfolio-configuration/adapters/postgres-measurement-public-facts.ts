import { sql } from "kysely";
import type { StableId } from "@shared/domain";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { MeasurementConfigurationPublicFactsPort } from "../application/measurement-public-facts.js";

/** Returns capability booleans only; labels and configured destinations never cross this module seam. */
export function createPostgresMeasurementConfigurationPublicFacts(scope: {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}): MeasurementConfigurationPublicFactsPort {
  async function setScope(transaction: Parameters<MeasurementConfigurationPublicFactsPort["hasPublicContactChannel"]>[1]) {
    const db = resolvePostgresTransaction(transaction);
    await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
      set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(db);
    return db;
  }
  return {
    async hasPublicContactChannel(input, transaction) {
      if (input.portfolioId !== scope.portfolioId) return { ok: true, value: false };
      const db = await setScope(transaction);
      const result = await sql<{ available: boolean }>`
        with configured_settings as materialized (
          select portfolio_id from portfolio_config.settings
          where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
          for share
        )
        select exists (
          select 1 from portfolio_config.contact_channels channel
          join configured_settings settings using (portfolio_id)
          where channel.portfolio_id = ${scope.portfolioId}::uuid
            and channel.channel = ${input.channel}
            and channel.available_locales @> jsonb_build_array(${input.locale}::text)
        ) as available
      `.execute(db);
      return { ok: true, value: result.rows[0]?.available === true };
    },
    async hasAvailableGlobalProjectCta(input, transaction) {
      if (input.portfolioId !== scope.portfolioId) return { ok: true, value: false };
      const db = await setScope(transaction);
      const result = await sql<{ available: boolean }>`
        with configured_settings as materialized (
          select global_cta_destination from portfolio_config.settings
          where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
          for share
        )
        select exists (
          select 1 from configured_settings
          where char_length(btrim(global_cta_destination)) > 0
        ) as available
      `.execute(db);
      return { ok: true, value: result.rows[0]?.available === true };
    },
  };
}
