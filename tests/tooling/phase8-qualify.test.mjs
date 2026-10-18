import assert from "node:assert/strict";
import test from "node:test";
import { qualifyPrerequisites, QUALIFICATION_STEPS } from "../../scripts/phase8-qualify.mjs";

const stable = { revision: "a".repeat(40), tree: "b".repeat(64), committedTree: "b".repeat(64) };
test("qualification runs every gate in order before evaluating evidence", async () => {
  const calls = [];
  const result = await qualifyPrerequisites({ getIdentity: () => stable, log() {}, run: async (step) => { calls.push(step[1]); return 0; } });
  assert.equal(result, 0);
  assert.deepEqual(calls, ["scripts/validation-environment.mjs", "scripts/phase3-gate.mjs", "scripts/phase4-gate.mjs",
    "scripts/phase5-gate.mjs", "scripts/docker-validation.mjs", "scripts/phase7-gate.mjs", "scripts/phase8-prerequisite-qualification.mjs"]);
});
test("a failed or interrupted gate never reaches the evaluator or reports success", async () => {
  for (const failure of [1, 2, null]) {
    const calls = [];
    const result = await qualifyPrerequisites({ getIdentity: () => stable, log() {}, run: async (step) => {
      calls.push(step[0]); return calls.length === 3 ? failure : 0;
    } });
    assert.notEqual(result, 0);
    assert.equal(calls.length, 3);
    assert.ok(!calls.includes("prerequisite qualification"));
  }
});
test("uncommitted source and source edits during any gate require a fresh run", async () => {
  let calls = 0;
  assert.equal(await qualifyPrerequisites({ getIdentity: () => ({ ...stable, committedTree: "c".repeat(64) }),
    log() {}, run: async () => { calls++; return 0; } }), 1);
  assert.equal(calls, 0);
  for (const changedField of ["revision", "tree"]) {
    for (let changedStep = 1; changedStep <= QUALIFICATION_STEPS.length; changedStep++) {
      calls = 0;
      const result = await qualifyPrerequisites({ log() {},
        getIdentity: () => calls === changedStep ? { ...stable, [changedField]: "changed" } : stable,
        run: async () => { calls++; return 0; } });
      assert.equal(result, 1);
      assert.equal(calls, changedStep);
    }
  }
});
