import test from "node:test";
import assert from "node:assert/strict";
import { createPhase3GateProject, removePhase3GateProject, skippedTestCount } from "../../scripts/phase3-gate-support.mjs";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

test("Phase 3 gate copies the complete immutable chain into an owned disposable project", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const project = createPhase3GateProject(root);
  try {
    assert.match(project.projectId, /^shipwithali-phase3-[a-f0-9]{16}$/u);
    const config = readFileSync(join(project.workdir, "supabase/config.toml"), "utf8");
    assert.ok(config.includes(`project_id = "${project.projectId}"`));
    assert.ok(!config.includes("port = 54322"));
    assert.deepEqual(readdirSync(join(project.workdir, "supabase/migrations")).sort(),
      readdirSync(join(root, "supabase/migrations")).filter(name => name.endsWith(".sql")).sort());
  } finally { removePhase3GateProject(project); }
  assert.equal(existsSync(project.workdir), false);
});

test("Phase 3 gate cleanup rejects a persistent checkout", () => {
  assert.throws(() => removePhase3GateProject({ workdir: process.cwd(), projectId: "shipwithali-portfolio" }));
});

test("Phase 3 gate skip reporting counts tests without counting skipped test files twice", () => {
  assert.equal(skippedTestCount("Test Files 1 passed | 1 skipped (2)\nTests 7 passed | 2 skipped (9)"), 2);
});

test("Phase 3 gate skip reporting handles alternate Vitest summaries and ANSI color", () => {
  assert.equal(skippedTestCount("\u001b[32m2 tests skipped\u001b[0m"), 2);
  assert.equal(skippedTestCount("Skipped: 3"), 3);
  assert.equal(skippedTestCount("Tests 14 passed (14)"), 0);
});
