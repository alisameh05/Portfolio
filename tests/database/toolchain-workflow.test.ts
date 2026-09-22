import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const expectedPins = {
  dependencies: {
    kysely: "0.29.6",
    pg: "8.23.0",
  },
  devDependencies: {
    "@types/pg": "8.23.1",
    "kysely-codegen": "0.20.0",
    supabase: "2.117.0",
  },
} as const;

function runNode(...args: string[]) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
}

describe("Phase 3 local PostgreSQL toolchain (#45)", () => {
  it("pins the reviewed database packages exactly in both manifests", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lockfile = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<
        string,
        { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; version?: string }
      >;
    };

    expect(packageJson.dependencies).toMatchObject(expectedPins.dependencies);
    expect(packageJson.devDependencies).toMatchObject(expectedPins.devDependencies);
    expect(lockfile.packages[""]?.dependencies).toMatchObject(expectedPins.dependencies);
    expect(lockfile.packages[""]?.devDependencies).toMatchObject(expectedPins.devDependencies);

    for (const [name, version] of Object.entries({
      ...expectedPins.dependencies,
      ...expectedPins.devDependencies,
    })) {
      expect(lockfile.packages[`node_modules/${name}`]?.version, name).toBe(version);
    }
  });

  it("exposes one repository-owned local lifecycle command surface", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts).toMatchObject({
      "db:verify": "node scripts/check-database-toolchain.mjs",
      "db:start": "node scripts/local-database.mjs start",
      "db:status": "node scripts/local-database.mjs status",
      "db:reset": "node scripts/local-database.mjs reset",
      "db:reuse": "node scripts/local-database.mjs reuse",
      "db:stop": "node scripts/local-database.mjs stop",
    });
  });

  it("plans only local Supabase operations through the pinned project dependency", () => {
    const expectedPlans = {
      start: ["start"],
      status: ["status", "--output", "json"],
      reset: ["db", "reset", "--local"],
      reuse: ["start"],
      stop: ["stop"],
    } as const;

    for (const [action, args] of Object.entries(expectedPlans)) {
      const result = runNode("scripts/local-database.mjs", action, "--plan");
      expect(result.status, result.stderr).toBe(0);
      const plan = JSON.parse(result.stdout) as {
        source: string;
        package: string;
        args: string[];
      };
      expect(plan).toEqual({
        source: "project-local",
        package: "supabase@2.117.0",
        args,
      });
      expect(result.stdout).not.toMatch(/--linked|project-ref|access[_-]?token|password/i);
    }
  });

  it("commits local configuration and an explicitly non-secret seed", () => {
    const config = readFileSync(join(ROOT, "supabase", "config.toml"), "utf8");
    const seed = readFileSync(join(ROOT, "supabase", "seed.sql"), "utf8");

    expect(config).toMatch(/^project_id\s*=\s*"shipwithali-portfolio"/m);
    expect(config).toMatch(/^\[db\.migrations\]$/m);
    expect(config).toMatch(/^\[db\.seed\]$/m);
    expect(config).toMatch(/^sql_paths\s*=\s*\["\.\/seed\.sql"\]$/m);
    expect(`${config}\n${seed}`).not.toMatch(
      /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SERVICE_ROLE_KEY)\s*=\s*\S+/i,
    );
    expect(seed).toContain("intentionally contains no data");
  });

  it("documents clean setup, inspection, reset, reuse, and shutdown without remote commands", () => {
    const guide = readFileSync(join(ROOT, "docs", "phase3-local-database.md"), "utf8");

    for (const command of [
      "npm ci",
      "npm run db:verify",
      "npm run db:start",
      "npm run db:status",
      "npm run db:reset",
      "npm run db:reuse",
      "npm run db:stop",
    ]) {
      expect(guide).toContain(command);
    }
    expect(guide).not.toMatch(/supabase\s+(?:login|link)|db\s+(?:push|pull|reset\s+--linked)/i);
  });

  it("passes the focused offline toolchain verification without exposing credentials", () => {
    const result = runNode("scripts/check-database-toolchain.mjs", "--check-only");
    expect(result.status, result.stderr).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Phase 3 database toolchain verification passed",
    );
    expect(`${result.stdout}\n${result.stderr}`).not.toMatch(
      /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@|SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD|SERVICE_ROLE_KEY)\s*=\s*\S+/i,
    );
  });
});
