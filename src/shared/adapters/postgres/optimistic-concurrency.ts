import { sql } from "kysely";

import type { TransactionContext } from "../../../runtime/ports.js";
import {
  PostgresInfrastructureError,
  postgresFailureCategory,
  resolvePostgresTransaction,
} from "./runtime.js";

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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertDefinition(definition: OptimisticFixtureDefinition): void {
  identifier(definition.schema);
  identifier(definition.table);
  identifier(definition.valueColumn);
}

function assertInput(input: {
  readonly id: string;
  readonly expectedVersion: number;
  readonly value: Readonly<Record<string, unknown>>;
}): void {
  if (!UUID_PATTERN.test(input.id)) {
    throw new TypeError("Optimistic update requires a UUID identity.");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new TypeError("Optimistic update requires an expected version >= 1.");
  }
  if (typeof input.value !== "object" || input.value === null || Array.isArray(input.value)) {
    throw new TypeError("Optimistic update requires a JSON object value.");
  }
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
  assertDefinition(definition);
  assertInput(input);
  const executor = resolvePostgresTransaction(context);
  const table = sql`${identifier(definition.schema)}.${identifier(definition.table)}`;
  const valueColumn = identifier(definition.valueColumn);
  let updated;
  try {
    updated = await sql<{ version: number }>`
    update ${table}
       set ${valueColumn} = ${JSON.stringify(input.value)}::jsonb,
           version = version + 1
     where id = ${input.id}::uuid and version = ${input.expectedVersion}
     returning version
  `.execute(executor);
  } catch (error) {
      throw new PostgresInfrastructureError(postgresFailureCategory(error));
    }
  const row = updated.rows[0];
  if (row !== undefined) return { kind: "updated", version: row.version };

  let existing;
  try {
    existing = await sql<{ version: number }>`
    select version from ${table} where id = ${input.id}::uuid
  `.execute(executor);
  } catch (error) {
      throw new PostgresInfrastructureError(postgresFailureCategory(error));
    }
  const current = existing.rows[0];
  return current === undefined
    ? { kind: "not_found" }
    : { kind: "precondition_failed", currentVersion: current.version };
}
