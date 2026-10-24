import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd();
const runId = randomUUID();
const startedAt = new Date().toISOString();
const initialSource = workingTreeSourceSha256();
const scope = "All repository migrations on disposable native PostgreSQL; restricted application and worker roles; existing configuration-only request-to-ready recovery scenarios; Content-owned full-history snapshot capture for Draft, Published, Hidden, and Archived Projects, Achievements, and Testimonials; independent English and Arabic revision/review/publication histories and exact current pointers; durable route identities, reservations, redirects, and discovery tie ordering; repeatable-read source capture; content-only and combined-scope package contents with omitted dependency declarations; independent offline schema/hash/count/domain validation; owner and purpose fenced worker reads with no Content writes; unsupported scopes failing safely; private/no-store download headers; role/RLS matrix enforcement.";
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE8_OWNER_EXPORT_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 240_000 });
  if (result.error || result.status !== 0) {
    if (args[0]?.includes("vitest")) { if (result.stdout) process.stdout.write(result.stdout); if (result.stderr) process.stderr.write(result.stderr); }
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n")
      .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000);
    throw new Error(`PHASE8_OWNER_EXPORT_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

const temp = join(tmpdir(), `portfolio-phase8-owner-export-${runId}`);
const data = join(temp, "data");
const reportPath = resolve("artifacts/phase8-owner-exports-vitest.json");
const roleReportPath = resolve("artifacts/phase8-owner-exports-rls-vitest.json");
const evidencePath = resolve("evidence/phase8-owner-exports-241.json");
mkdirSync(temp, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
rmSync(roleReportPath, { force: true });
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
  // Unix-domain socket paths must stay under a 107-byte limit; connection URLs
  // below are TCP loopback, so the extended configuration removes the socket.
  appendFileSync(join(data, "postgresql.conf"), "unix_socket_directories = ''\n");
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await admin.connect(); connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  // The application path reserves requests and jobs. The worker path reads
  // Content only under the exact content.owner-export purpose and transitions
  // exports through separate restricted connections.
  await admin.query("create role owner_export_application_runtime login nosuperuser nobypassrls; grant shipwithali_application to owner_export_application_runtime");
  await admin.query("create role owner_export_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to owner_export_worker_runtime");
  const applicationUrl = `postgres://owner_export_application_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const workerUrl = `postgres://owner_export_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const env = { ...process.env,
    PHASE8_OWNER_EXPORT_APPLICATION_URL: applicationUrl,
    PHASE8_OWNER_EXPORT_WORKER_URL: workerUrl,
    PHASE8_OWNER_EXPORT_ADMIN_URL: `${adminUrl}?sslmode=disable`,
    PHASE3_DATABASE_URL: `${adminUrl}?sslmode=disable`, PHASE3_REQUIRE_DATABASE: "1" };
  const testedSource = workingTreeSourceSha256();
  if (testedSource !== initialSource) throw new Error("PHASE8_OWNER_EXPORT_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  const acceptanceFiles = ["tests/phase8/owner-export-requests.test.ts", "tests/phase8/owner-export-adapter.test.ts",
    "tests/phase8/owner-export-postgres.test.ts", "tests/phase8/owner-export-assembly.test.ts", "tests/phase8/owner-export-content.test.ts", "tests/phase8/owner-export-content-postgres.test.ts"];
  const expectedTests = 52;
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...acceptanceFiles,
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== expectedTests || assertions.length !== expectedTests || tests.testResults.length !== acceptanceFiles.length ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_ACCEPTANCE_INCOMPLETE");
  }
  stage = "role-rls-acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/database/role-rls-matrix.test.ts",
    "--no-file-parallelism", "--reporter=json", `--outputFile=${roleReportPath}`], env);
  const roleMatrix = JSON.parse(readFileSync(roleReportPath, "utf8"));
  if (!roleMatrix.success || roleMatrix.numFailedTestSuites !== 0 || roleMatrix.numFailedTests !== 0 ||
      roleMatrix.numPendingTests !== 0 || roleMatrix.numTodoTests !== 0 || roleMatrix.numPassedTests === 0 ||
      roleMatrix.testResults.length !== 1 || roleMatrix.testResults.some(suite => suite.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_RLS_ACCEPTANCE_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("PHASE8_OWNER_EXPORT_SOURCE_CHANGED_DURING_ACCEPTANCE");
  result = {
    ticket: 241, runId, startedAt, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, postgresVersion,
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
      todo: tests.numTodoTests, failedSuites: tests.numFailedTestSuites },
    roleMatrix: { success: roleMatrix.success, passed: roleMatrix.numPassedTests,
      failed: roleMatrix.numFailedTests, skipped: roleMatrix.numPendingTests, todo: roleMatrix.numTodoTests },
    assertions: assertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    databaseRoles: ["owner_export_application_runtime", "shipwithali_application", "owner_export_worker_runtime",
      "shipwithali_worker", "anon", "authenticated"],
    criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:exports",
    scope,
  };
  console.log(JSON.stringify({ required: result.required, roleMatrix: result.roleMatrix, runId, sourceTreeSha256: testedSource }));
} catch (error) {
  console.error(error instanceof Error && /^PHASE8_OWNER_EXPORT_/.test(error.message) ? error.message : "PHASE8_OWNER_EXPORT_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status })) }));
  } catch { /* no test report exists */ }
  try {
    const report = JSON.parse(readFileSync(roleReportPath, "utf8"));
    for (const suite of report.testResults ?? []) {
      const failed = (suite.assertionResults ?? []).filter(assertion => assertion.status !== "passed");
      if (suite.status !== "passed" || failed.length > 0) {
        console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
          assertions: failed.map(assertion => ({ title: assertion.title, status: assertion.status,
            failureMessages: assertion.failureMessages?.map(message => String(message)
              .replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").replace(/\r?\n/g, " | ").slice(-1_000)) })) }));
      }
    }
  } catch { /* no role matrix report is available */ }
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try { if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]); rmSync(temp, { recursive: true, force: true }); cleanup = true; }
  catch { console.error("PHASE8_OWNER_EXPORT_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    result.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: evidencePath, cleanup }));
  }
}
