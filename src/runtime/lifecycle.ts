/**
 * lifecycle.ts — Phase 2 #27 graceful runtime lifecycle coordinator.
 *
 * Explicit lifecycle states (starting, ready, draining, failed) with an
 * idempotent shutdown coordinator. Shutdown disables readiness first, waits
 * for tracked in-flight work up to a bounded drain limit, then closes
 * registered resources exactly once in reverse registration order.
 *
 * Phase 2 readiness performs no database, Auth, storage, or
 * external-provider check: readiness is the lifecycle state alone.
 *
 * This module imports only provider-neutral runtime ports and plain
 * TypeScript types — never Next.js, Supabase, Kysely, Vercel, OpenAPI
 * tooling, or generated transport code. Timing is injected so tests stay
 * deterministic without real timers.
 */

import type {
  LifecycleResource,
  LifecycleState,
  ReadinessCheck,
} from "./ports.js";

export type { LifecycleState };

/** Default bounded drain limit: thirty seconds. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export interface LifecycleOptions {
  readonly drainTimeoutMs?: number;
  readonly wait?: (ms: number) => Promise<void>;
}

export interface SignalTarget {
  on(event: "SIGTERM" | "SIGINT" | string, handler: () => void): void;
  removeListener?(event: string, handler: () => void): void;
  off?(event: string, handler: () => void): void;
}

export interface LifecycleCoordinator {
  getState(): LifecycleState;
  isReady(): boolean;
  checkReadiness(): Promise<boolean>;
  markReady(): void;
  markFailed(): void;
  track<T>(work: Promise<T>): Promise<T>;
  registerResource(resource: LifecycleResource): void;
  registerReadinessCheck(check: ReadinessCheck): void;
  shutdown(): Promise<void>;
  installSignalHandlers(target?: SignalTarget): () => void;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createLifecycleCoordinator(
  options: LifecycleOptions = {},
): LifecycleCoordinator {
  const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
  const wait = options.wait ?? defaultWait;

  let state: LifecycleState = "starting";
  const inFlight = new Set<Promise<unknown>>();
  const resources: Array<LifecycleResource> = [];
  const readinessChecks: Array<ReadinessCheck> = [];
  let shutdownPromise: Promise<void> | undefined;

  function getState(): LifecycleState {
    return state;
  }

  function isReady(): boolean {
    return state === "ready";
  }

  async function checkReadiness(): Promise<boolean> {
    if (!isReady()) return false;
    const results = await Promise.all(
      readinessChecks.map(async (check) => {
        try {
          return await check.check();
        } catch {
          return false;
        }
      }),
    );
    return results.every(Boolean);
  }

  function markReady(): void {
    if (shutdownPromise !== undefined) return;
    if (state === "draining") return;
    state = "ready";
  }

  function markFailed(): void {
    if (shutdownPromise !== undefined) return;
    if (state === "draining") return;
    state = "failed";
  }

  function track<T>(work: Promise<T>): Promise<T> {
    inFlight.add(work);
    const cleanup = (): void => {
      inFlight.delete(work);
    };
    work.then(cleanup, cleanup);
    return work;
  }

  async function drainInFlight(): Promise<void> {
    if (inFlight.size === 0) return;
    const pending = Array.from(inFlight);
    await Promise.race([
      Promise.allSettled(pending),
      (async () => {
        await wait(drainTimeoutMs);
      })(),
    ]);
  }

  async function closeResourcesReverse(): Promise<void> {
    let firstError: unknown;
    for (let index = resources.length - 1; index >= 0; index -= 1) {
      const resource = resources[index] as LifecycleResource;
      try {
        await resource.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise !== undefined) {
      return shutdownPromise;
    }
    state = "draining";
    shutdownPromise = (async () => {
      await drainInFlight();
      await closeResourcesReverse();
    })();
    return shutdownPromise;
  }

  function resolveTarget(): SignalTarget | undefined {
    if (typeof process !== "undefined" && typeof process.on === "function") {
      return process as unknown as SignalTarget;
    }
    return undefined;
  }

  function installSignalHandlers(target?: SignalTarget): () => void {
    const resolved = target ?? resolveTarget();
    if (resolved === undefined) {
      return () => {};
    }
    const handler = (): void => {
      void shutdown();
    };
    resolved.on("SIGTERM", handler);
    resolved.on("SIGINT", handler);
    return () => {
      if (typeof resolved.removeListener === "function") {
        resolved.removeListener("SIGTERM", handler);
        resolved.removeListener("SIGINT", handler);
      } else if (typeof resolved.off === "function") {
        resolved.off("SIGTERM", handler);
        resolved.off("SIGINT", handler);
      }
    };
  }

  function registerResource(resource: LifecycleResource): void {
    resources.push(resource);
  }


  function registerReadinessCheck(check: ReadinessCheck): void {
    readinessChecks.push(check);
  }

  return {
    getState,
    isReady,
    checkReadiness,
    markReady,
    markFailed,
    track,
    registerResource,
    registerReadinessCheck,
    shutdown,
    installSignalHandlers,
  };
}

// ── Process-wide singleton for Route Handlers and the composition root ──────

let globalCoordinator: LifecycleCoordinator = createLifecycleCoordinator();

/** Shared coordinator used by /readyz and the composition root. */
export function getLifecycleCoordinator(): LifecycleCoordinator {
  return globalCoordinator;
}

/** Current lifecycle state of the shared coordinator. */
export function getLifecycleState(): LifecycleState {
  return globalCoordinator.getState();
}

/** Test-only seam to isolate focused suites. */
export function resetLifecycleForTests(): void {
  globalCoordinator = createLifecycleCoordinator();
}
