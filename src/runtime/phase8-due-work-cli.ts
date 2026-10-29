import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { DUE_WORK_STARTUP_INCOMPLETE_LINE, runDueWorkProcess,
  reportDueWorkModuleGraphReadyForTest, waitForDueWorkAdmission } from "../../scripts/phase8-due-work-process.mjs";
import type { DueWorkRunResult } from "./phase7-due-work.js";
import type { Rejection, Result } from "../shared/domain/index.js";

const admission = await waitForDueWorkAdmission();
if (admission.kind === "stopped") {
  admission.dispose();
  process.exitCode = 2;
} else if (admission.kind === "failed") {
  process.stderr.write("DUE_WORK_CONTROL_CHANNEL_FAILED\n");
  admission.dispose();
  process.exitCode = 1;
} else if (admission.kind === "interrupted") {
  process.stdout.write(`${DUE_WORK_STARTUP_INCOMPLETE_LINE}\n`);
  admission.dispose();
  process.exitCode = 2;
} else {
  const admittedAtMs = performance.now();
  try {
    const [composition, lifecycleModule, controlModule, summaryModule] = await Promise.all([
      import("../bootstrap/composition-root.js"),
      import("./lifecycle.js"),
      import("./phase8-due-work-control.js"),
      import("./phase8-due-work-summary.js"),
    ]);
    reportDueWorkModuleGraphReadyForTest();
    const remainingRunMs = Math.floor(admission.maxRunDurationMs - (performance.now() - admittedAtMs));
    if (admission.isSignalled() || remainingRunMs < 1_000) {
      process.stdout.write(`${DUE_WORK_STARTUP_INCOMPLETE_LINE}\n`);
      admission.dispose();
      process.exitCode = 2;
    } else {
      const runtimeEnvironment = composition.getRuntimeEnvironmentSnapshot();
      const budget = composition.getPhase8DueWorkBudgetFromEnvironment(remainingRunMs, runtimeEnvironment);
      if (budget === undefined) {
        process.stderr.write("DUE_WORK_BUDGET_INVALID\n");
        process.stdout.write("{\"ok\":false,\"code\":\"due_work_unavailable\"}\n");
        admission.dispose();
        process.exitCode = 1;
      } else {
        const lifecycle = lifecycleModule.getLifecycleCoordinator();
        const observations = {
          monotonicNowMs: () => performance.now(),
          memoryUsageBytes: () => process.memoryUsage().rss,
        };
        const incompleteBeforeWork: DueWorkRunResult = {
          scheduled: 0, deduplicated: 0, claimed: 0, completed: 0, released: 0, failed: 0, staleLeases: 0,
          processedCount: 0, incompleteBacklog: true, incompleteCoverage: false, incompleteOwnerExports: false,
          incomplete: true, lastCompletePolicyPeriod: null, oldestOverduePeriod: null, ownerExportAssembly: null,
        };
        process.stderr.write("DUE_WORK_RUN_STARTED\n");
        process.exitCode = await runDueWorkProcess({
          isSignalled: admission.isSignalled,
          makeStopCheck: (isSignalled: () => boolean) => controlModule.createDueWorkStopCheck({ budget, observations,
            isSignalled: () => admission.isSignalled() || isSignalled() }),
          run: async (shouldStop: () => boolean): Promise<Result<DueWorkRunResult, Rejection>> => {
            if (shouldStop()) return { ok: true, value: incompleteBeforeWork };
            await composition.initializeDatabaseRuntime(runtimeEnvironment, "worker");
            if (shouldStop()) return { ok: true, value: incompleteBeforeWork };
            return composition.getPhase7DueWorkWorkerService().runDueWork({
              workerId: `phase8-due-work-cli-${randomUUID()}`,
              maxClaimsPerPhase: budget.maxClaimsPerPhase,
              maxWorkBatchSize: budget.maxWorkBatchSize,
              maxCatchUpPeriods: budget.maxCatchUpPeriods,
              maxOwnerExportClaims: budget.maxOwnerExportClaims,
              shouldStop,
            });
          },
          shutdown: () => lifecycle.shutdown(),
          render: (result: Result<DueWorkRunResult, Rejection>) => {
            if (!result.ok) return { line: "{\"ok\":false,\"code\":\"due_work_unavailable\"}", exitCode: 1 };
            const totals = summaryModule.safeDueWorkTotals(result.value);
            if (totals === undefined) return { line: "{\"ok\":false,\"code\":\"due_work_unavailable\"}", exitCode: 1 };
            return { line: JSON.stringify({ ok: true, incomplete: totals["incomplete"], totals }),
              exitCode: totals["incomplete"] === true ? 2 : 0 };
          },
        });
        admission.dispose();
      }
    }
  } catch {
    if (admission.isSignalled()) {
      process.stdout.write(`${DUE_WORK_STARTUP_INCOMPLETE_LINE}\n`);
      process.exitCode = 2;
    } else {
      process.stdout.write("{\"ok\":false,\"code\":\"due_work_unavailable\"}\n");
      process.exitCode = 1;
    }
    admission.dispose();
  }
}
