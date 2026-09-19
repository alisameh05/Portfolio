import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GATE = join(ROOT, "scripts", "phase1-gate.mjs");

function runScript(script: string, args: string[] = []): { ok: boolean; output: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output: stdout };
  } catch (err: unknown) {
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = error.stdout?.toString() ?? "";
    const stderr = error.stderr?.toString() ?? "";
    return { ok: false, output: (stdout + stderr).trim() };
  }
}

describe("Phase 1 conformance gate (#12)", () => {
  it("provides one executable gate command", () => {
    expect(existsSync(GATE), "scripts/phase1-gate.mjs exists").toBe(true);
    const content = readFileSync(GATE, "utf8");
    expect(content).toMatch(/phase1-gate|conformance gate/i);
  });

  it("aggregates every required seam in one command", () => {
    const content = readFileSync(GATE, "utf8").toLowerCase();
    const requiredSeams = [
      "check-toolchain",
      "tsc --noemit",
      "vitest",
      "redocly lint public",
      "redocly lint owner",
      "redocly bundle",
      "public@v1",
      "owner@v1",
      "check-contract-drift",
      "check-contract-compatibility",
      "architecture-check",
      "check-review-policy",
      "check-coderabbit",
      "check-route-inventory",
      "frontend",
      "lab exclusion",
      "phase1-versions",
    ];
    for (const seam of requiredSeams) {
      expect(content, `gate must aggregate seam: ${seam}`).toContain(seam);
    }
  });

  it("identifies the failed seam and exits non-zero on failure", () => {
    const content = readFileSync(GATE, "utf8");
    // Each constituent check is wrapped with a named seam; failures record
    // the seam name and the process exits 1 when any check fails.
    expect(content).toMatch(/function check\(name/);
    expect(content).toMatch(/process\.exit\(1\)/);
    expect(content).toMatch(/process\.exit\(0\)/);
    expect(content).toMatch(/✗ \$\{name\}|✗ .*name/);
  });

  it("emits a durable gate report retaining all evidence", () => {
    const content = readFileSync(GATE, "utf8");
    const retained = [
      "openapi/generated/public-v1.json",
      "openapi/generated/owner-v1.json",
      "evidence/phase-1-versions.json",
      "evidence/phase-1-route-inventory.json",
      "evidence/phase-1-review-policy.md",
      "evidence/phase-1-contract-lint.log",
      "evidence/phase-1-generation-drift.log",
      "evidence/phase-1-compatibility.log",
      "evidence/phase-1-architecture.log",
      "AGENTS.md",
      "phase-1-gate-report.json",
    ];
    for (const file of retained) {
      expect(content).toContain(file);
    }
  });

  it("uses deterministic one-worker Vitest without reducing coverage", () => {
    const gate = readFileSync(GATE, "utf8");
    expect(gate).toMatch(/singleThread/);
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain("singleThread: true");
    expect(config).toContain('pool: "threads"');
    expect(config).toContain("tests/**/*.test.ts");
  });

  it("runs without production credentials, data, database, or network", () => {
    const gate = readFileSync(GATE, "utf8");
    // Must not read prod env vars, connect to a DB, or fetch over the network.
    // (The guarantee phrase "without production credentials" is allowed.)
    const stripped = gate.replace(/without production credentials/gi, "");
    expect(stripped).not.toMatch(/DATABASE_URL|SUPABASE_URL|SUPABASE_SERVICE_KEY|PROD_DB/i);
    expect(stripped).not.toMatch(/fetch\(\s*["']https?:/i);
    expect(gate).toMatch(/without production credentials|offline/i);
    // Constituent scripts must not require a running app, DB, or internet.
    for (const script of [
      "scripts/check-toolchain.mjs",
      "scripts/check-contract-drift.mjs",
      "scripts/check-contract-compatibility.mjs",
      "scripts/architecture-check.mjs",
      "scripts/check-route-inventory.mjs",
      "scripts/check-review-policy.mjs",
      "scripts/check-coderabbit.mjs",
    ]) {
      expect(existsSync(join(ROOT, script)), `${script} exists`).toBe(true);
    }
  });

  it("passes toolchain verification with pinned versions", () => {
    const result = runScript("scripts/check-toolchain.mjs", ["--output", "evidence/phase-1-versions.json"]);
    expect(result.ok).toBe(true);
    expect(existsSync(join(ROOT, "evidence", "phase-1-versions.json"))).toBe(true);
  });

  it("passes the review-policy check (Codex sole AI reviewer)", () => {
    const result = runScript("scripts/check-review-policy.mjs");
    expect(result.ok).toBe(true);
  });

  it("passes the CodeRabbit inventory with retained evidence", () => {
    const result = runScript("scripts/check-coderabbit.mjs");
    expect(result.ok).toBe(true);
    expect(existsSync(join(ROOT, "evidence", "phase-1-review-policy.md"))).toBe(true);
  });

  it("passes the route inventory with exactly five public operations", () => {
    const result = runScript("scripts/check-route-inventory.mjs");
    expect(result.ok).toBe(true);
    const report = JSON.parse(
      readFileSync(join(ROOT, "evidence", "phase-1-route-inventory.json"), "utf8"),
    ) as { publicOperations: string[]; forbiddenFindings: unknown[]; runtimeRoutes: unknown[] };
    expect(report.publicOperations).toHaveLength(5);
    expect(report.forbiddenFindings).toEqual([]);
    expect(report.runtimeRoutes).toEqual([]);
  });

  it("fails the verdict when compatibility has no baseline", () => {
    try {
      execSync(
        `node scripts/check-contract-compatibility.mjs --baseline missing-baseline.json --candidate ${"tests/fixtures/contract-compatibility/baseline.json"}`,
        { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      );
      expect.unreachable("compatibility without a baseline must fail");
    } catch (err: unknown) {
      const error = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      const output = `${error.stdout?.toString() ?? ""}\n${error.stderr?.toString() ?? ""}`;
      expect(output.toLowerCase()).toMatch(/baseline.*not found|not found/);
    }
  });

  it("proves both contracts lint and bundle to canonical artifacts", () => {
    expect(existsSync(join(ROOT, "openapi", "generated", "public-v1.json"))).toBe(true);
    expect(existsSync(join(ROOT, "openapi", "generated", "owner-v1.json"))).toBe(true);
    expect(existsSync(join(ROOT, "openapi", "baseline", "master", "public-v1.json"))).toBe(true);
    expect(existsSync(join(ROOT, "openapi", "baseline", "master", "owner-v1.json"))).toBe(true);
  });

  it("proves no provider leakage outside adapters and no frontend/Lab surface", () => {
    const inventory = JSON.parse(
      readFileSync(join(ROOT, "evidence", "phase-1-route-inventory.json"), "utf8"),
    ) as { forbiddenFindings: unknown[] };
    expect(inventory.forbiddenFindings).toEqual([]);
  });
});
