import assert from "node:assert/strict";
import test from "node:test";
import { rmSync } from "node:fs";
import { isLocalValidationProjectId } from "../../scripts/local-docker-loopback-adapter.mjs";
import {
  createProject,
  isolatedConfig,
  localEnvironment,
  requireExecutedTests,
  requirePredecessorTests,
  planCurrentCheckpointTests,
  requestedDatabaseTestFiles,
} from "../../scripts/portfolio-settings-integration.mjs";
import { migrationsAfterPhase5, phase4ReleaseMigrationFiles } from "../../scripts/phase4-migration-integrity.mjs";
import { PHASE_DATABASE_CHECKPOINTS } from "../../scripts/phase-contract-registry.mjs";

for (const ticket of [122, 123]) {
  test(`ticket ${ticket} executes every current checkpoint and required final suite exactly once`, () => {
    const currentFiles = PHASE_DATABASE_CHECKPOINTS.find((checkpoint) => checkpoint.id === "current")
      .suites.map((suite) => suite.file);
    const finalFiles = requestedDatabaseTestFiles({
      ticket122: ticket === 122, ticket123: ticket === 123, contentAuthoringTicket: true,
    });
    assert.equal(finalFiles.length, ticket === 122 ? 10 : 7);
    assert.ok(finalFiles.some((file) => !currentFiles.includes(file)), "the mode requires additional suites");
    const plan = planCurrentCheckpointTests(currentFiles, finalFiles);
    assert.deepEqual(plan.auditFiles, currentFiles.filter((file) => !finalFiles.includes(file)));
    assert.deepEqual(plan.finalFiles, finalFiles);
    const executions = [...plan.auditFiles, ...plan.finalFiles];
    const expected = [...new Set([...currentFiles, ...finalFiles])];
    assert.deepEqual(plan.completeInventory, expected);
    assert.deepEqual([...executions].sort(), [...expected].sort());
    assert.equal(new Set(executions).size, executions.length);
  });
}

test("checkpoint planning preserves default and content-authoring final suites without reruns", () => {
  const currentFiles = PHASE_DATABASE_CHECKPOINTS.find((checkpoint) => checkpoint.id === "current")
    .suites.map((suite) => suite.file);
  for (const contentAuthoringTicket of [false, true]) {
    const finalFiles = requestedDatabaseTestFiles({ contentAuthoringTicket });
    const plan = planCurrentCheckpointTests(currentFiles, finalFiles);
    assert.deepEqual(plan.finalFiles, finalFiles);
    assert.deepEqual(plan.completeInventory, currentFiles);
    assert.deepEqual([...plan.auditFiles, ...plan.finalFiles].sort(), [...currentFiles].sort());
  }
});

test("checkpoint planning rejects duplicate inventories and invalid suite paths", () => {
  const currentFiles = ["tests/database/role-rls-matrix.test.ts", "tests/database/portfolio-settings.integration.test.ts"];
  const finalFiles = [currentFiles[1]];
  const invalidInventories = [
    [null, finalFiles],
    [currentFiles, null],
    [[...currentFiles, currentFiles[0]], finalFiles],
    [currentFiles, [...finalFiles, finalFiles[0]]],
  ];
  for (const invalid of [undefined, null, 1, {}, "", "../tests/database/role-rls-matrix.test.ts",
    "tests/database/../database/role-rls-matrix.test.ts", "tests\\database\\role-rls-matrix.test.ts",
    "/tests/database/role-rls-matrix.test.ts", "package.json", "tests/other.test.ts"]) {
    invalidInventories.push([[...currentFiles, invalid], finalFiles], [currentFiles, [invalid]]);
  }
  for (const [checkpoint, final] of invalidInventories) {
    assert.throws(() => planCurrentCheckpointTests(checkpoint, final), /INVENTORY_PARTITION_INVALID/u);
  }
});

test("settings project identities fit the CLI's 40-character container identity limit", () => {
  for (const kind of ["clean", "upgrade"]) {
    const project = createProject(`settings-${kind}`, 57320, []);
    try {
      assert.ok(project.projectId.length <= 40, `${kind} identity is truncated by the CLI`);
      assert.ok(isLocalValidationProjectId(project.projectId));
    } finally { rmSync(project.workdir, { recursive: true, force: true }); }
  }
});

test("Phase 5 upgrade history applies Phase 4, Phase 5, then dependent later migrations", () => {
  const files = [
    "20260922170000_prepare_migration_capability.sql",
    "20261002150000_allow_versioned_portfolio_cta_updates.sql",
    "20261005001318_create_content_authoring.sql",
    "20261009100000_index_project_discovery_reads.sql",
    "20261010100000_create_private_media_upload_intents.sql",
    "20261012020000_index_current_visible_media_references.sql",
  ];

  assert.deepEqual(phase4ReleaseMigrationFiles(files), files.slice(0, 2));
  assert.deepEqual(migrationsAfterPhase5(files), files.slice(4));
});

test("the settings runner isolates both Supabase projects to distinct loopback port ranges", () => {
  const source = 'project_id = "shipwithali-portfolio"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n[studio]\nport = 54323\n[local_smtp]\nport = 54324\n[analytics]\nport = 54327\n[db.pooler]\nport = 54329\n';
  const config = isolatedConfig(source, "shipwithali-settings-test");
  assert.match(config, /project_id = "shipwithali-settings-test"/);
  assert.match(config, /port = 57321/);
  assert.match(config, /port = 57322/);
  assert.match(config, /shadow_port = 57320/);
  assert.match(config, /port = 57323/);
  const upgradeConfig = isolatedConfig(source, "shipwithali-upgrade-test", 57340);
  assert.match(upgradeConfig, /project_id = "shipwithali-upgrade-test"/);
  assert.match(upgradeConfig, /port = 57340/);
  assert.match(upgradeConfig, /port = 57342/);
  assert.match(upgradeConfig, /shadow_port = 57340/);
  assert.notEqual(config, upgradeConfig);
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

test("Phase 3 predecessor evidence requires every historical suite to pass without skips", () => {
  const files = ["transaction.test.ts", "rls.test.ts"];
  const passed = {
    success: true,
    numPassedTests: 8,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: [{ status: "passed" }, { status: "passed" }],
  };
  assert.equal(requirePredecessorTests(passed, files), 8);
  const currentFiles = ["tests/database/role-rls-matrix.test.ts", "tests/database/portfolio-settings.integration.test.ts",
    "tests/database/content-authoring.integration.test.ts"];
  const plan = planCurrentCheckpointTests(currentFiles, [currentFiles[1]]);
  assert.deepEqual(plan.auditFiles, [currentFiles[0], currentFiles[2]]);
  assert.deepEqual(plan.completeInventory, currentFiles);
  assert.throws(() => planCurrentCheckpointTests(currentFiles, ["tests/other.test.ts"]), /INVENTORY_PARTITION_INVALID/u);
  for (const report of [
    { ...passed, numPendingTests: 1 },
    { ...passed, testResults: [{ status: "passed" }] },
    { ...passed, testResults: [{ status: "passed" }, { status: "failed" }] },
  ]) {
    assert.throws(() => requirePredecessorTests(report, files), /PORTFOLIO_SETTINGS_PHASE3_PREDECESSOR_TESTS_FAILED/);
  }
});
