export const CI_NATIVE_POSTGRES_MAJOR = 17;
export const SUPPORTED_NATIVE_POSTGRES_MAJORS = Object.freeze([17, 18]);

/** Media correctness transactions require PostgreSQL's transaction_timeout. */
export function requireSupportedNativePostgres(version) {
  if (!/^\d+\.\d+(?:\.\d+)?$/u.test(version ?? "") ||
      !SUPPORTED_NATIVE_POSTGRES_MAJORS.includes(Number(version.split(".")[0]))) {
    throw new Error("NATIVE_POSTGRES_VERSION_UNSUPPORTED: Select PostgreSQL 17 or 18 with PHASE7_POSTGRES_BIN; transaction_timeout is required.");
  }
  return version;
}
