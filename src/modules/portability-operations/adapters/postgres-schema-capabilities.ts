import { sql, type Kysely } from "kysely";

import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import { PostgresInfrastructureError } from "../../../shared/adapters/postgres/runtime.js";

interface ColumnProbeRow {
  available: boolean;
}

const leaseAcquiredAtColumns = new WeakMap<Kysely<DB>, Promise<boolean>>();

/**
 * Migration 64 adds the optional acquisition timestamp independently of the
 * bounded-retry columns. Keep the legacy queue adapters executable before it.
 * Cache the capability per database handle; deployments apply migrations
 * before starting a new process, so a schema change requires a fresh handle.
 */
export function supportsLeaseAcquiredAtColumn(database: Kysely<DB>): Promise<boolean> {
  const cached = leaseAcquiredAtColumns.get(database);
  if (cached !== undefined) return cached;
  const probe = (async () => {
    try {
      const result = await sql<ColumnProbeRow>`
        select exists (
          select 1 from information_schema.columns
           where table_schema = 'operations'
             and table_name in ('outbox_events', 'jobs')
           group by table_schema
          having count(*) filter (where table_name = 'outbox_events' and column_name = 'lease_acquired_at') = 1
             and count(*) filter (where table_name = 'jobs' and column_name = 'lease_acquired_at') = 1
        ) as available
      `.execute(database);
      if (result.rows[0] === undefined) throw new PostgresInfrastructureError();
      return result.rows[0].available;
    } catch {
      throw new PostgresInfrastructureError();
    }
  })();
  leaseAcquiredAtColumns.set(database, probe);
  void probe.catch(() => {
    if (leaseAcquiredAtColumns.get(database) === probe) leaseAcquiredAtColumns.delete(database);
  });
  return probe;
}
