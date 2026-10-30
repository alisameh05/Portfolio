import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

for (const artifactState of ["missing", "malformed"]) {
  test(`integrated verification replaces stale passing evidence when an artifact is ${artifactState}`, () => {
    const root = mkdtempSync(join(tmpdir(), "phase8-integrated-"));
    try {
      mkdirSync(join(root, "scripts"));
      mkdirSync(join(root, "evidence"));
      for (const name of ["phase8-integrated-verification.mjs", "phase5-source-identity.mjs"]) {
        copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, "scripts", name));
      }
      // Substitute only the component command; run the real report writer and artifact reader.
      const npmCli = join(root, "component.mjs");
      writeFileSync(npmCli, "process.exitCode = 0;\n");
      const evidencePath = join(root, "evidence", "phase8-integrated-verification-256.json");
      writeFileSync(evidencePath, JSON.stringify({ runId: "stale", required: { success: true } }));
      if (artifactState === "malformed") {
        writeFileSync(join(root, "evidence", "phase8-owner-exports-241.json"), "{invalid json");
      }
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
        "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture"], { cwd: root });
      const result = spawnSync(process.execPath, [join(root, "scripts", "phase8-integrated-verification.mjs")], {
        cwd: root, encoding: "utf8", env: { ...process.env, npm_execpath: npmCli },
      });
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(readFileSync(evidencePath, "utf8"));
      assert.notEqual(report.runId, "stale");
      assert.equal(report.required.success, false);
      assert.equal(report.cleanup, false);
      assert.equal(report.runs.length, 1);
      assert.deepEqual(report.runs[0].testResults, []);
      assert.equal(report.runs[0].cleanupVerified, false);
      assert.match(report.runs[0].error, artifactState === "missing" ? /ENOENT/u : /JSON/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
