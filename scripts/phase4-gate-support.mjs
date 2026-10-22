import { approvedWindowsPhase2Skip } from "./qualification-command.mjs";

export const REQUIRED_PHASE4_CHECK_NAMES = Object.freeze([
  "predecessor-phase1",
  "predecessor-phase2",
  "predecessor-phase3-source",
  "validation-ready",
  "exact-toolchain",
  "contract-verification",
  "tooling-tests",
  "typecheck",
  "lint",
  "production-build",
  "architecture",
  "route-inventory",
  "runtime-boundary",
  "runtime-architecture",
  "phase4-context",
  "phase4-focused-tests",
  "phase4-migration-integrity-tests",
  "phase4-local-auth-real-token",
  "phase4-database-integrity",
]);

/**
 * @param {string} value
 * @param {{ workspace?: string, temporary?: string, secrets?: string[] }} options
 */
export function sanitizeEvidenceOutput(value, { workspace = "", temporary = "", secrets = [] } = {}) {
  let safe = value;
  for (const [path, replacement] of [[workspace, "<WORKSPACE>"], [temporary, "<TEMP>"]]) {
    if (path) safe = safe.replaceAll(path, replacement).replaceAll(path.split("\\").join("/"), replacement);
  }
  safe = safe
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[redacted-database-url]")
    .replace(/\b(bearer)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(authorization|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key|idempotency[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/\b(github[_-]?subject|provider[_-]?(?:user[_-]?)?subject|external[_-]?subject)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/"(access_token|refresh_token|password|secret|email|rawSubject|subject|githubSubject|github_subject|github-subject|providerSubject|provider_subject|provider_user_subject|provider-user-subject|externalSubject|external_subject|external-subject|ownerId|portfolioId|sessionId|cookie|csrfToken|ownerScope|destination)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]");
  for (const secret of secrets.filter((item) => typeof item === "string" && item.length >= 6)) {
    safe = safe.replaceAll(secret, "[redacted]");
  }
  return safe;
}

export function databaseEvidenceShapeErrors(database) {
  const errors = [];
  const state = database?.normalizedDatabaseState;
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return ["normalizedDatabaseState must be an object"];
  }
  for (const collection of ["grants", "policies"]) {
    if (!Array.isArray(state[collection])) {
      errors.push(`normalizedDatabaseState.${collection} must be an array`);
      continue;
    }
    if (state[collection].some((entry) => entry === null || typeof entry !== "object" || typeof entry.schema !== "string")) {
      errors.push(`normalizedDatabaseState.${collection} contains an invalid entry`);
    }
  }
  return errors;
}

export function classifyCheckResult({
  code,
  spawnError,
  output,
  failOnSkipped = false,
  allowWindowsPhase2HelperProcessSkip = false,
  platform = process.platform,
  requiresService = null,
}) {
  const cleanOutput = output.replaceAll(/\u001B\[[0-9;]*m/g, "");
  const skippedCounts = [
    ...cleanOutput.matchAll(/\b(\d+)\s+skipped\b/gi),
    ...cleanOutput.matchAll(/\bskipped(?:\s+tests?)?\s*[:=]\s*(\d+)\b/gi),
  ].map((match) => Number(match[1]));
  const knownWindowsPhase2Skip = allowWindowsPhase2HelperProcessSkip &&
    approvedWindowsPhase2Skip(cleanOutput, { platform, phase2RuntimeSuite: true });
  const skippedOrPartial = failOnSkipped &&
    ((skippedCounts.some((count) => count > 0) && !knownWindowsPhase2Skip) || /missing.*service/i.test(cleanOutput) ||
      /\bpartial\b/i.test(cleanOutput));
  const serviceUnavailable =
    requiresService !== null &&
    /LOCAL_DB_UNAVAILABLE|LOCAL_DB_URL_MISSING|PHASE3_DATABASE_URL_REQUIRED|PORTFOLIO_SETTINGS_DOCKER_UNAVAILABLE|LOCAL_AUTH_DOCKER_UNAVAILABLE|ECONNREFUSED|failed to connect to the docker API|database.*unavailable/i.test(
      cleanOutput,
    );

  let failure = null;
  if (spawnError !== undefined) failure = "spawn-failed";
  else if (code !== 0) failure = "exit-nonzero";
  else if (skippedOrPartial) failure = "skipped-or-partial";
  else if (serviceUnavailable) failure = "required-service-unavailable";

  return {
    passed: failure === null,
    exitCode: failure === null ? 0 : 1,
    failure,
  };
}

export function evaluateGate({ checks, requiredCheckNames, evidence, runId, revision, reusableEvidence = [] }) {
  const checkNames = new Set(checks.map((check) => check.name));
  const missingChecks = requiredCheckNames.filter((name) => !checkNames.has(name));
  const duplicateChecks = checks
    .map((check) => check.name)
    .filter((name, index, names) => names.indexOf(name) !== index);
  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name);
  const staleEvidence = evidence
    .filter((item) => {
      if (item.runId === runId && item.revision === revision && item.fresh === true) return false;
      // Evidence verified against the shared qualification context: the verify
      // caller confirmed the file's current digest equals the recorded digest
      // of a predecessor that completed on this exact source and definition.
      return !reusableEvidence.some((allowed) => allowed.file === item.file && allowed.sha256 === item.sha256);
    })
    .map((item) => item.file);
  const passed =
    missingChecks.length === 0 &&
    duplicateChecks.length === 0 &&
    failedChecks.length === 0 &&
    staleEvidence.length === 0;

  return {
    verdict: passed ? "pass" : "fail",
    missingChecks,
    duplicateChecks,
    failedChecks,
    staleEvidence,
  };
}
