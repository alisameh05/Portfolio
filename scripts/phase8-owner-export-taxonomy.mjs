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
const scope = "Issue #242 only: taxonomy identity, current assignments, complete value evolution and assignment histories; repeatable-read taxonomy plus Content-owned assignment capture; barrier-driven merge during capture; taxonomy-only dependency declarations; combined Project-reference resolution; independent offline schema, history, count, and hash validation; worker purpose and write fencing; empty taxonomy entry and cleanup.";
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
    throw new Error(`PHASE8_OWNER_EXPORT_TAXONOMY_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

const temp = join(tmpdir(), `portfolio-phase8-owner-taxonomy-${runId}`);
const data = join(temp, "data");
const reportPath = resolve("artifacts/phase8-owner-export-taxonomy-vitest.json");
const evidencePath = resolve("evidence/phase8-owner-export-taxonomy-242.json");
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
  writeFileSync(join(data, "postgresql.conf"), `${readFileSync(join(data, "postgresql.conf"), "utf8")}\nunix_socket_directories = ''\n`);
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await admin.connect(); connected = true;
  stage = "migrations";
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const name of migrations) { stage = `migration:${name}`; await admin.query(readFileSync(join("supabase/migrations", name), "utf8")); }
  await admin.query("create role owner_export_application_runtime login nosuperuser nobypassrls; grant shipwithali_application to owner_export_application_runtime; create role owner_export_worker_runtime login nosuperuser nobypassrls; grant shipwithali_worker to owner_export_worker_runtime");
  const applicationUrl = `postgres://owner_export_application_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const workerUrl = `postgres://owner_export_worker_runtime@127.0.0.1:${port}/postgres?sslmode=disable`;
  const env = { ...process.env,
    PHASE8_OWNER_EXPORT_APPLICATION_URL: applicationUrl,
    PHASE8_OWNER_EXPORT_WORKER_URL: workerUrl,
    PHASE8_OWNER_EXPORT_ADMIN_URL: `${adminUrl}?sslmode=disable`,
  };
  const testedSource = workingTreeSourceSha256();
  if (testedSource !== initialSource) throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_SOURCE_CHANGED_BEFORE_ACCEPTANCE");
  stage = "acceptance";
  const acceptanceFiles = ["tests/phase8/owner-export-taxonomy.test.ts", "tests/phase8/owner-export-taxonomy-postgres.test.ts"];
  const expectedTests = 5;
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", ...acceptanceFiles,
    "--no-file-parallelism", "--reporter=json", `--outputFile=${reportPath}`], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
      tests.numPassedTests !== expectedTests || assertions.length !== expectedTests || tests.testResults.length !== acceptanceFiles.length ||
      tests.testResults.some(suite => suite.status !== "passed") || assertions.some(assertion => assertion.status !== "passed")) {
    throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_ACCEPTANCE_INCOMPLETE");
  }
  if (workingTreeSourceSha256() !== testedSource) throw new Error("PHASE8_OWNER_EXPORT_TAXONOMY_SOURCE_CHANGED_DURING_ACCEPTANCE");
  result = {
    ticket: 242, runId, startedAt, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, postgresVersion,
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync(join("supabase/migrations", name))).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests,
      todo: tests.numTodoTests, failedSuites: tests.numFailedTestSuites },
    assertions: assertions.map(assertion => ({ title: assertion.title, status: assertion.status })),
    criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06"],
    criterionEvidence: {
      AC01: ["AC01-02 emits stable identities, current assignments, and ordered create/rename/retire/merge history", "AC01-06 captures complete taxonomy facts across an atomic merge and validates purpose and cleanup"],
      AC02: ["AC01-02 emits stable identities, current assignments, and ordered create/rename/retire/merge history", "AC01-06 captures complete taxonomy facts across an atomic merge and validates purpose and cleanup"],
      AC03: ["AC01-06 captures complete taxonomy facts across an atomic merge and validates purpose and cleanup"],
      AC04: ["AC04 declares Project dependencies without widening taxonomy-only selection and resolves them in full packages", "AC01-06 captures complete taxonomy facts across an atomic merge and validates purpose and cleanup"],
      AC05: ["AC05 declares a selected empty taxonomy as a zero-byte entry and rejects dangling merge mappings", "AC05 rejects record-count, schema-byte, and archive-integrity corruption"],
      AC06: ["AC01-06 captures complete taxonomy facts across an atomic merge and validates purpose and cleanup"],
    },
    roleBoundary: "taxonomy.owner-export for Taxonomy roots, values, and history; content.owner-export for current assignments and assignment history; read-only worker grants.",
    databaseRoles: ["owner_export_application_runtime", "shipwithali_application", "owner_export_worker_runtime", "shipwithali_worker", "anon", "authenticated"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:taxonomy",
    scope,
  };
  console.log(JSON.stringify({ required: result.required, runId, sourceTreeSha256: testedSource }));
} catch (error) {
  console.error(error instanceof Error && /^PHASE8_OWNER_EXPORT_TAXONOMY_/.test(error.message) ? error.message : "PHASE8_OWNER_EXPORT_TAXONOMY_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status, failureMessages: assertion.failureMessages })) }));
  } catch { /* no report is available */ }
  process.exitCode = 1;
} finally {
  if (connected) await admin.end();
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(temp, { recursive: true, force: true }); cleanup = true;
  } catch { console.error("PHASE8_OWNER_EXPORT_TAXONOMY_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    result.completedAt = new Date().toISOString();
    writeFileSync(evidencePath, `${JSON.stringify({ ...result, cleanup }, null, 2)}\n`);
    console.log(JSON.stringify({ evidence: evidencePath, cleanup }));
  }
}
