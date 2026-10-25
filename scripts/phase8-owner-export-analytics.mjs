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
const startedAt = new Date().toISOString();
const initialSource = workingTreeSourceSha256();
const scope = "Issue #246 only: immutable Measurement goal history and activation sequence; privacy-safe 31-day aggregate report windows; five-subject suppression with complementary suppression; 13-calendar-month UTC aggregate retention; Analytics-only portable schema 1.2 in manifest 1.8; independent schema, dependency, order, completeness, retention, and archive validation; repeatable-read race and Worker owner/purpose RLS; sanitized evidence and cleanup.";
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE8_OWNER_EXPORT_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;

function safeText(value) {
  return String(value ?? "").replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]")
    .replace(/(service_role_key|api[_-]?key|token|secret)=\S+/gi, "$1=[redacted]")
    .replace(/\r?\n/g, " | ").slice(-900);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 240_000 });
  if (result.error || result.status !== 0) {
    if (args[0]?.includes("vitest")) {
      if (result.stdout) process.stdout.write(safeText(result.stdout));
      if (result.stderr) process.stderr.write(safeText(result.stderr));
    }
    const detail = safeText([result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n"));
    throw new Error(`PHASE8_OWNER_EXPORT_ANALYTICS_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

const temp = join(tmpdir(), `portfolio-phase8-owner-analytics-${runId}`);
const data = join(temp, "data");
const reportPath = resolve("artifacts/phase8-owner-export-analytics-vitest.json");
const evidencePath = resolve("evidence/phase8-owner-export-analytics-246.json");
mkdirSync(temp, { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let connected = false, started = false, cleanup = false, stage = "runtime", result;
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const postgresVersion = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  writeFileSync(join(data, "postgresql.conf"), `${readFileSync(join(data, "postgresql.conf"), "utf8")}\nunix_socket_directories = ''\n`);
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  started = true;
  await admin.connect(); connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  await admin.query("create role owner_export_application_runtime login nosuperuser nobypassrls; grant shipwithali_application to owner_export_application_runtime; create role owner_export_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to owner_export_worker_runtime");
  const env = { ...process.env,
    PHASE8_OWNER_EXPORT_APPLICATION_URL: `postgres://owner_export_application_runtime@127.0.0.1:${port}/postgres?sslmode=disable`,
    PHASE8_OWNER_EXPORT_WORKER_URL: `postgres://owner_export_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`,
    PHASE8_OWNER_EXPORT_ADMIN_URL: `${adminUrl}?sslmode=disable`,
  };
  const testedSource = workingTreeSourceSha256();
  if (testedSource !== initialSource) throw new Error("PHASE8_OWNER_EXPORT_ANALYTICS_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  const acceptanceFiles = [
    "tests/phase8/owner-export-analytics.test.ts",
    "tests/phase8/owner-export-analytics-postgres.test.ts",
    "tests/phase8/owner-export-package.test.ts",
  ];
  const expectedTests = 22;
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...acceptanceFiles,
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== expectedTests || assertions.length !== expectedTests || tests.testResults.length !== acceptanceFiles.length ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_ANALYTICS_ACCEPTANCE_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("PHASE8_OWNER_EXPORT_ANALYTICS_SOURCE_CHANGED_DURING_ACCEPTANCE");
  result = {
    success: true,
    ticket: 246,
    runId,
    startedAt,
    sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(),
    sourceTreeSha256: testedSource,
    postgresVersion,
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
      todo: tests.numTodoTests, failedSuites: tests.numFailedTestSuites },
    assertions: assertions.map(assertion => ({ title: assertion.fullName ?? assertion.title, status: assertion.status })),
    criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07"],
    criterionEvidence: {
      AC01: ["Analytics-only archive preserves goal IDs, ordered immutable versions, activationSequence, and dependency references"],
      AC02: ["five-subject and complementary locale cells are omitted with low-sample/withheld meaning; no hidden count or fabricated zero is exported"],
      AC03: ["one locale breakdown only, no total, non-overlapping windows of at most 31 days, and at most 500 rows per query; cap hit is incomplete"],
      AC04: ["archive validator fixtures and real PostgreSQL package scan confirm no Visitor, event, consent, interaction, activation identity, or provider-secret fields"],
      AC05: ["UTC 13-calendar-month expiry boundary is checked before, at, and after expiry; incomplete checkpoint coverage is retained as withheld"],
      AC06: ["barrier-driven PostgreSQL activation and aggregate update remains invisible to one repeatable-read capture"],
      AC07: ["empty Analytics scope, exact schema coverage, record counts, dependencies, digests, retention, report order, and independent ZIP validation are checked"],
    },
    acceptanceFiles,
  };
} catch (error) {
  result = { success: false, ticket: 246, runId, startedAt, stage, failureCode: safeText(error instanceof Error ? error.message.split(":").slice(0, 3).join(":") : "UNKNOWN_FAILURE") };
  console.error(result.failureCode);
  process.exitCode = 1;
} finally {
  if (connected) await admin.end().catch(() => {});
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(temp, { recursive: true, force: true }); cleanup = true;
  } catch {
    console.error("PHASE8_OWNER_EXPORT_ANALYTICS_CLEANUP_FAILED");
    process.exitCode = 1;
  }
  mkdirSync("evidence", { recursive: true });
  result.completedAt = new Date().toISOString();
  result.cleanup = cleanup;
  writeFileSync(evidencePath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ evidence: evidencePath, cleanup, success: result.success }));
}
