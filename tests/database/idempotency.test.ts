import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { parseIdempotencyKey } from "../../src/shared/domain/idempotency-key.js";
import { hashCanonicalRequest } from "../../src/shared/application/idempotency.js";
import { PostgresInfrastructureError } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import type { IdempotentExecutionInput } from "../../src/modules/portability-operations/application/persistence.js";
import type { DB } from "../../src/shared/adapters/postgres/database.generated.js";

const NOW = "2026-09-22T12:00:00.000Z";
const EXPIRY = "2026-09-23T12:00:00.000Z";

type QueueEntry = { rows: unknown[] } | { throws: unknown };

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function testKey(value: string) {
  const parsed = parseIdempotencyKey(value);
  if (!parsed.ok) throw new Error(`test key invalid: ${value}`);
  return parsed.value;
}

function stubOperationsDatabase(queue: QueueEntry[]) {
  let calls = 0;
  const makeExecutor = () => {
    const implementation = {
      withPlugins() {
        return implementation;
      },
      transformQuery(node: unknown) {
        return node;
      },
      compileQuery(node: { sql?: unknown }) {
        const sqlText = typeof node?.sql === "string" ? node.sql : `stub statement ${calls}`;
        return { sql: sqlText, parameters: [] as never[] };
      },
      async executeQuery(compiled: { sql: string }) {
        const entry = queue[calls];
        calls += 1;
        if (entry === undefined) throw new Error(`unexpected query: ${compiled.sql}`);
        if ("throws" in entry) throw entry.throws;
        return { rows: entry.rows };
      },
    };
    return implementation;
  };
  const transaction = { getExecutor: () => makeExecutor() };
  const database = {
    getExecutor: () => makeExecutor(),
    transaction() {
      return {
        setIsolationLevel(_level: string) {
          return {
            async execute<T>(callback: (trx: unknown) => Promise<T>): Promise<T> {
              return callback(transaction);
            },
          };
        },
      };
    },
  } as unknown as Kysely<DB>;
  return { database, queryCount: () => calls };
}

function validInput(overrides: Partial<IdempotentExecutionInput> = {}): IdempotentExecutionInput {
  return {
    operationScope: "project.publish",
    actorScope: sha256("opaque-actor"),
    key: testKey("retry-key-never-stored"),
    requestHash: sha256("canonical-request"),
    expiresAt: EXPIRY,
    ...overrides,
  };
}

describe("idempotency ledger and execution seam (#51)", () => {
  it("rejects invalid scope, hash, expiry, and key material before touching the database", async () => {
    const cases: Array<{ name: string; input: IdempotentExecutionInput }> = [
      { name: "operation", input: validInput({ operationScope: "BAD SCOPE!" }) },
      { name: "actor", input: validInput({ actorScope: "not-hex" }) },
      { name: "hash", input: validInput({ requestHash: "not-hex" }) },
      { name: "expiry", input: validInput({ expiresAt: "not-a-date" }) },
      // biome-ignore lint: intentionally invalid branded key for validation test
      { name: "key-empty", input: validInput({ key: "" as never }) },
      // biome-ignore lint: spaces are not visible-ASCII-without-space
      { name: "key-space", input: validInput({ key: "has space" as never }) },
    ];
    for (const entry of cases) {
      const stub = stubOperationsDatabase([]);
      const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
      await expect(
        store.idempotency.execute(entry.input, async () => ({ status: "must-not-run" })),
        entry.name,
      ).rejects.toThrow(TypeError);
      expect(stub.queryCount(), entry.name).toBe(0);
    }
  });

  it("validates input before opening a transaction", async () => {
    // The idempotency seam owns its transaction; invalid input must fail before any I/O.
    const stub = stubOperationsDatabase([]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(
      store.idempotency.execute(validInput({ operationScope: "BAD!" }), async () => ({})),
    ).rejects.toThrow(TypeError);
    expect(stub.queryCount()).toBe(0);
  });

  it("executes first run and records the safe result in one transaction", async () => {
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [{ inserted: true }] },
      { rows: [] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
    let effects = 0;
    const result = await store.idempotency.execute(validInput(), async () => {
      effects += 1;
      return { status: "accepted", version: 1 };
    });
    expect(result).toEqual({ kind: "executed", result: { status: "accepted", version: 1 } });
    expect(effects).toBe(1);
  });

  it("replays an exact retry without rerunning effects", async () => {
    const envelope = { status: "accepted", version: 1 };
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            request_hash: sha256("canonical-request"),
            status: "completed",
            result_envelope: envelope,
            expires_at: EXPIRY,
          },
        ],
      },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
    let effects = 0;
    const result = await store.idempotency.execute(validInput(), async () => {
      effects += 1;
      return { status: "must-not-run" };
    });
    expect(result).toEqual({ kind: "replayed", result: envelope });
    expect(effects).toBe(0);
  });

  it("rejects reuse with another hash as conflict without running effects", async () => {
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            request_hash: sha256("canonical-request"),
            status: "completed",
            result_envelope: { status: "accepted" },
            expires_at: EXPIRY,
          },
        ],
      },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
    let effects = 0;
    const result = await store.idempotency.execute(
      validInput({ requestHash: sha256("different-request") }),
      async () => {
        effects += 1;
        return { status: "must-not-run" };
      },
    );
    expect(result).toEqual({ kind: "conflict" });
    expect(effects).toBe(0);
  });

  it("replaces an expired reservation and re-executes the effect", async () => {
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            request_hash: sha256("request-one"),
            status: "completed",
            result_envelope: { version: 1 },
            expires_at: "2026-09-21T12:00:00.000Z",
          },
        ],
      },
      { rows: [] },
      { rows: [] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
    let effects = 0;
    const result = await store.idempotency.execute(
      validInput({ requestHash: sha256("request-two") }),
      async () => {
        effects += 1;
        return { version: 2 };
      },
    );
    expect(result).toEqual({ kind: "executed", result: { version: 2 } });
    expect(effects).toBe(1);
  });

  it("rolls the reservation back together when the effect fails", async () => {
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [{ inserted: true }] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
    await expect(
      store.idempotency.execute(validInput(), async () => {
        throw new Error("EXPECTED_EFFECT_FAILURE");
      }),
    ).rejects.toBeInstanceOf(PostgresInfrastructureError);
    // Two timeout statements plus the reservation insert; no completion update ran.
    expect(stub.queryCount()).toBe(3);
  });

  it("rejects secret-bearing safe results without persisting them", async () => {
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [{ inserted: true }] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
    await expect(
      store.idempotency.execute(validInput(), async () => ({ accessToken: "hunter2" })),
    ).rejects.toBeInstanceOf(PostgresInfrastructureError);
    expect(stub.queryCount()).toBe(3);
  });

  it("redacts provider failures without leaking connection or secret material", async () => {
    const raw = new Error(
      "connection postgres://user:hunter2@localhost/db failed DETAIL: Key (key_hash)=(retry-key-never-stored) exists.",
    );
    const stub = stubOperationsDatabase([{ rows: [] }, { rows: [] }, { throws: raw }]);
    const store = createPostgresOperationsPersistence(stub.database, { now: () => NOW });
    try {
      await store.idempotency.execute(validInput(), async () => ({ status: "ok" }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PostgresInfrastructureError);
      expect((error as Error).message).toBe("PostgreSQL operation failed.");
      expect((error as Error).message).not.toContain("postgres://");
      expect((error as Error).message).not.toContain("hunter2");
      expect((error as Error).message).not.toContain("retry-key-never-stored");
      expect(String((error as Error).stack ?? "")).not.toContain("key_hash");
    }
  });

  it("hashes validated DTOs deterministically over UTF-8 bytes", async () => {
    const left = { z: [3, { b: true, a: null }], a: "مرحبا" };
    const right = { a: "مرحبا", z: [3, { a: null, b: true }] };
    expect(await hashCanonicalRequest(left)).toBe(await hashCanonicalRequest(right));
    expect(await hashCanonicalRequest({ value: null })).not.toBe(await hashCanonicalRequest({}));
    // Array order is preserved: different order hashes differently.
    expect(await hashCanonicalRequest({ items: [1, 2] })).not.toBe(
      await hashCanonicalRequest({ items: [2, 1] }),
    );
  });

  it("stores only hashes and envelopes in migration sources with least-privilege RLS", () => {
    const root = process.cwd();
    const migrations = readdirSync(join(root, "supabase", "migrations"))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => readFileSync(join(root, "supabase", "migrations", file), "utf8"))
      .join("\n");
    const unrelatedMigration =
      "create table content.contact_requests (email text, ip_address text, cookie text);";
    const source = `${migrations}\n${unrelatedMigration}`;
    expect(source.toLowerCase()).toContain("email text");
    const table = source.match(
      /create table operations\.idempotency_records\s*\(([\s\S]*?)\);/i,
    )?.[1];
    expect(table).toBeDefined();
    const lowerTable = table?.toLowerCase() ?? "";
    const lower = migrations.toLowerCase();
    expect(lowerTable).toContain("key_hash char(64)");
    expect(lowerTable).toContain("request_hash char(64)");
    expect(source.toLowerCase()).toContain(
      "alter table operations.idempotency_records force row level security",
    );
    expect(migrations).toContain("grant select, insert, update on operations.idempotency_records");
    expect(migrations).toContain("to shipwithali_application");
    // Raw tokens, cookies, IPs, emails, and provider identities are never stored.
    expect(lowerTable).not.toMatch(/\b(?:raw_token|cookie|ip_address|email)\b/);
    expect(lower).toMatch(/grant select, insert, update on operations\.idempotency_records to shipwithali_application/);
    expect(migrations).not.toMatch(
      /grant\s+.+operations\.idempotency_records.+to\s+(?:anon|authenticated)/,
    );
  });
});
