/**
 * postgres/runtime.ts — Phase 3 #48 PostgreSQL transaction and pool adapter.
 *
 * Production `TransactionRunner`: one `READ COMMITTED` transaction per run,
 * explicit opaque `TransactionContext` (resolvable only here via
 * `resolvePostgresTransaction`), bounded `lock_timeout`/`statement_timeout`,
 * parameterized statements, and redacted `PostgresInfrastructureError`
 * outcomes. No hidden ambient transaction state is used.
 */
import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Pool } from "pg";

import {
  isTransactionRollback,
  type LifecycleResource,
  type ReadinessCheck,
  type TransactionContext,
  type TransactionRollback,
  type TransactionRunner,
} from "../../../runtime/ports.js";
import { InputValidationError } from "@shared/domain";
import type { DB } from "./database.generated.js";

export type PostgresExecutor = Kysely<DB> | Transaction<DB>;

const TRANSACTIONS = new WeakMap<TransactionContext, PostgresExecutor>();
const CONTEXT_KIND = "transaction" as const;

class RequestedRollback<T> extends Error {
  constructor(readonly value: T) {
    super("TRANSACTION_ROLLBACK_REQUESTED");
  }
}

export class PostgresInfrastructureError extends Error {
  readonly code = "POSTGRES_UNAVAILABLE";

  constructor() {
    super("PostgreSQL operation failed.");
    this.name = "PostgresInfrastructureError";
  }
}

function createContext(executor: PostgresExecutor): TransactionContext {
  const context: TransactionContext = Object.freeze({ kind: CONTEXT_KIND });
  TRANSACTIONS.set(context, executor);
  return context;
}

/** Adapter-confined resolver; never export it through a domain/application barrel. */
export function resolvePostgresTransaction(
  context: TransactionContext,
): PostgresExecutor {
  const executor = TRANSACTIONS.get(context);
  if (executor === undefined) {
    throw new PostgresInfrastructureError();
  }
  return executor;
}

export function createPostgresTransactionRunner(
  database: Kysely<DB>,
  safeInputErrors: WeakSet<InputValidationError> = new WeakSet(),
): TransactionRunner {
  return {
    async run<T>(
      callback: (
        context: TransactionContext,
      ) => Promise<T | TransactionRollback<T>> | T | TransactionRollback<T>,
    ): Promise<T> {
      try {
        return await database.transaction().setIsolationLevel("read committed").execute(
          async (transaction) => {
            await sql`set local lock_timeout = '5s'`.execute(transaction);
            await sql`set local statement_timeout = '15s'`.execute(transaction);
            const result = await callback(createContext(transaction));
            if (isTransactionRollback(result)) {
              throw new RequestedRollback(result.value);
            }
            return result;
          },
        );
      } catch (error) {
        if (error instanceof RequestedRollback) return error.value as T;
        if (error instanceof PostgresInfrastructureError) throw error;
        if (error instanceof InputValidationError && safeInputErrors.has(error)) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}

export interface PostgresRuntimeDatabase {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
  readonly readiness: ReadinessCheck;
  readonly resource: LifecycleResource;
}

export interface PostgresPoolOptions {
  readonly max?: number;
  readonly connectionTimeoutMs?: number;
  readonly readinessTimeoutMs?: number;
}

export function createPostgresRuntimeDatabase(
  connectionString: string,
  options: PostgresPoolOptions = {},
): PostgresRuntimeDatabase {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 5,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 2_000,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: true,
  });
  const database = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  let closePromise: Promise<void> | undefined;

  const readiness: ReadinessCheck = {
    name: "postgresql",
    async check(): Promise<boolean> {
      const timeoutMs = options.readinessTimeoutMs ?? 2_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          sql`select 1`.execute(database),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("READINESS_TIMEOUT")), timeoutMs);
          }),
        ]);
        return true;
      } catch {
        return false;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };

  const resource: LifecycleResource = {
    name: "postgresql-pool",
    close(): Promise<void> {
      closePromise ??= database.destroy();
      return closePromise;
    },
  };

  return {
    database,
    transactions: createPostgresTransactionRunner(database),
    readiness,
    resource,
  };
}
