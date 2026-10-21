import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd();
const runId = randomUUID();
const privacyAcceptance = process.argv.includes("--privacy");
const refreshTypes = process.argv.includes("--refresh-types");
const initialSource = workingTreeSourceSha256();
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 180_000 });
  if (result.error || result.status !== 0) throw new Error(`DAILY_AGGREGATE_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}`);
  return result.stdout;
}

const temp = join(tmpdir(), `portfolio-daily-aggregates-${privacyAcceptance ? "203" : "202"}-${runId}`);
const data = join(temp, "data");
const reportPath = resolve(`artifacts/daily-aggregates-${privacyAcceptance ? "203" : "202"}-vitest.json`);
const evidencePath = resolve(`evidence/phase7-${privacyAcceptance ? "aggregate-privacy-203" : "daily-aggregates-202"}.json`);
mkdirSync(temp, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
rmSync(evidencePath, { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolvePort(value));
  });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let started = false;
let connected = false;
let result;
let cleanup = false;
let stage = "runtime";

try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const postgresVersion = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  started = true;
  mkdirSync(join(temp, "socket"), { recursive: true });
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F -k ${join(temp, "socket")}`, "-w", "start"]);
  await admin.connect();
  connected = true;
  stage = "baseline";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) {
    stage = `migration:${name}`;
    await admin.query(readFileSync(join("supabase/migrations", name), "utf8"));
  }
  await admin.query("create role aggregate_app_runtime login nosuperuser nobypassrls; grant shipwithali_application to aggregate_app_runtime; create role aggregate_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to aggregate_worker_runtime");
  const env = { ...process.env,
    PHASE7_AGGREGATE_DATABASE_URL: `postgres://aggregate_app_runtime@127.0.0.1:${port}/postgres?sslmode=disable`,
    PHASE7_AGGREGATE_ADMIN_URL: `${adminUrl}?sslmode=disable`,
  };
  stage = "type-generation";
  const typeFile = "src/modules/measurement/adapters/database.generated.ts";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_AGGREGATE_ADMIN_URL)",
    "--default-schema", "measurement", "--include-pattern", "measurement.*", "--date-parser", "timestamp", "--out-file", typeFile, "--log-level", "error"];
  if (!refreshTypes) codegen.push("--verify");
  run(process.execPath, codegen, env);
  const testedSource = workingTreeSourceSha256();
  if (!refreshTypes && testedSource !== initialSource) throw new Error("DAILY_AGGREGATE_SOURCE_CHANGED_BEFORE_ACCEPTANCE");

  stage = "acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/daily-aggregates.test.ts", "tests/phase7/daily-aggregates-postgres.test.ts",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== 23 || assertions.length !== 23 || tests.testResults.length !== 2 ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("DAILY_AGGREGATE_ACCEPTANCE_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("DAILY_AGGREGATE_SOURCE_CHANGED_DURING_ACCEPTANCE");

  const migrationName = privacyAcceptance ? "supabase/migrations/20261015200000_enable_fixed_aggregate_dimensions.sql" :
    "supabase/migrations/20261015190000_persist_reproducible_daily_aggregates.sql";
  const migrationHashes = migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") }));
  result = {
    ticket: privacyAcceptance ? 203 : 202,
    runId,
    sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(),
    sourceTreeSha256: testedSource,
    postgresVersion,
    migration: migrationName,
    migrationSha256: createHash("sha256").update(readFileSync(migrationName)).digest("hex"),
    migrations: migrationHashes,
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    assertions: assertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
    databaseRoles: ["aggregate_app_runtime", "aggregate_worker_runtime", "shipwithali_application", "shipwithali_worker", "anon", "authenticated"],
    reproduction: `npm run setup:validation; npm run validation:ready; npm run phase7:focus:${privacyAcceptance ? "aggregate-privacy" : "daily-aggregates"} (use --refresh-types only when regenerating database.generated.ts)`,
    scope: "All committed repository migrations on a disposable native PostgreSQL cluster; source-bound unit and real-PostgreSQL acceptance.",
  };
  console.log(JSON.stringify({ required: result.required, runId, sourceTreeSha256: testedSource }));
} catch (error) {
  console.error(error instanceof Error && /^DAILY_AGGREGATE_/.test(error.message) ? error.message : "DAILY_AGGREGATE_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status })) }));
  } catch { /* no report exists */ }
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(temp, { recursive: true, force: true });
    cleanup = true;
  } catch {
    console.error("DAILY_AGGREGATE_CLEANUP_FAILED");
    process.exitCode = 1;
  }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: `evidence/phase7-${privacyAcceptance ? "aggregate-privacy-203" : "daily-aggregates-202"}.json`, cleanup }));
  }
}
