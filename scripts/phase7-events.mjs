import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd(), runId = randomUUID(), source = workingTreeSourceSha256();
const refreshTypes = process.argv.includes("--refresh-types");
const ticket197 = process.argv.includes("--ticket-197");
const ticket198 = process.argv.includes("--ticket-198");
if (ticket197 && ticket198) throw new Error("EVENT_TICKET_MODE_CONFLICT");
const migration = ticket198 ? "supabase/migrations/20261015150000_enable_configuration_interaction_event_facts.sql" :
  ticket197 ? "supabase/migrations/20261015120000_persist_consented_public_events.sql" :
    "supabase/migrations/20261015120000_persist_consented_public_events.sql";
const evidencePath = resolve(ticket198 ? "evidence/phase7-event-capabilities-198.json" : ticket197 ? "evidence/phase7-event-facts-197.json" : "evidence/phase7-events-196.json");
const reportPath = resolve(ticket198 ? "artifacts/event-capabilities-vitest.json" : ticket197 ? "artifacts/event-facts-vitest.json" : "artifacts/events-vitest.json");
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
      ...(ticket198 ? { acceptanceCriteria: {
        "T11-01": ["T11-01/T11-04/T11-06 records only current configured capability facts and stable public identities", "T11-01/T11-06 accepts and preserves all nine action mappings as distinct facts"],
        "T11-02": ["T11-02/T11-03/T11-05 rejects absent or mismatched current configuration without durable effects", "T11-02/T11-03 rejects unconfigured Contact channel before durable effects", "T11-02/T11-03 rejects unavailable Global CTA destination before durable effects"],
        "T11-03": ["T11-02/T11-03 rejects English-only Project destination in Arabic before durable effects"],
        "T11-04": ["T11-01/T11-04/T11-06 records only current configured capability facts and stable public identities"],
        "T11-05": ["T11-05 rejects invalid Contact channel before durable effects", "T11-05 rejects raw destination URL before durable effects", "T11-05 rejects unknown closed-shape property as 400 before dispatch"],
        "T11-06": ["T11-01/T11-06 accepts and preserves all nine action mappings as distinct facts", "dispatches all nine contract actions through consent verification"],
        "T11-07": ["T11-07 replays and conflicts for each current capability fact exactly once", "T09-07 commits event, safe receipt and private job once; exact races replay and failures roll back"],
        "T11-08": ["T11-01/T11-04/T11-06 records only current configured capability facts and stable public identities", "T11-02/T11-03/T11-05 rejects absent or mismatched current configuration without durable effects"]
      } } : ticket197 ? { acceptanceCriteria: {
        "T10-01": ["T09-01/T09-03 persists each first-slice action and round-trips the full safe context", "T10-01/T10-04 persists related-project and testimonial actions with exact current public associations", "T10-01/T10-03 persists Media facts only when the optional public-use capability accepts them"],
        "T10-02": ["T09-04 binds current routes, Project, locale, type and Portfolio while allowing retained journey identities", "T10-01/T10-04 persists related-project and testimonial actions with exact current public associations", "T10-01/T10-03 persists Media facts only when the optional public-use capability accepts them"],
        "T10-03": ["T10-01/T10-03 persists Media facts only when the optional public-use capability accepts them", "fails only Media engagement safely when its optional public-use capability is missing", "fails only Media engagement safely when its optional public-use capability is unavailable"],
        "T10-04": ["T10-01/T10-04 persists related-project and testimonial actions with exact current public associations"],
        "T10-05": ["rejects invalid Media engagement before durable effects", "rejects invalid relationship payload before durable effects", "rejects unknown testimonial property before durable effects", "rejects unknown closed-shape property as 400 before dispatch", "rejects unknown context property as 400 before dispatch"],
        "T10-06": ["T09-04 binds current routes, Project, locale, type and Portfolio while allowing retained journey identities", "T10-01/T10-04 persists related-project and testimonial actions with exact current public associations"],
        "T10-07": ["T10-01/T10-03 persists Media facts only when the optional public-use capability accepts them", "T09-07 commits event, safe receipt and private job once; exact races replay and failures roll back"],
        "T10-08": ["fails only Media engagement safely when its optional public-use capability is missing", "fails only Media engagement safely when its optional public-use capability is unavailable", "T09-09 enforces module RLS and keeps optional event assembly out of core readiness"]
      } } : {}),
      required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
      suites: tests.testResults.map(suite => ({ name: suite.name.replace(root, ""), passed: suite.assertionResults?.length ?? 0 })),
      roles: ["event_runtime", "shipwithali_application", "shipwithali_worker", "anon", "authenticated"],
      reproduction: `npm run setup:validation; npm run validation:ready; npm run phase7:focus:events${ticket198 ? " -- --ticket-198" : ticket197 ? " -- --ticket-197" : ""}; PHASE7_POSTGRES_BIN selects installed PostgreSQL binaries`,
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
