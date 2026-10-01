/**
 * auth-config.ts — Phase 4 #80 Owner Auth configuration.
 *
 * Activates only the needed provider endpoint, public capability, and
 * allowlist inputs: SUPABASE_URL, SUPABASE_JWT_ISSUER, SUPABASE_JWT_AUDIENCE,
 * and OWNER_GITHUB_SUBJECTS. Provisioning-only privileged credentials and
 * OAuth secrets (for example GITHUB_OAUTH_CLIENT_SECRET) are never read here;
 * they are injected only into the provider consumer that performs live
 * provisioning or JWKS fetches.
 *
 * Rules:
 * - Validation runs only when `createOwnerAuthConfig` is called with an
 *   explicit env record. Importing this module never reads the ambient
 *   environment.
 * - This module never reads the ambient environment directly.
 * - Diagnostics name the variable and violated rule but never the value, so
 *   redaction tests can assert secret-like values never appear in messages.
 */

export interface OwnerAuthConfigEnv {
  readonly [key: string]: string | undefined;
}

export interface OwnerAuthConfig {
  readonly supabaseUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly ownerAllowlist: readonly string[];
}

export class OwnerAuthConfigError extends Error {
  readonly variable: string;
  readonly rule: string;

  constructor(variable: string, rule: string) {
    super(`Invalid Owner Auth configuration: ${variable} ${rule}.`);
    this.name = "OwnerAuthConfigError";
    this.variable = variable;
    this.rule = rule;
  }
}

function parseSupabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new OwnerAuthConfigError("SUPABASE_URL", "is required");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OwnerAuthConfigError("SUPABASE_URL", "must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OwnerAuthConfigError("SUPABASE_URL", "must use HTTP or HTTPS");
  }
  return raw.trim();
}

function parseRequiredText(
  raw: string | undefined,
  variable: string,
): string {
  if (raw === undefined || raw.trim() === "") {
    throw new OwnerAuthConfigError(variable, "is required");
  }
  return raw.trim();
}

const ALLOWLIST_ENTRY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function parseOwnerAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") {
    throw new OwnerAuthConfigError("OWNER_GITHUB_SUBJECTS", "is required");
  }
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new OwnerAuthConfigError(
      "OWNER_GITHUB_SUBJECTS",
      "must list at least one immutable GitHub subject",
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    // Immutable subjects only: never mutable username/email, user-editable
    // metadata, or caller-supplied Owner IDs. Email forms and whitespace are
    // rejected without echoing the value.
    if (!ALLOWLIST_ENTRY.test(entry) || entry.includes("@")) {
      throw new OwnerAuthConfigError(
        "OWNER_GITHUB_SUBJECTS",
        "must contain only immutable subject identifiers",
      );
    }
    if (seen.has(entry)) {
      throw new OwnerAuthConfigError(
        "OWNER_GITHUB_SUBJECTS",
        "must not contain duplicate subjects",
      );
    }
    seen.add(entry);
  }
  return Object.freeze([...seen]);
}

/**
 * Parse and freeze Owner Auth configuration once from an explicit env record.
 */
export function createOwnerAuthConfig(env: OwnerAuthConfigEnv): OwnerAuthConfig {
  const supabaseUrl = parseSupabaseUrl(env["SUPABASE_URL"]);
  const issuer = parseRequiredText(env["SUPABASE_JWT_ISSUER"], "SUPABASE_JWT_ISSUER");
  const audience = parseRequiredText(
    env["SUPABASE_JWT_AUDIENCE"],
    "SUPABASE_JWT_AUDIENCE",
  );
  const ownerAllowlist = parseOwnerAllowlist(env["OWNER_GITHUB_SUBJECTS"]);
  return Object.freeze({ supabaseUrl, issuer, audience, ownerAllowlist });
}
