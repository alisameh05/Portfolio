import test from "node:test";
import assert from "node:assert/strict";
import { skippedTestCount } from "../../scripts/phase3-gate-support.mjs";

test("Phase 3 gate skip reporting counts tests without counting skipped test files twice", () => {
  assert.equal(skippedTestCount("Test Files 1 passed | 1 skipped (2)\nTests 7 passed | 2 skipped (9)"), 2);
});

test("Phase 3 gate skip reporting handles alternate Vitest summaries and ANSI color", () => {
  assert.equal(skippedTestCount("\u001b[32m2 tests skipped\u001b[0m"), 2);
  assert.equal(skippedTestCount("Skipped: 3"), 3);
  assert.equal(skippedTestCount("Tests 14 passed (14)"), 0);
});
