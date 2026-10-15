import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Client } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd(), runId = randomUUID(), source = workingTreeSourceSha256();
const summaries = process.argv.includes("--summaries");
const suppression = summaries || process.argv.includes("--suppression");
const evidencePath = summaries ? "evidence/phase7-summaries-195.json" : suppression ? "evidence/phase7-suppression-194.json" : "evidence/phase7-moderation-193.json";
const expectedTests = summaries ? 132 : suppression ? 93 : 80;
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
function run(command, args, env = process.env) {
  const r = spawnSync(command, args, { cwd: root, env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: 180_000 });
  if (r.error || r.status !== 0) throw new Error(`MODERATION_COMMAND_FAILED:${args[0] ?? command}:${r.status ?? "unavailable"}`);
  return r.stdout;
}
const temp = mkdtempSync(join(tmpdir(), "portfolio-moderation-193-"));
const data = join(temp, "data"), reportPath = resolve(summaries ? "artifacts/summaries-vitest.json" : suppression ? "artifacts/suppression-vitest.json" : "artifacts/moderation-vitest.json");
mkdirSync("artifacts", { recursive: true });
rmSync(reportPath, { force: true });
if (suppression) rmSync("artifacts/suppression-query-plan.json", { force: true });
if (summaries) rmSync("artifacts/summary-query-plans.json", { force: true });
rmSync(evidencePath, { force: true });
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
  const migration = summaries ? "supabase/migrations/20261015093040_query_current_interaction_summaries.sql" : "supabase/migrations/20261015010000_retain_feedback_moderation.sql";
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
  const priorFeedback = ["0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb1", ...predecessor.slice(0,2)];
  await client.query("insert into interaction.feedback (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at) values ($1,$2,$3,'en','Prior','Retained','pending',1,'2026-10-14T00:00:00Z')", priorFeedback);
  stage = "moderation-upgrade"; migrate(adminUrl);
  const prior = (await client.query("select moderation_state,aggregate_version,paragraph from interaction.feedback where feedback_id=$1", [priorFeedback[0]])).rows;
  if (JSON.stringify(prior) !== '[{"moderation_state":"pending","aggregate_version":"1","paragraph":"Retained"}]') throw new Error("MODERATION_PRIOR_FEEDBACK_CHANGED");
  const preserved = (await client.query("select value from interaction.ratings where portfolio_id=$1 and project_id=$2 and visitor_id=$3", predecessor)).rows;
  if (JSON.stringify(preserved) !== '[{"value":3}]') throw new Error("MODERATION_PREDECESSOR_CHANGED");
  const schemaSql = `select jsonb_build_object(
    'columns', (select jsonb_agg(to_jsonb(c) order by table_name,column_name) from (select table_name,column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema='interaction' and table_name in ('feedback','moderation_decisions','reactions','ratings','current_reaction_counts','current_rating_summary')) c),
    'constraints', (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid in ('interaction.feedback'::regclass,'interaction.moderation_decisions'::regclass,'interaction.reactions'::regclass,'interaction.ratings'::regclass)),
    'indexes', (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname='interaction' and tablename in ('feedback','moderation_decisions','reactions','ratings')),
    'policies', (select jsonb_agg(to_jsonb(p) order by tablename,policyname) from pg_policies p where schemaname='interaction' and tablename in ('feedback','moderation_decisions','reactions','ratings','current_reaction_counts','current_rating_summary')),
    'grants', (select jsonb_agg(to_jsonb(g) order by table_name,grantee,privilege_type) from (select table_name,grantee,privilege_type from information_schema.role_table_grants where table_schema='interaction' and table_name in ('feedback','moderation_decisions','reactions','ratings','current_reaction_counts','current_rating_summary')) g),
    'columnGrants', (select jsonb_agg(to_jsonb(g) order by table_name,column_name,grantee,privilege_type) from (select table_name,column_name,grantee,privilege_type from information_schema.role_column_grants where table_schema='interaction' and table_name in ('feedback','moderation_decisions','reactions','ratings','current_reaction_counts','current_rating_summary')) g),
    'views', (select jsonb_agg(jsonb_build_object('name',c.relname,'owner',r.rolname,'options',c.reloptions,'definition',pg_get_viewdef(c.oid)) order by c.relname) from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='interaction'::regnamespace and c.relkind='v'),
    'rls', (select jsonb_agg(jsonb_build_object('table',relname,'enabled',relrowsecurity,'forced',relforcerowsecurity) order by relname) from pg_class where oid in ('interaction.feedback'::regclass,'interaction.moderation_decisions'::regclass,'interaction.reactions'::regclass,'interaction.ratings'::regclass))
  ) as schema`;
  const upgradedSchema = (await client.query(schemaSql)).rows[0].schema;
  await client.query("create database moderation_clean");
  await client.query("grant create on database moderation_clean to shipwithali_migration");
  stage = "clean-migrations"; migrate(`postgres://postgres@127.0.0.1:${port}/moderation_clean`);
  const cleanClient = new Client({ connectionString: `postgres://postgres@127.0.0.1:${port}/moderation_clean` });
  const ledgerSql = "select version from supabase_migrations.schema_migrations order by version";
  let cleanSchema, cleanLedger;
  await cleanClient.connect();
  try { cleanSchema = (await cleanClient.query(schemaSql)).rows[0].schema; cleanLedger = (await cleanClient.query(ledgerSql)).rows; }
  finally { await cleanClient.end(); }
  const upgradeLedger = (await client.query(ledgerSql)).rows;
  if (JSON.stringify(cleanSchema) !== JSON.stringify(upgradedSchema) || JSON.stringify(cleanLedger) !== JSON.stringify(upgradeLedger) || upgradeLedger.length !== migrations.length) throw new Error("MODERATION_MIGRATION_DRIFT");
  stage = "migration-no-op-replay"; migrate(adminUrl);
  if (JSON.stringify((await client.query(ledgerSql)).rows) !== JSON.stringify(upgradeLedger)) throw new Error("MODERATION_MIGRATION_REPLAY_DRIFT");
  const migrationQualification = { cleanUpgradeEquivalent: true, migrationReplayNoOp: true, predecessorRatingPreserved: true, predecessorFeedbackPreserved: true, ledger: upgradeLedger,
    schemaSha256: createHash("sha256").update(JSON.stringify(upgradedSchema)).digest("hex"), cli: run(process.execPath, ["node_modules/supabase/dist/supabase.js", "--version"]).trim() };
  // Auxiliary preservation fixture must not enter Moderation's acceptance counts.
  await client.query("delete from interaction.feedback where feedback_id=$1", [priorFeedback[0]]);
  await client.query("delete from interaction.ratings where portfolio_id=$1 and project_id=$2 and visitor_id=$3", predecessor);
  await client.query("create role moderation_runtime login nosuperuser nobypassrls; grant shipwithali_application to moderation_runtime; create role moderation_worker login nosuperuser nobypassrls; grant shipwithali_worker to moderation_worker; ");
  const env = { ...process.env, PHASE7_MODERATION_DATABASE_URL: `postgres://moderation_runtime@127.0.0.1:${port}/postgres`, PHASE7_MODERATION_ADMIN_URL: adminUrl, PHASE7_MODERATION_WORKER_URL: `postgres://moderation_worker@127.0.0.1:${port}/postgres` };
  if (summaries) {
    await client.query("create role reaction_runtime login nosuperuser nobypassrls; grant shipwithali_application to reaction_runtime; create role rating_runtime login nosuperuser nobypassrls; grant shipwithali_application to rating_runtime");
    Object.assign(env, { PHASE7_REACTION_DATABASE_URL: `postgres://reaction_runtime@127.0.0.1:${port}/postgres`, PHASE7_REACTION_ADMIN_URL: adminUrl,
      PHASE7_RATING_DATABASE_URL: `postgres://rating_runtime@127.0.0.1:${port}/postgres`, PHASE7_RATING_ADMIN_URL: adminUrl });
  }
  const generated = "src/modules/interaction-moderation/adapters/database.generated.ts";
  stage = "type-generation";
  const codegen = ["node_modules/kysely-codegen/dist/cli/bin.js", "--dialect", "postgres", "--url", "env(PHASE7_MODERATION_ADMIN_URL)",
    "--default-schema", "interaction", "--include-pattern", "interaction.*", "--date-parser", "timestamp", "--out-file", generated, "--log-level", "error"];
  if (!process.argv.includes("--refresh-types")) codegen.push("--verify");
  run(process.execPath, codegen, env);
  // Refresh is setup, not source-bound final acceptance.
  const testedSource = workingTreeSourceSha256();
  if (!process.argv.includes("--refresh-types") && testedSource !== source) throw new Error("MODERATION_SOURCE_CHANGED_DURING_RUN");
  console.log("Temporary restricted PostgreSQL ready; running private Moderation acceptance.");
  stage = "acceptance";
  run(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/phase7/moderation.test.ts", "tests/phase7/moderation-postgres.test.ts", "tests/runtime/owner-moderation.test.ts", "tests/phase4/owner-request-security.test.ts", "tests/phase4/owner-session-auth.test.ts",
    ...(suppression ? ["tests/phase7/suppression-postgres.test.ts"] : []),
    ...(summaries ? ["tests/phase7/summaries-postgres.test.ts", "tests/phase7/reactions-postgres.test.ts", "tests/phase7/ratings-postgres.test.ts"] : []),
    "--no-file-parallelism", "--reporter=json", "--outputFile=" + reportPath], env);
  const tests = JSON.parse(readFileSync(reportPath, "utf8"));
  const assertions = tests.testResults.flatMap(s => s.assertionResults ?? []);
  if (!tests.success || tests.numFailedTestSuites || tests.numFailedTests || tests.numPendingTests || tests.numTodoTests ||
      tests.numPassedTests !== expectedTests || assertions.length !== expectedTests || tests.testResults.length !== (summaries ? 9 : suppression ? 6 : 5) ||
      tests.testResults.some(s => s.status !== "passed") || assertions.some(a => a.status !== "passed")) throw new Error("MODERATION_ACCEPTANCE_INCOMPLETE");
  if (workingTreeSourceSha256() !== testedSource) throw new Error("MODERATION_SOURCE_CHANGED_DURING_RUN");
  result = { runId, sourceRevision: run("git", ["rev-parse", "HEAD"]).trim(), sourceTreeSha256: testedSource, version,
    migration, migrationQualification, migrationSha256: createHash("sha256").update(readFileSync(migration)).digest("hex"),
    migrations: migrations.map(name => ({ name, sha256: createHash("sha256").update(readFileSync("supabase/migrations/" + name)).digest("hex") })),
    tools: { node: process.versions.node, npm: (process.env.npm_config_user_agent ?? "").match(/npm\/([^\s]+)/)?.[1] ?? "unavailable" },
    assertions: assertions.map(a => ({ title: a.title.replace(/: \{.*$/, ": invalid shape"), status: a.status })),
    required: { success: tests.success, passed: tests.numPassedTests, failed: tests.numFailedTests, skipped: tests.numPendingTests, failedSuites: tests.numFailedTestSuites },
    roles: ["moderation_runtime", "moderation_worker", "shipwithali_application", "shipwithali_worker", "anon", "authenticated", ...(summaries ? ["shipwithali_summary_reader", "reaction_runtime", "rating_runtime"] : [])],
    ...(suppression ? { queryPlan: JSON.parse(readFileSync("artifacts/suppression-query-plan.json", "utf8")) } : {}),
    reproduction: `npm run setup:validation; npm run validation:ready; npm run phase7:focus:${summaries ? "summaries" : suppression ? "suppression" : "moderation"} (PHASE7_POSTGRES_BIN selects installed PostgreSQL binaries)`,
    ...(summaries ? { summaryPlans: JSON.parse(readFileSync("artifacts/summary-query-plans.json", "utf8")) } : {}),
    scope: "Native disposable PostgreSQL cluster; all current repository migrations with focused clean/upgrade/replay qualification. Full integrated Phase 3-6 qualification belongs to #208." };
} catch (error) {
  // No provider messages, connection strings, payloads or secret-bearing PostgreSQL logs.
  console.error(error instanceof Error && /^MODERATION_/.test(error.message) ? error.message : "MODERATION_VALIDATION_FAILED");
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
    if (dirname(resolve(temp)) !== resolve(tmpdir()) || !basename(temp).startsWith("portfolio-moderation-193-")) {
      console.error("MODERATION_CLEANUP_PATH_INVALID"); process.exitCode = 1;
    } else { rmSync(temp, { recursive: true, force: true }); cleanup = true; }
  } catch { console.error("MODERATION_CLEANUP_FAILED"); process.exitCode = 1; }
  if (result && cleanup) {
    mkdirSync("evidence", { recursive: true });
    writeFileSync(evidencePath, JSON.stringify({ ...result, cleanup }, null, 2) + "\n");
    console.log(JSON.stringify({ required: result.required, cleanup }));
  }
}
function readFileSyncSafe(path) { try { return readFileSync(path, "utf8"); } catch { return null; } }
