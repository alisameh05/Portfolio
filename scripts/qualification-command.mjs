import { spawn } from "node:child_process";

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
  heartbeat, heartbeatMs = 10_000 }) {
  return new Promise((resolve) => {
    const child = spawn(entry, args, { cwd, env: environment, shell, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    const timer = heartbeat ? setInterval(heartbeat, heartbeatMs) : null;
    child.on("close", (code, signal) => {
      if (timer !== null) clearInterval(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve(normalizeQualificationCommandResult({ status: code, errorCode: spawnError?.code ?? null, signal, output }));
    });
  });
}
