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
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n")
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000);
    throw new Error(`PHASE7_JOBS_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

const temp = join(tmpdir(), `portfolio-phase7-jobs-${runId}`);
const data = join(temp, "data");
const reportPath = resolve("artifacts/phase7-jobs-vitest.json");
const evidencePath = resolve("evidence/phase7-due-work-206.json");
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
  started = true;
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await admin.connect(); connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  await admin.query("create role due_work_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to due_work_worker_runtime");
  const workerUrl = `postgres://due_work_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const env = { ...process.env, PHASE7_JOBS_WORKER_URL: workerUrl,
    PHASE7_JOBS_SECOND_WORKER_URL: workerUrl, PHASE7_JOBS_ADMIN_URL: `${adminUrl}?sslmode=disable` };
  stage = "type-generation";
  for (const [schema, typeFile] of [
    ["measurement", "src/modules/measurement/adapters/database.generated.ts"],
    ["interaction", "src/modules/interaction-moderation/adapters/database.generated.ts"],
  ]) {
    const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_JOBS_ADMIN_URL)",
      "--default-schema", schema, "--include-pattern", `${schema}.*`, "--date-parser", "timestamp", "--out-file", typeFile, "--log-level", "error"];
    if (!refreshTypes) codegen.push("--verify");
    run(process.execPath, codegen, env);
  }
  const testedSource = workingTreeSourceSha256();
  if (!refreshTypes && testedSource !== initialSource) throw new Error("PHASE7_JOBS_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/due-work.test.ts", "tests/phase7/due-work-postgres.test.ts",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== 8 || assertions.length !== 8 || tests.testResults.length !== 2 ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE7_JOBS_ACCEPTANCE_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("PHASE7_JOBS_SOURCE_CHANGED_DURING_ACCEPTANCE");
  result = {
    ticket: 206, runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, postgresVersion,
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
      todo: tests.numTodoTests, failedSuites: tests.numFailedTestSuites },
    assertions: assertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    databaseRoles: ["due_work_worker_runtime", "shipwithali_worker", "anon", "authenticated"],
    criteria: ["T19-01", "T19-02", "T19-03", "T19-04", "T19-05", "T19-06", "T19-07", "T19-08", "T19-09"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:jobs",
    scope: "All repository migrations on disposable native PostgreSQL; two independent worker connections, restricted worker role, exact UTC retention, module-owned bounded commands, filtered leases, stale-token rejection, replay/reclaim and privacy-safe payloads.",
  };
  console.log(JSON.stringify({ required: result.required, runId, sourceTreeSha256: testedSource }));
} catch (error) {
  console.error(error instanceof Error && /^PHASE7_JOBS_/.test(error.message) ? error.message : "PHASE7_JOBS_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status })) }));
  } catch { /* no test report exists */ }
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try { if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); rmSync(temp, { recursive: true, force: true }); cleanup = true; }
  catch { console.error("PHASE7_JOBS_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: evidencePath, cleanup }));
  }
}
