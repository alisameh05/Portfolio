import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("source identity works without remotes and detects source changes independently of staging", () => {
  const root = mkdtempSync(join(tmpdir(), "portfolio-source-identity-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "evidence"));
    copyFileSync(new URL("../../scripts/phase5-source-identity.mjs", import.meta.url), join(root, "scripts/phase5-source-identity.mjs"));
    writeFileSync(join(root, "source.txt"), "first\n");
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "fixture");
    const hash = () => {
      const moduleUrl = pathToFileURL(join(root, "scripts/phase5-source-identity.mjs")).href;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import { workingTreeSourceSha256 } from ${JSON.stringify(moduleUrl)}; console.log(workingTreeSourceSha256());`],
      { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const original = hash();
    assert.match(original, /^[a-f0-9]{64}$/u);
    writeFileSync(join(root, "evidence/report.json"), "{\"verdict\":\"pass\"}\n");
    assert.equal(hash(), original);
    writeFileSync(join(root, "source.txt"), "second\n");
    const changed = hash();
    assert.notEqual(changed, original);
    git("add", ".");
    assert.equal(hash(), changed);
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "changed");
    assert.equal(hash(), changed);
    writeFileSync(join(root, "new.txt"), "new source\n");
    const untracked = hash();
    assert.notEqual(untracked, changed);
    git("add", "new.txt");
    assert.equal(hash(), untracked);
    rmSync(join(root, "source.txt"));
    const deleted = hash();
    assert.notEqual(deleted, untracked);
    git("add", "source.txt");
    assert.equal(hash(), deleted);
    git("remote", "add", "origin", "https://example.test/repo.git");
    git("update-ref", "refs/remotes/origin/master", "HEAD");
    assert.equal(hash(), deleted);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
