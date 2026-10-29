import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DUE_WORK_STARTUP_INCOMPLETE_LINE } from "./phase8-due-work-process.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const DEFAULT_MAX_RUN_MS = 30_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 400;
const MAX_SHUTDOWN_GRACE_MS = 400;
const MIN_RUN_MS = 1_000;
const MIN_WORKER_REMAINING_MS = 1_500;
const WORKER_HANDOFF_MARGIN_MS = 100;
const LEASE_DURATION_MS = 300_000;
const BUILD_TEMP_PREFIX = "portfolio-phase8-due-work-";

function readBoundedInteger(env, name, fallback) {
  const value = env[name];
  if (value === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** The invocation budget starts in the launcher, before TypeScript compilation. */
export function phase8DueWorkInvocationBudgetFromEnvironment(env = process.env) {
  const maxRunDurationMs = readBoundedInteger(env, "PHASE8_DUE_WORK_MAX_RUN_MS", DEFAULT_MAX_RUN_MS);
  const shutdownGraceMs = readBoundedInteger(env, "PHASE8_DUE_WORK_SHUTDOWN_GRACE_MS", DEFAULT_SHUTDOWN_GRACE_MS);
  if (maxRunDurationMs === undefined || shutdownGraceMs === undefined || maxRunDurationMs < MIN_RUN_MS ||
      shutdownGraceMs < 1 || shutdownGraceMs > MAX_SHUTDOWN_GRACE_MS ||
      maxRunDurationMs + shutdownGraceMs > LEASE_DURATION_MS) return undefined;
  return Object.freeze({ maxRunDurationMs, shutdownGraceMs });
}

/** Returns a child budget only when startup leaves a useful, lease-bounded window. */
export function remainingDueWorkRunBudgetMs(input) {
  if (!Number.isSafeInteger(input.maxRunDurationMs) || !Number.isFinite(input.startedAtMs) ||
      !Number.isFinite(input.nowMs) || input.nowMs < input.startedAtMs) return undefined;
  const remaining = Math.floor(input.maxRunDurationMs - (input.nowMs - input.startedAtMs) - WORKER_HANDOFF_MARGIN_MS);
  return remaining >= MIN_WORKER_REMAINING_MS ? remaining : undefined;
}

function linkInstalledPackages(source, destination) {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "@shared") continue;
    const sourceEntry = join(source, entry.name);
    const destinationEntry = join(destination, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      mkdirSync(destinationEntry, { recursive: true });
      for (const scoped of readdirSync(sourceEntry, { withFileTypes: true })) {
        if (!scoped.isDirectory() && !scoped.isSymbolicLink()) continue;
        symlinkSync(join(sourceEntry, scoped.name), join(destinationEntry, scoped.name), process.platform === "win32" ? "junction" : "dir");
      }
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      symlinkSync(sourceEntry, destinationEntry, process.platform === "win32" ? "junction" : "dir");
    }
  }
}

/** Builds the portable worker under the same deadline, then supervises it until cleanup. */
export async function runPhase8DueWorkLauncher(env = process.env) {
  const invocationStartedAtMs = performance.now();
  let buildBudget;
  let activeChild;
  let childKind;
  let stopReason;
  let finished = false;
  let deadlineTimer;
  let forceStopTimer;
  let temp;
  let tempRoot;
  let workerControl;
  let workerInput;
  let workerControlBuffer = "";
  let workerReady = false;
  let workerAdmitted = false;
  let workerControlSent = false;
  let stopPendingWorkerLogged = false;

  function clearTimer(timer) {
    if (timer !== undefined) clearTimeout(timer);
  }

  async function finish(code, { incompleteStartup = false } = {}) {
    if (finished) return;
    finished = true;
    clearTimer(deadlineTimer);
    clearTimer(forceStopTimer);
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
    let finalCode = Number.isInteger(code) ? code : 1;
    if (temp !== undefined) {
      try {
        const target = resolve(temp);
        if (tempRoot === undefined || dirname(target) !== tempRoot || !basename(target).startsWith(BUILD_TEMP_PREFIX)) {
          throw new Error("DUE_WORK_BUILD_TEMP_SCOPE_INVALID");
        }
        rmSync(target, { recursive: true, force: true });
      } catch {
        process.stderr.write("DUE_WORK_BUILD_CLEANUP_FAILED\n");
        finalCode = 1;
      }
    }
    workerControl?.destroy();
    workerControl = undefined;
    workerInput?.destroy();
    workerInput = undefined;
    if (incompleteStartup) process.stdout.write(`${DUE_WORK_STARTUP_INCOMPLETE_LINE}\n`);
    process.exitCode = finalCode;
  }

  function isChildRunning() {
    return activeChild !== undefined && activeChild.exitCode === null && activeChild.signalCode === null;
  }

  function armForceStop() {
    if (forceStopTimer !== undefined) return;
    forceStopTimer = setTimeout(() => {
      if (isChildRunning()) {
        try { activeChild.kill("SIGKILL"); } catch { process.stderr.write("DUE_WORK_FORCE_STOP_FAILED\n"); }
      }
    }, buildBudget?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS);
  }

  function sendWorkerControl(command) {
    if (workerControlSent || workerInput === undefined) {
      process.stderr.write("DUE_WORK_CONTROL_CHANNEL_FAILED\n");
      return false;
    }
    workerControlSent = true;
    try {
      workerInput.once("error", () => process.stderr.write("DUE_WORK_CONTROL_CHANNEL_FAILED\n"));
      workerInput.end(`${command}\n`);
      return true;
    } catch {
      process.stderr.write("DUE_WORK_CONTROL_CHANNEL_FAILED\n");
      return false;
    }
  }

  function failWorkerControlChannel() {
    if (finished) return;
    process.stderr.write("DUE_WORK_CONTROL_CHANNEL_FAILED\n");
    if (isChildRunning() && childKind === "worker" && !workerAdmitted) {
      try { activeChild.kill("SIGKILL"); } catch { process.stderr.write("DUE_WORK_FORCE_STOP_FAILED\n"); }
    }
  }

  function onWorkerControlData(chunk) {
    workerControlBuffer += chunk.toString("utf8");
    if (workerControlBuffer.length > 64) { failWorkerControlChannel(); return; }
    const newline = workerControlBuffer.indexOf("\n");
    if (newline < 0) return;
    if (workerControlBuffer.slice(0, newline) !== "READY" || newline !== workerControlBuffer.length - 1) {
      failWorkerControlChannel();
      return;
    }
    workerReady = true;
    workerControl?.removeListener("data", onWorkerControlData);
    workerControl?.pause();

    if (stopReason !== undefined) {
      sendWorkerControl("STOP");
      armForceStop();
      return;
    }
    const workerRunMs = remainingDueWorkRunBudgetMs({ maxRunDurationMs: buildBudget.maxRunDurationMs,
      startedAtMs: invocationStartedAtMs, nowMs: performance.now() });
    if (workerRunMs === undefined) {
      stopReason = "deadline";
      process.stderr.write("DUE_WORK_STARTUP_BUDGET_EXHAUSTED\n");
      sendWorkerControl("STOP");
      armForceStop();
      return;
    }
    // Once GO is queued, the child may begin work at any time. Treat it as
    // admitted before writing so later signal handling never invents zero totals.
    workerAdmitted = true;
    if (!sendWorkerControl(`GO ${workerRunMs}`)) {
      if (isChildRunning()) {
        try { activeChild.kill("SIGKILL"); } catch { process.stderr.write("DUE_WORK_FORCE_STOP_FAILED\n"); }
      }
    }
  }

  function requestStop(signal, reason) {
    stopReason ??= reason;
    if (isChildRunning()) {
      if (childKind === "worker" && !workerAdmitted) {
        if (workerReady) {
          sendWorkerControl("STOP");
        } else if (!stopPendingWorkerLogged) {
          stopPendingWorkerLogged = true;
          process.stderr.write("DUE_WORK_STOP_PENDING_WORKER_READY\n");
        }
        armForceStop();
        return;
      }
      const isWindowsDeadline = process.platform === "win32" && childKind === "worker" && reason === "deadline";
      if (!isWindowsDeadline) {
        try { activeChild.kill(signal); } catch { process.stderr.write("DUE_WORK_SIGNAL_FORWARD_FAILED\n"); }
      }
      armForceStop();
    }
  }

  const onSigterm = () => requestStop("SIGTERM", "signal");
  const onSigint = () => requestStop("SIGINT", "signal");
  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);

  buildBudget = phase8DueWorkInvocationBudgetFromEnvironment(env);
  if (buildBudget === undefined) {
    process.stderr.write("DUE_WORK_BUDGET_INVALID\n");
    await finish(1);
    return;
  }

  tempRoot = resolve(tmpdir());
  temp = join(tempRoot, `${BUILD_TEMP_PREFIX}${randomUUID()}`);
  const output = join(temp, "out");
  const dependencies = join(output, "node_modules");

  deadlineTimer = setTimeout(() => requestStop("SIGTERM", "deadline"),
    Math.max(0, buildBudget.maxRunDurationMs - buildBudget.shutdownGraceMs));
  deadlineTimer.unref?.();

  try {
    if (stopReason !== undefined) { await finish(2, { incompleteStartup: true }); return; }
    mkdirSync(output, { recursive: true });
    const compiler = resolve(root, "node_modules/typescript/bin/tsc");
    const build = spawn(process.execPath, [compiler, "--project", "tsconfig.phase8-worker.json", "--outDir", output], {
      cwd: root, env, stdio: "ignore", windowsHide: true,
    });
    activeChild = build;
    childKind = "build";
    build.once("spawn", () => process.stderr.write("DUE_WORK_BUILD_STARTED\n"));
    build.once("error", () => {
      activeChild = undefined;
      clearTimer(forceStopTimer);
      process.stderr.write("DUE_WORK_BUILD_FAILED\n");
      void finish(1);
    });
    build.once("exit", (code, signal) => {
      activeChild = undefined;
      childKind = undefined;
      clearTimer(forceStopTimer);
      if (stopReason !== undefined) {
        void finish(2, { incompleteStartup: true });
        return;
      }
      if (code !== 0 || signal !== null) {
        process.stderr.write("DUE_WORK_BUILD_FAILED\n");
        void finish(1);
        return;
      }
      try {
        writeFileSync(join(output, "package.json"), JSON.stringify({ private: true, type: "module" }));
        linkInstalledPackages(resolve(root, "node_modules"), dependencies);
        for (const name of ["domain", "application"]) {
          const compiled = join(output, "src", "shared", name);
          writeFileSync(join(compiled, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
          const scope = join(dependencies, "@shared");
          mkdirSync(scope, { recursive: true });
          symlinkSync(compiled, join(scope, name), process.platform === "win32" ? "junction" : "dir");
        }
        if (stopReason !== undefined) { void finish(2, { incompleteStartup: true }); return; }
        const workerRunMs = remainingDueWorkRunBudgetMs({ maxRunDurationMs: buildBudget.maxRunDurationMs,
          startedAtMs: invocationStartedAtMs, nowMs: performance.now() });
        if (workerRunMs === undefined) { void finish(2, { incompleteStartup: true }); return; }
        const workerEnv = { ...env, PHASE8_DUE_WORK_MAX_RUN_MS: String(workerRunMs) };
        const worker = spawn(process.execPath, [join(output, "src", "runtime", "phase8-due-work-cli.js")], {
          cwd: root, env: workerEnv, stdio: ["pipe", "inherit", "inherit", "pipe"], windowsHide: true,
        });
        activeChild = worker;
        childKind = "worker";
        workerControl = worker.stdio[3];
        workerInput = worker.stdin;
        if (workerControl === null || workerControl === undefined || workerInput === null || workerInput === undefined) {
          failWorkerControlChannel();
        } else {
          workerControl.on("data", onWorkerControlData);
          workerControl.once("error", () => {
            if (!workerReady) failWorkerControlChannel();
          });
          workerControl.once("end", () => {
            if (!workerReady) failWorkerControlChannel();
          });
        }
        worker.once("spawn", () => process.stderr.write("DUE_WORK_WORKER_STARTED\n"));
        worker.once("error", () => {
          activeChild = undefined;
          clearTimer(forceStopTimer);
          process.stderr.write("DUE_WORK_PROCESS_START_FAILED\n");
          void finish(1);
        });
        worker.once("exit", (workerCode, workerSignal) => {
          activeChild = undefined;
          childKind = undefined;
          clearTimer(forceStopTimer);
          const stoppedBeforeAdmission = !workerAdmitted && stopReason !== undefined;
          void finish(stoppedBeforeAdmission ? 2 : workerCode ?? 1,
            { incompleteStartup: stoppedBeforeAdmission });
        });
      } catch {
        process.stderr.write("DUE_WORK_BUILD_FAILED\n");
        void finish(1);
      }
    });
  } catch {
    process.stderr.write("DUE_WORK_BUILD_FAILED\n");
    await finish(1);
  }
}
