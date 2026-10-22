import assert from "node:assert/strict";
import test from "node:test";
import { combineWithCleanupFailures, ValidationFailure } from "../../scripts/validation-errors.mjs";
import { serializePortfolioSettingsFailure } from "../../scripts/portfolio-settings-integration.mjs";

test("structured failures sanitize metadata, paths, causes, and serialized output", () => {
  const failure = new ValidationFailure({
    code: "DATABASE_VALIDATION_FAILED",
    stage: "schema-stage password=hunter2",
    check: "policy-check",
    categories: ["policies", "token=supersecret"],
    paths: ["operations.jobs.policy jwt secret=abc123"],
    detail: "postgres://admin:credential@example.test/db password=hunter2",
    cause: Object.assign(new Error("SERVICE_ROLE_KEY=secret"), { code: "42501" }),
  });
  const output = JSON.stringify(failure.toSafeJson());
  for (const secret of ["hunter2", "credential", "supersecret", "abc123", "abc123\""]) {
    assert.equal(output.includes(secret), false);
  }
  assert.equal(failure.causeCode, "42501");
  assert.equal(failure.toSafeJson().paths.length, 1);
  const unsafeCause = new ValidationFailure({ code: "FIXTURE_FAILURE", stage: "test", cause: { code: "token=sentinel-secret" } });
  assert.equal(JSON.stringify(unsafeCause.toSafeJson()).includes("sentinel-secret"), false);
  const jsonSecrets = JSON.stringify({ password: "fixture-private-password-267", SERVICE_ROLE_KEY: "fixture-private-service-key-267",
    token: "fixture-private-token-267", nested: { "jwt_secret": "fixture-private-jwt-267" } });
  const escapedJson = JSON.stringify({ message: JSON.stringify({ token: "fixture-double-json-secret-267" }) });
  const redactedJson = new ValidationFailure({ code: "FIXTURE_FAILURE", stage: "test", detail: `${jsonSecrets} ${escapedJson}` }).toSafeJson();
  assert.doesNotMatch(JSON.stringify(redactedJson), /fixture-private-(?:password|service-key|token|jwt)-267|fixture-double-json-secret-267/u);
});

test("combined cleanup failures retain the primary cause and every cleanup cause safely", () => {
  const primary = new ValidationFailure({ code: "DATABASE_TEST_FAILED", stage: "adapter", check: "rls", detail: "assertion failed" });
  const result = combineWithCleanupFailures(primary, [
    new Error("cleanup one password=first-secret"),
    new Error("cleanup two token=second-secret"),
  ]);
  assert.ok(result instanceof ValidationFailure);
  const serialized = JSON.stringify(result.toSafeJson());
  assert.match(serialized, /DATABASE_TEST_FAILED/u);
  assert.match(serialized, /cleanup one/u);
  assert.match(serialized, /cleanup two/u);
  assert.doesNotMatch(serialized, /first-secret|second-secret/u);
  const structuredCleanup = new ValidationFailure({ code: "PORTFOLIO_SETTINGS_NETWORK_REMOVAL_FAILED", stage: "cleanup",
    check: "remove-isolated-network", cause: Object.assign(new Error("network failed SERVICE_ROLE_KEY=cleanup-secret"), { code: "ECONNREFUSED" }),
    paths: ["settings-clean"] });
  const structured = combineWithCleanupFailures(primary, [structuredCleanup]).toSafeJson().cleanupFailures[0];
  assert.deepEqual(structured, { code: "PORTFOLIO_SETTINGS_NETWORK_REMOVAL_FAILED", stage: "cleanup",
    check: "remove-isolated-network", causeCode: "ECONNREFUSED", categories: [], paths: ["settings-clean"], detail: null });
  assert.doesNotMatch(JSON.stringify(structured), /cleanup-secret/u);
  const cases = [
    { code: "PHASE3_HISTORICAL_TESTS_FAILED", stage: "phase3-historical-tests", check: "phase3-historical-suites",
      cause: Object.assign(new Error("assertion failed password=sentinel-secret"), { code: "23514" }) },
    { code: "PHASE5_CURRENT_SETTINGS_INTEGRATION_FAILED", stage: "current-settings-integration", check: "phase4-settings-suite",
      cause: Object.assign(new Error("fixture failed SERVICE_ROLE_KEY=sentinel-secret"), { code: "EXIT_1" }) },
    { code: "PORTFOLIO_SETTINGS_CURRENT_CHECKPOINT_TESTS_FAILED", stage: "current-checkpoint-tests", check: "current-checkpoint-suites",
      cause: Object.assign(new Error("migration assertion failed token=sentinel-secret"), { code: "EXIT_1" }) },
    { code: "PORTFOLIO_SETTINGS_TYPE_GENERATION_FAILED", stage: "database-type-codegen", check: "kysely-codegen",
      cause: Object.assign(new Error("database URL postgres://user:sentinel-secret@localhost/db"), { code: "EXIT_1" }) },
    { code: "DOCKER_ENGINE_UNAVAILABLE", stage: "project-health", check: "docker-engine-access",
      cause: Object.assign(new Error("ECONNREFUSED SERVICE_ROLE_KEY=sentinel-secret"), { code: "ECONNREFUSED" }) },
  ];
  for (const fixture of cases) {
    const serialized = serializePortfolioSettingsFailure(new ValidationFailure({ ...fixture, detail: "failed assertion token=sentinel-secret" }));
    const parsed = JSON.parse(serialized);
    assert.equal(parsed.code, fixture.code);
    assert.equal(parsed.stage, fixture.stage);
    assert.equal(parsed.check, fixture.check);
    assert.ok(parsed.causeCode);
    assert.doesNotMatch(serialized, /sentinel-secret/u);
  }
});
