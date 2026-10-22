import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
const originalExecFile = cp.execFileSync;
// Map only the integration runner's release-history reads to the owned fixture commit.
cp.execFileSync = (command, args, options) => {
  const release = '978287ed7863aae3f5390596c0e91229bd546621';
  if (command === 'git' && args.join(' ') === 'ls-tree -r --name-only ' + release + ' supabase/migrations') {
    args = [...args]; args[3] = process.env.NATIVE_ADMISSION_PREDECESSOR;
  } else if (command === 'git' && args.length === 2 && args[0] === 'show' && args[1].startsWith(release + ':supabase/migrations/')) {
    args = ['show', process.env.NATIVE_ADMISSION_PREDECESSOR + args[1].slice(release.length)];
  }
  return originalExecFile(command, args, options);
};
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
    // Deliberately own only fixture history: a shallow caller need not have the release commit.
    const gitDirectory = join(scratch, ".git");
    const fixtureConfig = join(scratch, "gitconfig");
    writeFileSync(fixtureConfig, "");
    // Git location/configuration overrides from a validation container must never
    // redirect fixture writes into the caller's mounted repository metadata.
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)));
    const fixtureEnv = { ...inherited, GIT_DIR: gitDirectory, GIT_WORK_TREE: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: "",
      GIT_CONFIG_GLOBAL: fixtureConfig, GIT_CONFIG_NOSYSTEM: "1" };
    const fixtureGit = (args) => execFileSync("git", args, { cwd: scratch, env: fixtureEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    fixtureGit(["init", "--quiet"]);
    const predecessorFiles = readdirSync(join(scratch, "supabase/migrations"))
      .filter((name) => name < "20261014194925_measurement_consent.sql").map((name) => `supabase/migrations/${name}`);
    fixtureGit(["-c", "core.autocrlf=false", "add", "--", ...predecessorFiles]);
    fixtureGit(["-c", "user.name=Native admission fixture", "-c", "user.email=fixture@example.invalid",
      "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "test: create owned predecessor fixture"]);
    const predecessor = fixtureGit(["rev-parse", "HEAD"]);
    writeFileSync(join(gitDirectory, "shallow"), `${predecessor}\n`);
    assert.equal(fixtureGit(["rev-parse", "--is-shallow-repository"]), "true");
    assert.notEqual(spawnSync("git", ["cat-file", "-e", "978287ed7863aae3f5390596c0e91229bd546621"],
      { cwd: scratch, env: fixtureEnv, stdio: "ignore" }).status, 0);
    for (const script of ["phase7-events.mjs", "phase7-goal-conversions.mjs", "phase7-integration-208.mjs"]) {
      writeFileSync(trace, "");
      const child = spawnSync(process.execPath, ["--require", preload, join(root, "scripts", script)], {
        cwd: scratch, env: { ...fixtureEnv, NATIVE_ADMISSION_PREDECESSOR: predecessor,
          PHASE7_POSTGRES_BIN: join(scratch, "bin"), NATIVE_ADMISSION_TRACE: trace },
        encoding: "utf8", timeout: 30_000, windowsHide: true,
      });
      assert.equal(child.status, 1, `${script}: ${child.error?.code ?? child.stderr}`);
      assert.match(child.stderr, /NATIVE_POSTGRES_VERSION_UNSUPPORTED/u, script);
      assert.equal(readFileSync(trace, "utf8"), "postgres\n", `${script} must reject PostgreSQL 16 before cluster creation`);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("native PostgreSQL fixture isolates inherited Git paths and preserves caller metadata", () => {
  const caller = mkdtempSync(join(tmpdir(), "p7-git-caller-"));
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)));
  delete environment.NODE_TEST_CONTEXT;
  const snapshot = () => {
    const files = [];
    const visit = (directory, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name), relative = `${prefix}${entry.name}`;
        if (entry.isDirectory()) visit(path, `${relative}/`);
        else files.push([relative, createHash("sha256").update(readFileSync(path)).digest("hex")]);
      }
    };
    visit(caller);
    return files;
  };
  try {
    execFileSync("git", ["init", "--bare", "--quiet", caller], { env: environment, stdio: "pipe" });
    const index = join(caller, "caller-index"), config = join(caller, "caller-config");
    writeFileSync(index, "caller index sentinel");
    writeFileSync(config, "# caller configuration sentinel\n");
    for (const inherited of [{ GIT_COMMON_DIR: caller }, {
      GIT_COMMON_DIR: caller, GIT_OBJECT_DIRECTORY: join(caller, "objects"), GIT_INDEX_FILE: index,
      GIT_SHALLOW_FILE: join(caller, "caller-shallow"), GIT_GRAFT_FILE: join(caller, "info/grafts"),
      GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config, GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: join(caller, "hooks"), GIT_TRACE: join(caller, "caller-trace"),
    }]) {
      const before = snapshot();
      const child = spawnSync(process.execPath, ["--test", "--test-name-pattern=^native PostgreSQL admission requires",
        fileURLToPath(import.meta.url)], { env: { ...environment, ...inherited }, encoding: "utf8", timeout: 30_000, windowsHide: true });
      assert.deepEqual(snapshot(), before, "fixture Git commands must not alter caller refs, objects, index, configuration or logs");
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
    }
  } finally { rmSync(caller, { recursive: true, force: true }); }
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
