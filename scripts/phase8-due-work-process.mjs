import { writeSync } from "node:fs";

export const DUE_WORK_STARTUP_INCOMPLETE_LINE = JSON.stringify({
  ok: true,
  incomplete: true,
  totals: {
    scheduled: 0, deduplicated: 0, claimed: 0, completed: 0, released: 0, failed: 0, staleLeases: 0,
    processedCount: 0, incompleteBacklog: true, incompleteCoverage: false, incompleteOwnerExports: false,
    incomplete: true, ownerExportAssembly: null,
  },
});

const MIN_WORKER_RUN_MS = 1_500;
// The 400 ms maximum shutdown grace keeps the worker window inside the
// existing five-minute Operations lease.
const MAX_WORKER_RUN_MS = 299_600;

/** Emits a fixed test-only startup marker without exposing runtime environment access in the CLI. */
export function reportDueWorkModuleGraphReadyForTest() {
  if (process.env.NODE_ENV === "test") process.stderr.write("DUE_WORK_TEST_MODULE_GRAPH_READY\n");
}

/** Installs OS signal latches before announcing READY, then waits for bounded supervisor admission. */
/** @returns {Promise<
 * {kind: "stopped", isSignalled: () => boolean, dispose: () => void} |
 * {kind: "interrupted", isSignalled: () => boolean, dispose: () => void} |
 * {kind: "failed", isSignalled: () => boolean, dispose: () => void} |
 * {kind: "admitted", maxRunDurationMs: number, isSignalled: () => boolean, dispose: () => void}
 * >} */
export async function waitForDueWorkAdmission() {
  let signal;
  let disposed = false;
  const onSigterm = () => { signal ??= "SIGTERM"; };
  const onSigint = () => { signal ??= "SIGINT"; };
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  };
  const isSignalled = () => signal !== undefined;

  const command = await new Promise((resolve) => {
    let input = "";
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 64) { settle(undefined); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      if (newline !== input.length - 1) { settle(undefined); return; }
      settle(input.slice(0, newline));
    };
    const onEnd = () => settle(undefined);
    const onError = () => settle(undefined);
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onError);
    process.stdin.resume();
    try {
      writeSync(3, "READY\n");
      if (process.env.NODE_ENV === "test") process.stderr.write("DUE_WORK_TEST_WORKER_READY\n");
    }
    catch { settle(undefined); }
  });

  if (command === "STOP") {
    if (process.env.NODE_ENV === "test") process.stderr.write("DUE_WORK_TEST_WORKER_STOP_RECEIVED\n");
    return { kind: "stopped", isSignalled, dispose };
  }
  const match = typeof command === "string" ? /^GO ([1-9][0-9]{0,5})$/u.exec(command) : null;
  const maxRunDurationMs = match === null ? undefined : Number(match[1]);
  if (!Number.isSafeInteger(maxRunDurationMs) || maxRunDurationMs < MIN_WORKER_RUN_MS ||
      maxRunDurationMs > MAX_WORKER_RUN_MS) {
    dispose();
    return { kind: "failed", isSignalled, dispose };
  }
  if (isSignalled()) return { kind: "interrupted", isSignalled, dispose };
  if (process.env.NODE_ENV === "test") process.stderr.write("DUE_WORK_TEST_WORKER_ADMITTED\n");
  return { kind: "admitted", maxRunDurationMs, isSignalled, dispose };
}

/** Process lifecycle seam shared by the portable worker CLI and its subprocess gate. */
export async function runDueWorkProcess(input) {
  let signalled = false;
  let exitCode = 1;
  const stop = (signal) => {
    signalled = true;
    input.onStopSignal?.(signal);
  };
  const onSigterm = () => stop("SIGTERM");
  const onSigint = () => stop("SIGINT");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  try {
    const shouldStop = input.makeStopCheck(() => signalled || input.isSignalled?.() === true);
    const result = await input.run(shouldStop);
    const rendered = input.render(result);
    process.stdout.write(`${rendered.line}\n`);
    exitCode = rendered.exitCode;
  } catch {
    process.stdout.write(`${input.failureLine ?? "{\"ok\":false,\"code\":\"due_work_unavailable\"}"}\n`);
    exitCode = 1;
  }
  try {
    await input.shutdown();
  } catch {
    process.stderr.write(`${input.shutdownFailureLine ?? "DUE_WORK_SHUTDOWN_FAILED"}\n`);
    exitCode = 1;
  } finally {
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  }
  return exitCode;
}
