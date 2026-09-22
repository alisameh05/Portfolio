import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("Phase 2 authoritative gate definition (#33)", () => {
  it("exposes every constituent check independently", () => {
    const packageJson = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };

    expect(packageJson.scripts).toMatchObject({
      build: "next build",
      lint: "eslint .",
      "runtime:boundary": "node scripts/check-runtime-boundary.mjs",
      "runtime:architecture": "node scripts/check-runtime-architecture.mjs",
      "test:runtime:configuration": "vitest run tests/runtime/configuration.test.ts",
      "test:runtime:http": "vitest run tests/runtime",
      "test:runtime:problem": "vitest run tests/runtime/problem.test.ts",
      "test:runtime:health":
        "vitest run tests/runtime/livez.test.ts tests/runtime/readiness-lifecycle.test.ts",
      "phase2:gate": "node scripts/phase2-gate.mjs",
    });
  });

  it("provides the aggregate gate script", () => {
    expect(existsSync(join(ROOT, "scripts", "phase2-gate.mjs"))).toBe(true);
  });

  it("keeps committed evidence free of local absolute paths", () => {
    const evidenceFiles = [
      "phase-2-contract-drift.log",
      "phase-2-contract-tests.log",
      "phase-2-configuration.log",
      "phase-2-http-adapters.log",
      "phase-2-problem-details.log",
      "phase-2-health-lifecycle.log",
    ];
    for (const file of evidenceFiles) {
      const content = readFileSync(join(ROOT, "evidence", file), "utf8");
      expect(content, file).not.toMatch(/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/m);
    }
  });
});
