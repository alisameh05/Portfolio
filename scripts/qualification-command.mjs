import { spawn } from "node:child_process";
import { join } from "node:path";

export const WINDOWS_PHASE2_NONREQUIRED_SKIP = "tests/runtime/media-processing-tools.test.ts > bounded PDF output reads > stops helper processes before rejecting a timed out or oversized worker";

export function approvedWindowsPhase2Skip(output, { platform = process.platform, phase2RuntimeSuite = false } = {}) {
  if (platform !== "win32" || phase2RuntimeSuite !== true) return false;
  const text = output.replaceAll(/\u001B\[[0-9;]*m/gu, "");
  const markers = [...text.matchAll(/^\s*↓\s+(tests\/runtime\/media-processing-tools\.test\.ts > bounded PDF output reads > stops helper processes before rejecting a timed out or oversized worker)\s*$/gmu)];
  const summaries = [...text.matchAll(/^\s*Tests\s+\d+ passed \| 1 skipped \(\d+\)\s*$/gmu)];
  const otherSkips = [...text.matchAll(/^\s*↓\s+(?!tests\/runtime\/media-processing-tools\.test\.ts > bounded PDF output reads > stops helper processes before rejecting a timed out or oversized worker).+$/gmu)];
  return markers.length === 1 && markers[0][1] === WINDOWS_PHASE2_NONREQUIRED_SKIP && summaries.length === 1 && otherSkips.length === 0;
}

// Test runners may exit successfully for skipped or todo tests. Classify the
// actual transcript before the caller can persist a reusable success.
function incompleteCounts(output) {
  const text = output.replaceAll(/\u001B\[[0-9;]*m/gu, "");
  const maximum = (patterns) => Math.max(0, ...patterns.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => Number(match[1]))));
  const skipped = maximum([/\b(\d+)\s+skipped\b/giu, /^\s*#?\s*skipped\s+(\d+)\b/gimu,
    /\bskipped(?:\s+tests?)?\s*[:=]\s*(\d+)\b/giu]);
  const cancelled = maximum([/^\s*#?\s*cancelled\s+(\d+)\b/gimu, /\b(\d+)\s+cancelled\b/giu]);
  const todo = maximum([/^\s*#?\s*todo\s+(\d+)\b/gimu, /\b(\d+)\s+todo\b/giu]);
  const failed = maximum([/^\s*#?\s*fail\s+(\d+)\b/gimu, /\b(\d+)\s+failed\b/giu]);
  return { skipped: skipped + cancelled + todo, failed };
}

export function normalizeQualificationCommandResult({ status, errorCode = null, output = "", signal = null, timedOut = false, skipped = 0 }) {
  const counts = incompleteCounts(output);
  const incomplete = counts.skipped > 0 || counts.failed > 0;
  return { status: errorCode || signal || incomplete || timedOut ? 1 : status ?? 1,
    errorCode: errorCode ?? (signal ? "QUALIFICATION_COMMAND_INTERRUPTED" : incomplete ? "QUALIFICATION_COMMAND_INCOMPLETE" : null),
    timedOut, skipped: Math.max(skipped, counts.skipped), output };
}

export function executeQualificationCommand({ entry, args = [], cwd, environment = process.env, shell = false,
  heartbeat, heartbeatMs = 10_000, timeoutMs }) {
  return new Promise((resolve) => {
    const windows = process.platform === "win32";
    const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const child = spawn(entry, args, { cwd, env: environment, shell, windowsHide: true,
      detached: bounded && !windows, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let spawnError, errorCode = null, timedOut = false, stopping = false, settled = false, closed = false;
    let exitCode = null, exitSignal = null, escalation, completion, killer, killerDeadline;
    const finish = (cleanupFailed = false) => {
      if (settled) return;
      settled = true;
      for (const timer of [heartbeatTimer, timeout, escalation, completion, killerDeadline]) if (timer) clearTimeout(timer);
      // An escaped inherited writer must never hold validation/DB cleanup hostage.
      child.stdout.destroy(); child.stderr.destroy(); child.unref();
      if (killer) killer.kill();
      if (cleanupFailed) chunks.push(Buffer.from("\nQUALIFICATION_COMMAND_PROCESS_CLEANUP_FAILED\n"));
      resolve({ ...normalizeQualificationCommandResult({ status: exitCode,
        errorCode: errorCode ?? spawnError?.code ?? null, timedOut, signal: exitSignal,
        output: Buffer.concat(chunks).toString("utf8") }), ...(cleanupFailed ? { cleanupFailed: true } : {}) });
    };
    const signalGroup = (signal) => {
      if (!bounded || child.pid === undefined) return false;
      // Only this live invocation's newly created process group is addressed.
      try { process.kill(-child.pid, signal); return true; }
      catch (error) { return error.code === "ESRCH"; }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      completion = setTimeout(() => finish(!closed), 500);
      if (windows) {
        // Never look up an exited/reused parent PID. An active ChildProcess is
        // owned by this invocation; taskkill terminates its currently live tree.
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        killer = spawn(join(process.env.SystemRoot ?? "C:/Windows", "System32", "taskkill.exe"),
          ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        const fallback = () => { child.kill(); if (closed) finish(); };
        killerDeadline = setTimeout(() => { killer.kill(); fallback(); }, 300);
        killer.once("error", fallback);
        killer.once("close", () => { clearTimeout(killerDeadline); fallback(); });
      } else {
        signalGroup("SIGTERM");
        escalation = setTimeout(() => { signalGroup("SIGKILL"); if (closed) finish(); }, 100);
      }
    };
    const capture = (chunk) => { if (!settled) chunks.push(chunk); };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => { spawnError = error; });
    const heartbeatTimer = heartbeat ? setInterval(heartbeat, heartbeatMs) : null;
    const timeout = bounded ? setTimeout(() => {
      timedOut = true;
      errorCode = "ETIMEDOUT";
      stop();
    }, timeoutMs) : null;
    child.on("close", (code, signal) => {
      closed = true; exitCode = code; exitSignal = signal;
      if (!stopping) finish();
      else if (!windows) { signalGroup("SIGKILL"); finish(); }
      else if (!killer || killer.exitCode !== null) finish();
    });
  });
}

/** Execute reviewed package prerequisites through the same live-run primitive cache. */
export async function executeQualificationPackagePrerequisite({ script, root, cache, environment = process.env,
  execute = executeQualificationCommand, timeoutMs = 900_000, sanitizeOutput = (value) => String(value ?? "") }) {
  const began = performance.now();
  const invoke = async (command) => {
    const remaining = timeoutMs - (performance.now() - began);
    if (remaining <= 0) return normalizeQualificationCommandResult({ status: 1, errorCode: "ETIMEDOUT", timedOut: true });
    return normalizeQualificationCommandResult(await execute({ ...command, cwd: root, environment, timeoutMs: remaining }));
  };
  if (script === "contract:verify") {
    const { verifyQualificationContracts } = await import("./qualification-contract-verification.mjs");
    const verified = await verifyQualificationContracts({ root, cache, environment, execute: invoke, sanitizeOutput, log: () => {} });
    const constituents = verified.results.map(({ script, reused, reuseProof }) => ({ script, reused, reuseProof }));
    const reused = verified.results.every((result) => result.reused);
    return { status: verified.status, errorCode: verified.results.find((result) => result.errorCode)?.errorCode ?? null,
      timedOut: verified.results.some((result) => result.timedOut),
      skipped: verified.results.reduce((sum, result) => sum + result.skipped, 0),
      output: verified.results.map((result) => result.output).join("\n"), reused, constituents,
      reuseProof: reused ? { algorithm: "qualification-contract-prerequisites/v1", constituents } : null };
  }
  const command = environment.npm_execpath
    ? { entry: process.execPath, args: [environment.npm_execpath, "run", script] }
    : { entry: process.platform === "win32" ? "npm.cmd" : "npm", args: ["run", script], shell: process.platform === "win32" };
  return cache.runAsync({ script, args: [], entry: JSON.stringify({ entry: command.entry, args: command.args }), environment,
    invoke: () => invoke(command), sanitizeOutput });
}
