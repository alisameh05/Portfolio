import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  createPostgresTransactionRunner,
  PostgresInfrastructureError,
  resolvePostgresTransaction,
} from "../../src/shared/adapters/postgres/runtime.js";
import {
  requestTransactionRollback,
  type TransactionContext,
} from "../../src/runtime/ports.js";
import type { DB } from "../../src/shared/adapters/postgres/database.generated.js";

interface StubCall {
  readonly isolationLevel?: string;
  readonly statements: string[];
  readonly committed: boolean;
}

function createStubDatabase(options: { failWith?: unknown } = {}): {
  database: Kysely<DB>;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const database = {
    transaction() {
      return {
        setIsolationLevel(level: string) {
          return {
            async execute<T>(callback: (transaction: unknown) => Promise<T>): Promise<T> {
              const call: { isolationLevel?: string; statements: string[]; committed: boolean } = {
                isolationLevel: level,
                statements: [],
                committed: false,
              };
              calls.push(call as StubCall);
              const transaction = {
                getExecutor() {
                  const executorImpl = {
                    withPlugins() {
                      return executorImpl;
                    },
                    transformQuery(node: unknown) {
                      return node;
                    },
                    compileQuery(node: { sql?: unknown; sqlFragments?: unknown }) {
                      const fragments = Array.isArray(node?.sqlFragments)
                        ? (node.sqlFragments as unknown[]).filter((part): part is string => typeof part === "string")
                        : [];
                      const sqlText =
                        typeof node?.sql === "string"
                          ? node.sql
                          : fragments.length > 0
                            ? fragments.join("")
                            : "set local timeout";
                      return { sql: sqlText, parameters: [] as never[] };
                    },
                    async executeQuery(compiled: { sql: string }) {
                      call.statements.push(compiled.sql);
                      return { rows: [] };
                    },
                  };
                  return executorImpl;
                },
              };
              try {
                const result = await callback(transaction);
                call.committed = true;
                return result;
              } catch (error) {
                if (options.failWith !== undefined) throw options.failWith;
                throw error;
              }
            },
          };
        },
      };
    },
  } as unknown as Kysely<DB>;
  return { database, calls };
}

describe("PostgreSQL transaction runner (#48)", () => {
  it("runs callbacks in READ COMMITTED with bounded timeouts and an opaque context", async () => {
    const { database, calls } = createStubDatabase();
    const runner = createPostgresTransactionRunner(database);

    let observed: TransactionContext | undefined;
    const result = await runner.run((context) => {
      observed = context;
      expect(Object.isFrozen(context)).toBe(true);
      expect({ ...context }).toEqual({ kind: "transaction" });
      expect("execute" in (context as unknown as Record<string, unknown>)).toBe(false);
      const executor = resolvePostgresTransaction(context) as unknown as {
        getExecutor?: () => { executeQuery: unknown };
      };
      expect(typeof executor.getExecutor).toBe("function");
      expect(typeof executor.getExecutor?.().executeQuery).toBe("function");
      return "committed-value";
    });

    expect(result).toBe("committed-value");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.isolationLevel).toBe("read committed");
    const statements = calls[0]?.statements.join("\n") ?? "";
    expect(statements).toContain("lock_timeout");
    expect(statements).toContain("'5s'");
    expect(statements).toContain("statement_timeout");
    expect(statements).toContain("'15s'");
    expect(calls[0]?.committed).toBe(true);
    expect(observed?.kind).toBe("transaction");
  });

  it("rolls back and redacts provider failures without leaking SQL", async () => {
    const { database } = createStubDatabase();
    const runner = createPostgresTransactionRunner(database);

    const failure = new Error(
      'duplicate key value violates unique constraint "outbox_events_pkey" DETAIL: Key (event_id)=(secret) exists. postgres://user:hunter2@localhost/db',
    );
    await expect(
      runner.run(() => {
        throw failure;
      }),
    ).rejects.toBeInstanceOf(PostgresInfrastructureError);

    try {
      await runner.run(() => {
        throw failure;
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toBe("PostgreSQL operation failed.");
      expect(String((error as Error).message)).not.toContain("postgres://");
      expect(String((error as Error).message)).not.toContain("hunter2");
      expect(String((error as Error).stack ?? "")).not.toContain("outbox_events_pkey");
    }
  });

  it("honors explicit rollback outcomes as a rolled-back value", async () => {
    const { database, calls } = createStubDatabase();
    const runner = createPostgresTransactionRunner(database);

    const result = await runner.run((context) => {
      expect(resolvePostgresTransaction(context)).toBeDefined();
      return requestTransactionRollback("rolled-back");
    });

    expect(result).toBe("rolled-back");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.committed).toBe(false);
  });

  it("rejects resolving a transaction outside the runner with a safe error", () => {
    const foreign = Object.freeze({ kind: "transaction" }) as TransactionContext;
    expect(() => resolvePostgresTransaction(foreign)).toThrow(PostgresInfrastructureError);
    try {
      resolvePostgresTransaction(foreign);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("PostgreSQL operation failed.");
    }
  });
});
