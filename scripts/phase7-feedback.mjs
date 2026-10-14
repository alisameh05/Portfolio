import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd(), runId = randomUUID(), source = workingTreeSourceSha256();
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
function run(command, args, env = process.env) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 180_000 });
  if (r.error || r.status !== 0) throw new Error(`FEEDBACK_COMMAND_FAILED:${args[0] ?? command}:${r.status ?? "unavailable"}`);
  return r.stdout;
}
const temp = mkdtempSync(join(tmpdir(), "portfolio-feedback-192-"));
const data = join(temp, "data"), reportPath = resolve("artifacts/feedback-vitest.json");
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
rmSync("evidence/phase7-feedback-192.json", { force: true });
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const p = server.address().port; server.close(() => resolvePort(p)); });
});
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const client = new Client({ connectionString: adminUrl });
let started = false, connected = false, result, cleanup = false, stage = "runtime";
try {
  run(process.execPath, ["scripts/validation-environment.mjs"]);
  const version = run(exe("postgres"), ["--version"]).trim();
  stage = "cluster";
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  started = true;
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await client.connect(); connected = true;
  stage = "baseline";
  await client.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync("supabase/migrations").filter(n => n.endsWith(".sql")).sort();
  const migration = "supabase/migrations/20261015003000_persist_private_feedback.sql";
  const migrationProject = join(temp, "migration-project");
  mkdirSync(join(migrationProject, "supabase/migrations"), { recursive: true });
  copyFileSync("supabase/config.toml", join(migrationProject, "supabase/config.toml"));
  // This disposable loopback cluster intentionally has no TLS listener.
  const migrate = dbUrl => run(process.execPath, ["node_modules/supabase/dist/supabase.js", "migration", "up", "--db-url", dbUrl + "?sslmode=disable",
    "--workdir", migrationProject, "--yes"], { ...process.env, SUPABASE_TELEMETRY_DISABLED: "true" });
  for (const name of migrations.filter(n => n < basename(migration))) copyFileSync("supabase/migrations/" + name, join(migrationProject, "supabase/migrations", name));
  stage = "prior-release-migrations"; migrate(adminUrl);
  const predecessor = ["0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1", "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2", "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea3"];
  await client.query("insert into interaction.ratings (portfolio_id,project_id,visitor_id,value,updated_at) values ($1,$2,$3,3,'2026-10-14T00:00:00Z')", predecessor);
  for (const name of migrations.filter(n => n >= basename(migration))) copyFileSync("supabase/migrations/" + name, join(migrationProject, "supabase/migrations", name));
  stage = "feedback-upgrade"; migrate(adminUrl);
  const preserved = (await client.query("select value from interaction.ratings where portfolio_id=$1 and project_id=$2 and visitor_id=$3", predecessor)).rows;
  if (JSON.stringify(preserved) !== '[{"value":3}]') throw new Error("FEEDBACK_PREDECESSOR_CHANGED");
  const schemaSql = `select jsonb_build_object(
    'columns', (select jsonb_agg(to_jsonb(c) order by column_name) from (select column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='interaction' and table_name='feedback') c),
    'constraints', (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid='interaction.feedback'::regclass),
    'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname='interaction' and tablename='feedback'),
    'policies', (select jsonb_agg(to_jsonb(p) order by policyname) from pg_policies p where schemaname='interaction' and tablename='feedback'),
    'grants', (select jsonb_agg(to_jsonb(g) order by grantee,privilege_type) from (select grantee,privilege_type from information_schema.role_table_grants where table_schema='interaction' and table_name='feedback') g),
    'rls', (select jsonb_build_object('enabled',relrowsecurity,'forced',relforcerowsecurity) from pg_class where oid='interaction.feedback'::regclass)
  ) as schema`;
  const upgradedSchema = (await client.query(schemaSql)).rows[0].schema;
  await client.query("create database feedback_clean");
  await client.query("grant create on database feedback_clean to shipwithali_migration");
  stage = "clean-migrations"; migrate(`postgres://postgres@127.0.0.1:${port}/feedback_clean`);
  const cleanClient = new Client({ connectionString: `postgres://postgres@127.0.0.1:${port}/feedback_clean` });
  const ledgerSql = "select version from supabase_migrations.schema_migrations order by version";
  let cleanSchema, cleanLedger;
  await cleanClient.connect();
  try { cleanSchema = (await cleanClient.query(schemaSql)).rows[0].schema; cleanLedger = (await cleanClient.query(ledgerSql)).rows; }
  finally { await cleanClient.end(); }
  const upgradeLedger = (await client.query(ledgerSql)).rows;
  if (JSON.stringify(cleanSchema) !== JSON.stringify(upgradedSchema) || JSON.stringify(cleanLedger) !== JSON.stringify(upgradeLedger) || upgradeLedger.length !== migrations.length) throw new Error("FEEDBACK_MIGRATION_DRIFT");
  stage = "migration-no-op-replay"; migrate(adminUrl);
  if (JSON.stringify((await client.query(ledgerSql)).rows) !== JSON.stringify(upgradeLedger)) throw new Error("FEEDBACK_MIGRATION_REPLAY_DRIFT");
  const migrationQualification = { cleanUpgradeEquivalent: true, migrationReplayNoOp: true, predecessorRatingPreserved: true, ledger: upgradeLedger,
    schemaSha256: createHash("sha256").update(JSON.stringify(upgradedSchema)).digest("hex"), cli: run(process.execPath, ["node_modules/supabase/dist/supabase.js", "--version"]).trim() };
  // Auxiliary preservation fixture must not enter Feedback's acceptance counts.
  await client.query("delete from interaction.ratings where portfolio_id=$1 and project_id=$2 and visitor_id=$3", predecessor);
  await client.query("create role feedback_runtime login nosuperuser nobypassrls; grant shipwithali_application to feedback_runtime; create role feedback_worker login nosuperuser nobypassrls; grant shipwithali_worker to feedback_worker; ");
  const env = { ...process.env, PHASE7_FEEDBACK_DATABASE_URL: `postgres://feedback_runtime@127.0.0.1:${port}/postgres`, PHASE7_FEEDBACK_ADMIN_URL: adminUrl, PHASE7_FEEDBACK_WORKER_URL: `postgres://feedback_worker@127.0.0.1:${port}/postgres` };
  const generated = "src/modules/interaction-moderation/adapters/database.generated.ts";
  stage = "type-generation";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_FEEDBACK_ADMIN_URL)",
    "--default-schema", "interaction", "--include-pattern", "interaction.*", "--date-parser", "timestamp", "--out-file", generated, "--log-level", "error"];
  if (!process.argv.includes("--refresh-types")) codegen.push("--verify");
  run(process.execPath, codegen, env);
  // Refresh is setup, not source-bound final acceptance.
  const testedSource = workingTreeSourceSha256();
  if (!process.argv.includes("--refresh-types") && testedSource !== source) throw new Error("FEEDBACK_SOURCE_CHANGED_DURING_RUN");
  console.log("Temporary restricted PostgreSQL ready; running private Feedback acceptance.");
  stage = "acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/feedback.test.ts", "tests/phase7/feedback-postgres.test.ts", "tests/runtime/feedback.test.ts", "tests/runtime/feedback-limits.test.ts", "tests/runtime/phase7-contracts.test.ts",
    "--no-file-parallelism", "--reporter=json", "--outputFile=" + reportPath], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(s => s.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites || tests.numFailedTests || tests.numPendingTests || tests.numTodoTests ||
      tests.numPassedTests !== 57 || assertions.length !== 57 || tests.testResults.length !== 5 ||
      tests.testResults.some(s => s.status !== "passed") || assertions.some(a => a.status !== "passed")) throw new Error("FEEDBACK_ACCEPTANCE_INCOMPLETE");
  if (workingTreeSourceSha256() !== testedSource) throw new Error("FEEDBACK_SOURCE_CHANGED_DURING_RUN");
  result = { runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, version,
    migration, migrationQualification, migrationSha256: createHash("sha256").update(readFileSync(migration)).digest("hex"),
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync("supabase/migrations/" + name)).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    assertions: assertions.map(a => ({ title: a.title.replace(/: \{.*$/, ": invalid shape"), status: a.status })),
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
    roles: ["feedback_runtime", "feedback_worker", "shipwithali_application", "shipwithali_worker", "anon", "authenticated"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:feedback (PHASE7_POSTGRES_BIN selects installed PostgreSQL binaries)",
    scope: "Native disposable PostgreSQL cluster; all repository migrations through #192. Full Phase 3-6 upgrade qualification belongs to #208." };
} catch (error) {
  // No provider messages, connection strings, payloads or secret-bearing PostgreSQL logs.
  console.error(error instanceof Error && /^FEEDBACK_/.test(error.message) ? error.message : "FEEDBACK_VALIDATION_FAILED");
  console.error(JSON.stringify({ stage, code: typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : "unavailable" }));
  if (readFileSyncSafe(reportPath)) {
    const r = JSON.parse(readFileSync(reportPath, "utf8"));
    for (const suite of r.testResults ?? []) console.error(JSON.stringify({ suite: suite.name.replace(root, ""), status: suite.status,
      assertions: (suite.assertionResults ?? []).map(a => ({ title: a.title.replace(/: \{.*$/, ": invalid shape"), status: a.status })) }));
  }
  process.exitCode = 1;
} finally {
  if (connected) await client.end();
  try {
    if (started) run(exe("pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
    if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith("portfolio-feedback-192-")) {
      console.error("FEEDBACK_CLEANUP_PATH_INVALID"); process.exitCode = 1;
    } else { rmSync(temp, { recursive: true, force: true }); cleanup = true; }
  } catch { console.error("FEEDBACK_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync("evidence/phase7-feedback-192.json", JSON.stringify({ ...result, cleanup }, null, 2) + "\n");
    console.log(JSON.stringify({ required: result.required, cleanup }));
  }
}
function readFileSyncSafe(path) { try { return readFileSync(path, "utf8"); } catch { return null; } }
