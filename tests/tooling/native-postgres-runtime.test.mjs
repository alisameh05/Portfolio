import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireSupportedNativePostgres } from "../../scripts/native-postgres-runtime.mjs";
import { setupCiNativePostgres } from "../../scripts/setup-ci-native-postgres.mjs";

test("native PostgreSQL admission requires supported transaction timeout and catalog versions", () => {
  for (const version of ["17.9", "18.3"]) assert.equal(requireSupportedNativePostgres(version), version);
  for (const version of ["16.15", "19.0", "17", "unavailable"]) {
    assert.throws(() => requireSupportedNativePostgres(version), /NATIVE_POSTGRES_VERSION_UNSUPPORTED/u);
  }
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "p7-admission-"));
  try {
    mkdirSync(join(scratch, "supabase"));
    cpSync(join(root, "supabase/migrations"), join(scratch, "supabase/migrations"), { recursive: true });
    const trace = join(scratch, "native-calls.jsonl"), preload = join(scratch, "process-boundary.cjs");
    writeFileSync(preload, `const cp = require('node:child_process');
const original = cp.spawnSync;
cp.spawnSync = (command, args, options) => {
  const name = require('node:path').basename(command).replace(/\\.exe$/, '');
  if (['postgres', 'initdb', 'pg_ctl'].includes(name)) {
    require('node:fs').appendFileSync(process.env.NATIVE_ADMISSION_TRACE, name + '\\n');
    return { status: name === 'postgres' ? 0 : 1, stdout: name === 'postgres' ? 'postgres (PostgreSQL) 16.15' : '', stderr: '' };
  }
  if (args[0] === 'scripts/validation-environment.mjs') return { status: 0, stdout: '' };
  return original(command, args, options);
};
require('node:module').syncBuiltinESMExports();
`);
    const gitDirectory = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).trim();
    for (const script of ["phase7-events.mjs", "phase7-goal-conversions.mjs", "phase7-integration-208.mjs"]) {
      writeFileSync(trace, "");
      const child = spawnSync(process.execPath, ["--require", preload, join(root, "scripts", script)], {
        cwd: scratch, env: { ...process.env, GIT_DIR: gitDirectory, PHASE7_POSTGRES_BIN: join(scratch, "bin"), NATIVE_ADMISSION_TRACE: trace },
        encoding: "utf8", timeout: 30_000, windowsHide: true,
      });
      assert.equal(child.status, 1, `${script}: ${child.error?.code ?? child.stderr}`);
      assert.match(child.stderr, /NATIVE_POSTGRES_VERSION_UNSUPPORTED/u, script);
      assert.equal(readFileSync(trace, "utf8"), "postgres\n", `${script} must reject PostgreSQL 16 before cluster creation`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("CI native PostgreSQL setup uses signed PGDG packages and exports only a verified selected runtime", () => {
  const commands = [], writes = [];
  let version = "17.9", installStatus = 0;
  const options = {
    platform: "linux", env: { GITHUB_ACTIONS: "true", GITHUB_ENV: "/runner/env" },
    readFile: () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
    appendFile: (...args) => writes.push(args),
    run: (command, args, processOptions) => {
      commands.push({ command, args, input: processOptions?.input });
      if (command === "/usr/lib/postgresql/17/bin/postgres") return { status: 0, stdout: `postgres (PostgreSQL) ${version}\n` };
      if (command === "dpkg") return { status: 0, stdout: "amd64\n" };
      if (args.includes("postgresql-17")) return { status: installStatus };
      return { status: 0 };
    },
  };
  assert.deepEqual(setupCiNativePostgres(options), { bin: "/usr/lib/postgresql/17/bin", version: "17.9" });
  assert.ok(commands.some(({ command, args }) => command === "sudo" && args.includes("https://www.postgresql.org/media/keys/ACCC4CF8.asc")));
  assert.ok(commands.some(({ command, args, input }) => command === "sudo" && args[0] === "tee" &&
    input === "Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nArchitectures: amd64\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n"));
  assert.ok(commands.some(({ command, args }) => command === "sudo" && args.join(" ") === "apt-get install -y postgresql-17"));
  assert.deepEqual(writes, [["/runner/env", "PHASE7_POSTGRES_BIN=/usr/lib/postgresql/17/bin\n"]]);
  writes.length = 0;
  version = "16.15";
  assert.throws(() => setupCiNativePostgres(options), /NATIVE_POSTGRES_VERSION_UNSUPPORTED/u);
  assert.deepEqual(writes, []);
  version = "18.3";
  assert.throws(() => setupCiNativePostgres(options), /CI_NATIVE_POSTGRES_SELECTED_MAJOR_MISMATCH/u);
  installStatus = 1;
  assert.throws(() => setupCiNativePostgres(options), /CI_NATIVE_POSTGRES_SETUP_COMMAND_FAILED/u);
  assert.deepEqual(writes, []);
  commands.length = 0;
  assert.throws(() => setupCiNativePostgres({ ...options, platform: "win32" }), /CI_NATIVE_POSTGRES_HOST_REQUIRED/u);
  assert.throws(() => setupCiNativePostgres({ ...options, env: {} }), /CI_NATIVE_POSTGRES_HOST_REQUIRED/u);
  assert.throws(() => setupCiNativePostgres({ ...options, readFile: () => 'ID=ubuntu\nVERSION_ID="22.04"\n' }), /CI_NATIVE_POSTGRES_HOST_REQUIRED/u);
  assert.deepEqual(commands, []);
});
