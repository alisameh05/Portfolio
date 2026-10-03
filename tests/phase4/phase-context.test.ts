import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

type PhaseContextModule = {
  PHASES: Record<string, string>;
  HISTORICAL_RESTRICTIONS: Record<string, string>;
  PHASE4_ALLOWED_ACTIVATION: string[];
  EXPECTED_PUBLIC_OPERATIONS: number;
  EXPECTED_OWNER_OPERATIONS: number;
  PHASE4_NEGATIVE_FIXTURES: Array<{ name: string; path: string; expectedRule: string }>;
  allowedActivationsFor: (phase: string) => string[];
  getPhaseContext: (env?: NodeJS.ProcessEnv) => string;
};

type BoundaryModule = {
  buildRuntimeBoundary: (root?: string) => { verdict: string };
};

type RuntimeArchModule = {
  inspectRuntimeArchitecture: (root?: string) => { verdict: string; findings: unknown[] };
};

describe("Phase 4 completion gate (#90)", () => {
  it("exposes a shared phase-context definition with historical and current phases", async () => {
    const modulePath = join(ROOT, "scripts", "phase-context.mjs");
    expect(existsSync(modulePath), "scripts/phase-context.mjs exists").toBe(true);
    const mod = (await import("../../scripts/phase-context.mjs")) as unknown as PhaseContextModule;
    expect(mod.PHASES).toMatchObject({ PHASE2: "phase2", PHASE3: "phase3", PHASE4: "phase4" });
    expect(mod.HISTORICAL_RESTRICTIONS["phase2"]).toMatch(/fake/i);
    expect(mod.HISTORICAL_RESTRICTIONS["phase3"]).toMatch(/infrastructure/i);
    expect(mod.PHASE4_ALLOWED_ACTIVATION).toEqual(
      expect.arrayContaining(["identity-access", "portfolio-configuration"]),
    );
    expect(mod.EXPECTED_PUBLIC_OPERATIONS).toBe(5);
    expect(mod.EXPECTED_OWNER_OPERATIONS).toBe(39);
    expect(mod.allowedActivationsFor("phase2")).toEqual(expect.arrayContaining(["fakes"]));
    expect(mod.allowedActivationsFor("phase4")).toEqual(
      expect.arrayContaining(["identity-access", "portfolio-configuration"]),
    );
    expect(mod.getPhaseContext({})).toBe("phase4");
    expect(mod.getPhaseContext({ SHIPWITHALI_PHASE: "phase2" })).toBe("phase2");
  });

  it("exposes independently runnable Phase 4 check entrypoints", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["phase4:context"]).toBe("node scripts/check-phase4-context.mjs");
    expect(packageJson.scripts["phase4:gate"]).toBe("node scripts/phase4-gate.mjs");
    expect(existsSync(join(ROOT, "scripts", "check-phase4-context.mjs"))).toBe(true);
    expect(existsSync(join(ROOT, "scripts", "phase4-gate.mjs"))).toBe(true);
  });

  it("keeps exactly five public and thirty-nine Owner operations", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, ["scripts/check-route-inventory.mjs"], {
      cwd: ROOT,
      stdio: "pipe",
    });
    const report = JSON.parse(
      readFileSync(join(ROOT, "evidence", "phase-1-route-inventory.json"), "utf8"),
    ) as { publicOperations: string[]; ownerOperations: string[]; forbiddenFindings: unknown[] };
    expect(report.publicOperations).toHaveLength(5);
    expect(report.ownerOperations).toHaveLength(39);
    expect(report.forbiddenFindings).toEqual([]);
  });

  it("preserves provider seams and runtime boundaries", async () => {
    const boundaryMod = (await import("../../scripts/check-runtime-boundary.mjs")) as unknown as BoundaryModule;
    const boundary = boundaryMod.buildRuntimeBoundary(ROOT);
    expect(boundary.verdict).toBe("pass");

    const archMod = (await import("../../scripts/check-runtime-architecture.mjs")) as unknown as RuntimeArchModule;
    const architecture = archMod.inspectRuntimeArchitecture(ROOT);
    expect(architecture.verdict).toBe("pass");
    expect(architecture.findings).toEqual([]);
  });

  it("rejects Phase 4 negative fixtures for leakage, routes, writes, frontend, and later-phase activation", async () => {
    const mod = (await import("../../scripts/phase-context.mjs")) as unknown as PhaseContextModule;
    expect(mod.PHASE4_NEGATIVE_FIXTURES.length).toBeGreaterThanOrEqual(5);
    const categories = mod.PHASE4_NEGATIVE_FIXTURES.map((fixture) => fixture.expectedRule);
    expect(categories.join(" ")).toMatch(/provider/i);
    expect(categories.join(" ")).toMatch(/generated/i);
    expect(categories.join(" ")).toMatch(/route|uncontracted|http/i);
    expect(categories.join(" ")).toMatch(/cross-module|foreign|write/i);
    expect(categories.join(" ")).toMatch(/frontend|browser|lab|react/i);
    expect(categories.join(" ")).toMatch(/later-phase|activation|placeholder/i);
    for (const fixture of mod.PHASE4_NEGATIVE_FIXTURES) {
      expect(existsSync(join(ROOT, fixture.path)), `fixture exists: ${fixture.path}`).toBe(true);
    }

    const { execFileSync } = await import("node:child_process");
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { verifyPhase4NegativeFixtures } from './scripts/check-phase4-context.mjs'; console.log(JSON.stringify(verifyPhase4NegativeFixtures(process.cwd())));",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    const results = JSON.parse(output.trim().split("\n").at(-1) as string) as Array<{
      name: string;
      rejected: boolean;
    }>;
    expect(results.length).toBeGreaterThanOrEqual(5);
    for (const result of results) {
      expect(result.rejected, `${result.name} must be rejected`).toBe(true);
    }
  });

  it("confines placeholder privileged actors to explicit production files, never via fixture exceptions", async () => {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { scanPlaceholderPrivilegedActors } from './scripts/check-phase4-context.mjs'; console.log(JSON.stringify(scanPlaceholderPrivilegedActors(process.cwd())));",
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    const scan = JSON.parse(output.trim().split("\n").at(-1) as string) as {
      productionFiles: string[];
      unexpectedFiles: string[];
    };
    expect(scan.productionFiles).toHaveLength(0);
    expect(scan.unexpectedFiles).toEqual([]);
  });

  it("preserves exact toolchain pins and never bypasses architecture checks", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      engines: { node: string; npm: string };
      devDependencies: Record<string, string>;
    };
    expect(packageJson.engines.node).toBe("24.21.0");
    expect(packageJson.engines.npm).toBe("11.19.0");
    const gate = readFileSync(join(ROOT, "scripts", "phase4-gate.mjs"), "utf8");
    expect(gate).toMatch(/architecture-check/);
    expect(gate).not.toMatch(/--no-verify|skip.*arch|bypass.*arch/i);
    const context = readFileSync(join(ROOT, "scripts", "check-phase4-context.mjs"), "utf8");
    expect(context).toMatch(/architecture|depcruise|forbiddenSourceReasons|inspectRuntimeArchitecture/);
  });

  it("fails the Phase 4 gate on missing services, skipped checks, and stale evidence", () => {
    const gate = readFileSync(join(ROOT, "scripts", "phase4-gate.mjs"), "utf8");
    const support = readFileSync(join(ROOT, "scripts", "phase4-gate-support.mjs"), "utf8");
    expect(gate).toMatch(/requiresService/);
    expect(support).toMatch(/LOCAL_DB_UNAVAILABLE|LOCAL_AUTH_DOCKER_UNAVAILABLE/);
    expect(support).toMatch(/skippedOrPartial/i);
    expect(support).toMatch(/staleEvidence/);
    expect(gate).toMatch(/process\.exitCode\s*=\s*1/);
  });
});
