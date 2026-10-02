#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "node_modules/supabase/dist/supabase.js");
const CODEGEN = join(ROOT, "node_modules/kysely-codegen/dist/cli/bin.js");
const GENERATED = join(ROOT, "src/shared/adapters/postgres/database.generated.ts");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 600_000,
    env: options.env ?? localEnvironment(),
  });
  if (result.error || result.status !== 0) {
    throw new Error(options.errorCode ?? "PORTFOLIO_SETTINGS_COMMAND_FAILED");
  }
  return result.stdout;
}

export function localEnvironment(source = process.env) {
  const env = { ...source, CI: "1" };
  for (const key of Object.keys(env)) {
    if (/^(?:SUPABASE_|PHASE4_|DATABASE_|OWNER_GITHUB_)/.test(key)) delete env[key];
  }
  return env;
}

function requireDocker() {
  run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    timeout: 20_000,
    errorCode: "PORTFOLIO_SETTINGS_DOCKER_UNAVAILABLE",
  });
}

export function isolatedConfig(source, projectId) {
  let config = source.replace(/^project_id = .*$/m, `project_id = "${projectId}"`);
  const replacements = new Map([
    ["port = 54320", "port = 57320"],
    ["port = 54321", "port = 57321"],
    ["port = 54322", "port = 57322"],
    ["port = 54323", "port = 57323"],
    ["port = 54324", "port = 57324"],
    ["port = 54327", "port = 57327"],
    ["port = 54329", "port = 57329"],
  ]);
  for (const [from, to] of replacements) {
    if (!config.includes(from)) throw new Error("PORTFOLIO_SETTINGS_PORT_LAYOUT_CHANGED");
    config = config.replace(from, to);
  }
  return config;
}

function readDatabaseUrl(workdir) {
  const output = run(process.execPath, [CLI, "--workdir", workdir, "status", "--output", "json"], {
    timeout: 30_000,
    errorCode: "PORTFOLIO_SETTINGS_STATUS_FAILED",
  });
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("PORTFOLIO_SETTINGS_DB_URL_MISSING");
  const status = JSON.parse(output.slice(start, end + 1));
  const connectionString = status.DB_URL ?? status.db_url;
  if (typeof connectionString !== "string") throw new Error("PORTFOLIO_SETTINGS_DB_URL_MISSING");
  const url = new URL(connectionString);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || url.port !== "57322") {
    throw new Error("PORTFOLIO_SETTINGS_DB_NOT_ISOLATED");
  }
  return connectionString;
}

export function requireExecutedTests(report) {
  if (
    report.success !== true || report.numPassedTests < 1 || report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
    report.testResults?.length !== 1 || report.testResults[0].status !== "passed"
  ) throw new Error("PORTFOLIO_SETTINGS_TEST_FAILED: no missing or skipped database evidence is accepted.");
}

export function main() {
  requireDocker();
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const supabasePackage = JSON.parse(readFileSync(join(ROOT, "node_modules/supabase/package.json"), "utf8"));
  if (supabasePackage.version !== packageJson.devDependencies.supabase) {
    throw new Error("PORTFOLIO_SETTINGS_CLI_PIN_MISMATCH");
  }

  const projectId = `shipwithali-settings-${process.pid}-${randomBytes(4).toString("hex")}`;
  const workdir = mkdtempSync(join(tmpdir(), `${projectId}-`));
  const network = `${projectId}-loopback`;
  const env = localEnvironment();
  let networkCreated = false;
  let attemptedStart = false;
  let failure;
  const invoke = (args, timeout = 600_000) => run(process.execPath, [CLI, "--workdir", workdir, ...args], {
    timeout,
    env,
    errorCode: "PORTFOLIO_SETTINGS_SUPABASE_FAILED",
  });

  try {
    const supabase = join(workdir, "supabase");
    mkdirSync(supabase);
    writeFileSync(
      join(supabase, "config.toml"),
      isolatedConfig(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"), projectId),
    );
    cpSync(join(ROOT, "supabase/migrations"), join(supabase, "migrations"), { recursive: true });
    copyFileSync(join(ROOT, "supabase/seed.sql"), join(supabase, "seed.sql"));
    run("docker", ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network], {
      timeout: 20_000,
      env,
      errorCode: "PORTFOLIO_SETTINGS_NETWORK_CREATE_FAILED",
    });
    networkCreated = true;
    attemptedStart = true;
    console.log("Starting isolated loopback PostgreSQL with production migrations.");
    invoke(["start", "--network-id", network]);

    const databaseUrl = readDatabaseUrl(workdir);
    const databaseEnv = { ...env, PHASE4_SETTINGS_DATABASE_URL: databaseUrl };
    const generationArgs = [
      CODEGEN,
      "--dialect", "postgres",
      "--url", "env(PHASE4_SETTINGS_DATABASE_URL)",
      "--default-schema", "operations,portfolio_config",
      "--include-pattern", "{operations,portfolio_config}.*",
      "--date-parser", "timestamp",
      "--out-file", GENERATED,
      "--log-level", "error",
    ];
    if (!process.argv.includes("--refresh-types")) generationArgs.push("--verify");
    run(process.execPath, generationArgs, {
      env: databaseEnv,
      errorCode: process.argv.includes("--refresh-types")
        ? "PORTFOLIO_SETTINGS_TYPE_GENERATION_FAILED"
        : "PORTFOLIO_SETTINGS_TYPE_DRIFT",
    });
    const reportPath = join(workdir, "test-report.json");
    const result = spawnSync(process.execPath, [
      join(ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "tests/database/portfolio-settings.integration.test.ts",
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ], {
      cwd: ROOT,
      env: { ...databaseEnv, PHASE4_REQUIRE_SETTINGS: "1" },
      encoding: "utf8",
      timeout: 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let report;
    try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { throw new Error("PORTFOLIO_SETTINGS_TEST_REPORT_MISSING"); }
    if (result.error || result.status !== 0) {
      const messages = report.testResults?.flatMap((suite) => suite.assertionResults?.flatMap((test) => test.failureMessages ?? []) ?? []).join("\n") ?? "";
      const code = messages.match(/PORTFOLIO_SETTINGS_[A-Z_]+/)?.[0] ?? "assertion";
      throw new Error(`PORTFOLIO_SETTINGS_TEST_FAILED:${code}`);
    }
    requireExecutedTests(report);
    console.log(`Portfolio settings real PostgreSQL integration: ${report.numPassedTests} passed, 0 skipped.`);
  } catch (error) {
    failure = error;
  } finally {
    let cleanupFailed = false;
    if (attemptedStart) {
      try { invoke(["stop", "--no-backup"], 90_000); } catch { cleanupFailed = true; }
    }
    if (networkCreated) {
      const result = spawnSync("docker", ["network", "rm", network], {
        env, encoding: "utf8", timeout: 20_000, stdio: "ignore",
      });
      if (result.error || result.status !== 0) cleanupFailed = true;
    }
    const absoluteWorkdir = resolve(workdir);
    const tempRoot = resolve(tmpdir());
    if (absoluteWorkdir.startsWith(`${tempRoot}\\`) || absoluteWorkdir.startsWith(`${tempRoot}/`)) {
      rmSync(absoluteWorkdir, { recursive: true, force: true });
    }
    if (cleanupFailed) failure = new Error("PORTFOLIO_SETTINGS_CLEANUP_FAILED: isolated database resources need recovery.");
  }

  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith("PORTFOLIO_SETTINGS_")
      ? error.message
      : "PORTFOLIO_SETTINGS_RUNNER_FAILED: private diagnostics suppressed.");
    process.exitCode = 1;
  }
}
