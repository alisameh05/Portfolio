import type { ReadinessCheck } from "../../src/runtime/ports.js";

/** Explicit Auth configuration for database-only assembly tests; no Auth calls are made. */
export const isolatedOwnerAuthEnvironment = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_JWT_ISSUER: "http://127.0.0.1:54321/auth/v1",
  SUPABASE_JWT_AUDIENCE: "authenticated",
  OWNER_GITHUB_SUBJECTS: "910294",
};

/** Database-only predecessor suites do not qualify Auth; #252 exercises its real probe separately. */
export const isolatedIdentityReadiness: ReadinessCheck = {
  name: "isolated-test-identity",
  async check() { return true; },
};
