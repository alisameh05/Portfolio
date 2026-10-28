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
  type TransactionRunOptions,
} from "../../../runtime/ports.js";
import { InputValidationError } from "@shared/domain";
import type { DB } from "./database.generated.js";

export type PostgresExecutor = Kysely<DB> | Transaction<DB>;

const TRANSACTIONS = new WeakMap<TransactionContext, PostgresExecutor>();
const CONTEXT_KIND = "transaction" as const;

type RuntimeObservation = Readonly<Record<string, string | number>>;
type RuntimeObservationSink = (observation: RuntimeObservation) => void;

function emitRuntimeObservation(fields: RuntimeObservation, sink?: RuntimeObservationSink): void {
  try { (sink ?? ((observation) => console.info(JSON.stringify(observation))))({ event: "operations.signal",
    observedAt: new Date().toISOString(), ...fields }); }
  catch { /* telemetry is best effort */ }
}

function isAuthorizationFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === "object"; depth += 1) {
    if (current instanceof PostgresInfrastructureError) {
      if (current.category === "authorization") return true;
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    const record = current as Record<string, unknown>;
    if (record["code"] === "42501") return true;
    if (record["code"] === "POSTGRES_UNAVAILABLE" &&
        record["name"] === "PostgresInfrastructureError" && record["category"] === "authorization") return true;
    current = record["cause"];
  }
  return false;
}

export function postgresFailureCategory(error: unknown): "authorization" | "transaction" {
  return isAuthorizationFailure(error) ? "authorization" : "transaction";
}

class RequestedRollback<T> extends Error {
  constructor(readonly value: T) {
    super("TRANSACTION_ROLLBACK_REQUESTED");
  }
}

export class PostgresInfrastructureError extends Error {
  readonly code = "POSTGRES_UNAVAILABLE";
  readonly category: "authorization" | "transaction";

  constructor(category: "authorization" | "transaction" = "transaction") {
    super("PostgreSQL operation failed.");
    this.name = "PostgresInfrastructureError";
    this.category = category;
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
  runtimeObservationSink?: RuntimeObservationSink,
): TransactionRunner {
  return {
    async run<T>(
      callback: (
        context: TransactionContext,
      ) => Promise<T | TransactionRollback<T>> | T | TransactionRollback<T>,
      options: TransactionRunOptions = {},
    ): Promise<T> {
      try {
        return await database.transaction().setIsolationLevel(options.isolationLevel ?? "read committed").execute(
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
        if (error instanceof PostgresInfrastructureError) {
          emitRuntimeObservation({ signal: "database-failure", category: error.category }, runtimeObservationSink);
          throw error;
        }
        if (error instanceof InputValidationError && safeInputErrors.has(error)) throw error;
        const category = postgresFailureCategory(error);
        emitRuntimeObservation({ signal: "database-failure", category }, runtimeObservationSink);
        throw new PostgresInfrastructureError(category);
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
  readonly runtimeObservationSink?: RuntimeObservationSink;
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
  const configuredLimit = options.max ?? 5;
  const recordPoolUsage = () => {
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1 || configuredLimit > 1_000) return;
    const usedConnections = Math.max(0, Math.min(1_000, pool.totalCount - pool.idleCount));
    emitRuntimeObservation({ signal: "database-pool", usedConnections, configuredLimit }, options.runtimeObservationSink);
  };
  pool.on("acquire", recordPoolUsage);
  // pg-pool emits `release` before adding the client back to its idle array.
  // Defer the sample until that release transition (and any queued checkout)
  // has completed so it represents current occupancy rather than one stale
  // pre-transition observation.
  pool.on("release", () => setImmediate(recordPoolUsage));
  pool.on("remove", recordPoolUsage);
  pool.on("error", () => emitRuntimeObservation({ signal: "database-failure", category: "pool" }, options.runtimeObservationSink));
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
    transactions: createPostgresTransactionRunner(database, undefined, options.runtimeObservationSink),
    readiness,
    resource,
  };
}
