import { spawnSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const COMMAND = join(ROOT, "scripts", "phase3-database-tests.mjs");

describe("Phase 3 focused database test command", () => {
  it("fails before running tests when the local database URL is missing", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env["PHASE3_DATABASE_URL"];
    delete env["PHASE3_REQUIRE_DATABASE"];

    const result = spawnSync(
      process.execPath,
      [COMMAND, "tests/database/optimistic-concurrency.test.ts"],
      { cwd: ROOT, env, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("PHASE3_DATABASE_URL_REQUIRED");
  });

  it("fails the command when Vitest reports a skipped database suite", () => {
    const fixture = join(ROOT, "tests", "database", `.phase3-skipped-${process.pid}.test.ts`);
    writeFileSync(
      fixture,
      'import { describe, it } from "vitest"; describe.skip("database", () => { it("runs", () => {}); });\n',
      "utf8",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PHASE3_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    };
    delete env["PHASE3_REQUIRE_DATABASE"];

    try {
      const result = spawnSync(process.execPath, [COMMAND, fixture.slice(ROOT.length + 1)], {
        cwd: ROOT,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("skipped");
      expect(result.stderr).toContain("skipped database suites are a failing verdict");
    } finally {
      unlinkSync(fixture);
    }
  });
});
