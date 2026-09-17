import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

const NINE_MODULES = [
  "portfolio-configuration",
  "content-publishing",
  "taxonomy-discovery",
  "media",
  "cv-portfolio",
  "interaction-moderation",
  "measurement",
  "identity-access",
  "portability-operations",
] as const;

function runDepcruise(targetPath: string): { ok: boolean; output: string } {
  try {
    const output = execSync(
      `npx depcruise ${targetPath} --config .dependency-cruiser.cjs --output-type err-long`,
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { ok: true, output };
  } catch (err: unknown) {
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = error.stdout?.toString() ?? "";
    const stderr = error.stderr?.toString() ?? "";
    return { ok: false, output: (stdout + stderr).trim() };
  }
}

function scanAllFiles(dir: string): string[] {
  const results: string[] = [];
  try {
    const list = readdirSync(dir);
    for (const item of list) {
      const full = join(dir, item);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        results.push(...scanAllFiles(full));
      } else {
        results.push(full);
      }
    }
  } catch {
    // skip unreadable
  }
  return results;
}

describe("Nine Module Skeletons Structure", () => {
  for (const moduleName of NINE_MODULES) {
    it(`should contain full skeleton structure for module: ${moduleName}`, () => {
      const moduleDir = join(ROOT, "src", "modules", moduleName);
      expect(existsSync(moduleDir), `Module dir ${moduleName} exists`).toBe(true);

      const subdirs = ["domain", "application", "ports", "adapters"];
      for (const sub of subdirs) {
        const subDir = join(moduleDir, sub);
        expect(existsSync(subDir), `Subdir ${moduleName}/${sub} exists`).toBe(true);
      }

      const barrel = join(moduleDir, "index.ts");
      expect(existsSync(barrel), `Barrel ${moduleName}/index.ts exists`).toBe(true);
    });
  }
});

describe("Module Skeletons Purity and Isolation Invariants", () => {
  const modulesDir = join(ROOT, "src", "modules");
  const allFiles = scanAllFiles(modulesDir);

  it("must contain no JSX or TSX UI surface", () => {
    const jsxFiles = allFiles.filter((f) => /\.(?:tsx|jsx)$/.test(f));
    expect(jsxFiles).toEqual([]);
  });

  it("must contain no Route Handlers inside module skeletons", () => {
    const routeFiles = allFiles.filter((f) => /(?:^|[\\/])route\.(?:ts|js)$/.test(f));
    expect(routeFiles).toEqual([]);
  });

  it("must contain no active SQL persistence statements", () => {
    const sqlViolations: string[] = [];
    for (const file of allFiles) {
      const content = readFileSync(file, "utf8");
      if (/\b(?:SELECT\s+.+\s+FROM|INSERT\s+INTO\s+|DELETE\s+FROM\s+|UPDATE\s+.+\s+SET)\b/i.test(content)) {
        sqlViolations.push(file);
      }
    }
    expect(sqlViolations).toEqual([]);
  });

  it("must contain no provider package imports in modules", () => {
    const providerViolations: string[] = [];
    for (const file of allFiles) {
      const content = readFileSync(file, "utf8");
      if (/from\s+["'](?:@supabase\/|kysely|@vercel\/|next\/)/i.test(content)) {
        providerViolations.push(file);
      }
    }
    expect(providerViolations).toEqual([]);
  });

  it("must contain no Lab entry implementation in modules (ADR-0007)", () => {
    const labViolations: string[] = [];
    for (const file of allFiles) {
      const content = readFileSync(file, "utf8");
      if (/\b(?:class|function|interface)\s+LabEntry\b/i.test(content)) {
        labViolations.push(file);
      }
    }
    expect(labViolations).toEqual([]);
  });
});

describe("Architecture Checker Dependency Rules Enforcement", () => {
  it("passes clean dependency check for src/ with 0 violations", () => {
    const result = runDepcruise("src");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no dependency violations found");
  });

  it("rejects provider-leakage fixture with rule: no-provider-in-domain", () => {
    const result = runDepcruise("tests/fixtures/invalid-deps/provider-leakage");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no-provider-in-domain");
  });

  it("rejects generated-code-leakage fixture with rule: no-generated-code-leakage", () => {
    const result = runDepcruise("tests/fixtures/invalid-deps/generated-code-leakage");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no-generated-code-leakage");
  });

  it("rejects deep-cross-module-import fixture with rule: no-deep-cross-module-import", () => {
    const result = runDepcruise("tests/fixtures/invalid-deps/deep-cross-module-import");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no-deep-cross-module-import");
  });

  it("rejects cycle fixture with rule: no-cycles", () => {
    const result = runDepcruise("tests/fixtures/invalid-deps/cycle");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("no-cycles");
  });
});
