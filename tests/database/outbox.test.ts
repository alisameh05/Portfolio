import { describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { PostgresInfrastructureError } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import {
  parseSafeErrorCode,
  type VersionedPayload,
} from "../../src/modules/portability-operations/application/persistence.js";
import type { TransactionContext } from "../../src/runtime/ports.js";
import type { DB } from "../../src/shared/adapters/postgres/database.generated.js";

const NOW = "2026-09-22T12:00:00.000Z";
const EXPIRY = "2026-09-22T12:00:30.000Z";
const EVENT_A = "018f4f7d-0000-7000-8000-0000000000a1";
const EVENT_B = "018f4f7d-0000-7000-8000-0000000000a2";
const AGGREGATE = "018f4f7d-0000-7000-8000-0000000000b0";
const FOREIGN = Object.freeze({ kind: "transaction" }) as TransactionContext;

type QueueEntry = { rows: unknown[] } | { throws: unknown };

function stubOperationsDatabase(queue: QueueEntry[]) {
  let calls = 0;
  const statements: string[] = [];
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
        statements.push(compiled.sql);
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
  return { database, statements, queryCount: () => calls };
}

function validEvent(eventId: string) {
  const payload: VersionedPayload = {
    type: "project.published",
    version: 1,
    value: { locale: "en" },
  };
  return {
    eventId,
    payload,
    aggregateId: AGGREGATE,
    aggregateVersion: 1,
    correlationId: "trace-outbox-50",
    occurredAt: NOW,
    availableAt: NOW,
  };
}

describe("transactional outbox adapter (#50)", () => {
  it("rejects a duplicate event identity without recording a second fact", async () => {
    const duplicate = new Error(
      'duplicate key value violates unique constraint "outbox_events_pkey" DETAIL: Key (event_id)=(secret) exists. postgres://user:hunter2@localhost/db',
    );
    const { database } = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { throws: duplicate },
    ]);
    const store = createPostgresOperationsPersistence(database);

    await store.transactions.run((context) => store.outbox.append(context, validEvent(EVENT_A)));
    await expect(
      store.transactions.run((context) => store.outbox.append(context, validEvent(EVENT_A))),
    ).rejects.toBeInstanceOf(PostgresInfrastructureError);

    try {
      await store.transactions.run((context) => store.outbox.append(context, validEvent(EVENT_A)));
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("PostgreSQL operation failed.");
      expect(String((error as Error).stack ?? "")).not.toContain("hunter2");
      expect(String((error as Error).stack ?? "")).not.toContain("outbox_events_pkey");
    }
  });

  it("rejects invalid payloads without writing outbox rows", async () => {
    const cases: Array<{ name: string; payload: VersionedPayload }> = [
      { name: "type", payload: { type: "Bad Type!", version: 1, value: { locale: "en" } } },
      { name: "version", payload: { type: "project.published", version: 0, value: { locale: "en" } } },
      {
        name: "secret",
        payload: { type: "project.published", version: 1, value: { token: "hunter2" } },
      },
    ];
    for (const entry of cases) {
      const stub = stubOperationsDatabase([{ rows: [] }, { rows: [] }]);
      const store = createPostgresOperationsPersistence(stub.database);
      await expect(
        store.transactions.run((context) =>
          store.outbox.append(context, { ...validEvent(EVENT_A), payload: entry.payload }),
        ),
      ).rejects.toThrow(TypeError);
      expect(stub.queryCount(), entry.name).toBe(2);
    }
  });

  it("rejects a foreign transaction context without touching the database", async () => {
    const stub = stubOperationsDatabase([]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(store.outbox.append(FOREIGN, validEvent(EVENT_A))).rejects.toBeInstanceOf(
      PostgresInfrastructureError,
    );
    expect(stub.queryCount()).toBe(0);
  });

  it("claims due events with fresh tokens and computed expiry", async () => {
    let tokens = 0;
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            event_id: EVENT_A,
            event_type: "project.published",
            schema_version: 1,
            payload: { locale: "en" },
            attempt_count: 0,
          },
          {
            event_id: EVENT_B,
            event_type: "project.published",
            schema_version: 1,
            payload: { locale: "ar" },
            attempt_count: 2,
          },
        ],
      },
      { rows: [] },
      { rows: [] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, {
      leaseTokens: { generate: () => `token-${++tokens}` },
    });

    const leased = await store.outbox.claimDue({
      workerId: "worker-one",
      now: NOW,
      leaseDurationSeconds: 30,
      limit: 10,
    });

    expect(leased).toHaveLength(2);
    expect(leased[0]?.leaseToken).toBe("token-1");
    expect(leased[1]?.leaseToken).toBe("token-2");
    expect(leased[0]?.leaseExpiresAt).toBe(EXPIRY);
    expect(leased[0]?.attemptCount).toBe(1);
    expect(leased[1]?.attemptCount).toBe(3);
    expect(leased[0]?.payload).toEqual({
      type: "project.published",
      version: 1,
      value: { locale: "en" },
    });
  });

  it("guards completion, failure, and release on the current lease token", async () => {
    const empty = stubOperationsDatabase([{ rows: [] }]);
    const emptyStore = createPostgresOperationsPersistence(empty.database);
    await expect(emptyStore.outbox.complete(EVENT_A, "stale-token", NOW)).resolves.toBe(false);
    const emptyFail = stubOperationsDatabase([{ rows: [] }]);
    await expect(
      createPostgresOperationsPersistence(emptyFail.database).outbox.fail(
        EVENT_A,
        "stale-token",
        parseSafeErrorCode("HANDLER_TIMEOUT"),
      ),
    ).resolves.toBe(false);
    const emptyRelease = stubOperationsDatabase([{ rows: [] }]);
    await expect(
      createPostgresOperationsPersistence(emptyRelease.database).outbox.release(EVENT_A, "stale-token"),
    ).resolves.toBe(false);

    const completed = stubOperationsDatabase([{ rows: [{ changed: true }] }]);
    await expect(
      createPostgresOperationsPersistence(completed.database).outbox.complete(EVENT_A, "token-1", NOW),
    ).resolves.toBe(true);
    const failed = stubOperationsDatabase([{ rows: [{ changed: true }] }]);
    await expect(
      createPostgresOperationsPersistence(failed.database).outbox.fail(
        EVENT_A,
        "token-1",
        parseSafeErrorCode("HANDLER_TIMEOUT"),
      ),
    ).resolves.toBe(true);
    const released = stubOperationsDatabase([{ rows: [{ changed: true }] }]);
    await expect(
      createPostgresOperationsPersistence(released.database).outbox.release(EVENT_A, "token-1"),
    ).resolves.toBe(true);
  });

  it("issues unguessable lease tokens from the default generator", async () => {
    const dueRow = (eventId: string) => ({
      event_id: eventId,
      event_type: "project.published",
      schema_version: 1,
      payload: { locale: "en" },
      attempt_count: 0,
    });
    const firstStub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [dueRow(EVENT_A)] },
      { rows: [] },
    ]);
    const firstStore = createPostgresOperationsPersistence(firstStub.database);
    const secondStub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [dueRow(EVENT_B)] },
      { rows: [] },
    ]);
    const secondStore = createPostgresOperationsPersistence(secondStub.database);
    const claim = { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 1 };

    const first = await firstStore.outbox.claimDue(claim);
    const second = await secondStore.outbox.claimDue(claim);

    expect(first[0]?.leaseToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second[0]?.leaseToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second[0]?.leaseToken).not.toBe(first[0]?.leaseToken);
  });

  it("rejects unsafe failure codes before touching the database", async () => {
    const stub = stubOperationsDatabase([]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(
      store.outbox.fail(EVENT_A, "token-1", "lowercase-bad!" as never),
    ).rejects.toThrow(TypeError);
    expect(stub.queryCount()).toBe(0);
  });

  it("redacts provider failures on guarded transitions", async () => {
    const raw = new Error("connection postgres://user:hunter2@localhost/db failed");
    const stub = stubOperationsDatabase([{ throws: raw }]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(store.outbox.complete(EVENT_A, "token-1", NOW)).rejects.toBeInstanceOf(
      PostgresInfrastructureError,
    );
    try {
      await store.outbox.complete(EVENT_A, "token-1", NOW);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("PostgreSQL operation failed.");
      expect((error as Error).message).not.toContain("postgres://");
    }
  });

  it("bounds claim batches and validates worker identity", async () => {
    for (const input of [
      { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 0 },
      { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 101 },
      { workerId: "", now: NOW, leaseDurationSeconds: 30, limit: 10 },
    ]) {
      const stub = stubOperationsDatabase([]);
      const store = createPostgresOperationsPersistence(stub.database);
      await expect(store.outbox.claimDue(input)).rejects.toThrow(TypeError);
      expect(stub.queryCount()).toBe(0);
    }
  });
});
