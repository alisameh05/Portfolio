import { PHASE7_DUE_WORK_LIMITS } from "./phase7-due-work.js";
import type { WorkBatchSize } from "@shared/application";

const MEBIBYTE = 1_048_576;
const MAX_SHUTDOWN_GRACE_MS = 400;
const MIN_RUN_WINDOW_MS = 1_000;
const MAX_MEMORY_BUDGET_BYTES = 1_073_741_824;

/** Application-owned limits; host adapters only provide observations and stop signals. */
export interface Phase8DueWorkBudget {
  readonly maxClaimsPerPhase: number;
  readonly maxWorkBatchSize: WorkBatchSize;
  readonly maxCatchUpPeriods: number;
  readonly maxOwnerExportClaims: number;
  /** Total invocation window, including the reserved shutdown grace. */
  readonly maxRunDurationMs: number;
  readonly shutdownGraceMs: number;
  readonly maxMemoryBytes: number;
}

/** Provider-neutral observations. Node and HTTP hosts supply their own readings. */
export interface DueWorkRuntimeObservationPort {
  monotonicNowMs(): number;
  memoryUsageBytes(): number | null;
}

export const DEFAULT_PROTECTED_DUE_WORK_BUDGET: Phase8DueWorkBudget = Object.freeze({
  maxClaimsPerPhase: 50,
  maxWorkBatchSize: PHASE7_DUE_WORK_LIMITS.maxWorkBatchSize,
  maxCatchUpPeriods: PHASE7_DUE_WORK_LIMITS.maxCatchUpPeriods,
  maxOwnerExportClaims: 2,
  maxRunDurationMs: 30_000,
  shutdownGraceMs: MAX_SHUTDOWN_GRACE_MS,
  maxMemoryBytes: 512 * MEBIBYTE,
});

function configuredInteger(env: Readonly<Record<string, string | undefined>>, name: string, fallback: number): number | undefined {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Parse only bounded operational overrides; secret and database settings stay in the composition root. */
export function phase8DueWorkBudgetFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Phase8DueWorkBudget | undefined {
  const maxClaimsPerPhase = configuredInteger(env, "PHASE8_DUE_WORK_MAX_CLAIMS_PER_PHASE", DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxClaimsPerPhase);
  const rawBatchSize = configuredInteger(env, "PHASE8_DUE_WORK_MAX_BATCH_SIZE", DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxWorkBatchSize);
  const maxCatchUpPeriods = configuredInteger(env, "PHASE8_DUE_WORK_MAX_CATCH_UP_PERIODS", DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxCatchUpPeriods);
  const maxOwnerExportClaims = configuredInteger(env, "PHASE8_DUE_WORK_MAX_OWNER_EXPORT_CLAIMS", DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxOwnerExportClaims);
  const maxRunDurationMs = configuredInteger(env, "PHASE8_DUE_WORK_MAX_RUN_MS", DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxRunDurationMs);
  const shutdownGraceMs = configuredInteger(env, "PHASE8_DUE_WORK_SHUTDOWN_GRACE_MS", DEFAULT_PROTECTED_DUE_WORK_BUDGET.shutdownGraceMs);
  const maxMemoryBytes = configuredInteger(env, "PHASE8_DUE_WORK_MAX_MEMORY_BYTES", DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxMemoryBytes);
  const maxWorkBatchSize = rawBatchSize === 25 || rawBatchSize === 50 || rawBatchSize === 100
    ? rawBatchSize as WorkBatchSize : undefined;
  if ([maxClaimsPerPhase, maxWorkBatchSize, maxCatchUpPeriods, maxOwnerExportClaims, maxRunDurationMs,
    shutdownGraceMs, maxMemoryBytes].some((value) => value === undefined)) return undefined;
  const budget: Phase8DueWorkBudget = { maxClaimsPerPhase: maxClaimsPerPhase!, maxWorkBatchSize: maxWorkBatchSize!,
    maxCatchUpPeriods: maxCatchUpPeriods!, maxOwnerExportClaims: maxOwnerExportClaims!, maxRunDurationMs: maxRunDurationMs!,
    shutdownGraceMs: shutdownGraceMs!, maxMemoryBytes: maxMemoryBytes! };
  return isValidPhase8DueWorkBudget(budget) ? budget : undefined;
}

export function isValidPhase8DueWorkBudget(value: Phase8DueWorkBudget): boolean {
  return Number.isSafeInteger(value.maxClaimsPerPhase) && value.maxClaimsPerPhase >= 1 &&
    value.maxClaimsPerPhase <= PHASE7_DUE_WORK_LIMITS.maxClaimsPerPhase &&
    [25, 50, PHASE7_DUE_WORK_LIMITS.maxWorkBatchSize].includes(value.maxWorkBatchSize) &&
    Number.isSafeInteger(value.maxCatchUpPeriods) && value.maxCatchUpPeriods >= 1 &&
    value.maxCatchUpPeriods <= PHASE7_DUE_WORK_LIMITS.maxCatchUpPeriods &&
    Number.isSafeInteger(value.maxOwnerExportClaims) && value.maxOwnerExportClaims >= 0 &&
    value.maxOwnerExportClaims <= PHASE7_DUE_WORK_LIMITS.maxOwnerExportClaims &&
    Number.isSafeInteger(value.maxRunDurationMs) && value.maxRunDurationMs >= MIN_RUN_WINDOW_MS &&
    Number.isSafeInteger(value.shutdownGraceMs) && value.shutdownGraceMs >= 1 &&
    value.shutdownGraceMs <= MAX_SHUTDOWN_GRACE_MS &&
    value.maxRunDurationMs + value.shutdownGraceMs <= PHASE7_DUE_WORK_LIMITS.leaseDurationMs &&
    Number.isSafeInteger(value.maxMemoryBytes) && value.maxMemoryBytes >= 16 * MEBIBYTE &&
    value.maxMemoryBytes <= MAX_MEMORY_BUDGET_BYTES;
}

/** Stops before another claim when the invocation deadline, signal, or memory cap is reached. */
export function createDueWorkStopCheck(input: {
  readonly budget: Phase8DueWorkBudget;
  readonly observations: DueWorkRuntimeObservationPort;
  readonly isSignalled?: () => boolean;
}): () => boolean {
  const startedAt = input.observations.monotonicNowMs();
  const stopAt = startedAt + input.budget.maxRunDurationMs - input.budget.shutdownGraceMs;
  return () => {
    if (!Number.isFinite(startedAt) || !Number.isFinite(stopAt) || input.isSignalled?.() === true) return true;
    const now = input.observations.monotonicNowMs();
    if (!Number.isFinite(now) || now >= stopAt) return true;
    const memoryBytes = input.observations.memoryUsageBytes();
    return memoryBytes === null || !Number.isSafeInteger(memoryBytes) || memoryBytes < 0 ||
      memoryBytes >= input.budget.maxMemoryBytes;
  };
}
