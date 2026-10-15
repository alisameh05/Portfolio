import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd();
const runId = randomUUID();
const startingSource = workingTreeSourceSha256();
const refreshTypes = process.argv.includes("--refresh-types");
const reportPath = resolve("artifacts/goal-conversions-vitest.json");
const evidencePath = resolve("evidence/phase7-goal-conversions-201.json");
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 180_000 });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").slice(-1_000)
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ");
    throw new Error(`GOAL_CONVERSION_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

const cacheRoot = resolve(root, "node_modules", ".cache");
mkdirSync(cacheRoot, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
if (!refreshTypes) rmSync(evidencePath, { force: true });
const temp = mkdtempSync(join(cacheRoot, "portfolio-goal-conversions-201-"));
const safeTemp = resolve(temp);
if (!safeTemp.startsWith(`${cacheRoot}${sep}`)) throw new Error("GOAL_CONVERSION_TEMP_PATH_INVALID");
const data = join(temp, "data");
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let started = false, connected = false, cleanup = false, result, stage = "runtime";
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const postgresVersion = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  started = true;
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await admin.connect(); connected = true;
  stage = "baseline";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  const migrationFile = "20261015180000_match_analytics_goal_conversions.sql";
  if (!migrations.includes(migrationFile)) throw new Error("GOAL_CONVERSION_MIGRATION_MISSING");
  const project = join(temp, "migration-project");
  mkdirSync(join(project, "supabase/migrations"), { recursive: true });
  copyFileSync("supabase/config.toml", join(project, "supabase/config.toml"));
  for (const name of migrations) copyFileSync(join("supabase/migrations", name), join(project, "supabase/migrations", name));
  stage = "migrations";
  run(process.execPath, ["node_modules/supabase/dist/supabase.js", "migration", "up", "--db-url", `${adminUrl}?sslmode=disable`, "--workdir", project, "--yes"],
    { ...process.env, SUPABASE_TELEMETRY_DISABLED: "true" });
  await admin.query("create role conversion_runtime login nosuperuser nobypassrls; grant shipwithali_worker to conversion_runtime");
  const env = { ...process.env, PHASE7_CONVERSION_DATABASE_URL: `postgres://conversion_runtime@127.0.0.1:${port}/postgres?sslmode=disable`,
    PHASE7_CONVERSION_ADMIN_URL: `${adminUrl}?sslmode=disable` };
  stage = "type-generation";
  const typeFile = "src/modules/measurement/adapters/database.generated.ts";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_CONVERSION_ADMIN_URL)",
    "--default-schema", "measurement", "--include-pattern", "measurement.*", "--date-parser", "timestamp", "--out-file", typeFile, "--log-level", "error"];
  if (!refreshTypes) codegen.push("--verify");
  run(process.execPath, codegen, env);
  if (refreshTypes) {
    console.log("Generated Measurement database types from the disposable migration chain.");
  } else {
    const testedSource = workingTreeSourceSha256();
    if (testedSource !== startingSource) throw new Error("GOAL_CONVERSION_SOURCE_CHANGED_DURING_SETUP");
    stage = "acceptance";
    run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/goal-conversions.test.ts", "tests/phase7/goal-conversions-postgres.test.ts",
      "--reporter=json", `--outputFile=${reportPath}`], env);
    const tests = JSON.parse(readFileSync(reportPath, "utf8"));
    const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
    if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
        tests.numPassedTests !== assertions.length || tests.testResults.length !== 2 || tests.testResults.some(suite => suite.status !== "passed") ||
        assertions.some(assertion => assertion.status !== "passed")) throw new Error("GOAL_CONVERSION_ACCEPTANCE_INCOMPLETE");
    if (workingTreeSourceSha256() !== testedSource) throw new Error("GOAL_CONVERSION_SOURCE_CHANGED_DURING_RUN");
    const migrationSha256 = createHash("sha256").update(readFileSync(join("supabase/migrations", migrationFile))).digest("hex");
    result = {
      ticket: 201, runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource,
      node: process.version, npm: /^npm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? "unknown", postgres: postgresVersion,
      migration: { id: migrationFile, sha256: migrationSha256 },
      required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
        todo: tests.numTodoTests, failedSuites: tests.numFailedTestSuites },
      suites: tests.testResults.map(suite => ({ name: suite.name.replace(root, ""), passed: suite.assertionResults?.length ?? 0 })),
      roles: ["conversion_runtime", "shipwithali_worker", "anon", "authenticated"],
      criteria: {
        "T14-01": ["single and multi-step event, route, Project, order and same-subject fixtures"],
        "T14-02": ["unrelated intervening events accepted; reversed, cross-subject, mis-scoped and metadata-only evidence rejected"],
        "T14-03": ["inclusive 30-minute boundary and expired partial reset"],
        "T14-04": ["terminal/goal-version uniqueness across job retry, checkpoint resume and generation recomputation"],
        "T14-05": ["half-open activation intervals, tied activation sequence and version-switch reset"],
        "T14-06": ["late event recomputation and stale/replayed job preserve canonical ordered output"],
        "T14-07": ["withdrawal/regrant revision change resets progress; worker reads current consent"],
        "T14-08": ["authorized worker, real PostgreSQL persistence, bounded batch and atomic injected rollback"]
      },
      reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:goal-conversions (PHASE7_POSTGRES_BIN selects installed PostgreSQL binaries)",
      scope: "Full repository migration chain in a loopback-only disposable native PostgreSQL cluster with a restricted non-superuser worker role. No production or development database was modified."
    };
  }
} catch (error) {
  const message = error instanceof Error && /^GOAL_CONVERSION_/.test(error.message) ? error.message :
    `GOAL_CONVERSION_VALIDATION_FAILED:${String(error?.message ?? "unavailable").replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").slice(0, 250)}`;
  console.error(message);
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status,
        ...(assertion.status === "passed" ? {} : { failure: (assertion.failureMessages ?? []).join(" ").slice(0, 1_000) }) })) }));
  } catch {}
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(safeTemp, { recursive: true, force: true }); cleanup = true;
  } catch { console.error("GOAL_CONVERSION_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup && !refreshTypes) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
    console.log(JSON.stringify({ required: result.required, cleanup }));
  }
}
