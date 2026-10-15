export interface PseudonymousConfigEnv {
  readonly [key: string]: string | undefined;
}

export interface PseudonymousKey {
  readonly version: number;
  /** Canonical base64url encoding of exactly 32 random secret bytes. */
  readonly secret: string;
}

export interface PseudonymousKeyring {
  readonly active: PseudonymousKey;
  /** At most two older keys; keep only while their bounded tokens can remain valid. */
  readonly previous: readonly PseudonymousKey[];
}

export interface PseudonymousIdentityConfig {
  readonly functional: PseudonymousKeyring;
  readonly measurement: PseudonymousKeyring;
}

export class PseudonymousIdentityConfigError extends Error {
  readonly variable: string;
  readonly rule: string;

  constructor(variable: string, rule: string) {
    super(`Invalid pseudonymous identity configuration: ${variable} ${rule}.`);
    this.name = "PseudonymousIdentityConfigError";
    this.variable = variable;
    this.rule = rule;
  }
}

function positiveVersion(raw: string | undefined, variable: string): number {
  if (raw === undefined || !/^[1-9]\d{0,4}$/.test(raw)) {
    throw new PseudonymousIdentityConfigError(variable, "must be an integer from 1 to 65535");
  }
  const version = Number(raw);
  if (version > 65535) {
    throw new PseudonymousIdentityConfigError(variable, "must be an integer from 1 to 65535");
  }
  return version;
}

function validateSecret(raw: string, variable: string): string {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(raw, "base64url");
  } catch {
    throw new PseudonymousIdentityConfigError(variable, "must be canonical base64url");
  }
  if (bytes.length !== 32 || bytes.toString("base64url") !== raw) {
    throw new PseudonymousIdentityConfigError(variable, "must encode exactly 32 random bytes as canonical base64url");
  }
  return raw;
}

function parseKeyring(
  env: PseudonymousConfigEnv,
  prefix: "FUNCTIONAL_ID" | "MEASUREMENT_ID",
): PseudonymousKeyring {
  const keyName = `${prefix}_HASH_KEY`;
  const versionName = `${prefix}_HASH_KEY_VERSION`;
  const previousName = `${prefix}_HASH_PREVIOUS_KEYS`;
  const rawActive = env[keyName];
  if (rawActive === undefined || rawActive.trim() === "") {
    throw new PseudonymousIdentityConfigError(keyName, "is required");
  }
  const active = Object.freeze({
    version: positiveVersion(env[versionName], versionName),
    secret: validateSecret(rawActive.trim(), keyName),
  });
  const rawPrevious = env[previousName]?.trim() ?? "";
  const previous: PseudonymousKey[] = [];
  if (rawPrevious !== "") {
    const entries = rawPrevious.split(",");
    if (entries.length > 2) {
      throw new PseudonymousIdentityConfigError(previousName, "may contain at most two previous keys");
    }
    const seenVersions = new Set([active.version]);
    for (const entry of entries) {
      const match = /^(\d{1,5}):([A-Za-z0-9_-]+)$/.exec(entry.trim());
      if (match === null) {
        throw new PseudonymousIdentityConfigError(previousName, "must use version:base64url entries");
      }
      const version = positiveVersion(match[1], previousName);
      if (version >= active.version || seenVersions.has(version)) {
        throw new PseudonymousIdentityConfigError(previousName, "must use unique versions older than the active key");
      }
      const secret = match[2];
      if (secret === undefined) {
        throw new PseudonymousIdentityConfigError(previousName, "must use version:base64url entries");
      }
      seenVersions.add(version);
      previous.push(Object.freeze({
        version,
        secret: validateSecret(secret, previousName),
      }));
    }
  }
  const keyMaterial = new Set([active.secret]);
  for (const key of previous) {
    if (keyMaterial.has(key.secret)) {
      throw new PseudonymousIdentityConfigError(previousName, "must not reuse key material across versions");
    }
    keyMaterial.add(key.secret);
  }
  return Object.freeze({ active, previous: Object.freeze(previous) });
}

/** Parse versioned purpose-specific keys without reading ambient environment or exposing values in errors. */
export function createFunctionalPseudonymousIdentityConfig(env: PseudonymousConfigEnv): Pick<PseudonymousIdentityConfig, "functional"> {
  const functional = parseKeyring(env, "FUNCTIONAL_ID");
  // Optional Measurement configuration cannot prevent functional use. When
  // configured, reject overlapping purpose material without requiring it.
  const measurementSecrets = [env["MEASUREMENT_ID_HASH_KEY"]?.trim(),
    ...(env["MEASUREMENT_ID_HASH_PREVIOUS_KEYS"]?.split(",").map(entry => entry.trim().split(":")[1]) ?? [])];
  if ([functional.active, ...functional.previous].some(key => measurementSecrets.includes(key.secret))) {
    throw new PseudonymousIdentityConfigError("FUNCTIONAL_ID_HASH_KEY/MEASUREMENT_ID_HASH_KEY", "must use distinct purpose-specific secrets");
  }
  return Object.freeze({ functional });
}

/** Complete two-purpose configuration for callers activating both identities. */
export function createPseudonymousIdentityConfig(
  env: PseudonymousConfigEnv,
): PseudonymousIdentityConfig {
  const functional = parseKeyring(env, "FUNCTIONAL_ID");
  const measurement = parseKeyring(env, "MEASUREMENT_ID");
  const functionalSecrets = [functional.active, ...functional.previous].map((key) => key.secret);
  const measurementSecrets = [measurement.active, ...measurement.previous].map((key) => key.secret);
  if (functionalSecrets.some((secret) => measurementSecrets.includes(secret))) {
    throw new PseudonymousIdentityConfigError(
      "FUNCTIONAL_ID_HASH_KEY/MEASUREMENT_ID_HASH_KEY",
      "must use distinct purpose-specific secrets",
    );
  }
  return Object.freeze({ functional, measurement });
}
