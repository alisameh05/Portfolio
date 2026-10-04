import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFailureInjector, mediaAcceptanceFacts } from "../phase5/fixtures/failure-injection.js";

type VerificationModule = {
  FOCUS_SUITES: Record<string, string>;
  FOCUS_ENTRYPOINTS: Record<string, string>;
  dockerDependencyResult: (probe?: (...args: unknown[]) => { error?: Error; status: number | null; stdout?: string }) => { available: boolean; code: string };
  makeVerificationReport: (input: Record<string, unknown>) => Record<string, unknown>;
  localVerificationEnvironment: (source: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  parseVitestReport: (report: unknown) => {
    executed: number;
    failed: number;
    skipped: number;
    verdict: string;
    scenarioAcceptance: boolean;
  };
  sanitizeVerificationText: (value: string) => string;
  verifyRequiredDependency: (result: { available: boolean; code: string }) => { passed: boolean; code: string };
};

describe("Phase 5 verification preparation (#107)", () => {
  it("separates Phase 5 activation from the historical Phase 2-4 contexts", async () => {
    const phases = await import("../../scripts/phase-context.mjs") as unknown as {
      PHASES: Record<string, string>;
      PHASE5_ALLOWED_ACTIVATION: string[];
      allowedActivationsFor: (phase: string) => string[];
    };
    expect(phases.PHASES["PHASE5"]).toBe("phase5");
    expect(phases.PHASE5_ALLOWED_ACTIVATION).toEqual(["content-and-publishing", "taxonomy-and-discovery"]);
    expect(phases.allowedActivationsFor("phase5")).toEqual(phases.PHASE5_ALLOWED_ACTIVATION);
    expect(phases.allowedActivationsFor("phase4")).toEqual(["identity-access", "portfolio-configuration"]);
  });

  it("declares separate focused suites for the four Phase 5 verification seams", async () => {
    const harness = await import("../../scripts/phase5-verification.mjs") as unknown as VerificationModule;
    expect(Object.keys(harness.FOCUS_SUITES)).toEqual(["authoring", "taxonomy", "database", "owner"]);
    expect(new Set(Object.values(harness.FOCUS_SUITES)).size).toBe(4);
    expect(harness.FOCUS_SUITES["authoring"]).toMatch(/authoring/);
    expect(harness.FOCUS_SUITES["taxonomy"]).toMatch(/taxonomy/);
    expect(harness.FOCUS_SUITES["database"]).toMatch(/database/);
    expect(harness.FOCUS_SUITES["owner"]).toMatch(/owner/);
    expect(harness.FOCUS_ENTRYPOINTS).toEqual({
      authoring: "authoring-review-publication-routes",
      taxonomy: "taxonomy-status-relationships-discovery",
      database: "database-rls-migrations-concurrency",
      owner: "owner-adapters-composition",
    });
    const packageJson = JSON.parse((await import("node:fs")).readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    for (const entrypoint of Object.values(harness.FOCUS_ENTRYPOINTS)) {
      expect(packageJson.scripts[`phase5:focus:${entrypoint}`]).toBeDefined();
      expect(packageJson.scripts[`prephase5:focus:${entrypoint}`]).toBe("npm run validation:ready");
    }
    expect(packageJson.scripts["phase5:context"]).toBe("node scripts/check-phase5-context.mjs");
    expect(packageJson.scripts["prephase5:smoke"]).toBe("npm run validation:ready");
  });

  it("accepts complete Vitest JSON evidence and rejects empty, partial, failed, and skipped runs", async () => {
    const { parseVitestReport } = await import("../../scripts/phase5-verification.mjs") as unknown as VerificationModule;
    const complete = {
      success: true,
      numTotalTests: 2,
      numPassedTests: 2,
      numFailedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [{ status: "passed", assertionResults: [{ status: "passed" }, { status: "passed" }] }],
    };
    expect(parseVitestReport(complete)).toMatchObject({
      executed: 2, failed: 0, skipped: 0, verdict: "pass", scenarioAcceptance: true,
    });
    for (const report of [
      { ...complete, numTotalTests: 0, numPassedTests: 0, testResults: [] },
      { ...complete, numPassedTests: 1, numPendingTests: 1 },
      { ...complete, numFailedTests: 1, success: false },
      { ...complete, numTodoTests: 1 },
      { ...complete, testResults: [{ status: "passed", assertionResults: [{ status: "skipped" }] }] },
    ]) {
      expect(parseVitestReport(report).verdict).toBe("fail");
      expect(parseVitestReport(report).scenarioAcceptance).toBe(false);
    }
  });

  it("fails required dependency and cleanup errors and sanitizes structured evidence", async () => {
    const harness = await import("../../scripts/phase5-verification.mjs") as unknown as VerificationModule;
    expect(harness.dockerDependencyResult(() => ({ status: 1, stdout: "" }))).toMatchObject({
      available: false, code: "PHASE5_REQUIRED_DATABASE_UNAVAILABLE",
    });
    expect(harness.dockerDependencyResult(() => ({ status: 0, stdout: "29.7.2" }))).toMatchObject({
      available: true, code: "PHASE5_REQUIRED_DATABASE_AVAILABLE",
    });
    const localEnvironment = harness.localVerificationEnvironment({ SUPABASE_ACCESS_TOKEN: "remote", PHASE4_DATABASE_URL: "remote", DATABASE_URL: "remote", OWNER_GITHUB_SUBJECTS: "remote", PATH: "safe" });
    expect(localEnvironment).toMatchObject({ CI: "1", PATH: "safe" });
    expect(localEnvironment).not.toHaveProperty("SUPABASE_ACCESS_TOKEN");
    const integration = await import("../../scripts/portfolio-settings-integration.mjs") as unknown as {
      evidenceOutputPath: (candidate?: string) => string;
    };
    const tempEvidence = join(tmpdir(), "shipwithali-phase5-smoke-test.json");
    expect(integration.evidenceOutputPath(tempEvidence)).toBe(tempEvidence);
    expect(() => integration.evidenceOutputPath(join(tmpdir(), "unrelated-evidence.json")))
      .toThrow("PORTFOLIO_SETTINGS_EVIDENCE_PATH_INVALID");
    expect(harness.verifyRequiredDependency({ available: false, code: "DOCKER_UNAVAILABLE" })).toMatchObject({
      passed: false, code: "DOCKER_UNAVAILABLE",
    });
    const report = harness.makeVerificationReport({
      runId: "run-1",
      sourceRevision: "a".repeat(40),
      suite: "database",
      result: { executed: 1, failed: 0, skipped: 0, verdict: "pass", scenarioAcceptance: true },
      dependency: { required: true, available: true, code: "DOCKER_AVAILABLE" },
      cleanup: { attempted: true, passed: false },
      reproduction: ["npm run phase5:focus:database"],
    });
    expect(report).toMatchObject({
      verdict: "fail", runId: "run-1", sourceRevision: "a".repeat(40), cleanup: { passed: false },
    });
    expect(harness.sanitizeVerificationText("postgresql://owner:secret@127.0.0.1:5432/db token=abc"))
      .toBe("[redacted-database-url] token=[redacted]");
  });

  it("injects transaction, projection, outbox and receipt failures using provider-neutral Media facts", () => {
    for (const point of ["transaction", "projection", "outbox", "receipt"] as const) {
      const inject = createFailureInjector(point);
      expect(() => inject.hit(point)).toThrow(`INJECTED_${point.toUpperCase()}_FAILURE`);
      expect(() => inject.hit(point === "transaction" ? "projection" : "transaction")).not.toThrow();
    }
    expect(mediaAcceptanceFacts).toEqual([
      { status: "accepted" }, { status: "rejected", reason: "unsafe" }, { status: "unavailable" },
    ]);
    const productionFiles = [] as string[];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory)) {
        const file = join(directory, entry);
        const metadata = statSync(file);
        if (metadata.isDirectory()) visit(file);
        else if (/\.(?:ts|js|mjs)$/.test(entry)) productionFiles.push(file);
      }
    };
    visit("src");
    for (const file of productionFiles) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/tests\/phase5\/fixtures\/failure-injection/);
    }
  });
});
