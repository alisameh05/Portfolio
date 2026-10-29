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
const JOB_A = "018f4f7d-0000-7000-8000-0000000000a1";
const JOB_B = "018f4f7d-0000-7000-8000-0000000000a2";
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
      compileQuery(node: { sql?: string } | unknown) {
        const graphic = node as { sql?: string } | undefined;
        const rendered = JSON.stringify(node) ?? "";
        const sqlText =
          typeof graphic?.sql === "string" ? graphic.sql :
          rendered.includes("to_regclass('operations.incidents')") ? rendered :
          rendered.includes("information_schema.columns") ? rendered :
          rendered.includes("operations.phase7_schedule_progress") ? rendered :
          `stub statement ${calls}`;
        return { sql: sqlText, parameters: [] as never[] };
      },
      async executeQuery(compiled: { sql: string }) {
        // This fixture models the schema before optional lease timestamps.
        if (compiled.sql.includes("information_schema.columns") && compiled.sql.includes("lease_acquired_at")) {
          return { rows: [{ available: false }] };
        }
        // The schema-era probe is infrastructure plumbing, not a scripted step.
        if (compiled.sql.includes("to_regclass('operations.incidents')")) {
          return { rows: [{ bounded: true }] };
        }
        // This adapter fixture represents the legacy schema before Phase 7 scheduling fields.
        if (compiled.sql.includes("operations.phase7_schedule_progress")) {
          return { rows: [{ enabled: false }] };
        }
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

function validJob(jobId: string) {
  const payload: VersionedPayload = {
    type: "cache.refresh",
    version: 1,
    value: { target: "public" },
  };
  return { jobId, payload, availableAt: NOW };
}

describe("leased-job store adapter (#52)", () => {
  it("rejects non-stable job identities before writing", async () => {
    for (const jobId of ["not-a-uuid", "018f4f7d-0000-1000-8000-0000000000a1", ""]) {
      const stub = stubOperationsDatabase([{ rows: [] }, { rows: [] }]);
      const store = createPostgresOperationsPersistence(stub.database);
      await expect(
        store.transactions.run((context) => store.jobs.enqueue(context, validJob(jobId))),
      ).rejects.toThrow(/stable|uuid|identity/i);
      expect(stub.queryCount()).toBe(2);
    }
  });

  it("validates RFC 3339 availability clocks and rejects secret payloads before writes", async () => {
    for (const availableAt of [NOW, "2026-09-22T15:00:00+03:00"]) {
      const validClock = stubOperationsDatabase([{ rows: [] }, { rows: [] }, { rows: [] }]);
      const validClockStore = createPostgresOperationsPersistence(validClock.database);
      await expect(
        validClockStore.transactions.run((context) =>
          validClockStore.jobs.enqueue(context, { ...validJob(JOB_A), availableAt }),
        ),
      ).resolves.toBe(true);
      expect(validClock.queryCount()).toBe(3);
    }

    for (const availableAt of [
      "not-a-time",
      "2026-09-22",
      "09/22/2026",
      "0",
      "2026-02-30T12:00:00Z",
    ]) {
      const badClock = stubOperationsDatabase([{ rows: [] }, { rows: [] }]);
      const badClockStore = createPostgresOperationsPersistence(badClock.database);
      await expect(
        badClockStore.transactions.run((context) =>
          badClockStore.jobs.enqueue(context, { ...validJob(JOB_A), availableAt }),
        ),
      ).rejects.toThrow(/RFC 3339|availability|clock/i);
      expect(badClock.queryCount()).toBe(2);
    }

    const secret = stubOperationsDatabase([{ rows: [] }, { rows: [] }]);
    const secretStore = createPostgresOperationsPersistence(secret.database);
    await expect(
      secretStore.transactions.run((context) =>
        secretStore.jobs.enqueue(context, {
          ...validJob(JOB_A),
          payload: { type: "cache.refresh", version: 1, value: { accessToken: "secret" } },
        }),
      ),
    ).rejects.toThrow(/sensitive/i);
    expect(secret.queryCount()).toBe(2);
  });

  it("rejects a foreign transaction context without touching the database", async () => {
    const stub = stubOperationsDatabase([]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(store.jobs.enqueue(FOREIGN, validJob(JOB_A))).rejects.toBeInstanceOf(
      PostgresInfrastructureError,
    );
    expect(stub.queryCount()).toBe(0);
  });

  it("claims due jobs with fresh tokens, computed expiry, and incremented attempts", async () => {
    let tokens = 0;
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            job_id: JOB_A,
            job_type: "cache.refresh",
            payload_version: 1,
            payload: { target: "public" },
            attempt_count: 0,
            semantic_scope_id: null,
            semantic_period: null,
          },
          {
            job_id: JOB_B,
            job_type: "cache.refresh",
            payload_version: 1,
            payload: { target: "owner" },
            attempt_count: 2,
            semantic_scope_id: null,
            semantic_period: null,
          },
        ],
      },
      { rows: [{ lease_expires_at: EXPIRY }] },
      { rows: [{ lease_expires_at: EXPIRY }] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database, {
      leaseTokens: { generate: () => `job-token-${++tokens}` },
    });

    const leased = await store.jobs.claimDue({
      workerId: "worker-one",
      now: NOW,
      leaseDurationSeconds: 30,
      limit: 10,
    });

    expect(leased).toHaveLength(2);
    expect(leased[0]?.leaseToken).toBe("job-token-1");
    expect(leased[1]?.leaseToken).toBe("job-token-2");
    expect(leased[0]?.leaseExpiresAt).toBe(EXPIRY);
    expect(leased[0]?.attemptCount).toBe(1);
    expect(leased[1]?.attemptCount).toBe(3);
    expect(leased[0]?.payload).toEqual({
      type: "cache.refresh",
      version: 1,
      value: { target: "public" },
    });
  });

  it("guards job completion, failure, and release on the current lease token", async () => {
    const empty = stubOperationsDatabase([{ rows: [] }]);
    await expect(
      createPostgresOperationsPersistence(empty.database).jobs.complete(JOB_A, "stale-token", NOW),
    ).resolves.toBe(false);
    const emptyFail = stubOperationsDatabase([{ rows: [] }, { rows: [] }, { rows: [] }]);
    await expect(
      createPostgresOperationsPersistence(emptyFail.database).jobs.fail(
        JOB_A,
        "stale-token",
        parseSafeErrorCode("HANDLER_TIMEOUT"),
      ),
    ).resolves.toBe(false);
    const emptyRelease = stubOperationsDatabase([{ rows: [] }]);
    await expect(
      createPostgresOperationsPersistence(emptyRelease.database).jobs.release(JOB_A, "stale-token"),
    ).resolves.toBe(false);

    const completed = stubOperationsDatabase([{ rows: [{ changed: true }] }]);
    await expect(
      createPostgresOperationsPersistence(completed.database).jobs.complete(JOB_A, "token-1", NOW),
    ).resolves.toBe(true);
    const failed = stubOperationsDatabase([{ rows: [] }, { rows: [] }, { rows: [] }]);
    await expect(
      createPostgresOperationsPersistence(failed.database).jobs.fail(
        JOB_A,
        "token-1",
        parseSafeErrorCode("HANDLER_TIMEOUT"),
      ),
    ).resolves.toBe(false);
    const released = stubOperationsDatabase([{ rows: [{ changed: true }] }]);
    await expect(
      createPostgresOperationsPersistence(released.database).jobs.release(JOB_A, "token-1"),
    ).resolves.toBe(true);
  });

  it("issues unguessable lease tokens from the default generator", async () => {
    const dueRow = (jobId: string) => ({
      job_id: jobId,
      job_type: "cache.refresh",
      payload_version: 1,
      payload: { target: "public" },
      attempt_count: 0,
      semantic_scope_id: null,
      semantic_period: null,
    });
    const firstStub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [dueRow(JOB_A)] },
      { rows: [{ lease_expires_at: EXPIRY }] },
    ]);
    const firstStore = createPostgresOperationsPersistence(firstStub.database);
    const secondStub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [dueRow(JOB_B)] },
      { rows: [{ lease_expires_at: EXPIRY }] },
    ]);
    const secondStore = createPostgresOperationsPersistence(secondStub.database);
    const claim = { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 1 };

    const first = await firstStore.jobs.claimDue(claim);
    const second = await secondStore.jobs.claimDue(claim);

    expect(first[0]?.leaseToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second[0]?.leaseToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second[0]?.leaseToken).not.toBe(first[0]?.leaseToken);
  });

  it("rejects unsafe job failure codes before touching the database", async () => {
    const stub = stubOperationsDatabase([]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(
      store.jobs.fail(JOB_A, "token-1", "lowercase-bad!" as never),
    ).rejects.toThrow(TypeError);
    expect(stub.queryCount()).toBe(0);
  });

  it("redacts provider failures on job transitions", async () => {
    const raw = new Error("connection postgres://user:hunter2@localhost/db failed");
    const stub = stubOperationsDatabase([{ throws: raw }]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(store.jobs.complete(JOB_A, "token-1", NOW)).rejects.toBeInstanceOf(
      PostgresInfrastructureError,
    );
    try {
      await store.jobs.complete(JOB_A, "token-1", NOW);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toBe("PostgreSQL operation failed.");
      expect((error as Error).message).not.toContain("postgres://");
    }
  });

  it("bounds job claim batches and validates worker identity", async () => {
    for (const input of [
      { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 0 },
      { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 101 },
      { workerId: "", now: NOW, leaseDurationSeconds: 30, limit: 10 },
    ]) {
      const stub = stubOperationsDatabase([]);
      const store = createPostgresOperationsPersistence(stub.database);
      await expect(store.jobs.claimDue(input)).rejects.toThrow(TypeError);
      expect(stub.queryCount()).toBe(0);
    }
  });

  it("exposes persistence transitions only, without scheduler or handler surfaces", async () => {
    const stub = stubOperationsDatabase([{ rows: [] }, { rows: [] }, { rows: [] }]);
    const store = createPostgresOperationsPersistence(stub.database);
    expect(Object.keys(store.jobs).sort()).toEqual(
      [
        "admitPhase7DependentWork",
        "advancePhase7AggregateSchedule",
        "advancePhase7RetentionSchedule",
        "claimDue",
        "complete",
        "enqueue",
        "fail",
        "getDeadForRedrive",
        "getPhase7ScheduleStatus",
        "getPhase7ScheduleStatusAtDatabaseCurrentPeriod",
        "redriveDead",
        "release",
        "scheduleRetry",
      ].sort(),
    );
    const source = JSON.stringify(Object.keys(store.jobs));
    expect(source).not.toMatch(/"schedule"|handle|backoff|alert|dashboard/i);
  });

  it("schedules transient retry from database time under the current unexpired token", async () => {
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [{ job_id: JOB_A, status: "available" }] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(store.jobs.scheduleRetry(JOB_A, "current-token", parseSafeErrorCode("HANDLER_TIMEOUT"), 45_000))
      .resolves.toBe(true);
    expect(stub.queryCount()).toBe(3);
  });

  it("terminalizes a permanent failure and writes one safe incident atomically", async () => {
    const stub = stubOperationsDatabase([
      { rows: [] },
      { rows: [] },
      { rows: [{ job_id: JOB_A, status: "dead" }] },
      { rows: [] },
    ]);
    const store = createPostgresOperationsPersistence(stub.database);
    await expect(store.jobs.fail(JOB_A, "current-token", parseSafeErrorCode("JOB_INVALID")))
      .resolves.toBe(true);
    expect(stub.queryCount()).toBe(4);
  });
});
