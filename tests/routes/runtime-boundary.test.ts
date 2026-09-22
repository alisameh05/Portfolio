import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRuntimeBoundary } from "../../scripts/check-runtime-boundary.mjs";

const ROOT = process.cwd();

describe("Phase 2 contract-to-adapter runtime boundary (#33)", () => {
  it("maps every public and Owner operation identifier to exactly one adapter", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.matrix).toHaveLength(44);
    expect(report.matrix.filter((entry) => entry.surface === "public")).toHaveLength(5);
    expect(report.matrix.filter((entry) => entry.surface === "owner")).toHaveLength(39);
    expect(report.matrix.every((entry) => entry.matches.length === 1)).toBe(true);
  });

  it("rejects adapters that are not declared by either contract", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.undeclaredAdapters).toEqual([]);
    expect(report.duplicateOperationIds).toEqual([]);
  });

  it("keeps /livez and /readyz as the only operational routes", () => {
    const report = buildRuntimeBoundary(ROOT);

    expect(report.operationalRoutes).toEqual([
      "src/app/livez/route.ts",
      "src/app/readyz/route.ts",
    ]);
    expect(report.unexpectedRouteFiles).toEqual([]);
  });

  it("emits the durable Phase 2 runtime-boundary evidence", () => {
    const reportPath = join(ROOT, "evidence", "phase-2-runtime-boundary.json");
    expect(existsSync(reportPath)).toBe(true);

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      verdict: string;
      matrix: unknown[];
    };
    expect(report.verdict).toBe("pass");
    expect(report.matrix).toHaveLength(44);
  });
});
