import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createQualificationPrerequisiteCache } from "../../scripts/qualification-prerequisite-cache.mjs";
import { executeQualificationPackagePrerequisite } from "../../scripts/qualification-command.mjs";
import { runIntegrationPackagePrerequisites } from "../../scripts/phase7-integration-208.mjs";

test("gate and nested npm integration share each equivalent prerequisite primitive with complete proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "qualification-integration-"));
  try {
    const scripts = ["lint", "contract:verify", "typecheck", "test:arch", "route:inventory", "runtime:architecture", "runtime:boundary", "build"];
    const packageScripts = {
      lint: "eslint .", "contract:verify": "npm run contract:generate && npm run contract:drift && npm run contract:compatibility",
      "contract:generate": "npm run contract:lint && node scripts/generate-contract-artifacts.mjs",
      typecheck: "tsc --noEmit", "test:arch": "node scripts/architecture-check.mjs", "route:inventory": "node scripts/check-route-inventory.mjs",
      "runtime:architecture": "node scripts/check-runtime-architecture.mjs", "runtime:boundary": "node scripts/check-runtime-boundary.mjs", build: "next build",
      "gate-environment": "node capture-environment.cjs gate", "integrated-environment": "node capture-environment.cjs integrated",
    };
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "qualification-fixture", version: "1.0.0", scripts: packageScripts }));
    writeFileSync(join(root, "package-lock.json"), "locked");
    for (const directory of ["node_modules", "evidence", "openapi/generated", "src/contracts/http/v1/generated", "src/contracts/http/owner/v1/generated", ".next/server", ".next/static"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    for (const artifact of ["node_modules/.shipwithali-validation.json", "openapi/generated/public-v1.json", "openapi/generated/owner-v1.json",
      "evidence/phase-1-route-inventory.json", "evidence/phase-2-runtime-architecture.json", "evidence/phase-2-runtime-boundary.json",
      ".next/BUILD_ID", ".next/required-server-files.json", ".next/server/app.js", ".next/static/chunk.js"]) {
      writeFileSync(join(root, artifact), "fixture artifact");
    }
    const runtime = { node: process.versions.node, npm: "11.19.0", platform: process.platform, architecture: process.arch };
    const sourceRevision = "a".repeat(40), sourceTreeSha256 = "b".repeat(64), definitionHash = "c".repeat(64);
    const contextPath = join(root, "context.json"), runId = "12345678-1234-4234-8234-123456789abc";
    writeFileSync(contextPath, JSON.stringify({ algorithm: "phase8-qualification-run/v1", runId, definitionHash,
      status: "running", identity: { revision: sourceRevision, sourceTreeSha256, runtime } }));
    writeFileSync(join(root, "capture-environment.cjs"), `const { writeFileSync } = require('node:fs');
writeFileSync(process.argv[2] + '-environment.json', JSON.stringify(process.env));
if (process.argv[2] === 'gate') require('node:child_process').execFileSync(process.execPath,
  [process.env.npm_execpath, 'run', 'integrated-environment', '--silent'], { env: process.env, stdio: 'pipe' });
`);
    const npm = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
    execFileSync(process.execPath, [npm, "run", "gate-environment", "--silent"], { cwd: root, stdio: "pipe",
      env: { ...process.env, CI: "1", SHIPWITHALI_PHASE: "phase7", PHASE7_GATE_RUN_ID: "fixture-gate",
        PHASE8_QUALIFICATION_CONTEXT: contextPath, PHASE8_ACTIVE_RUN_ID: runId, PHASE8_DEFINITION_HASH: definitionHash } });
    const gate = JSON.parse(readFileSync(join(root, "gate-environment.json"), "utf8"));
    const integrated = JSON.parse(readFileSync(join(root, "integrated-environment.json"), "utf8"));
    const pathKey = Object.keys(gate).find((key) => key.toUpperCase() === "PATH");
    assert.notEqual(gate[pathKey], integrated[pathKey], "the fixture must cross a real npm nesting boundary");
    assert.deepEqual([...new Set(gate[pathKey].split(delimiter))], [...new Set(integrated[pathKey].split(delimiter))]);
    const cacheFor = (environment) => createQualificationPrerequisiteCache({ root, sourceRevision, sourceTreeSha256, runtime, environment });
    const cache = cacheFor(gate), counts = {}, budgets = {};
    const producedArtifacts = { "route:inventory": "evidence/phase-1-route-inventory.json",
      "runtime:architecture": "evidence/phase-2-runtime-architecture.json", "runtime:boundary": "evidence/phase-2-runtime-boundary.json" };
    const execute = async ({ args, timeoutMs }) => {
      const name = args[1] === "run" ? args[2] : args[0].endsWith("check-contract-drift.mjs") ? "contract-drift" : "contract-compatibility";
      counts[name] = (counts[name] ?? 0) + 1;
      if (producedArtifacts[name]) writeFileSync(join(root, producedArtifacts[name]), JSON.stringify({ execution: counts[name] }));
      budgets[name] ??= timeoutMs;
      assert.ok(timeoutMs > 0 && timeoutMs <= 900_000, "the original package-check timeout must remain bounded");
      return { status: 0, output: "passed" };
    };
    const gateChecks = async (environment) => {
      const results = [];
      for (const script of scripts) results.push(await executeQualificationPackagePrerequisite({ script, root, cache, environment, execute }));
      return results;
    };
    const expected = { lint: 1, "contract:generate": 1, "contract-drift": 1, "contract-compatibility": 1,
      typecheck: 1, "test:arch": 1, "route:inventory": 1, "runtime:architecture": 1, "runtime:boundary": 1, build: 1 };
    await gateChecks(gate);
    const predecessorArtifacts = Object.values(producedArtifacts).map((path) => {
      const bytes = readFileSync(join(root, path));
      return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
    });
    const assertPredecessorsUnchanged = () => {
      for (const artifact of predecessorArtifacts) {
        const bytes = readFileSync(join(root, artifact.path));
        assert.deepEqual(bytes, artifact.bytes, "reuse must not overwrite completed predecessor artifacts");
        assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
      }
    };
    const rows = await runIntegrationPackagePrerequisites({ root, cache, environment: integrated, execute });
    assertPredecessorsUnchanged();
    assert.deepEqual(counts, expected, "integration must reuse the gate's actual primitive executions");
    assert.deepEqual(rows.map((row) => row.command), scripts.map((script) => `npm run ${script}`));
    for (const row of rows) {
      assert.equal(row.passed, true);
      assert.equal(row.reused, true);
      assert.ok(row.reuseProof);
    }
    const contract = rows.find((row) => row.command === "npm run contract:verify");
    assert.equal(contract.reuseProof.constituents.length, 3);
    assert.ok(contract.reuseProof.constituents.every((item) => item.reused && item.reuseProof.executionId));
    assert.ok((await gateChecks(gate)).every((result) => result.reused));
    assertPredecessorsUnchanged();
    assert.deepEqual(counts, expected);
    assert.ok(budgets["contract:generate"] > budgets["contract-drift"] && budgets["contract-drift"] > budgets["contract-compatibility"],
      "contract constituents share one original timeout budget");
    const total = () => Object.values(counts).reduce((sum, count) => sum + count, 0);
    const orderedPath = [...new Set(gate[pathKey].split(delimiter))];
    const reorderedPath = [orderedPath[1], orderedPath[0], ...orderedPath.slice(2)].join(delimiter);
    for (const changed of [{ ...integrated, [pathKey]: reorderedPath },
      { ...integrated, [pathKey]: join(root, "different-tools") + delimiter + integrated[pathKey] },
      { ...integrated, QUALIFICATION_INPUT: "changed" }]) {
      const before = total();
      assert.ok((await runIntegrationPackagePrerequisites({ root, cache: cacheFor(changed), environment: changed, execute })).every((row) => !row.reused));
      assert.equal(total() - before, 10, "meaningful environment changes require all ten primitive executions");
      for (const artifact of predecessorArtifacts) writeFileSync(join(root, artifact.path), artifact.bytes);
    }
    writeFileSync(join(root, ".next/server/app.js"), "changed compiled artifact");
    const beforeArtifact = total();
    const artifactRows = await runIntegrationPackagePrerequisites({ root, cache, environment: integrated, execute });
    assert.deepEqual(artifactRows.filter((row) => !row.reused).map((row) => row.command), ["npm run build"]);
    assert.equal(total() - beforeArtifact, 1);
    writeFileSync(join(root, "node_modules/.shipwithali-validation.json"), "changed installed tools");
    const beforeTools = total();
    assert.ok((await runIntegrationPackagePrerequisites({ root, cache, environment: integrated, execute })).every((row) => !row.reused));
    assert.equal(total() - beforeTools, 10);
    const standalone = { ...integrated };
    for (const name of ["PHASE8_QUALIFICATION_CONTEXT", "PHASE8_ACTIVE_RUN_ID", "PHASE8_DEFINITION_HASH"]) delete standalone[name];
    const beforeStandalone = total();
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.ok((await runIntegrationPackagePrerequisites({ root, cache: cacheFor(standalone), environment: standalone, execute })).every((row) => !row.reused));
    }
    assert.equal(total() - beforeStandalone, 20, "standalone checks always execute freshly");
    for (const failure of [{ status: 1, errorCode: "EACCES", output: "password=PRIVATE_PAYLOAD" },
      { status: 0, output: "# skipped 1" }, { status: 1, errorCode: "ETIMEDOUT", timedOut: true, output: "password=PRIVATE_PAYLOAD" }]) {
      await assert.rejects(() => runIntegrationPackagePrerequisites({ root, cache: cacheFor(standalone), environment: standalone,
        execute: async () => failure }), (error) => {
        assert.equal(error.check, "lint");
        assert.match(error.code, /^(?:EACCES|ETIMEDOUT|QUALIFICATION_COMMAND_INCOMPLETE)$/u);
        assert.doesNotMatch(error.message, /PRIVATE_PAYLOAD/u);
        return true;
      });
    }
    const secretEnvironment = { ...standalone, TOOL_SECRET: "sentinel-private-compiler-value" };
    await assert.rejects(() => runIntegrationPackagePrerequisites({ root, cache: cacheFor(secretEnvironment), environment: secretEnvironment,
      execute: async () => ({ status: 1, output: "x".repeat(2_000) +
        "\nsrc/example.ts:17:3 error TS2322: incompatible boolean type password=sentinel-password " + secretEnvironment.TOOL_SECRET }) }), (error) => {
      assert.match(error.message, /src\/example\.ts:17:3 error TS2322/u);
      assert.doesNotMatch(error.message, /sentinel-password|sentinel-private-compiler-value/u);
      assert.match(error.detail, /\[redacted\]/u);
      assert.ok(error.detail.length <= 1_000);
      return true;
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
