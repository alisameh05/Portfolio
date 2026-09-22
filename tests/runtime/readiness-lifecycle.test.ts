/**
 * readiness-lifecycle.test.ts — Phase 2 #27
 *
 * Seam under test (pre-agreed):
 * - Lifecycle coordinator via observable state transitions and Response objects.
 * - GET /readyz via standard Response (no database or provider).
 * - GET /livez remaining 200 in every lifecycle state.
 * - Shutdown via injected timing and fake resources (deterministic, no timers).
 *
 * Acceptance (issue #27):
 * - Lifecycle state is starting, ready, draining, or failed; init reaches ready
 *   only after config + composition succeed, failure reaches failed.
 * - GET /readyz returns 200 with minimal ready status only in ready.
 * - Starting/failed/draining return safe 503 Problem Details with stable
 *   RUNTIME_NOT_READY code and no configuration or dependency details.
 * - Phase 2 readiness has no database, Auth, storage, or external-provider check.
 * - GET /livez remains 200 while the process can answer in every state.
 * - Shutdown moves to draining and disables readiness before waiting for
 *   tracked in-flight work.
 * - SIGTERM and SIGINT use the same shutdown coordinator where supported.
 * - Registered resources close exactly once in reverse registration order.
 * - Repeated signals/shutdown calls reuse the same in-progress operation.
 * - Default drain limit is thirty seconds; injected timing is deterministic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";

import {
  createLifecycleCoordinator,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type LifecycleCoordinator,
} from "../../src/runtime/lifecycle.js";
import { createReadyzResponse } from "../../src/runtime/readyz.js";

const ROOT = process.cwd();

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("readiness and graceful lifecycle (#27)", () => {
  let lifecycle: LifecycleCoordinator;

  beforeEach(() => {
    lifecycle = createLifecycleCoordinator();
  });

  it("starts in starting and reaches ready only after successful init", () => {
    expect(lifecycle.getState()).toBe("starting");
    expect(lifecycle.isReady()).toBe(false);
    lifecycle.markReady();
    expect(lifecycle.getState()).toBe("ready");
    expect(lifecycle.isReady()).toBe(true);
  });

  it("reaches failed on initialization failure", () => {
    lifecycle.markFailed();
    expect(lifecycle.getState()).toBe("failed");
    expect(lifecycle.isReady()).toBe(false);
  });

  it("returns 200 with minimal ready status only in ready", async () => {
    lifecycle.markReady();
    const ok = createReadyzResponse(lifecycle.getState());
    expect(ok.status).toBe(200);
    expect(await readJson(ok)).toEqual({ status: "ready" });

    for (const state of ["starting", "failed", "draining"] as const) {
      const probe = createReadyzResponse(state);
      expect(probe.status).toBe(503);
      const body = await readJson(probe);
      expect(body["status"]).toBe(503);
      expect(body["code"]).toBe("RUNTIME_NOT_READY");
      expect(body["traceId"]).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    }
  });

  it("exposes no configuration or dependency details while not ready", async () => {
    for (const state of ["starting", "failed", "draining"] as const) {
      const probe = createReadyzResponse(state);
      const serialized = JSON.stringify(await readJson(probe));
      for (const leak of [
        "APP_BASE_URL",
        "NODE_ENV",
        "DATABASE_URL",
        "postgres://",
        "supabase",
        "localhost:3000",
        "example.com",
      ]) {
        expect(serialized).not.toContain(leak);
      }
    }
    const content = readFileSync(join(ROOT, "src/runtime/readyz.ts"), "utf8");
    expect(content).not.toMatch(/from\s+["'][^"']*(supabase|kysely|database)/i);
    expect(content).not.toMatch(/fetch\s*\(\s*["']https?:/i);
  });

  it("phase 2 readiness performs no provider check", () => {
    for (const file of ["src/runtime/lifecycle.ts", "src/runtime/readyz.ts"]) {
      const content = readFileSync(join(ROOT, file), "utf8");
      expect(content).not.toMatch(/from\s+["']@supabase\//);
      expect(content).not.toMatch(/from\s+["']kysely["']/);
      expect(content).not.toMatch(/from\s+["'][^"']*(kysely|supabase|database)/i);
      expect(content).not.toMatch(/fetch\s*\(\s*["']https?:/i);
    }
  });

  it("keeps GET /livez at 200 in every lifecycle state", async () => {
    const { GET } = await import("../../src/app/livez/route.js");
    for (const state of ["starting", "ready", "draining", "failed"] as const) {
      if (state === "ready") lifecycle.markReady();
      else if (state === "failed") lifecycle.markFailed();
      else if (state === "draining") {
        lifecycle.markReady();
        void lifecycle.shutdown();
      }
      const response = await GET();
      expect(response.status).toBe(200);
      expect(await readJson(response)).toEqual({ status: "live" });
      lifecycle = createLifecycleCoordinator();
    }
  });

  it("shutdown drains before waiting and closes resources once in reverse order", async () => {
    const order: Array<string> = [];
    let resolveWork!: () => void;
    const work = new Promise<void>((resolve) => {
      resolveWork = resolve;
    });
    const tracked = lifecycle.track(work);
    let trackedSettled = false;
    void tracked.then(() => {
      trackedSettled = true;
    });

    lifecycle.registerResource({
      name: "first",
      close: async () => {
        order.push("first");
      },
    });
    lifecycle.registerResource({
      name: "second",
      close: async () => {
        order.push("second");
      },
    });
    lifecycle.markReady();

    const shutdownPromise = lifecycle.shutdown();
    // Readiness is disabled before drain completes.
    expect(lifecycle.getState()).toBe("draining");
    expect(lifecycle.isReady()).toBe(false);
    expect(createReadyzResponse(lifecycle.getState()).status).toBe(503);
    // In-flight work is awaited: resources not yet closed.
    expect(order).toEqual([]);
    expect(trackedSettled).toBe(false);

    resolveWork();
    await shutdownPromise;
    expect(trackedSettled).toBe(true);
    expect(order).toEqual(["second", "first"]);
  });

  it("reuses the same in-progress shutdown on repeated calls", async () => {
    let closes = 0;
    lifecycle.registerResource({
      name: "only",
      close: async () => {
        closes += 1;
      },
    });
    lifecycle.markReady();
    const first = lifecycle.shutdown();
    const second = lifecycle.shutdown();
    expect(second).toBe(first);
    await first;
    await second;
    expect(closes).toBe(1);
  });

  it("uses a thirty-second default drain limit with injected deterministic timing", async () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(30_000);
    let waitedMs: number | undefined;
    const hanging = createLifecycleCoordinator({
      drainTimeoutMs: 1_000,
      wait: async (ms: number) => {
        waitedMs = ms;
      },
    });
    hanging.markReady();
    // Never-resolving tracked work forces the timeout path.
    hanging.track(new Promise<void>(() => {}));
    await hanging.shutdown();
    expect(waitedMs).toBe(1_000);
    expect(hanging.getState()).toBe("draining");
  });

  it("routes SIGTERM and SIGINT through the same shutdown coordinator", async () => {
    const handlers = new Map<string, () => void>();
    const processLike = {
      on(event: string, handler: () => void): void {
        handlers.set(event, handler);
      },
      removeListener(): void {},
    };
    const cleanup = lifecycle.installSignalHandlers(processLike);
    expect(handlers.has("SIGTERM")).toBe(true);
    expect(handlers.has("SIGINT")).toBe(true);
    lifecycle.markReady();
    handlers.get("SIGTERM")?.();
    const drainingAfterTerm = lifecycle.getState();
    // Reset for the INT path on a fresh coordinator sharing the same installer shape.
    const second = createLifecycleCoordinator();
    const handlers2 = new Map<string, () => void>();
    second.installSignalHandlers({
      on(event: string, handler: () => void): void {
        handlers2.set(event, handler);
      },
      removeListener(): void {},
    });
    second.markReady();
    handlers2.get("SIGINT")?.();
    expect(drainingAfterTerm).toBe("draining");
    expect(second.getState()).toBe("draining");
    await lifecycle.shutdown();
    await second.shutdown();
    cleanup();
  });

  it("composition init reaches ready on success and failed on bad config", async () => {
    const { initializeRuntime, resetRuntimeForTests } = await import(
      "../../src/bootstrap/composition-root.js"
    );
    const { getLifecycleState } = await import("../../src/runtime/lifecycle.js");
    resetRuntimeForTests();
    expect(getLifecycleState()).toBe("starting");
    initializeRuntime({ NODE_ENV: "test", APP_BASE_URL: "http://localhost:3000" });
    expect(getLifecycleState()).toBe("ready");

    resetRuntimeForTests();
    expect(() =>
      initializeRuntime({ NODE_ENV: "bogus", APP_BASE_URL: "http://localhost:3000" }),
    ).toThrow();
    expect(getLifecycleState()).toBe("failed");
    resetRuntimeForTests();
  });

  it("wires GET /readyz without provider or frontend surface", async () => {
    const { GET } = await import("../../src/app/readyz/route.js");
    const { resetRuntimeForTests, initializeRuntime } = await import(
      "../../src/bootstrap/composition-root.js"
    );
    resetRuntimeForTests();
    const startingResponse = await GET();
    expect(startingResponse.status).toBe(503);
    const startingBody = await readJson(startingResponse);
    expect(startingBody["code"]).toBe("RUNTIME_NOT_READY");
    initializeRuntime({ NODE_ENV: "test", APP_BASE_URL: "http://localhost:3000" });
    const readyResponse = await GET();
    expect(readyResponse.status).toBe(200);
    expect(await readJson(readyResponse)).toEqual({ status: "ready" });
    resetRuntimeForTests();
    const response = await GET();
    expect(response.status).toBe(503);
    const routeContent = readFileSync(join(ROOT, "src/app/readyz/route.ts"), "utf8");
    expect(routeContent).not.toMatch(/process\s*\.\s*env\s*(?:\[|\.|as\b)/);
    expect(routeContent).not.toMatch(/from\s+["']react["']/);
    expect(routeContent).not.toMatch(/localStorage|sessionStorage|indexedDB|document\s*\.\s*cookie/);
    expect(routeContent).not.toMatch(/supabase|kysely|postgres:\/\//i);
  });
});
