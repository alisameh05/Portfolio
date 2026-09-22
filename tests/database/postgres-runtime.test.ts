import { describe, expect, it } from "vitest";

import {
  getOperationsPersistence,
  initializeDatabaseRuntime,
  resetRuntimeForTests,
  type DatabaseRuntimeDependencies,
} from "../../src/bootstrap/composition-root.js";
import type { OperationsPersistencePorts } from "../../src/modules/portability-operations/application/index.js";
import { createPhase2TransactionFake } from "../../src/runtime/fakes/transaction.js";
import {
  createLifecycleCoordinator,
  getLifecycleCoordinator,
} from "../../src/runtime/lifecycle.js";

function createOperationsFake(): OperationsPersistencePorts {
  return {
    transactions: createPhase2TransactionFake(),
    idempotency: { execute: async () => ({ kind: "conflict" }) },
    outbox: {
      append: async () => undefined,
      claimDue: async () => [],
      complete: async () => false,
      fail: async () => false,
      release: async () => false,
    },
    jobs: {
      enqueue: async () => undefined,
      claimDue: async () => [],
      complete: async () => false,
      fail: async () => false,
      release: async () => false,
    },
  };
}

describe("PostgreSQL runtime composition (#47)", () => {
  it("requires DATABASE_URL without exposing it or a provider handle", async () => {
    resetRuntimeForTests();
    await expect(
      initializeDatabaseRuntime(
        { NODE_ENV: "test", APP_BASE_URL: "http://localhost:3000" },
        "application",
        () => {
          throw new Error("must not construct dependencies");
        },
      ),
    ).rejects.toThrow("Database runtime initialization failed.");

    const operations = createOperationsFake();
    const dependencies: DatabaseRuntimeDependencies = {
      operations,
      resource: { name: "postgresql", close: async () => undefined },
      readiness: { name: "postgresql", check: async () => true },
    };
    const state = await initializeDatabaseRuntime(
      {
        NODE_ENV: "test",
        APP_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgresql://runtime:secret@127.0.0.1:54322/postgres",
        DATABASE_DIRECT_URL: "postgresql://migration:secret@127.0.0.1:54322/postgres",
      },
      "worker",
      () => dependencies,
    );

    expect(state).toEqual({
      nodeEnv: "test",
      appBaseUrl: "http://localhost:3000",
      runtimeKind: "worker",
    });
    expect("databaseUrl" in state).toBe(false);
    expect("database" in state).toBe(false);
    expect(getOperationsPersistence()).toBe(operations);
    resetRuntimeForTests();
  });

  it("waits for tracked work and closes the database resource exactly once", async () => {
    resetRuntimeForTests();
    let closeCount = 0;
    let finishWork!: () => void;
    const work = new Promise<void>((resolve) => { finishWork = resolve; });
    await initializeDatabaseRuntime(
      {
        NODE_ENV: "test",
        APP_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgresql://runtime:secret@127.0.0.1:54322/postgres",
      },
      "application",
      () => ({
        operations: createOperationsFake(),
        resource: {
          name: "postgresql",
          close: async () => { closeCount += 1; },
        },
        readiness: { name: "postgresql", check: async () => true },
      }),
    );
    const lifecycle = getLifecycleCoordinator();
    void lifecycle.track(work);
    const firstShutdown = lifecycle.shutdown();
    const secondShutdown = lifecycle.shutdown();
    expect(firstShutdown).toBe(secondShutdown);
    await Promise.resolve();
    expect(closeCount).toBe(0);
    finishWork();
    await Promise.all([firstShutdown, secondShutdown]);
    expect(closeCount).toBe(1);
    resetRuntimeForTests();
  });

  it("keeps readiness false while a registered dependency is unavailable and recovers", async () => {
    let databaseReady = false;
    const lifecycle = createLifecycleCoordinator();
    lifecycle.registerReadinessCheck({
      name: "postgresql",
      check: async () => databaseReady,
    });
    lifecycle.markReady();

    expect(await lifecycle.checkReadiness()).toBe(false);
    databaseReady = true;
    expect(await lifecycle.checkReadiness()).toBe(true);
    await lifecycle.shutdown();
    expect(await lifecycle.checkReadiness()).toBe(false);
  });
});
