import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isolatedConfig, localEnvironment, requireDocker, requireExecutedTests } from "../../scripts/local-auth-integration.mjs";

test("missing Docker and inaccessible daemon fail with safe actionable diagnostics", () => {
  assert.throws(() => requireDocker(() => ({ error: { code: "ENOENT" } })), /LOCAL_AUTH_DOCKER_MISSING/);
  assert.throws(() => requireDocker(() => ({ status: 1, stderr: "secret-token" })), /LOCAL_AUTH_DOCKER_UNAVAILABLE/);
  requireDocker(() => ({ status: 0 }));
});
test("a skipped or empty integration suite cannot count as passing", () => {
  const passed = { success: true, numPassedTests: 1, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ status: "passed" }] };
  requireExecutedTests(passed);
  for (const change of [{ numPassedTests: 0 }, { numPendingTests: 1 }, { success: false }, { numTodoTests: 1 }, { testResults: [] }]) {
    assert.throws(() => requireExecutedTests({ ...passed, ...change }), /LOCAL_AUTH_TEST_FAILED/);
  }
});
test("isolated Auth config preserves signup restrictions and leaves source untouched", () => {
  const source = readFileSync(new URL("../../supabase/config.toml", import.meta.url), "utf8");
  const config = isolatedConfig(source, "test-auth");
  assert.match(config, /\[auth\]\s*enabled = true/);
  assert.match(config, /\[api\]\s*enabled = true/);
  assert.match(config, /port = 56321/);
  assert.match(config, /port = 56322/);
  assert.match(config, /shadow_port = 56320/);
  const dynamicallyAllocated = isolatedConfig(source, "test-auth-dynamic", { api: 54010, db: 54011, shadow: 54012 });
  assert.match(dynamicallyAllocated, /port = 54010/);
  assert.match(dynamicallyAllocated, /port = 54011/);
  assert.match(dynamicallyAllocated, /shadow_port = 54012/);
  assert.equal((config.match(/enable_signup = false/g) ?? []).length, (source.match(/enable_signup = false/g) ?? []).length);
  assert.match(config, /enable_anonymous_sign_ins = false/);
  assert.match(source, /\[auth\]\s*enabled = false/);
});
test("remote provider credentials never reach isolated CLI or tests", () => {
  assert.deepEqual(localEnvironment({ PATH: "tools", SUPABASE_ACCESS_TOKEN: "remote", PHASE4_LOCAL_AUTH_URL: "remote", DATABASE_URL: "remote", OWNER_GITHUB_SUBJECTS: "remote" }), { PATH: "tools", CI: "1" });
});
