import { sql } from "kysely";

import type { TransactionContext } from "../../../runtime/ports.js";
import { resolvePostgresTransaction } from "./runtime.js";

export type OptimisticUpdateResult =
  | { readonly kind: "updated"; readonly version: number }
  | { readonly kind: "not_found" }
  | { readonly kind: "precondition_failed"; readonly currentVersion: number };

export interface OptimisticFixtureDefinition {
  readonly schema: string;
  readonly table: string;
  readonly valueColumn: string;
}

function identifier(value: string): ReturnType<typeof sql.raw> {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
    throw new TypeError("Unsafe PostgreSQL identifier.");
  }
  return sql.raw(value);
}

/** Compare, write, increment, and return in one atomic SQL statement. */
export async function updateVersionedRecord(
  context: TransactionContext,
  definition: OptimisticFixtureDefinition,
  input: {
    readonly id: string;
    readonly expectedVersion: number;
    readonly value: Readonly<Record<string, unknown>>;
  },
): Promise<OptimisticUpdateResult> {
  const executor = resolvePostgresTransaction(context);
  const table = sql`${identifier(definition.schema)}.${identifier(definition.table)}`;
  const valueColumn = identifier(definition.valueColumn);
  const updated = await sql<{ version: number }>`
    update ${table}
       set ${valueColumn} = ${JSON.stringify(input.value)}::jsonb,
           version = version + 1
     where id = ${input.id}::uuid and version = ${input.expectedVersion}
     returning version
  `.execute(executor);
  const row = updated.rows[0];
  if (row !== undefined) return { kind: "updated", version: row.version };

  const existing = await sql<{ version: number }>`
    select version from ${table} where id = ${input.id}::uuid
  `.execute(executor);
  const current = existing.rows[0];
  return current === undefined
    ? { kind: "not_found" }
    : { kind: "precondition_failed", currentVersion: current.version };
}
