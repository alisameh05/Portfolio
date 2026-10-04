#!/usr/bin/env node
/**
 * phase-context.mjs — shared phase definitions, extended by Phase 4 #78 and Phase 5 #107.
 *
 * Historical Phase 2 fake-only and Phase 3 infrastructure-only restrictions
 * remain enforceable against their original fixtures and baselines. The
 * current activation policy is phase-specific: Phase 4 permits Identity and
 * Access plus Portfolio Configuration; Phase 5 permits Content and Publishing
 * plus Taxonomy and Discovery.
 *
 * No database, network, credentials, or running application required.
 * Pure definition module; deterministic and side-effect free on import.
 */

export const PHASES = Object.freeze({
  PHASE2: "phase2",
  PHASE3: "phase3",
  PHASE4: "phase4",
  PHASE5: "phase5",
});

export const HISTORICAL_RESTRICTIONS = Object.freeze({
  phase2: "fake-only runtime: production composition fails closed, deterministic fakes only",
  phase3: "infrastructure-only database: operations ledger/outbox/jobs primitives only, no business tables",
});

export const PHASE2_ALLOWED = Object.freeze(["fakes", "fail-closed-production"]);
export const PHASE3_ALLOWED = Object.freeze(["operations-infra", "fail-closed-business"]);
export const PHASE4_ALLOWED_ACTIVATION = Object.freeze([
  "identity-access",
  "portfolio-configuration",
]);
export const PHASE5_ALLOWED_ACTIVATION = Object.freeze([
  "content-and-publishing",
  "taxonomy-and-discovery",
]);

export const EXPECTED_PUBLIC_OPERATIONS = 5;
export const EXPECTED_OWNER_OPERATIONS = 39;

/**
 * Phase 4 negative fixtures. Each entry must be rejected by the
 * corresponding rule in check-phase4-context.mjs. Paths are repository
 * relative. Existing Phase 1 invalid-deps fixtures remain authoritative for
 * their four rules; the entries below extend coverage to Phase 4 concerns
 * without weakening those historical fixtures.
 */
export const PHASE4_NEGATIVE_FIXTURES = Object.freeze([
  {
    name: "phase4-provider-leakage",
    path: "tests/fixtures/invalid-deps/phase4-provider-leakage/modules/acme/application/leaky.ts",
    expectedRule: "no-provider-in-application",
  },
  {
    name: "phase4-generated-leakage",
    path: "tests/fixtures/invalid-deps/phase4-generated-leakage/modules/acme/application/leaky.ts",
    expectedRule: "no-generated-code-leakage",
  },
  {
    name: "phase4-uncontracted-route",
    path: "tests/fixtures/invalid-deps/phase4-uncontracted-route/route.ts",
    expectedRule: "uncontracted-route-handler",
  },
  {
    name: "phase4-cross-module-write",
    path: "tests/fixtures/invalid-deps/phase4-cross-module-write/modules/consumer/application/writer.ts",
    expectedRule: "cross-module-write-no-foreign-adapters",
  },
  {
    name: "phase4-frontend-lab-surface",
    path: "tests/fixtures/invalid-deps/phase4-frontend-lab-surface/component.tsx",
    expectedRule: "frontend-browser-lab-surface",
  },
  {
    name: "phase4-later-phase-activation",
    path: "tests/fixtures/invalid-deps/phase4-later-phase-activation/modules/acme/application/activation.ts",
    expectedRule: "later-phase-activation-placeholder-bypass",
  },
]);

/** Original Phase 1 invalid fixtures that must keep passing. */
export const HISTORICAL_INVALID_FIXTURES = Object.freeze([
  { name: "provider-leakage", path: "tests/fixtures/invalid-deps/provider-leakage", expectedRule: "no-provider-in-domain" },
  { name: "generated-code-leakage", path: "tests/fixtures/invalid-deps/generated-code-leakage", expectedRule: "no-generated-code-leakage" },
  { name: "deep-cross-module-import", path: "tests/fixtures/invalid-deps/deep-cross-module-import", expectedRule: "no-deep-cross-module-import" },
  { name: "cycle", path: "tests/fixtures/invalid-deps/cycle", expectedRule: "no-cycles" },
]);

/**
 * Production files currently carrying the deterministic Phase 2 placeholder
 * Owner actor. Prefactor records exactly nine owner HTTP adapters. Tickets
 * #80/#81 remove production placeholder construction; at that point this
 * expectation flips to zero and any remaining placeholder becomes a required
 * failure. Test fakes under src/runtime/fakes/ and tests/ are explicitly
 * excluded from this production scan.
 */
export const EXPECTED_PLACEHOLDER_PRODUCTION_FILES = Object.freeze([]);

export function allowedActivationsFor(phase) {
  switch (phase) {
    case PHASES.PHASE2:
      return [...PHASE2_ALLOWED];
    case PHASES.PHASE3:
      return [...PHASE3_ALLOWED];
    case PHASES.PHASE4:
      return [...PHASE4_ALLOWED_ACTIVATION];
    case PHASES.PHASE5:
      return [...PHASE5_ALLOWED_ACTIVATION];
    default:
      throw new Error(`UNKNOWN_PHASE_${String(phase)}`);
  }
}

export function getPhaseContext(env = process.env) {
  const raw = env["SHIPWITHALI_PHASE"];
  if (raw === undefined || raw === "") return PHASES.PHASE4;
  if (raw === PHASES.PHASE2 || raw === PHASES.PHASE3 || raw === PHASES.PHASE4 || raw === PHASES.PHASE5) return raw;
  throw new Error(`INVALID_PHASE_${String(raw)}`);
}

export function isHistoricalFixture(path) {
  const normalized = String(path).split("\\").join("/");
  return HISTORICAL_INVALID_FIXTURES.some((fixture) => normalized.startsWith(fixture.path));
}
