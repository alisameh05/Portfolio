import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { qualifyPrerequisites, QUALIFICATION_STEPS, requireQualificationDocker } from "../../scripts/phase8-qualify.mjs";

const stable = { revision: "a".repeat(40), tree: "b".repeat(64), committedTree: "b".repeat(64) };
const checkEnvironment = () => {};
test("the real CLI with no Docker exits before changing any prerequisite report", () => {
  const root = new URL("../../", import.meta.url);
  const reports = ["phase-3-gate-report.json", "phase-4-gate-report.json", "phase-5-gate-report.json",
    "phase6-gate-report.json", "phase7-gate-report.json", "phase8-prerequisite-qualification.json"];
  const before = reports.map((name) => readFileSync(new URL(`evidence/${name}`, root)));
  // Empty PATH means current-directory lookup on POSIX, where docker/ is a
  // directory. Use an actual empty search directory to model a missing binary.
  const emptyPath = mkdtempSync(join(tmpdir(), "phase8-no-docker-"));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("scripts/phase8-qualify.mjs", root))], {
      env: { ...process.env, PATH: emptyPath, Path: emptyPath }, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PHASE8_DOCKER_MISSING/u);
    assert.doesNotMatch(result.stdout, /Qualifying Phases|Running Phase/u);
    reports.forEach((name, index) => assert.deepEqual(readFileSync(new URL(`evidence/${name}`, root)), before[index]));
  } finally { rmSync(emptyPath, { recursive: true, force: true }); }
});
test("Docker preflight distinguishes missing executable, access, timeout, engine OS and Compose", () => {
  const linux = { status: 0, stdout: "linux\n" };
  for (const [result, code] of [
    [{ error: { code: "ENOENT" } }, "PHASE8_DOCKER_MISSING"],
    [{ error: { code: "EPERM" } }, "PHASE8_DOCKER_UNAVAILABLE"],
    [{ error: { code: "ETIMEDOUT" }, status: null }, "PHASE8_DOCKER_UNAVAILABLE"],
    [{ status: 1 }, "PHASE8_DOCKER_UNAVAILABLE"],
    [{ status: 0, stdout: "windows" }, "PHASE8_DOCKER_LINUX_REQUIRED"],
  ]) assert.throws(() => requireQualificationDocker(() => result), new RegExp(code));
  assert.throws(() => requireQualificationDocker((_, args) => args[0] === "info" ? linux : { status: 1 }), /PHASE8_DOCKER_COMPOSE_REQUIRED/u);
  const calls = [];
  requireQualificationDocker((command, args, options) => {
    calls.push([command, args]);
    assert.equal(options.timeout, 15_000);
    assert.equal(options.maxBuffer, 16 * 1024);
    assert.equal(options.windowsHide, true);
    return args[0] === "info" ? linux : { status: 0 };
  });
  assert.deepEqual(calls, [["docker", ["info", "--format", "{{.OSType}}"]], ["docker", ["compose", "version"]]]);
});
test("Docker preflight failure leaves source inspection and every evidence producer untouched", async () => {
  let inspected = false;
  const calls = [], messages = [];
  const result = await qualifyPrerequisites({ checkEnvironment: () => { throw new Error("PHASE8_DOCKER_MISSING"); },
    getIdentity: () => { inspected = true; return stable; }, log: (message) => messages.push(message),
    run: async (step) => { calls.push(step); return 0; } });
  assert.equal(result, 1);
  assert.equal(inspected, false);
  assert.deepEqual(calls, []);
  assert.match(messages.join("\n"), /PHASE8_DOCKER_MISSING/u);
});
test("qualification runs every gate in order before evaluating evidence", async () => {
  const calls = [];
  const result = await qualifyPrerequisites({ checkEnvironment, getIdentity: () => stable, log() {}, run: async (step) => { calls.push(step[1]); return 0; } });
  assert.equal(result, 0);
  assert.deepEqual(calls, ["scripts/validation-environment.mjs", "scripts/phase3-gate.mjs", "scripts/phase4-gate.mjs",
    "scripts/phase5-gate.mjs", "scripts/docker-validation.mjs", "scripts/phase7-gate.mjs", "scripts/phase8-prerequisite-qualification.mjs"]);
});
test("a failed or interrupted gate never reaches the evaluator or reports success", async () => {
  for (const failure of [1, 2, null]) {
    const calls = [];
    const result = await qualifyPrerequisites({ checkEnvironment, getIdentity: () => stable, log() {}, run: async (step) => {
      calls.push(step[0]); return calls.length === 3 ? failure : 0;
    } });
    assert.notEqual(result, 0);
    assert.equal(calls.length, 3);
    assert.ok(!calls.includes("prerequisite qualification"));
  }
});
test("uncommitted source and source edits during any gate require a fresh run", async () => {
  let calls = 0;
  assert.equal(await qualifyPrerequisites({ checkEnvironment, getIdentity: () => ({ ...stable, committedTree: "c".repeat(64) }),
    log() {}, run: async () => { calls++; return 0; } }), 1);
  assert.equal(calls, 0);
  for (const changedField of ["revision", "tree"]) {
    for (let changedStep = 1; changedStep <= QUALIFICATION_STEPS.length; changedStep++) {
      calls = 0;
      const result = await qualifyPrerequisites({ checkEnvironment, log() {},
        getIdentity: () => calls === changedStep ? { ...stable, [changedField]: "changed" } : stable,
        run: async () => { calls++; return 0; } });
      assert.equal(result, 1);
      assert.equal(calls, changedStep);
    }
  }
});
