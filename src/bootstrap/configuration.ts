/**
 * configuration.ts — Phase 2 #25 active runtime configuration.
 *
 * The active Phase 2 runtime requires only NODE_ENV and APP_BASE_URL.
 * Database-enabled application or worker composition additionally validates
 * DATABASE_URL through the composition root; the migration-only
 * DATABASE_DIRECT_URL is accepted solely by migration, generation, and
 * backup tooling and is never read here. Remaining Supabase, Auth, storage,
 * deployment, and testing secrets stay documented placeholders in
 * `.env.example` and are neither read nor required here.
 *
 * Rules:
 * - Validation runs only when `createRuntimeConfig` is called from the
 *   composition root. Importing this module never reads the environment.
 * - This module never reads `process.env` directly; the caller forwards an
 *   explicit env record once during bootstrap.
 * - Diagnostics name the variable and the violated rule but never the value.
 */

export type RuntimeEnvironment = "development" | "test" | "production";

export interface RuntimeConfig {
  readonly nodeEnv: RuntimeEnvironment;
  readonly appBaseUrl: string;
}

export type DatabaseRuntimeKind = "application" | "worker";

/** Explicit env record forwarded once by the composition root. */
export type RuntimeConfigEnv = Record<string, string | undefined>;

const RUNTIME_ENVIRONMENTS: readonly RuntimeEnvironment[] = [
  "development",
  "test",
  "production",
];

export class RuntimeConfigError extends Error {
  readonly variable: string;
  readonly rule: string;

  constructor(variable: string, rule: string) {
    super(`Invalid runtime configuration: ${variable} ${rule}.`);
    this.name = "RuntimeConfigError";
    this.variable = variable;
    this.rule = rule;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  // Strip brackets that URL may preserve for IPv6 literals.
  const bare = normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}

function parseNodeEnv(raw: string | undefined): RuntimeEnvironment {
  if (raw === undefined || raw.trim() === "") {
    throw new RuntimeConfigError("NODE_ENV", "is required");
  }
  if ((RUNTIME_ENVIRONMENTS as readonly string[]).includes(raw)) {
    return raw as RuntimeEnvironment;
  }
  throw new RuntimeConfigError(
    "NODE_ENV",
    "must be one of development, test, or production",
  );
}

function parseAppBaseUrl(raw: string | undefined, nodeEnv: RuntimeEnvironment): string {
  if (raw === undefined || raw.trim() === "") {
    throw new RuntimeConfigError("APP_BASE_URL", "is required");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RuntimeConfigError("APP_BASE_URL", "must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RuntimeConfigError("APP_BASE_URL", "must use HTTP or HTTPS");
  }
  if (nodeEnv === "production" && url.protocol !== "https:") {
    // Explicit loopback test context: plain HTTP is permitted only for
    // loopback hosts so local production-mode smoke tests can run.
    if (!isLoopbackHostname(url.hostname)) {
      throw new RuntimeConfigError(
        "APP_BASE_URL",
        "must use HTTPS in production except for a loopback test context",
      );
    }
  }
  return raw;
}

/**
 * Parse and freeze the active runtime configuration once.
 *
 * Unknown extra keys (including documented future placeholders) are ignored:
 * they are neither read nor required in Phase 2.
 */
export function createRuntimeConfig(env: RuntimeConfigEnv): RuntimeConfig {
  const nodeEnv = parseNodeEnv(env["NODE_ENV"]);
  const appBaseUrl = parseAppBaseUrl(env["APP_BASE_URL"], nodeEnv);
  return Object.freeze({ nodeEnv, appBaseUrl });
}
