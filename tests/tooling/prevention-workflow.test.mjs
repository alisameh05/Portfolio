import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PREVENTION_WORKFLOW, validatePreventionWorkflowSource } from "../../scripts/check-prevention-workflow.mjs";
import { REQUIRED_CACHE_TESTS, REQUIRED_REGRESSION_TESTS, validatePrerequisiteCacheTap, validateValidationEvolutionTap }
  from "../../scripts/run-validation-evolution-tests.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const baseline = readFileSync(join(ROOT, PREVENTION_WORKFLOW), "utf8");

test("the declared prevention workflow runs the complete regression inventory and strict aggregator", () => {
  assert.deepEqual(validatePreventionWorkflowSource(baseline), []);
});

test("workflow mutations cannot omit triggers, suites, checks, or failures", () => {
  const mutations = [
    ["paths filter", (s) => s.replace("branches:\n      - master", "branches:\n      - master\n    paths:\n      - scripts/**")],
    ["wrong trigger branch", (s) => s.replace("- master", "- feature")],
    ["missing merge queue", (s) => s.replace("  merge_group:\n", "")],
    ["missing AC02 and AC03 inventory", (s) => s.replace("npm run test:validation-evolution", "npm run test:setup")],
    ["skipped failure aggregation", (s) => s.replace("needs.evolution-regressions.result", "'success'")],
    ["missing self-check dependency", (s) => s.replace("needs: [evolution-regressions, prevention-workflow-selfcheck]", "needs: [evolution-regressions]")],
    ["error continuation", (s) => s.replace("runs-on: ubuntu-24.04", "runs-on: ubuntu-24.04\n    continue-on-error: true")],
    ["swallowed regression failure", (s) => s.replace("run: npm run test:validation-evolution", "run: npm run test:validation-evolution || true")],
    ["batched regression failure", (s) => s.replace("run: npm run test:validation-evolution", "run: npm run test:validation-evolution\n          true")],
    ["commented regression command", (s) => s.replace("run: npm run test:validation-evolution", "run: |\n          # npm run test:validation-evolution\n          true")],
    ["skipped regression job", (s) => s.replace("  evolution-regressions:\n", "  evolution-regressions:\n    if: false\n")],
    ["skipped regression step", (s) => s.replace("        run: npm run test:validation-evolution", "        if: false\n        run: npm run test:validation-evolution")],
    ["expression-based error continuation", (s) => s.replace("    runs-on: ubuntu-24.04\n", "    runs-on: ubuntu-24.04\n    continue-on-error: ${{ github.event_name == 'pull_request' }}\n")],
    ["unconditional success aggregator", (s) => s.replace("node -e \"process.exitCode = process.env.EVOLUTION_RESULTS !== 'success' || process.env.SELFCHECK_RESULTS !== 'success' ? 1 : 0\"", "node -e \"process.exitCode = 0\"")],
    ["aggregator ignores failed prerequisite", (s) => s.replace("process.env.EVOLUTION_RESULTS !== 'success'", "process.env.EVOLUTION_RESULTS === 'success'")],
    ["skipped aggregate step", (s) => s.replace("      - name: Aggregate validation-evolution results", "      - name: Aggregate validation-evolution results\n        if: false")],
    ["default merge checkout on pull requests", (s) => s.replace("ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}", "ref: ${{ github.sha }}")],
    ["missing current head checkout", (s) => s.replace("          ref: ${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}\n", "")],
  ];
  for (const [name, mutate] of mutations) {
    assert.notDeepEqual(validatePreventionWorkflowSource(mutate(baseline)), [], name);
  }
});

test("workflow checker rejects invalid YAML and missing regression job", () => {
  assert.deepEqual(validatePreventionWorkflowSource("jobs: ["), ["PREVENTION_WORKFLOW_INVALID_YAML"]);
  const missing = baseline.replace(/  evolution-regressions:[\s\S]*?\n  prevention-workflow-selfcheck:/u, "  prevention-workflow-selfcheck:");
  assert.ok(validatePreventionWorkflowSource(missing).includes("PREVENTION_WORKFLOW_JOB_MISSING:evolution-regressions"));
});

test("regression TAP rejects removed, skipped, cancelled, or failed constituents", () => {
  const names = REQUIRED_REGRESSION_TESTS.map((name) => `# Subtest: ${name}\nok 1 - ${name}`).join("\n");
  const complete = `TAP version 13\n${names}\n1..${REQUIRED_REGRESSION_TESTS.length}\n# tests ${REQUIRED_REGRESSION_TESTS.length}\n# pass ${REQUIRED_REGRESSION_TESTS.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  assert.deepEqual(validateValidationEvolutionTap(complete, 0), []);
  assert.ok(validateValidationEvolutionTap(complete.replace(`# pass ${REQUIRED_REGRESSION_TESTS.length}`, `# pass ${REQUIRED_REGRESSION_TESTS.length - 1}`), 0).length > 0);
  assert.ok(validateValidationEvolutionTap(complete.replace("# skipped 0", "# skipped 1"), 0).length > 0);
  assert.ok(validateValidationEvolutionTap(complete.replace("# cancelled 0", "# cancelled 1"), 0).length > 0);
  assert.ok(validateValidationEvolutionTap(complete.replace(/# Subtest: regression TAP[^\n]*\n[^\n]*/u, ""), 0).length > 0);
  assert.ok(validateValidationEvolutionTap(complete, 1).length > 0);
  const cacheNames = REQUIRED_CACHE_TESTS.map((name) => `# Subtest: ${name}\nok 1 - ${name}`).join("\n");
  const cacheTap = `TAP version 13\n${cacheNames}\n1..${REQUIRED_CACHE_TESTS.length}\n# tests ${REQUIRED_CACHE_TESTS.length}\n# pass ${REQUIRED_CACHE_TESTS.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  assert.deepEqual(validatePrerequisiteCacheTap(cacheTap, 0), []);
  assert.ok(validatePrerequisiteCacheTap(cacheTap.replace("# skipped 0", "# skipped 1"), 0).length > 0);
  assert.ok(validatePrerequisiteCacheTap(cacheTap.replace("# pass 7", "# pass 6"), 0).length > 0);
});
