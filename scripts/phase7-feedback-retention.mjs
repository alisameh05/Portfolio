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
const refreshTypes = process.argv.includes("--refresh-types");
const initialSource = workingTreeSourceSha256();
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 240_000 });
  if (result.error || result.status !== 0) {
    if (args[0]?.includes("vitest")) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
    throw new Error(`FEEDBACK_RETENTION_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}`);
  }
  return result.stdout;
}

const temp = join(tmpdir(), `portfolio-feedback-retention-205-${runId}`);
const data = join(temp, "data");
const reportPath = resolve("artifacts/feedback-retention-vitest.json");
const evidencePath = resolve("evidence/phase7-feedback-retention-205.json");
mkdirSync(temp, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
rmSync(evidencePath, { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let started = false, connected = false, cleanup = false, stage = "runtime", result;
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const postgresVersion = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  mkdirSync(join(temp, "socket"), { recursive: true });
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F -k ${join(temp, "socket")}`, "-w", "start"]);
  started = true;
  await admin.connect(); connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  await admin.query("create role feedback_retention_app_runtime login nosuperuser nobypassrls; grant shipwithali_application to feedback_retention_app_runtime; create role feedback_retention_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to feedback_retention_worker_runtime");
  const env = { ...process.env,
    PHASE7_FEEDBACK_RETENTION_WORKER_URL: `postgres://feedback_retention_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`,
    PHASE7_FEEDBACK_RETENTION_APP_URL: `postgres://feedback_retention_app_runtime@127.0.0.1:${port}/postgres?sslmode=disable`,
    PHASE7_FEEDBACK_RETENTION_ADMIN_URL: `${adminUrl}?sslmode=disable`,
  };
  stage = "type-generation";
  const typeFile = "src/modules/interaction-moderation/adapters/database.generated.ts";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_FEEDBACK_RETENTION_ADMIN_URL)",
    "--default-schema", "interaction", "--include-pattern", "interaction.*", "--date-parser", "timestamp", "--out-file", typeFile, "--log-level", "error"];
  if (!refreshTypes) codegen.push("--verify");
  run(process.execPath, codegen, env);
  const testedSource = workingTreeSourceSha256();
  if (!refreshTypes && testedSource !== initialSource) throw new Error("FEEDBACK_RETENTION_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/feedback-retention.test.ts", "tests/phase7/feedback-retention-postgres.test.ts",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== 12 || assertions.length !== 12 || tests.testResults.length !== 2 ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("FEEDBACK_RETENTION_ACCEPTANCE_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("FEEDBACK_RETENTION_SOURCE_CHANGED_DURING_ACCEPTANCE");
  const migrationName = "supabase/migrations/20261015203000_retain_feedback_privacy.sql";
  result = {
    ticket: 205, runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, postgresVersion,
    migration: migrationName, migrationSha256: createHash("sha256").update(readFileSync(migrationName)).digest("hex"),
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    assertions: assertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
    databaseRoles: ["feedback_retention_app_runtime", "feedback_retention_worker_runtime", "shipwithali_application", "shipwithali_worker", "anon", "authenticated"],
    criteria: ["T18-01", "T18-02", "T18-03", "T18-04", "T18-05", "T18-06", "T18-07", "T18-08", "T18-09"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:feedback-retention (use --refresh-types only when regenerating database.generated.ts)",
    scope: "All repository migrations on disposable native PostgreSQL with app/worker RLS roles; exact cutoffs, moderation race, bounded restart, rollback and privacy audit.",
  };
  console.log(JSON.stringify({ required: result.required, runId, sourceTreeSha256: testedSource }));
} catch (error) {
  console.error(error instanceof Error && /^FEEDBACK_RETENTION_/.test(error.message) ? error.message : "FEEDBACK_RETENTION_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status })) }));
  } catch { /* no report exists */ }
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try { if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); rmSync(temp, { recursive: true, force: true }); cleanup = true; }
  catch { console.error("FEEDBACK_RETENTION_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: evidencePath, cleanup }));
  }
}
