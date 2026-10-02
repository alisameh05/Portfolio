import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fingerprint, observeRuntime, verifyEnvironment, writeInstallStamp } from "../../scripts/validation-environment.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "validation-environment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pkg = { engines: { node: "24.21.0", npm: "11.19.0" }, packageManager: "npm@11.19.0", dependencies: { pg: "8.23.0" }, devDependencies: { typescript: "6.0.3" } };
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, ".nvmrc"), "24.21.0\n");
  const runtime = { node: "24.21.0", npm: "11.19.0" };
  const install = () => {
    for (const [name, version] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      mkdirSync(join(root, "node_modules", name), { recursive: true });
      writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ version }));
    }
    writeInstallStamp(root);
  };
  return { root, runtime, install };
}

test("rejects Node 20 and mismatched npm before installation", (t) => {
  const { root } = fixture(t);
  const errors = verifyEnvironment(root, { node: "20.19.0", npm: "10.8.2" }, { runtimeOnly: true });
  assert.match(errors.join("\n"), /VALIDATION_NODE_MISMATCH/);
  assert.match(errors.join("\n"), /VALIDATION_NPM_MISMATCH/);
});

test("runtime-only preflight works before dependencies exist", (t) => {
  const { root, runtime } = fixture(t);
  assert.deepEqual(verifyEnvironment(root, runtime, { runtimeOnly: true }), []);
});

test("reads exact npm from lifecycle metadata without spawning another process", () => {
  assert.deepEqual(observeRuntime({ npm_config_user_agent: "npm/11.19.0 node/v24.21.0 win32 x64" }), {
    node: process.versions.node,
    npm: "11.19.0",
  });
  assert.equal(observeRuntime({}).npm, "unknown");
});

test("rejects missing development dependencies even with an installation stamp", (t) => {
  const { root, runtime, install } = fixture(t);
  install();
  rmSync(join(root, "node_modules", "typescript"), { recursive: true });
  assert.match(verifyEnvironment(root, runtime).join("\n"), /VALIDATION_DEPENDENCY_MISMATCH: typescript/);
});

test("rejects cached dependencies after lockfile changes", (t) => {
  const { root, runtime, install } = fixture(t);
  install();
  const before = fingerprint(root);
  writeFileSync(join(root, "package-lock.json"), '{"changed":true}');
  assert.notEqual(fingerprint(root), before);
  assert.match(verifyEnvironment(root, runtime).join("\n"), /VALIDATION_INSTALL_STALE/);
});

test("requires successful setup and exact installed versions", (t) => {
  const { root, runtime, install } = fixture(t);
  assert.match(verifyEnvironment(root, runtime).join("\n"), /VALIDATION_INSTALL_STALE/);
  install();
  assert.deepEqual(verifyEnvironment(root, runtime), []);
  writeFileSync(join(root, "node_modules", "pg", "package.json"), '{"version":"8.22.0"}');
  assert.match(verifyEnvironment(root, runtime).join("\n"), /VALIDATION_DEPENDENCY_MISMATCH: pg/);
});

test("a registry install failure cannot leave a previously ready environment", (t) => {
  const { root, runtime, install } = fixture(t);
  install();
  mkdirSync(join(root, "scripts"));
  for (const name of ["setup-validation.mjs", "validation-environment.mjs"]) {
    copyFileSync(new URL(`../../scripts/${name}`, import.meta.url), join(root, "scripts", name));
  }
  const cli = join(root, "npm-cli.mjs");
  writeFileSync(cli, 'if (process.argv[2] === "--version") console.log("11.19.0"); else { console.error("HTTP 403"); process.exitCode = 23; }');
  const result = spawnSync(process.execPath, [join(root, "scripts", "setup-validation.mjs")], {
    cwd: root, encoding: "utf8", env: {
      ...process.env,
      npm_config_user_agent: "npm/11.19.0 node/v24.21.0 win32 x64",
      npm_execpath: cli,
    },
  });
  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /VALIDATION_INSTALL_FAILED/);
  assert.equal(existsSync(join(root, "node_modules", ".shipwithali-validation.json")), false);
  assert.match(verifyEnvironment(root, runtime).join("\n"), /VALIDATION_INSTALL_STALE/);
});
