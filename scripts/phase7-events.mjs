import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd(), runId = randomUUID(), source = workingTreeSourceSha256();
const refreshTypes = process.argv.includes("--refresh-types");
const migration = "supabase/migrations/20261015120000_persist_consented_public_events.sql";
const evidencePath = resolve("evidence/phase7-events-196.json"), reportPath = resolve("artifacts/events-vitest.json");
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
function run(command, args, env = process.env) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 180_000 });
  if (r.error || r.status !== 0) {
    const diagnostic = [r.stderr, r.stdout, r.error?.message].filter(Boolean).join("\n").trim().slice(-1_500).replace(/\r?\n/g, " | ") || "unavailable";
    throw new Error(`EVENT_COMMAND_FAILED:${args[0] ?? command}:${r.status ?? "unavailable"}:${diagnostic}`);
  }
  return r.stdout;
}
mkdirSync(join(root, "node_modules", ".cache"), { recursive: true });
const temp = mkdtempSync(join(root, "node_modules", ".cache", "portfolio-events-196-")), data = join(temp, "data");
mkdirSync("artifacts", { recursive: true }); rmSync(reportPath, { force: true }); rmSync(evidencePath, { force: true });
const port = await new Promise((ok, fail) => {
  const server = createServer(); server.once("error", fail); server.listen(0, "127.0.0.1", () => {
    const value = server.address().port; server.close(() => ok(value));
  });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`, client = new Client({ connectionString: adminUrl });
let started = false, connected = false, result, cleanup = false, stage = "runtime";
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const version = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster"; run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]); started = true;
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await client.connect(); connected = true;
  stage = "baseline";
  await client.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  if (!migrations.includes(migration.slice(migration.lastIndexOf("/") + 1))) throw new Error("EVENT_MIGRATION_MISSING");
  const project = join(temp, "migration-project"); mkdirSync(join(project, "supabase/migrations"), { recursive: true });
  copyFileSync("supabase/config.toml", join(project, "supabase/config.toml"));
  for (const name of migrations) copyFileSync(join("supabase/migrations", name), join(project, "supabase/migrations", name));
  stage = "migrations";
  run(process.execPath, ["node_modules/supabase/dist/supabase.js", "migration", "up", "--db-url", adminUrl + "?sslmode=disable", "--workdir", project, "--yes"],
    { ...process.env, SUPABASE_TELEMETRY_DISABLED: "true" });
  await client.query("create role event_runtime login nosuperuser nobypassrls; grant shipwithali_application to event_runtime");
  const env = { ...process.env, PHASE7_EVENT_DATABASE_URL: `postgres://event_runtime@127.0.0.1:${port}/postgres?sslmode=disable`, PHASE7_EVENT_ADMIN_URL: adminUrl + "?sslmode=disable" };
  stage = "type-generation";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_EVENT_ADMIN_URL)",
    "--default-schema", "measurement", "--include-pattern", "measurement.*", "--date-parser", "timestamp", "--out-file", "src/modules/measurement/adapters/database.generated.ts", "--log-level", "error"];
  if (!refreshTypes) codegen.push("--verify");
  run(process.execPath, codegen, env);
  if (refreshTypes) { console.log("Generated measurement database types for the disposable migrated schema."); process.exitCode = 0; }
  else {
    const testedSource = workingTreeSourceSha256();
    if (testedSource !== source) throw new Error("EVENT_SOURCE_CHANGED_DURING_SETUP");
    stage = "acceptance";
    run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/events-application.test.ts", "tests/phase7/events-postgres.test.ts",
      "tests/phase7/consent-crypto.test.ts", "tests/runtime/public-event.test.ts", "--reporter=json", "--outputFile=" + reportPath], env);
    const tests = JSON.parse(readFileSync(reportPath, "utf8"));
    const assertions = tests.testResults.flatMap(suite => suite.assertionResults ?? []);
    if (!tests.success || tests.numFailedTestSuites || tests.numFailedTests || tests.numPendingTests || tests.numTodoTests ||
        tests.numPassedTests !== assertions.length || tests.testResults.length !== 4 || tests.testResults.some(suite => suite.status !== "passed") ||
        assertions.some(assertion => assertion.status !== "passed")) throw new Error("EVENT_ACCEPTANCE_INCOMPLETE");
    if (workingTreeSourceSha256() !== testedSource) throw new Error("EVENT_SOURCE_CHANGED_DURING_RUN");
    result = { runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, version, migration,
      migrationSha256: createHash("sha256").update(readFileSync(migration)).digest("hex"),
      required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
      suites: tests.testResults.map(suite => ({ name: suite.name.replace(root, ""), passed: suite.assertionResults?.length ?? 0 })),
      roles: ["event_runtime", "shipwithali_application", "shipwithali_worker", "anon", "authenticated"],
      reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:events (PHASE7_POSTGRES_BIN selects installed PostgreSQL binaries)",
      scope: "Disposable native PostgreSQL cluster; full repository migration chain, restricted application role, HTTP/application/consent integration. No production database was modified." };
  }
} catch (error) {
  const safeMessage = String(error?.message ?? "unavailable").replace(/postgres(?:ql)?:\/\/\S+/gi, "[database-url]").slice(0, 300);
  console.error(error instanceof Error && /^EVENT_/.test(error.message) ? error.message : `EVENT_VALIDATION_FAILED:${safeMessage}`);
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of report.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(assertion => ({ title: assertion.title, status: assertion.status })) }));
  } catch {}
  process.exitCode = 1;
} finally {
  if (connected) await client.end();
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    rmSync(temp, { recursive: true, force: true }); cleanup = true;
  } catch { console.error("EVENT_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync(evidencePath, JSON.stringify({ ...result, cleanup }, null, 2) + "\n");
    console.log(JSON.stringify({ required: result.required, cleanup }));
  }
}
