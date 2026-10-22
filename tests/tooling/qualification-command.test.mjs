import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { executeQualificationCommand } from "../../scripts/qualification-command.mjs";
import { createQualificationPrerequisiteCache } from "../../scripts/qualification-prerequisite-cache.mjs";
import { verifyQualificationContracts } from "../../scripts/qualification-contract-verification.mjs";

test("qualification command rejects real TAP skips before returning a cacheable result", async () => {
  const directory = mkdtempSync(join(tmpdir(), "qualification-command-"));
  try {
    const fixture = join(directory, "fixture.test.mjs");
    writeFileSync(fixture, 'import test from "node:test"; test.skip("required fixture", () => {});\n');
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = await executeQualificationCommand({ entry: process.execPath,
      args: ["--test", "--test-reporter=tap", fixture], cwd: directory, environment });
    assert.match(result.output, /# skipped 1/u);
    assert.equal(result.status, 1);
    assert.equal(result.skipped, 1);
    assert.equal(result.errorCode, "QUALIFICATION_COMMAND_INCOMPLETE");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("compound contract verification reuses the actual earlier drift and compatibility executions", async () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-contracts-"));
  try {
    const runtime = { node: process.versions.node, npm: "11.19.0", platform: process.platform, architecture: process.arch };
    const sourceRevision = "a".repeat(40), sourceTreeSha256 = "b".repeat(64), definitionHash = "c".repeat(64);
    const contextPath = join(root, "context.json"), runId = "12345678-1234-4234-8234-123456789abc";
    const environment = { CI: "1", npm_execpath: "fixture-npm-cli.js", PHASE8_QUALIFICATION_CONTEXT: contextPath,
      PHASE8_ACTIVE_RUN_ID: runId, PHASE8_DEFINITION_HASH: definitionHash };
    writeFileSync(contextPath, JSON.stringify({ algorithm: "phase8-qualification-run/v1", runId, definitionHash,
      status: "running", identity: { revision: sourceRevision, sourceTreeSha256, runtime } }));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
      "contract:generate": "npm run contract:lint && node scripts/generate-contract-artifacts.mjs",
    } }));
    writeFileSync(join(root, "package-lock.json"), "locked");
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "node_modules/.shipwithali-validation.json"), "stamp");
    for (const directory of ["openapi/generated", "src/contracts/http/v1/generated", "src/contracts/http/owner/v1/generated"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    for (const name of ["public-v1", "owner-v1"]) writeFileSync(join(root, `openapi/generated/${name}.json`), "{}");
    const cache = createQualificationPrerequisiteCache({ root, sourceRevision, sourceTreeSha256, runtime, environment });
    const executions = { generation: 0, drift: 0, compatibility: 0 };
    for (const [name, key] of [["check-contract-drift", "drift"], ["check-contract-compatibility", "compatibility"]]) {
      cache.run({ script: `direct:${name}.mjs`, args: [], environment,
        entry: JSON.stringify({ entry: process.execPath, args: [join(root, `scripts/${name}.mjs`)] }),
        invoke: () => { executions[key]++; return { status: 0, output: "earlier phase proof" }; } });
    }
    const execute = async ({ args }) => {
      if (args.includes("contract:generate")) executions.generation++;
      else if (args[0].endsWith("check-contract-drift.mjs")) executions.drift++;
      else executions.compatibility++;
      return { status: 0, errorCode: null, timedOut: false, skipped: 0, output: "passed" };
    };
    for (let phase = 0; phase < 2; phase++) {
      const result = await verifyQualificationContracts({ root, cache, environment, execute, log: () => {} });
      assert.equal(result.status, 0);
      assert.equal(result.results[1].reused, true);
      assert.equal(result.results[2].reused, true);
    }
    assert.deepEqual(executions, { generation: 1, drift: 1, compatibility: 1 });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("qualification command rejects Vitest skips and cancelled or todo TAP outcomes", async () => {
  const timeout = await executeQualificationCommand({ entry: process.execPath,
    args: ["--input-type=module", "-e", "setTimeout(() => {}, 500)"], timeoutMs: 20 });
  assert.equal(timeout.status, 1);
  assert.equal(timeout.timedOut, true);
  assert.equal(timeout.errorCode, "ETIMEDOUT");
  for (const output of ["Tests 2 passed | 1 skipped (3)", "# cancelled 1", "# todo 1", "# fail 1"]) {
    const result = await executeQualificationCommand({ entry: process.execPath,
      args: ["--input-type=module", "-e", `process.stdout.write(${JSON.stringify(output)})`] });
    assert.equal(result.status, 1, output);
    assert.equal(result.errorCode, "QUALIFICATION_COMMAND_INCOMPLETE");
  }
  const success = await executeQualificationCommand({ entry: process.execPath,
    args: ["--input-type=module", "-e", 'console.log("# pass 1\\n# fail 0\\n# cancelled 0\\n# skipped 0\\n# todo 0")'] });
  assert.equal(success.status, 0);
  assert.equal(success.skipped, 0);
  assert.equal(success.errorCode, null);
});
