import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  updateVersionedRecord,
  type OptimisticFixtureDefinition,
} from "../../src/shared/adapters/postgres/optimistic-concurrency.js";
import {
  createPostgresRuntimeDatabase,
  createPostgresTransactionRunner,
  PostgresInfrastructureError,
} from "../../src/shared/adapters/postgres/runtime.js";
import type { DB } from "../../src/shared/adapters/postgres/database.generated.js";
import type { TransactionContext } from "../../src/runtime/ports.js";

const DATABASE_URL = process.env["PHASE3_DATABASE_URL"];
if (process.env["PHASE3_REQUIRE_DATABASE"] === "1" && !DATABASE_URL) {
  throw new Error("PHASE3_DATABASE_URL is required for the Phase 3 integration gate.");
}
const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const DEFINITION: OptimisticFixtureDefinition = {
  schema: "phase3_test",
  table: "versioned_records",
  valueColumn: "value",
};

const FOREIGN = Object.freeze({ kind: "transaction" }) as TransactionContext;
const VALID_ID = "018f4f7d-0000-7000-8000-000000000031";
const MISSING_ID = "018f4f7d-0000-7000-8000-000000000032";

function stubRunner(queue: Array<{ rows: unknown[]; throws?: unknown }>) {
  const statements: string[] = [];
  let calls = 0;
  const database = {
    transaction() {
      return {
        setIsolationLevel(_level: string) {
          return {
            async execute<T>(callback: (transaction: unknown) => Promise<T>): Promise<T> {
              const transaction = {
                getExecutor() {
                  const executorImpl = {
                    withPlugins() {
                      return executorImpl;
                    },
                    transformQuery(node: unknown) {
                      return node;
                    },
                    compileQuery(node: { sql?: unknown }) {
                      const sqlText = typeof node?.sql === "string" ? node.sql : `stub statement ${calls}`;
                      return { sql: sqlText, parameters: [] as never[] };
                    },
                    async executeQuery(compiled: { sql: string }) {
                      statements.push(compiled.sql);
                      const entry = queue[calls++] ?? { rows: [] };
                      if (entry.throws !== undefined) throw entry.throws;
                      return { rows: entry.rows };
                    },
                  };
                  return executorImpl;
                },
              };
              return callback(transaction);
            },
          };
        },
      };
    },
  } as unknown as Kysely<DB>;
  return { database, statements };
}

describe("optimistic-concurrency adapter pattern (#49)", () => {
  it("rejects unsafe identifiers before touching the database", async () => {
    for (const bad of [
      { ...DEFINITION, schema: "phase3_test; drop table x; --" },
      { ...DEFINITION, table: "Versioned-Records" },
      { ...DEFINITION, valueColumn: "value\"); --" },
    ]) {
      await expect(
        updateVersionedRecord(FOREIGN, bad, {
          id: VALID_ID,
          expectedVersion: 1,
          value: { state: "x" },
        }),
      ).rejects.toThrow(TypeError);
    }
  });

  it("rejects invalid identity, version, and value before touching the database", async () => {
    await expect(
      updateVersionedRecord(FOREIGN, DEFINITION, {
        id: "not-a-uuid",
        expectedVersion: 1,
        value: { state: "x" },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      updateVersionedRecord(FOREIGN, DEFINITION, {
        id: VALID_ID,
        expectedVersion: 0,
        value: { state: "x" },
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      updateVersionedRecord(FOREIGN, DEFINITION, {
        id: VALID_ID,
        expectedVersion: 1.5,
        value: { state: "x" },
      }),
    ).rejects.toThrow(TypeError);
  });

  it("maps one atomic update, missing identity, and stale version through a stub executor", async () => {
    const { database } = stubRunner([{ rows: [] }, { rows: [] }, { rows: [{ version: 2 }] }]);
    const runner = createPostgresTransactionRunner(database);
    const updated = await runner.run((context) =>
      updateVersionedRecord(context, DEFINITION, {
        id: VALID_ID,
        expectedVersion: 1,
        value: { winner: "stub" },
      }),
    );
    expect(updated).toEqual({ kind: "updated", version: 2 });

    const missingStub = stubRunner([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [] }]);
    const missingRunner = createPostgresTransactionRunner(missingStub.database);
    await expect(
      missingRunner.run((context) =>
        updateVersionedRecord(context, DEFINITION, {
          id: MISSING_ID,
          expectedVersion: 1,
          value: { absent: true },
        }),
      ),
    ).resolves.toEqual({ kind: "not_found" });

    const staleStub = stubRunner([{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [{ version: 2 }] }]);
    const staleRunner = createPostgresTransactionRunner(staleStub.database);
    await expect(
      staleRunner.run((context) =>
        updateVersionedRecord(context, DEFINITION, {
          id: VALID_ID,
          expectedVersion: 1,
          value: { stale: true },
        }),
      ),
    ).resolves.toEqual({ kind: "precondition_failed", currentVersion: 2 });
  });

  it("redacts provider failures without leaking SQL or connection data", async () => {
    const raw = new Error(
      'connection postgres://user:hunter2@localhost/db failed DETAIL: Key (id)=(secret) exists.',
    );
    const { database } = stubRunner([{ rows: [] }, { rows: [] }, { rows: [], throws: raw }]);
    const runner = createPostgresTransactionRunner(database);
    try {
      await runner.run((context) =>
        updateVersionedRecord(context, DEFINITION, {
          id: VALID_ID,
          expectedVersion: 1,
          value: { state: "x" },
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresInfrastructureError);
      expect(String((error as Error).message)).toBe("PostgreSQL operation failed.");
      expect(String((error as Error).message)).not.toContain("postgres://");
      expect(String((error as Error).message)).not.toContain("hunter2");
      expect(String((error as Error).stack ?? "")).not.toContain("secret");
    }
  });

  it("keeps the disposable fixture out of production migrations, seeds, and generated contracts", () => {
    const root = process.cwd();
    const migrationDir = join(root, "supabase", "migrations");
    const migrationFiles = readdirSync(migrationDir).filter((file) => file.endsWith(".sql"));
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      const content = readFileSync(join(migrationDir, file), "utf8").toLowerCase();
      expect(content).not.toContain("versioned_records");
      expect(content).not.toContain("phase3_test");
    }
    const generated = readFileSync(
      join(root, "src", "shared", "adapters", "postgres", "database.generated.ts"),
      "utf8",
    );
    expect(generated).not.toContain("versioned_records");
    expect(generated).not.toContain("phase3_test");
    const seedPath = join(root, "supabase", "seed.sql");
    if (existsSync(seedPath)) {
      const seed = readFileSync(seedPath, "utf8").toLowerCase();
      expect(seed).not.toContain("versioned_records");
    }
  });
});

describeDatabase("optimistic-concurrency disposable fixture (#49)", () => {
  const first = createPostgresRuntimeDatabase(DATABASE_URL ?? "");
  const second = createPostgresRuntimeDatabase(DATABASE_URL ?? "");
  const definition: OptimisticFixtureDefinition = {
    schema: "phase3_occ_disposable",
    table: "versioned_records",
    valueColumn: "value",
  };
  const rowId = "018f4f7d-0000-7000-8000-000000000071";
  const absentId = "018f4f7d-0000-7000-8000-000000000072";

  beforeAll(async () => {
    await sql`create schema if not exists phase3_occ_disposable`.execute(first.database);
    await sql`drop table if exists phase3_occ_disposable.versioned_records`.execute(first.database);
    await sql`
      create table phase3_occ_disposable.versioned_records (
        id uuid primary key,
        version integer not null default 1,
        value jsonb not null
      )
    `.execute(first.database);
    await sql`
      insert into phase3_occ_disposable.versioned_records (id, value)
      values (${rowId}::uuid, ${JSON.stringify({ state: "initial" })}::jsonb)
    `.execute(first.database);
  });

  afterAll(async () => {
    await sql`drop schema if exists phase3_occ_disposable cascade`.execute(first.database);
    await first.resource.close();
    await second.resource.close();
  });

  it("starts at version one and updates atomically", async () => {
    const initial = await sql<{ version: number }>`
      select version from phase3_occ_disposable.versioned_records where id = ${rowId}::uuid
    `.execute(first.database);
    expect(initial.rows[0]?.version).toBe(1);

    const updated = await first.transactions.run((context) =>
      updateVersionedRecord(context, definition, {
        id: rowId,
        expectedVersion: 1,
        value: { state: "second" },
      }),
    );
    expect(updated).toEqual({ kind: "updated", version: 2 });
  });

  it("distinguishes missing identity from a stale version", async () => {
    await expect(
      first.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: absentId,
          expectedVersion: 1,
          value: { absent: true },
        }),
      ),
    ).resolves.toEqual({ kind: "not_found" });
    await expect(
      first.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: rowId,
          expectedVersion: 1,
          value: { stale: true },
        }),
      ),
    ).resolves.toEqual({ kind: "precondition_failed", currentVersion: 2 });
  });

  it("lets exactly one of two independent connections win with no lost update", async () => {
    await sql`delete from phase3_occ_disposable.versioned_records`.execute(first.database);
    await sql`
      insert into phase3_occ_disposable.versioned_records (id, value)
      values (${rowId}::uuid, ${JSON.stringify({ state: "initial" })}::jsonb)
    `.execute(first.database);

    const race = await Promise.all([
      first.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: rowId,
          expectedVersion: 1,
          value: { winner: "one" },
        }),
      ),
      second.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: rowId,
          expectedVersion: 1,
          value: { winner: "two" },
        }),
      ),
    ]);
    expect(race.filter((result) => result.kind === "updated")).toHaveLength(1);
    expect(race.filter((result) => result.kind === "precondition_failed")).toEqual([
      { kind: "precondition_failed", currentVersion: 2 },
    ]);

    const winner = race.find((result) => result.kind === "updated");
    expect(winner?.kind).toBe("updated");
    const final = await sql<{ version: number; value: { winner: string } }>`
      select version, value from phase3_occ_disposable.versioned_records where id = ${rowId}::uuid
    `.execute(first.database);
    expect(final.rows[0]?.version).toBe(2);
    const winnerValue =
      winner?.kind === "updated"
        ? race[0]?.kind === "updated"
          ? "one"
          : "two"
        : "unknown";
    expect(final.rows[0]?.value).toEqual({ winner: winnerValue });
  });
});
