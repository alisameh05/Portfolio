// Structured, safe validation failures.
//
// Every validation error carries: stage (which orchestration step), check
// (named gate/contract), cause code (stable machine code), and precise schema
// paths / difference categories. Sensitive values are redacted at
// construction; the actionable cause survives instead of collapsing into a
// generic category name. Primary failures are preserved alongside cleanup
// failures instead of being overwritten by them.

const SECRET_PATTERNS = [
  [/(\\?"(?:password|passwd|secret|token|service_role_key|anon_key|jwt_secret|supabase_access_token)\\?"\s*:\s*\\?")(?:\\.|[^"\\])*(\\?")/gi, "$1[redacted]$2"],
  [/(\b["']?(?:password|passwd|secret|token|service_role_key|anon_key|jwt_secret|supabase_access_token)["']?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s}\]]+)/gi, "$1\"[redacted]\""],
  [/postgres(?:ql)?:\/\/[^\s"']+:[^\s"']+@/gi, "postgres://[redacted]@"],
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted jwt]"],
  [/(\b(?:ANON_KEY|SERVICE_ROLE_KEY|JWT_SECRET|SUPABASE_ACCESS_TOKEN)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]"],
  [/(\b(?:anon|service_role)\s+key|jwt\s+secret|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]"],
];

function safeIdentifier(value, fallback = "unknown") {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const safe = redactSafeDetail(value).replace(/[^A-Za-z0-9_.:/|-]/g, "_").slice(0, 160);
  return safe || fallback;
}

export function redactSafeDetail(value) {
  let safe = String(value ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) safe = safe.replace(pattern, replacement);
  return safe
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[^A-Za-z0-9_.,/:=@'"+()\[\]<> -]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** Extract actionable assertion facts without serializing messages, stacks or payload diffs. */
export function safeAssertionDiagnostic(assertion) {
  const messages = (Array.isArray(assertion?.failureMessages) ? assertion.failureMessages : [])
    .filter((message) => typeof message === "string").slice(0, 3).map((message) => message.slice(0, 16_384))
    .join("\n").replace(/\x1b\[[0-9;]*m/gu, "");
  const source = messages.replaceAll("\\", "/").match(
    /\b(tests\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:test|spec)\.[cm]?[jt]sx?:[1-9]\d{0,5}:[1-9]\d{0,4})(?=\s|\)|$)/u,
  )?.[1] ?? null;
  const mismatch = messages.match(
    /^AssertionError: expected (true|false|-?\d+(?:\.\d+)?) to (?:be|equal) (true|false|-?\d+(?:\.\d+)?)(?=$| \/\/)/mu,
  );
  let comparison = null;
  if (mismatch && mismatch[1] !== mismatch[2]) {
    if ([mismatch[1], mismatch[2]].every((value) => value === "true" || value === "false")) {
      comparison = { kind: "boolean-mismatch", actual: mismatch[1] === "true", expected: mismatch[2] === "true" };
    } else if ([mismatch[1], mismatch[2]].every((value) => /^-?\d+(?:\.\d+)?$/u.test(value))) {
      // Numeric values may themselves be private payloads; retain only the mismatch category.
      comparison = { kind: "number-mismatch" };
    }
  }
  const sqlState = messages.match(/\b(?:SQLSTATE|sqlState|code)["']?\s*[:=]\s*["']?([0-9A-Z]{5})["']?(?=\s|[,}.)]|$)/u)?.[1] ?? null;
  const timeout = messages.match(/^(?:Error: )?(Test|Hook) timed out in [1-9]\d{0,8}ms\.(?=\n|$)/mu)?.[1];
  const reportedCategory = assertion?.meta?.validationFailure?.errorCategory;
  const errorCategory = timeout === "Test" ? "test-timeout" : timeout === "Hook" ? "hook-timeout" :
    ["test-timeout", "hook-timeout"].includes(reportedCategory) ? reportedCategory : null;
  const duration = assertion?.duration;
  return { source, comparison, sqlState,
    ...(errorCategory ? { errorCategory } : {}),
    ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0 && duration <= 86_400_000 ? { durationMs: Math.round(duration) } : {}) };
}

/**
 * A structured validation failure with stage/check/cause and precise paths.
 * `message` is the safe single-line form; structured fields are also exposed.
 */
export class ValidationFailure extends Error {
  constructor({ code, stage, check, categories = [], paths = [], detail, cause, cleanupFailures = [] } = {}) {
    if (typeof code !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(code)) {
      throw new TypeError("ValidationFailure requires an UPPER_SNAKE code");
    }
    const segments = [code];
    const safeSegment = (value) => typeof value === "string" && value.length > 0 ? safeIdentifier(value) : null;
    if (safeSegment(stage)) segments.push(safeIdentifier(stage));
    if (safeSegment(check)) segments.push(safeIdentifier(check));
    const safeCategories = [...new Set(categories.filter((item) => typeof item === "string").map((item) => safeIdentifier(item)))];
    const categoryText = safeCategories.join(",");
    if (categoryText) segments.push(categoryText);
    const safePaths = [...new Set(paths.filter((item) => typeof item === "string").map((item) => safeIdentifier(item)))];
    const pathText = safePaths.join("|");
    if (pathText) segments.push(pathText);
    const safeDetail = redactSafeDetail(detail);
    let safeMessage = segments.map((segment) => segment.replace(/[^A-Za-z0-9_.,/|-]/g, "_")).join(":");
    if (safeDetail) safeMessage += `:${safeDetail}`;
    super(safeMessage, cause === undefined ? undefined : { cause });
    this.name = "ValidationFailure";
    this.code = code;
    this.stage = stage === undefined ? null : safeIdentifier(stage);
    this.check = check === undefined ? null : safeIdentifier(check);
    this.categories = safeCategories;
    this.paths = safePaths;
    this.detail = safeDetail || null;
    this.causeCode = inputCauseCode(cause);
    this.cleanupFailures = cleanupFailures.map((error) => error instanceof ValidationFailure ? {
      code: error.code, stage: error.stage, check: error.check, causeCode: error.causeCode,
      categories: error.categories, paths: error.paths, detail: error.detail,
    } : {
      code: failureCode(error), stage: "cleanup", check: null, causeCode: inputCauseCode(error), categories: [], paths: [],
      detail: redactSafeDetail(error instanceof Error ? error.message : String(error)),
    });
  }

  /** Structured, secret-free representation for evidence reports. */
  toSafeJson() {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      check: this.check,
      categories: this.categories,
      paths: this.paths,
      detail: this.detail,
      causeCode: this.causeCode,
      cleanupFailures: this.cleanupFailures,
      message: this.message,
    };
  }
}

function inputCauseCode(cause) {
  if (cause && typeof cause === "object" && typeof cause.code === "string" && (/^[A-Z][A-Z0-9_]{0,79}$/.test(cause.code) || /^[A-Z0-9]{5}$/.test(cause.code))) return cause.code;
  const origin = cause instanceof Error ? cause : null;
  if (origin === null) return null;
  if (typeof origin.code === "string" && (/^[A-Z][A-Z0-9_]{0,79}$/.test(origin.code) || /^[A-Z0-9]{5}$/.test(origin.code))) return origin.code;
  if (origin instanceof ValidationFailure) return origin.code;
  return null;
}

/** Stable safe code for any thrown value, preserving the deepest cause code. */
export function failureCode(error, fallback = "VALIDATION_FAILED") {
  if (error instanceof ValidationFailure) return error.code;
  let current = error;
  while (current !== null && typeof current === "object") {
    if (typeof current.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(current.code)) return current.code;
    const message = current instanceof Error ? current.message : null;
    if (typeof message === "string") {
      const match = message.match(/^[A-Z][A-Z0-9_]+(?::[A-Za-z0-9_.,/|-]+)*/u);
      if (match !== null) return match[0].split(":")[0];
    }
    current = current.cause ?? null;
  }
  return fallback;
}

/**
 * Combines a primary failure with later cleanup failures so the primary cause
 * is never lost. Cleanup details are redacted and appended without replacing
 * the actionable primary message.
 */
export function combineWithCleanupFailures(primary, cleanupFailures) {
  const failures = cleanupFailures.filter(Boolean);
  if (failures.length === 0) return primary;
  const note = `cleanup-failures-count=${failures.length}`;
  if (primary instanceof ValidationFailure) {
    return new ValidationFailure({
      code: "PORTFOLIO_SETTINGS_CLEANUP_FAILED",
      stage: primary.stage ?? null,
      check: primary.check ?? null,
      categories: primary.categories,
      paths: primary.paths,
      detail: `primary=${primary.message} ${note}`,
      cause: primary,
      cleanupFailures: failures,
    });
  }
  return new ValidationFailure({
    code: primary?.code ?? "PORTFOLIO_SETTINGS_CLEANUP_FAILED",
    stage: "cleanup",
    detail: `primary=${redactSafeDetail(primary instanceof Error ? primary.message : String(primary))} ${note}`,
    cleanupFailures: failures,
  });
}
