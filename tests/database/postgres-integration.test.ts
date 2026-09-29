import { createHash } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { parseIdempotencyKey } from "../../src/shared/domain/idempotency-key.js";
import { parseSafeErrorCode } from "../../src/modules/portability-operations/application/persistence.js";
import {
  createPostgresRuntimeDatabase,
  resolvePostgresTransaction,
} from "../../src/shared/adapters/postgres/runtime.js";
import { updateVersionedRecord } from "../../src/shared/adapters/postgres/optimistic-concurrency.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import {
  requestTransactionRollback,
  type TransactionContext,
} from "../../src/runtime/ports.js";

const DATABASE_URL = process.env["PHASE3_DATABASE_URL"];
if (process.env["PHASE3_REQUIRE_DATABASE"] === "1" && !DATABASE_URL) {
  throw new Error("PHASE3_DATABASE_URL is required for the Phase 3 integration gate.");
}

const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const NOW = "2026-09-22T12:00:00.000Z";
const LATER = "2026-09-22T12:01:00.000Z";
const AFTER_LATER = "2026-09-22T12:02:00.000Z";
const EVENT_A = "018f4f7d-0000-7000-8000-000000000001";
const EVENT_B = "018f4f7d-0000-7000-8000-000000000002";
const EVENT_C = "018f4f7d-0000-7000-8000-000000000003";
const EVENT_D = "018f4f7d-0000-7000-8000-000000000004";
const AGGREGATE = "018f4f7d-0000-7000-8000-000000000010";
const JOB_A = "018f4f7d-0000-7000-8000-000000000021";
const JOB_B = "018f4f7d-0000-7000-8000-000000000022";
const JOB_C = "018f4f7d-0000-7000-8000-000000000023";
const JOB_D = "018f4f7d-0000-7000-8000-000000000024";
const VERSIONED = "018f4f7d-0000-7000-8000-000000000031";
const MISSING_VERSIONED = "018f4f7d-0000-7000-8000-000000000032";
const STATE_COMMIT = "018f4f7d-0000-7000-8000-000000000041";
const STATE_ROLLBACK = "018f4f7d-0000-7000-8000-000000000042";

describeDatabase("PostgreSQL production adapters (#48-#52)", () => {
  const first = createPostgresRuntimeDatabase(DATABASE_URL ?? "");
  const second = createPostgresRuntimeDatabase(DATABASE_URL ?? "");
  let tokenSequence = 0;
  const store = createPostgresOperationsPersistence(first.database, {
    now: () => NOW,
    leaseTokens: { generate: () => `lease-${++tokenSequence}` },
  });
  const secondStore = createPostgresOperationsPersistence(second.database, {
    now: () => NOW,
    leaseTokens: { generate: () => `worker-two-${++tokenSequence}` },
  });

  function idempotencyKey(value: string) {
    const parsed = parseIdempotencyKey(value);
    if (!parsed.ok) throw new Error("test key invalid");
    return parsed.value;
  }

  async function writeRepresentativeState(
    context: TransactionContext,
    id: string,
    value: string,
  ): Promise<void> {
    const transaction = resolvePostgresTransaction(context);
    await sql`
      insert into phase3_test.representative_state (id, value)
      values (${id}::uuid, ${value})
    `.execute(transaction);
  }

  beforeAll(async () => {
    await sql`delete from operations.idempotency_records`.execute(first.database);
    await sql`delete from operations.outbox_events`.execute(first.database);
    await sql`delete from operations.jobs`.execute(first.database);
    await sql`create schema if not exists phase3_test`.execute(first.database);
    await sql`drop table if exists phase3_test.versioned_records`.execute(first.database);
    await sql`
      create table phase3_test.versioned_records (
        id uuid primary key,
        version integer not null default 1,
        value jsonb not null
      )
    `.execute(first.database);
    await sql`drop table if exists phase3_test.representative_state`.execute(first.database);
    await sql`
      create table phase3_test.representative_state (
        id uuid primary key,
        value text not null
      )
    `.execute(first.database);
  });

  beforeEach(async () => {
    await sql`delete from operations.idempotency_records`.execute(first.database);
    await sql`delete from operations.outbox_events`.execute(first.database);
    await sql`delete from operations.jobs`.execute(first.database);
    await sql`delete from phase3_test.versioned_records`.execute(first.database);
    await sql`delete from phase3_test.representative_state`.execute(first.database);
    await sql`
      insert into phase3_test.versioned_records (id, value)
      values (${VERSIONED}::uuid, ${JSON.stringify({ state: "initial" })}::jsonb)
    `.execute(first.database);
  });

  afterAll(async () => {
    await sql`drop schema if exists phase3_test cascade`.execute(first.database);
    await first.resource.close();
    await second.resource.close();
  });

  it("commits participating writes and rolls all of them back on explicit rollback", async () => {
    await store.transactions.run(async (context) => {
      await writeRepresentativeState(context, STATE_COMMIT, "committed");
      await store.outbox.append(context, {
        eventId: EVENT_A,
        payload: { type: "project.published", version: 1, value: { locale: "en" } },
        aggregateId: AGGREGATE,
        aggregateVersion: 1,
        correlationId: "trace-atomic-commit",
        occurredAt: NOW,
        availableAt: NOW,
      });
      return undefined;
    });

    await store.transactions.run(async (context) => {
      await writeRepresentativeState(context, STATE_ROLLBACK, "rolled-back");
      await store.outbox.append(context, {
        eventId: EVENT_B,
        payload: { type: "project.published", version: 1, value: { locale: "ar" } },
        aggregateId: AGGREGATE,
        aggregateVersion: 2,
        correlationId: "trace-atomic-rollback",
        occurredAt: NOW,
        availableAt: NOW,
      });
      return requestTransactionRollback(undefined);
    });

    const rows = await sql<{ event_id: string }>`
      select event_id::text from operations.outbox_events order by event_id
    `.execute(first.database);
    expect(rows.rows.map((row) => row.event_id)).toEqual([EVENT_A]);
    const state = await sql<{ id: string }>`
      select id::text from phase3_test.representative_state order by id
    `.execute(first.database);
    expect(state.rows.map((row) => row.id)).toEqual([STATE_COMMIT]);
  });

  it("allows exactly one optimistic update from the same expected version", async () => {
    const definition = {
      schema: "phase3_test",
      table: "versioned_records",
      valueColumn: "value",
    };
    const race = await Promise.all([
      store.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: VERSIONED,
          expectedVersion: 1,
          value: { winner: "one" },
        }),
      ),
      secondStore.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: VERSIONED,
          expectedVersion: 1,
          value: { winner: "two" },
        }),
      ),
    ]);
    expect(race.filter((result) => result.kind === "updated")).toHaveLength(1);
    expect(race.filter((result) => result.kind === "precondition_failed")).toEqual([
      { kind: "precondition_failed", currentVersion: 2 },
    ]);
    expect(
      await store.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: MISSING_VERSIONED,
          expectedVersion: 1,
          value: { absent: true },
        }),
      ),
    ).toEqual({ kind: "not_found" });
    expect(
      await store.transactions.run((context) =>
        updateVersionedRecord(context, definition, {
          id: VERSIONED,
          expectedVersion: 1,
          value: { stale: true },
        }),
      ),
    ).toEqual({ kind: "precondition_failed", currentVersion: 2 });
  });

  it("replays exact idempotent requests, rejects conflicts, and persists only hashes", async () => {
    let effects = 0;
    const input = {
      operationScope: "project.publish",
      actorScope: createHash("sha256").update("opaque-actor").digest("hex"),
      key: idempotencyKey("retry-key-never-stored"),
      requestHash: createHash("sha256").update("canonical-request").digest("hex"),
      expiresAt: "2026-09-23T12:00:00.000Z",
    };
    const execute = () =>
      store.idempotency.execute(input, async () => {
        effects += 1;
        return { status: "accepted", version: 2 };
      });

    const firstResult = await execute();
    const replay = await execute();
    const conflict = await store.idempotency.execute(
      { ...input, requestHash: createHash("sha256").update("different").digest("hex") },
      async () => ({ status: "must-not-run" }),
    );
    const anotherActor = {
      ...input,
      actorScope: createHash("sha256").update("another-actor").digest("hex"),
    };
    const actorResult = await store.idempotency.execute(anotherActor, async () => {
      effects += 1;
      return { status: "accepted", version: 2 };
    });
    const actorReplay = await store.idempotency.execute(anotherActor, async () => ({
      status: "must-not-run",
    }));
    const anotherOperation = { ...input, operationScope: "project.measure" };
    const operationResult = await store.idempotency.execute(anotherOperation, async () => {
      effects += 1;
      return { status: "accepted", version: 2 };
    });
    const operationReplay = await store.idempotency.execute(anotherOperation, async () => ({
      status: "must-not-run",
    }));

    expect(firstResult.kind).toBe("executed");
    expect(replay).toEqual({ kind: "replayed", result: { status: "accepted", version: 2 } });
    expect(conflict).toEqual({ kind: "conflict" });
    expect(actorResult.kind).toBe("executed");
    expect(actorReplay.kind).toBe("replayed");
    expect(operationResult.kind).toBe("executed");
    expect(operationReplay.kind).toBe("replayed");
    expect(effects).toBe(3);
    const stored = await sql<{ body: string }>`
      select row_to_json(r)::text as body from operations.idempotency_records r
    `.execute(first.database);
    expect(stored.rows[0]?.body).not.toContain("retry-key-never-stored");
    expect(stored.rows[0]?.body).not.toContain("opaque-actor");
  });

  it("serializes concurrent retries and rolls reservation, state, and outbox back together", async () => {
    const input = {
      operationScope: "project.publish",
      actorScope: createHash("sha256").update("concurrent-actor").digest("hex"),
      key: idempotencyKey("concurrent-retry-key"),
      requestHash: createHash("sha256").update("same-request").digest("hex"),
      expiresAt: "2026-09-23T12:00:00.000Z",
    };
    let effects = 0;
    const effect = async () => {
      effects += 1;
      return { status: "accepted", version: 1 };
    };
    const results = await Promise.all([
      store.idempotency.execute(input, effect),
      secondStore.idempotency.execute(input, effect),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["executed", "replayed"]);
    expect(effects).toBe(1);

    await sql`delete from operations.idempotency_records`.execute(first.database);
    await expect(
      store.idempotency.execute(
        { ...input, key: idempotencyKey("rollback-retry-key") },
        async (context) => {
          await writeRepresentativeState(context, STATE_ROLLBACK, "must-rollback");
          await store.outbox.append(context, {
            eventId: EVENT_D,
            payload: { type: "project.published", version: 1, value: { locale: "en" } },
            aggregateId: AGGREGATE,
            aggregateVersion: 1,
            correlationId: "trace-idempotency-rollback",
            occurredAt: NOW,
            availableAt: NOW,
          });
          throw new Error("EXPECTED_EFFECT_FAILURE");
        },
      ),
    ).rejects.toThrow("PostgreSQL operation failed.");
    const persisted = await sql<{ ledger: number; state: number; outbox: number }>`
      select
        (select count(*)::int from operations.idempotency_records) as ledger,
        (select count(*)::int from phase3_test.representative_state) as state,
        (select count(*)::int from operations.outbox_events) as outbox
    `.execute(first.database);
    expect(persisted.rows[0]).toEqual({ ledger: 0, state: 0, outbox: 0 });
  });

  it("replaces an expired idempotency record using the injected clock", async () => {
    const key = idempotencyKey("expiring-retry-key");
    const base = {
      operationScope: "project.publish",
      actorScope: createHash("sha256").update("expiry-actor").digest("hex"),
      key,
      requestHash: createHash("sha256").update("request-one").digest("hex"),
      expiresAt: "2026-09-23T12:00:00.000Z",
    };
    expect((await store.idempotency.execute(base, async () => ({ version: 1 }))).kind).toBe("executed");
    const futureStore = createPostgresOperationsPersistence(second.database, {
      now: () => "2026-09-24T12:00:00.000Z",
      leaseTokens: { generate: () => "future-token" },
    });
    const replacement = await futureStore.idempotency.execute(
      {
        ...base,
        requestHash: createHash("sha256").update("request-two").digest("hex"),
        expiresAt: "2026-09-25T12:00:00.000Z",
      },
      async () => ({ version: 2 }),
    );
    expect(replacement).toEqual({ kind: "executed", result: { version: 2 } });
  });

  it("orders, exclusively leases, and reclaims expired outbox and jobs", async () => {
    await store.transactions.run(async (context) => {
      for (const eventId of [EVENT_B, EVENT_A]) {
        await store.outbox.append(context, {
          eventId,
          payload: { type: "project.published", version: 1, value: { locale: "en" } },
          aggregateId: AGGREGATE,
          aggregateVersion: 1,
          correlationId: "trace-ordering",
          occurredAt: NOW,
          availableAt: NOW,
        });
      }
      await store.outbox.append(context, {
        eventId: EVENT_C,
        payload: { type: "project.published", version: 1, value: { locale: "ar" } },
        aggregateId: AGGREGATE,
        aggregateVersion: 2,
        correlationId: "trace-future",
        occurredAt: NOW,
        availableAt: AFTER_LATER,
      });
      await store.jobs.enqueue(context, {
        jobId: JOB_A,
        payload: { type: "cache.refresh", version: 1, value: { target: "public" } },
        availableAt: NOW,
      });
      await store.jobs.enqueue(context, {
        jobId: JOB_B,
        payload: { type: "cache.refresh", version: 1, value: { target: "owner" } },
        availableAt: NOW,
      });
      return undefined;
    });

    const claim = { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 10 };
    const ordered = await store.outbox.claimDue({ ...claim, limit: 2 });
    expect(ordered.map((event) => event.eventId)).toEqual([EVENT_A, EVENT_B]);
    for (const event of ordered) {
      expect(await store.outbox.complete(event.eventId, event.leaseToken, LATER)).toBe(true);
    }
    await store.transactions.run(async (context) => {
      await store.outbox.append(context, {
        eventId: EVENT_D,
        payload: { type: "project.published", version: 1, value: { locale: "en" } },
        aggregateId: AGGREGATE,
        aggregateVersion: 3,
        correlationId: "trace-exclusive",
        occurredAt: NOW,
        availableAt: NOW,
      });
      return undefined;
    });
    const [eventsOne, eventsTwo] = await Promise.all([
      store.outbox.claimDue(claim),
      secondStore.outbox.claimDue({ ...claim, workerId: "worker-two" }),
    ]);
    expect(eventsOne.length + eventsTwo.length).toBe(1);
    const event = eventsOne[0] ?? eventsTwo[0];
    expect(event?.eventId).toBe(EVENT_D);
    expect(await store.outbox.complete(EVENT_D, "stale-token", LATER)).toBe(false);
    const reclaimedEvent = await secondStore.outbox.claimDue({
      ...claim,
      now: LATER,
      workerId: "worker-two",
    });
    expect(reclaimedEvent).toHaveLength(1);
    expect(reclaimedEvent[0]?.eventId).toBe(EVENT_D);
    expect(reclaimedEvent[0]?.leaseToken).not.toBe(event?.leaseToken);

    let markLocked!: () => void;
    let releaseLocked!: () => void;
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseLocked = resolve; });
    const lockWork = first.database.transaction().execute(async (transaction) => {
      await sql`
        select job_id from operations.jobs
         where completed_at is null
         order by available_at, job_id
         for update
         limit 1
      `.execute(transaction);
      markLocked();
      await release;
    });
    await locked;
    let progressed: Awaited<ReturnType<typeof secondStore.jobs.claimDue>> = [];
    try {
      progressed = await secondStore.jobs.claimDue({ ...claim, workerId: "worker-two", limit: 1 });
    } finally {
      releaseLocked();
      await lockWork;
    }
    expect(progressed.map((job) => job.jobId)).toEqual([JOB_B]);
    expect(await secondStore.jobs.complete(JOB_B, progressed[0]?.leaseToken ?? "", LATER)).toBe(true);

    const jobsOne = await store.jobs.claimDue({ ...claim, limit: 1 });
    const jobsTwo = await secondStore.jobs.claimDue({ ...claim, workerId: "worker-two" });
    expect(jobsOne).toHaveLength(1);
    expect(jobsOne[0]?.jobId).toBe(JOB_A);
    expect(jobsTwo).toHaveLength(0);
    expect(await store.jobs.release(JOB_A, "stale-token")).toBe(false);
    const reclaimed = await secondStore.jobs.claimDue({ ...claim, now: LATER, workerId: "worker-two" });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.leaseToken).not.toBe(jobsOne[0]?.leaseToken);
  });

  it("claims jobs concurrently with no simultaneous ownership and recovers after failure", async () => {
    await store.transactions.run(async (context) => {
      for (const jobId of [JOB_C, JOB_D]) {
        await store.jobs.enqueue(context, {
          jobId,
          payload: { type: "cache.refresh", version: 1, value: { target: "public" } },
          availableAt: NOW,
        });
      }
      return undefined;
    });

    const claim = { workerId: "worker-one", now: NOW, leaseDurationSeconds: 30, limit: 10 };
    const [firstClaim, secondClaim] = await Promise.all([
      store.jobs.claimDue(claim),
      secondStore.jobs.claimDue({ ...claim, workerId: "worker-two" }),
    ]);
    const owned = [...firstClaim, ...secondClaim];
    expect(owned).toHaveLength(2);
    expect(new Set(owned.map((job) => job.jobId))).toEqual(new Set([JOB_C, JOB_D]));
    expect(new Set(owned.map((job) => job.leaseToken)).size).toBe(2);

    const survivor = owned[0];
    const survivorId = survivor?.jobId ?? "";
    const survivorToken = survivor?.leaseToken ?? "";
    expect(await store.jobs.complete(survivorId, "stale-token", LATER)).toBe(false);
    expect(await store.jobs.complete(survivorId, survivorToken, LATER)).toBe(true);
    expect(await store.jobs.complete(survivorId, survivorToken, LATER)).toBe(false);

    const remaining = owned[1];
    const remainingId = remaining?.jobId ?? "";
    const remainingToken = remaining?.leaseToken ?? "";
    expect(
      await secondStore.jobs.fail(remainingId, remainingToken, parseSafeErrorCode("HANDLER_TIMEOUT")),
    ).toBe(true);
    const afterFail = await store.jobs.claimDue({ ...claim, workerId: "worker-three" });
    expect(afterFail.map((job) => job.jobId)).toEqual([remainingId]);
    expect(afterFail[0]?.leaseToken).not.toBe(remainingToken);
    expect(await store.jobs.release(remainingId, remainingToken)).toBe(false);
    expect(await store.jobs.fail(remainingId, remainingToken, parseSafeErrorCode("HANDLER_TIMEOUT"))).toBe(
      false,
    );

    const crashToken = afterFail[0]?.leaseToken ?? "";
    const recovered = await secondStore.jobs.claimDue({
      ...claim,
      now: LATER,
      workerId: "worker-two",
    });
    expect(recovered.map((job) => job.jobId)).toEqual([remainingId]);
    expect(recovered[0]?.leaseToken).not.toBe(crashToken);
    expect(await secondStore.jobs.complete(remainingId, crashToken, LATER)).toBe(false);
    expect(await secondStore.jobs.release(remainingId, crashToken)).toBe(false);
    expect(
      await secondStore.jobs.complete(remainingId, recovered[0]?.leaseToken ?? "", LATER),
    ).toBe(true);
  });
});
