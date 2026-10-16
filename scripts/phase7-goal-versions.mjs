import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd();
const runId = randomUUID();
const startingSource = workingTreeSourceSha256();
const refreshTypes = process.argv.includes("--refresh-types");
const reportPath = resolve("artifacts/goal-versions-vitest.json");
const evidencePath = resolve("evidence/phase7-goal-activation-200.json");
const versionEvidencePath = resolve("evidence/phase7-goal-versions-199.json");
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 180_000 });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").slice(-1_000).replace(/\r?\n/g, " | ");
    throw new Error(`GOAL_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail || "unavailable"}`);
  }
  return result.stdout;
}

mkdirSync(join(root, "node_modules", ".cache"), { recursive: true });
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
if (!refreshTypes) {
  rmSync(evidencePath, { force: true });
  rmSync(versionEvidencePath, { force: true });
}
const temp = mkdtempSync(join(root, "node_modules", ".cache", "portfolio-goals-199-"));
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
  const migration = "supabase/migrations/20261015170000_activate_analytics_goal_versions.sql";
  if (!migrations.includes(migration.split("/").at(-1))) throw new Error("GOAL_MIGRATION_MISSING");
  const project = join(temp, "migration-project");
  mkdirSync(join(project, "supabase/migrations"), { recursive: true });
  copyFileSync("supabase/config.toml", join(project, "supabase/config.toml"));
  for (const name of migrations) copyFileSync(join("supabase/migrations", name), join(project, "supabase/migrations", name));
  stage = "migrations";
  run(process.execPath, ["node_modules/supabase/dist/supabase.js", "migration", "up", "--db-url", `${adminUrl}?sslmode=disable`, "--workdir", project, "--yes"],
    { ...process.env, SUPABASE_TELEMETRY_DISABLED: "true" });
  await admin.query("create role goal_runtime login nosuperuser nobypassrls; grant shipwithali_application to goal_runtime");
  const env = { ...process.env, PHASE7_GOAL_DATABASE_URL: `postgres://goal_runtime@127.0.0.1:${port}/postgres?sslmode=disable`, PHASE7_GOAL_ADMIN_URL: `${adminUrl}?sslmode=disable` };
  stage = "type-generation";
  const typeFile = "src/modules/measurement/adapters/database.generated.ts";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_GOAL_ADMIN_URL)",
    "--default-schema", "measurement", "--include-pattern", "measurement.*", "--date-parser", "timestamp", "--out-file", typeFile, "--log-level", "error"];
  if (!refreshTypes) codegen.push("--verify");
  run(process.execPath, codegen, env);
  if (refreshTypes) {
    console.log("Generated Measurement database types from the disposable migration chain.");
  } else {
    const testedSource = workingTreeSourceSha256();
    if (testedSource !== startingSource) throw new Error("GOAL_SOURCE_CHANGED_DURING_SETUP");
    stage = "acceptance";
    run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/goal-versions.test.ts", "tests/phase7/goal-versions-postgres.test.ts",
      "tests/runtime/owner-analytics.test.ts", "tests/phase4/owner-request-security.test.ts", "--reporter=json", `--outputFile=${reportPath}`], env);
    const tests = JSON.parse(readFileSync(reportPath, "utf8"));
    const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
    if (!tests.success || tests.numFailedTestSuites !== 0 || tests.numFailedTests !== 0 || tests.numPendingTests !== 0 || tests.numTodoTests !== 0 ||
        tests.numPassedTests !== assertions.length || tests.testResults.length !== 4 || tests.testResults.some(suite => suite.status !== "passed") ||
        assertions.some(assertion => assertion.status !== "passed")) throw new Error("GOAL_ACCEPTANCE_INCOMPLETE");
    if (workingTreeSourceSha256() !== testedSource) throw new Error("GOAL_SOURCE_CHANGED_DURING_RUN");
    const npmVersion = /^npm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1] ?? "unknown";
    result = {
      runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource,
      tools: { node: process.version, npm: npmVersion, supabase: run(process.execPath, ["node_modules/supabase/dist/supabase.js", "--version"]).trim(), postgres: postgresVersion },
      migration, migrationSha256: createHash("sha256").update(readFileSync(migration)).digest("hex"),
      acceptanceCriteria: {
        "T12-01": ["real Owner create-version HTTP operation returns a contract-valid 201 receipt", "authorized inspect returns the immutable ordered version view, nullable pointer, and history"],
        "T12-02": ["version one bootstraps root and snapshot atomically at aggregate version two", "expected version other than one rejects bootstrap and absent-root inspect is not_found"],
        "T12-03": ["a two-party barrier overlaps independent concurrent initializers and yields exactly one root and version one", "exact retry replays original receipt and changed payload conflicts without another outbox effect"],
        "T12-04": ["name, action, step, scope, duplicate, wrong-type, unavailable, and Portfolio boundaries validated", "one hundred scope and ten step limits accepted; one hundred one and eleven rejected"],
        "T12-05": ["retained Hidden Project and route identities remain valid goal scopes without changing public lifecycle"],
        "T12-06": ["later versions append ordered snapshots without changing the active pointer or activation facts"],
        "T12-07": ["stale preconditions and non-Owner actors are rejected safely", "replay checks current Owner authorization again", "the shared verified Owner boundary rejects invalid origin and CSRF before dispatch"],
        "T12-08": ["root, snapshot, outbox, and ledger failures leave no durable root/version/receipt/fact", "restricted application role cannot update or delete immutable snapshots"],
        "T13-01": ["existing Owner activation HTTP operation returns contract-valid 200 and inspect exposes the active pointer and ordered history"],
        "T13-02": ["creation leaves activation unchanged and activation preserves definition snapshot bytes with one active pointer"],
        "T13-03": ["cross-goal and foreign-Portfolio version IDs reject without private leakage or state changes; absent root is not_found"],
        "T13-04": ["exact replay and fresh-key same-version activation add no duplicate fact or aggregate increment"],
        "T13-05": ["changed-payload key reuse conflicts, stale If-Match returns 412, and replay requires current Owner authorization"],
        "T13-06": ["independent concurrent activations serialize to one pointer/history", "injected pointer-history, outbox, and ledger failures roll back together"],
        "T13-07": ["fixed-clock tied activation timestamps retain deterministic goal-local sequence for delayed matching"],
        "T13-08": ["scoped Owner composition, real PostgreSQL/RLS, and generated strict HTTP response validation pass"]
      },
      required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
      suites: tests.testResults.map(suite => ({ name: suite.name.replace(root, ""), passed: suite.assertionResults?.length ?? 0 })),
      roles: ["goal_runtime", "shipwithali_application", "anon", "authenticated"],
      reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:goal-versions (PHASE7_POSTGRES_BIN selects installed PostgreSQL binaries)",
      scope: "Full repository migration chain in a loopback-only disposable native PostgreSQL cluster, restricted non-superuser application role, real Owner application and HTTP adapters; no production or development database was modified."
    };
  }
} catch (error) {
  const message = error instanceof Error && /^GOAL_/.test(error.message) ? error.message : `GOAL_VALIDATION_FAILED:${String(error?.message ?? "unavailable").replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").slice(0, 250)}`;
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
    rmSync(temp, { recursive: true, force: true }); cleanup = true;
  } catch { console.error("GOAL_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup && !refreshTypes) {
    mkdirSync("evidence", { recursive: true });
    const versionEvidence = { ...result, acceptanceCriteria: Object.fromEntries(Object.entries(result.acceptanceCriteria).filter(([criterion]) => criterion.startsWith("T12-"))), cleanup };
    const activationEvidence = { ...result, acceptanceCriteria: Object.fromEntries(Object.entries(result.acceptanceCriteria).filter(([criterion]) => criterion.startsWith("T13-"))), cleanup };
    writeFileSync(versionEvidencePath, `${JSON.stringify(versionEvidence, null, 2)}\n`);
    writeFileSync(evidencePath, `${JSON.stringify(activationEvidence, null, 2)}\n`);
    console.log(JSON.stringify({ required: result.required, cleanup }));
  }
}
