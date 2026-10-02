import assert from "node:assert/strict";
import test from "node:test";
import {
  isolatedConfig,
  localEnvironment,
  requireExecutedTests,
} from "../../scripts/portfolio-settings-integration.mjs";

test("the settings runner isolates Supabase ports and binds its project id", () => {
  const config = isolatedConfig(
    'project_id = "shipwithali-portfolio"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[studio]\nport = 54323\n[local_smtp]\nport = 54324\n[analytics]\nport = 54327\n[db.pooler]\nport = 54329\n',
    "shipwithali-settings-test",
  );
  assert.match(config, /project_id = "shipwithali-settings-test"/);
  assert.match(config, /port = 57321/);
  assert.match(config, /port = 57322/);
  assert.match(config, /shadow_port = 57320/);
  assert.match(config, /port = 57323/);
});

test("the settings runner removes inherited provider credentials", () => {
  const env = localEnvironment({
    PATH: "pinned",
    PHASE4_SETTINGS_DATABASE_URL: "private",
    DATABASE_URL: "private",
    SUPABASE_ACCESS_TOKEN: "private",
    OWNER_GITHUB_CLIENT_SECRET: "private",
  });
  assert.equal(env.PATH, "pinned");
  assert.equal(env.CI, "1");
  for (const key of ["PHASE4_SETTINGS_DATABASE_URL", "DATABASE_URL", "SUPABASE_ACCESS_TOKEN", "OWNER_GITHUB_CLIENT_SECRET"]) {
    assert.equal(Object.hasOwn(env, key), false);
  }
});

test("the settings runner rejects missing, partial, failed, or skipped database evidence", () => {
  const passed = {
    success: true,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{ status: "passed" }],
  };
  assert.doesNotThrow(() => requireExecutedTests(passed));
  for (const report of [
    { ...passed, numPassedTests: 0 },
    { ...passed, numFailedTests: 1 },
    { ...passed, numPendingTests: 1 },
    { ...passed, testResults: [] },
    { ...passed, testResults: [{ status: "failed" }] },
  ]) {
    assert.throws(() => requireExecutedTests(report), /PORTFOLIO_SETTINGS_TEST_FAILED/);
  }
});
