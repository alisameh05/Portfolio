import type { ReadinessCheck } from "../../src/runtime/ports.js";

/** Database-only predecessor suites do not qualify Auth; #252 exercises its real probe separately. */
export const isolatedIdentityReadiness: ReadinessCheck = {
  name: "isolated-test-identity",
  async check() { return true; },
};
