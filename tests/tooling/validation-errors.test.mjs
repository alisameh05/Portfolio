import assert from "node:assert/strict";
import test from "node:test";
import { combineWithCleanupFailures, safeAssertionDiagnostic, ValidationFailure } from "../../scripts/validation-errors.mjs";
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

  const source = "tests/phase7/moderation-postgres.test.ts:147:29";
  const booleanFailure = safeAssertionDiagnostic({ failureMessages: [
    `AssertionError: expected false to be true // Object.is equality\n\n- Expected\n+ Received\n\n- true\n+ false\n\n ❯ D:\\private-home\\Portfolio\\${source.replaceAll("/", "\\")}\n`,
  ] });
  assert.deepEqual(booleanFailure, { source, comparison: { kind: "boolean-mismatch", actual: false, expected: true }, sqlState: null });
  assert.deepEqual(safeAssertionDiagnostic({ failureMessages: [
    "\u001b[31mAssertionError: expected true to be false // Object.is equality\u001b[39m\n",
  ] }), { source: null, comparison: { kind: "boolean-mismatch", actual: true, expected: false }, sqlState: null });
  assert.deepEqual(safeAssertionDiagnostic({ failureMessages: [
    "AssertionError: expected 123456789 to be 0 // Object.is equality\n ❯ /private/home/Portfolio/tests/phase7/moderation-postgres.test.ts:155:7\n",
  ] }), { source: "tests/phase7/moderation-postgres.test.ts:155:7", comparison: { kind: "number-mismatch" }, sqlState: null });
  const privateFailure = safeAssertionDiagnostic({ failureMessages: [
    "AssertionError: expected { paragraph: 'fixture-private-feedback', author_name: 'fixture-private-person', token: 'fixture-private-token' } to deeply equal {}\n" +
      "- Expected\n+ Received\n+ SERVICE_ROLE_KEY=fixture-private-service-key\n+ postgres://admin:fixture-private-password@localhost/db\n" +
      " ❯ /private/home/Portfolio/tests/phase7/moderation-postgres.test.ts:188:11\n" +
      "Serialized Error: { code: '42501', detail: 'fixture-private-payload' }",
  ], expected: { paragraph: "fixture-private-feedback" }, actual: "fixture-private-feedback" });
  assert.deepEqual(privateFailure, { source: "tests/phase7/moderation-postgres.test.ts:188:11", comparison: null, sqlState: "42501" });
  assert.doesNotMatch(JSON.stringify([booleanFailure, privateFailure]), /fixture-private-|private-home|private\/home|postgres:\/\/|SERVICE_ROLE_KEY/u);
  assert.deepEqual(safeAssertionDiagnostic({ failureMessages: ["password=fixture-private-password\ncode='fixture-private-token'"] }),
    { source: null, comparison: null, sqlState: null });
  assert.deepEqual(safeAssertionDiagnostic({ failureMessages: [escapedJson, jsonSecrets],
    actual: { token: "fixture-private-token" }, expected: { author: "fixture-private-person" } }),
  { source: null, comparison: null, sqlState: null });
  assert.deepEqual(safeAssertionDiagnostic({ failureMessages: ['Serialized Error: { "code": "23514", "detail": "fixture-private-payload" }'] }),
    { source: null, comparison: null, sqlState: "23514" });
  assert.deepEqual(safeAssertionDiagnostic(null), { source: null, comparison: null, sqlState: null });
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
