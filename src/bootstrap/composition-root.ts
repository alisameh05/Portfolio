/**
 * composition-root.ts — Phase 2 #25 single runtime assembly point.
 *
 * This is the only place that assembles runtime configuration and
 * dependencies. Route Handlers obtain what they need from here (or, for
 * operational probes like /livez, from nothing at all) and never construct
 * providers or application services themselves.
 *
 * Configuration is parsed once when `initializeRuntime` is called — never on
 * module import — and consumers receive the frozen value via
 * `getRuntimeConfig` instead of reading the ambient environment.
 */

import {
  createRuntimeConfig,
  type RuntimeConfig,
  type RuntimeConfigEnv,
} from "./configuration.js";

export type { RuntimeConfig } from "./configuration.js";

let current: RuntimeConfig | undefined;

export function initializeRuntime(env: RuntimeConfigEnv): RuntimeConfig {
  const config = createRuntimeConfig(env);
  current = config;
  return config;
}

/** Default bootstrap seam: forwards the ambient environment exactly once. */
export function initializeRuntimeFromEnvironment(): RuntimeConfig {
  return initializeRuntime({ ...(process.env as RuntimeConfigEnv) });
}

export function getRuntimeConfig(): RuntimeConfig {
  if (current === undefined) {
    throw new Error("Runtime is not initialized: call initializeRuntime first.");
  }
  return current;
}

export function isRuntimeInitialized(): boolean {
  return current !== undefined;
}

/** Test-only seam to isolate focused suites. */
export function resetRuntimeForTests(): void {
  current = undefined;
}
