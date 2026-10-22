import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQualificationPrerequisiteCache } from "../../scripts/qualification-prerequisite-cache.mjs";

const runtime = { node: "24.21.0", npm: "11.19.0", platform: process.platform, architecture: process.arch };
const sourceRevision = "a".repeat(40);
const sourceTreeSha256 = "b".repeat(64);
const definitionHash = "c".repeat(64);

function fixture({ active = true, platform = runtime.platform, source = sourceTreeSha256 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "qualification-prereq-"));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", build: "next build",
    "route:inventory": "node scripts/check-route-inventory.mjs" } }));
  writeFileSync(join(root, "package-lock.json"), "lock");
  writeFileSync(join(root, "node_modules", ".shipwithali-validation.json"), "stamp");
  const contextPath = join(root, "context.json");
  const runId = "12345678-1234-4234-8234-123456789abc";
  writeFileSync(contextPath, JSON.stringify({ algorithm: "phase8-qualification-run/v1", runId,
    definitionHash, status: "running", identity: { revision: sourceRevision, sourceTreeSha256: source,
      runtime: { ...runtime, platform } } }));
  const environment = active ? { CI: "1", PHASE8_ACTIVE_RUN_ID: runId, PHASE8_DEFINITION_HASH: definitionHash,
    PHASE8_QUALIFICATION_CONTEXT: contextPath, SHIPWITHALI_PHASE: "phase5", PHASE5_GATE_RUN_ID: "gate-one" } : { CI: "1" };
  const cache = createQualificationPrerequisiteCache({ root, sourceRevision, sourceTreeSha256: source,
    runtime: { ...runtime, platform }, environment });
  return { root, environment, cache, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function npmEntry(root, script) {
  return JSON.stringify({ entry: process.execPath, args: ["npm-cli.js", "run", script] });
}

function invoke(cache, root, { script = "typecheck", env, args = [], result = { status: 0, output: "ok\n" }, artifacts } = {}) {
  return cache.run({ script, args, entry: npmEntry(root, script), environment: env,
    artifactPaths: artifacts, sanitizeOutput: (output) => String(output).trim(), invoke: () => result });
}

test("reuses an equivalent checked command across phase gates only within the active run", () => {
  const f = fixture();
  try {
    let executions = 0;
    const first = f.cache.run({ script: "typecheck", entry: npmEntry(f.root, "typecheck"), environment: f.environment,
      invoke: () => { executions++; return { status: 0, output: "clean\n" }; }, sanitizeOutput: (value) => value.trim() });
    const phase6Env = { ...f.environment, SHIPWITHALI_PHASE: "phase6", PHASE6_GATE_RUN_ID: "gate-two" };
    const second = f.cache.run({ script: "typecheck", entry: npmEntry(f.root, "typecheck"), environment: phase6Env,
      invoke: () => { executions++; return { status: 0, output: "unexpected" }; }, sanitizeOutput: (value) => value.trim() });
    assert.equal(executions, 1);
    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.match(second.reuseProof.outputSha256, /^[a-f0-9]{64}$/u);
  } finally { f.cleanup(); }
});

test("semantic aliases share a cache only after each invocation matches its reviewed command", () => {
  const f = fixture();
  try {
    let executions = 0;
    const first = f.cache.run({ script: "typecheck", entry: npmEntry(f.root, "typecheck"), environment: f.environment,
      invoke: () => { executions++; return { status: 0, output: "typed" }; } });
    const direct = f.cache.run({ script: "direct:typescript", args: ["--noEmit"],
      entry: JSON.stringify({ entry: process.execPath, args: [join(f.root, "node_modules/typescript/bin/tsc"), "--noEmit"] }),
      environment: f.environment, invoke: () => { executions++; return { status: 0, output: "wrongly reran" }; } });
    assert.equal(first.reused, false);
    assert.equal(direct.reused, true);
    assert.equal(executions, 1);
    const spoofed = f.cache.run({ script: "direct:typescript", args: ["--noEmit"],
      entry: JSON.stringify({ entry: "node", args: ["-e", "process.exit(0)"] }), environment: f.environment,
      invoke: () => ({ status: 0, output: "must execute but remain uncached" }) });
    assert.equal(spoofed.reused, false);
  } finally { f.cleanup(); }
});

test("direct and npm route inventory aliases share the same artifact proof", () => {
  const f = fixture();
  try {
    const artifact = "evidence/phase-1-route-inventory.json";
    mkdirSync(join(f.root, "evidence"), { recursive: true });
    writeFileSync(join(f.root, artifact), "route report v1");
    let executions = 0;
    const direct = f.cache.run({ script: "direct:check-route-inventory.mjs",
      entry: JSON.stringify({ entry: process.execPath, args: [join(f.root, "scripts/check-route-inventory.mjs")] }),
      environment: f.environment, invoke: () => { executions++; return { status: 0, output: "routes" }; } });
    const npm = f.cache.run({ script: "route:inventory", entry: npmEntry(f.root, "route:inventory"), environment: f.environment,
      invoke: () => { executions++; return { status: 0, output: "wrong rerun" }; } });
    assert.equal(direct.reused, false);
    assert.equal(npm.reused, true);
    writeFileSync(join(f.root, artifact), "route report changed");
    assert.equal(f.cache.run({ script: "route:inventory", entry: npmEntry(f.root, "route:inventory"), environment: f.environment,
      invoke: () => { executions++; return { status: 0, output: "rerun after artifact change" }; } }).reused, false);
    assert.equal(executions, 2);
  } finally { f.cleanup(); }
});

test("standalone runs and noncanonical commands never reuse", () => {
  const f = fixture({ active: false });
  try {
    let executions = 0;
    const run = () => f.cache.run({ script: "typecheck", entry: npmEntry(f.root, "typecheck"), environment: f.environment,
      invoke: () => { executions++; return { status: 0, output: "ok" }; } });
    assert.equal(run().reused, false);
    assert.equal(run().reused, false);
    assert.equal(executions, 2);
    const wrapped = f.cache.run({ script: "typecheck", entry: JSON.stringify({ entry: "sh", args: ["-c", "true"] }),
      environment: f.environment, invoke: () => ({ status: 0, output: "ok" }) });
    assert.equal(wrapped.reused, false);
  } finally { f.cleanup(); }
});

test("failed, interrupted, skipped, or timed-out results are never cached", () => {
  for (const result of [
      { status: 1, output: "failed" }, { status: 0, errorCode: "EINTR", output: "interrupted" },
      { status: 0, skipped: 1, output: "skipped" }, { status: 0, timedOut: true, output: "timeout" },
    ]) {
    const f = fixture();
    try {
      assert.equal(invoke(f.cache, f.root, { result, env: f.environment }).reused, false);
      assert.equal(invoke(f.cache, f.root, { env: f.environment }).reused, false);
    } finally { f.cleanup(); }
  }
});

test("source, environment, runtime, platform, and command changes make a fresh execution", () => {
  const f = fixture();
  try {
    f.cache.run({ script: "typecheck", entry: npmEntry(f.root, "typecheck"), environment: f.environment,
      invoke: () => ({ status: 0, output: "ok" }) });
    const variants = [
      createQualificationPrerequisiteCache({ root: f.root, sourceRevision, sourceTreeSha256: "d".repeat(64), runtime, environment: f.environment }),
      createQualificationPrerequisiteCache({ root: f.root, sourceRevision, sourceTreeSha256, runtime: { ...runtime, node: "25.0.0" }, environment: f.environment }),
      createQualificationPrerequisiteCache({ root: f.root, sourceRevision, sourceTreeSha256, runtime: { ...runtime, platform: "other" }, environment: f.environment }),
    ];
    for (const cache of variants) {
      const result = cache.run({ script: "typecheck", entry: npmEntry(f.root, "typecheck"), environment: f.environment,
        invoke: () => ({ status: 0, output: "fresh" }) });
      assert.equal(result.reused, false);
    }
    const changedEnv = { ...f.environment, FEATURE_FLAG: "changed" };
    assert.equal(f.cache.run({ script: "typecheck", entry: npmEntry(f.root, "typecheck"), environment: changedEnv,
      invoke: () => ({ status: 0, output: "fresh" }) }).reused, false);
    assert.equal(f.cache.run({ script: "typecheck", args: ["--watch"], entry: npmEntry(f.root, "typecheck"), environment: f.environment,
      invoke: () => ({ status: 0, output: "fresh" }) }).reused, false);
  } finally { f.cleanup(); }
});

test("output artifacts must exist and remain byte-identical for reuse", () => {
  const f = fixture();
  try {
    const artifact = ".next/server";
    mkdirSync(join(f.root, artifact), { recursive: true });
    mkdirSync(join(f.root, ".next/static"), { recursive: true });
    writeFileSync(join(f.root, ".next/server/app.js"), "compiled one");
    writeFileSync(join(f.root, ".next/BUILD_ID"), "id");
    writeFileSync(join(f.root, ".next/required-server-files.json"), "manifest");
    writeFileSync(join(f.root, ".next/static/chunk.js"), "compiled one");
    const run = () => f.cache.run({ script: "build", entry: npmEntry(f.root, "build"), environment: f.environment,
      invoke: () => ({ status: 0, output: "built" }) });
    assert.equal(run().reused, false);
    assert.equal(run().reused, true);
    writeFileSync(join(f.root, ".next/server/app.js"), "compiled two");
    assert.equal(run().reused, false);
    assert.equal(readFileSync(join(f.root, ".next/server/app.js"), "utf8"), "compiled two");
  } finally { f.cleanup(); }
});
