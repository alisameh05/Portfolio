import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  getOperationsPersistence,
  initializeDatabaseRuntime,
  resetRuntimeForTests,
  type DatabaseRuntimeDependencies,
} from "../../src/bootstrap/composition-root.js";
import { GET as getReadiness } from "../../src/app/readyz/route.js";
import {
  createPostgresRuntimeDatabase,
} from "../../src/shared/adapters/postgres/runtime.js";
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
      scheduleRetry: async () => false,
      release: async () => false,
    },
    jobs: {
      enqueue: async () => undefined,
      claimDue: async () => [],
      complete: async () => false,
      fail: async () => false,
      scheduleRetry: async () => false,
      getDeadForRedrive: async () => null,
      redriveDead: async () => null,
      release: async () => false,
    },
  };
}

const BASE_ENV = {
  NODE_ENV: "test",
  APP_BASE_URL: "http://localhost:3000",
};

describe("PostgreSQL runtime composition (#47)", () => {
  it("requires DATABASE_URL without exposing it or a provider handle", async () => {
    resetRuntimeForTests();
    await expect(
      initializeDatabaseRuntime(
        { ...BASE_ENV },
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
        ...BASE_ENV,
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
        ...BASE_ENV,
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

  it("closes the database resource when the readiness check throws", async () => {
    resetRuntimeForTests();
    let closeCount = 0;
    await expect(
      initializeDatabaseRuntime(
        {
          ...BASE_ENV,
          DATABASE_URL: "postgresql://runtime:secret@127.0.0.1:54322/postgres",
        },
        "application",
        () => ({
          operations: createOperationsFake(),
          resource: {
            name: "postgresql",
            close: async () => { closeCount += 1; },
          },
          readiness: {
            name: "postgresql",
            check: async () => { throw new Error("probe failed"); },
          },
        }),
      ),
    ).rejects.toThrow("Database runtime initialization failed.");
    expect(closeCount).toBe(1);
    const { getLifecycleCoordinator } = await import(
      "../../src/runtime/lifecycle.js"
    );
    await getLifecycleCoordinator().shutdown();
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

  it("keeps the migration credential out of runtime composition and redacts startup failures", async () => {
    const root = process.cwd();
    const stripComments = (source: string): string =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
    for (const file of [
      "src/bootstrap/composition-root.ts",
      "src/bootstrap/configuration.ts",
      "src/shared/adapters/postgres/runtime.ts",
    ]) {
      const code = stripComments(readFileSync(join(root, file), "utf8"));
      expect(code).not.toContain("DATABASE_DIRECT_URL");
      expect(code).not.toContain('env["DATABASE_DIRECT_URL"]');
    }

    resetRuntimeForTests();
    try {
      await initializeDatabaseRuntime(
        {
          ...BASE_ENV,
          DATABASE_URL: "http://runtime:s3cr3t-pw@127.0.0.1:54322/postgres",
        },
        "application",
        () => {
          throw new Error("must not construct dependencies");
        },
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Database runtime initialization failed.");
      const chain: string[] = [];
      let current: unknown = error;
      while (current instanceof Error) {
        chain.push(current.message, String(current.stack ?? ""));
        current = (current as { cause?: unknown }).cause;
      }
      const serialized = chain.join("\n");
      expect(serialized).not.toContain("s3cr3t-pw");
      expect(serialized).not.toContain("postgresql://");
      expect(serialized).not.toContain("postgres://");
      expect(serialized).toContain("DATABASE_URL");
    } finally {
      resetRuntimeForTests();
    }
  });

  it("surfaces database loss and recovery through the safe readiness route", async () => {
    resetRuntimeForTests();
    let databaseReady = true;
    await initializeDatabaseRuntime(
      {
        ...BASE_ENV,
        DATABASE_URL: "postgresql://runtime:secret@127.0.0.1:54322/postgres",
      },
      "application",
      () => ({
        operations: createOperationsFake(),
        resource: { name: "postgresql", close: async () => undefined },
        readiness: { name: "postgresql", check: async () => databaseReady },
      }),
    );

    const readyResponse = await getReadiness();
    expect(readyResponse.status).toBe(200);
    expect(await readyResponse.json()).toEqual({ status: "ready" });

    databaseReady = false;
    const degradedResponse = await getReadiness();
    expect(degradedResponse.status).toBe(503);
    const degradedBody = (await degradedResponse.json()) as Record<string, unknown>;
    expect(degradedBody["code"]).toBe("RUNTIME_NOT_READY");
    const degradedSerialized = JSON.stringify(degradedBody);
    expect(degradedSerialized).not.toContain("secret");
    expect(degradedSerialized).not.toContain("postgresql://");
    expect(degradedSerialized).not.toContain("postgres://");

    databaseReady = true;
    const recoveredResponse = await getReadiness();
    expect(recoveredResponse.status).toBe(200);

    await getLifecycleCoordinator().shutdown();
    const drainingResponse = await getReadiness();
    expect(drainingResponse.status).toBe(503);
    resetRuntimeForTests();
  });

  it("reports bounded unready without throwing when PostgreSQL is unreachable", async () => {
    const unreachable = createPostgresRuntimeDatabase(
      "postgresql://runtime:secret@127.0.0.1:1/postgres",
      { max: 1, connectionTimeoutMs: 500, readinessTimeoutMs: 500 },
    );
    try {
      await expect(unreachable.readiness.check()).resolves.toBe(false);
      await expect(unreachable.resource.close()).resolves.toBeUndefined();
      await expect(unreachable.resource.close()).resolves.toBeUndefined();
    } finally {
      await unreachable.resource.close();
    }
  });
});
