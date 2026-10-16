#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { Client, Pool } from "pg";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const root = process.cwd();
const runId = randomUUID();
const baseline = "978287ed7863aae3f5390596c0e91229bd546621"; // master immediately before Phase 7 migrations
const firstPhase7Migration = "20261014194925_measurement_consent.sql";
const evidencePath = resolve("evidence/phase7-integrated-208.json");
const reportPath = resolve("artifacts/phase7-integrated-208-vitest.json");
const initialSource = workingTreeSourceSha256();
const discoveredBin = process.platform === "win32" ? "C:/Program Files/PostgreSQL/18/bin" :
  spawnSync("pg_config", ["--bindir"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim();
const bin = process.env.PHASE7_POSTGRES_BIN ?? discoveredBin ?? "";
const exe = name => bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
const schemas = ["content", "cv", "cv_portfolio", "identity_access", "interaction", "media", "measurement", "operations", "portfolio_config", "public_read", "taxonomy"];
const id = n => `0196a1b2-7c3d-7e11-9f22-${n.toString(16).padStart(12, "0")}`;
const evidenceInputs = ["phase7-consent-189.json","phase7-reactions-190.json","phase7-ratings-191.json","phase7-feedback-192.json","phase7-moderation-193.json","phase7-suppression-194.json","phase7-summaries-195.json","phase7-events-196.json","phase7-event-facts-197.json","phase7-event-capabilities-198.json","phase7-goal-versions-199.json","phase7-goal-activation-200.json","phase7-goal-conversions-201.json","phase7-daily-aggregates-202.json","phase7-aggregate-privacy-203.json","phase7-retention-204.json","phase7-feedback-retention-205.json","phase7-due-work-206.json","phase7-http-assembly-207.json"];

export function compareCatalogs(upgrade, clean) {
  if (JSON.stringify(upgrade) !== JSON.stringify(clean)) throw new Error("PHASE7_INTEGRATION_CLEAN_UPGRADE_CATALOG_DIFFERENCE");
  return true;
}

export function assertNoPublicSensitiveAccess(matrix) {
  const violations = matrix.filter(row => ["PUBLIC", "anon", "authenticated", "service_role"].includes(row.grantee) &&
    (Object.values(row.schemaPrivileges ?? {}).some(privileges => privileges.usage || privileges.create) || row.schemaUsage ||
      (Array.isArray(row.tablePrivileges) ? row.tablePrivileges.length > 0 : Boolean(row.tablePrivileges && row.tablePrivileges !== "{}"))));
  if (violations.length) throw new Error(`PHASE7_INTEGRATION_UNTRUSTED_DATABASE_GRANT_FOUND:${violations.map(row => `${row.grantee}(schema=${row.schemaUsage},table=${JSON.stringify(row.tablePrivileges)})`).join(";")}`);
  return true;
}

export function collectPlanIndexes(plan, indexes = []) {
  if (plan?.["Index Name"]) indexes.push(plan["Index Name"]);
  if (Array.isArray(plan?.["Conflict Arbiter Indexes"])) indexes.push(...plan["Conflict Arbiter Indexes"]);
  for (const child of plan?.Plans ?? []) collectPlanIndexes(child, indexes);
  return indexes;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env: options.env ?? process.env, encoding: "utf8", windowsHide: true,
    ...(command === exe("pg_ctl") ? { stdio: "ignore" } : {}), timeout: options.timeout ?? 240_000 });
  if (result.error || result.status !== 0) {
    const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join("\n").trim()
      .replace(/postgres(?:ql)?:\/\/\S+/giu, "[database-url]").replace(/\r?\n/gu, " | ").slice(-1_000) || "unavailable";
    throw new Error(`PHASE7_INTEGRATION_COMMAND_FAILED:${args[0] ?? command}:${result.status ?? "unavailable"}:${detail}`);
  }
  return result.stdout ?? "";
}

function git(args) { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
function verifyEvidenceInputs() {
  return evidenceInputs.map(name => {
    const path = join(root, "evidence", name);
    let evidence;
    try { evidence = JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error(`PHASE7_INTEGRATION_REQUIRED_EVIDENCE_MISSING:${name}`); }
    const required = evidence.required ?? {
      success: evidence.focusedAcceptance?.success,
      passed: evidence.focusedAcceptance?.passed,
      failed: evidence.focusedAcceptance?.failed,
      skipped: evidence.focusedAcceptance?.requiredSkipped,
      failedSuites: (evidence.checks ?? []).filter(check => check.failed > 0 || check.success === false).length,
    };
    const cleanup = evidence.cleanup ?? evidence.focusedAcceptance?.cleanup;
    if (!required || required.success !== true || Number(required.failed ?? 0) !== 0 || Number(required.skipped ?? 0) !== 0 || Number(required.failedSuites ?? 0) !== 0 || cleanup !== true || typeof evidence.sourceTreeSha256 !== "string") {
      throw new Error(`PHASE7_INTEGRATION_REQUIRED_EVIDENCE_INVALID:${name}`);
    }
    return { path: `evidence/${name}`, runId: evidence.runId ?? evidence.validationBatchId ?? "not-recorded", sourceRevision: evidence.sourceRevision ?? "not-recorded", baseCommit: evidence.baseCommit ?? null, sourceTreeSha256: evidence.sourceTreeSha256, passed: Number(required.passed ?? 0), failed: 0, skipped: 0, cleanup: true };
  });
}
function runPackageCheck(name) {
  if (!process.env.npm_execpath) throw new Error("PHASE7_INTEGRATION_NPM_EXEC_PATH_MISSING");
  run(process.execPath, [process.env.npm_execpath, "run", name], { timeout: 900_000 });
  return { command: `npm run ${name}`, passed: true };
}
function runUnitCheck() {
  run(process.execPath, ["--test", "tests/tooling/phase7-integration-208.test.mjs"], { timeout: 120_000 });
  return { command: "node --test tests/tooling/phase7-integration-208.test.mjs", passed: true };
}
function migrationNamesAt(commit) {
  return git(["ls-tree", "-r", "--name-only", commit, "supabase/migrations"]).split(/\r?\n/u)
    .map(path => path.split("/").at(-1)).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/u.test(name ?? "")).sort();
}
function currentMigrationNames() {
  return readdirSync(join(root, "supabase", "migrations")).filter(name => /^\d{14}_[a-z0-9_]+\.sql$/u.test(name)).sort();
}
function historicalMigration(name) { return git(["show", `${baseline}:supabase/migrations/${name}`]); }
function connectString(db, user = "postgres", port) { return `postgres://${user}@127.0.0.1:${port}/${db}?sslmode=disable`; }

async function withClient(connectionString, work) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try { return await work(client); } finally { await client.end(); }
}

async function applyMigrations(connectionString, migrations) {
  await withClient(connectionString, async client => {
    for (const migration of migrations) {
      const sql = migration.historical ? historicalMigration(migration.name) : readFileSync(join(root, "supabase", "migrations", migration.name), "utf8");
      await client.query(sql);
    }
  });
}

async function catalogSnapshot(connectionString) {
  return withClient(connectionString, async client => {
    const schemasResult = await client.query("select nspname as name, pg_get_userbyid(nspowner) as owner,coalesce(nspacl::text,'') as acl from pg_namespace where nspname=any($1::text[]) order by 1", [schemas]);
    const roles = await client.query("select rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname=any($1::text[]) order by 1", [["anon", "authenticated", "service_role", "shipwithali_application", "shipwithali_worker", "shipwithali_migration", "shipwithali_backup", "shipwithali_summary_reader"]]);
    const objects = await client.query("select n.nspname as schema,c.relname as name,c.relkind as kind,pg_get_userbyid(c.relowner) as owner,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,coalesce(c.reloptions,'{}') as options from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=any($1::text[]) and c.relkind in ('r','p','v','m','f') order by 1,2", [schemas]);
    const columns = await client.query("select table_schema as schema,table_name as table,column_name as column_name,data_type,is_nullable,column_default from information_schema.columns where table_schema=any($1::text[]) order by 1,2,ordinal_position", [schemas]);
    const policies = await client.query("select schemaname as schema,tablename as table,policyname as name,lower(permissive) as permissive,roles,cmd,coalesce(qual,'') as using,coalesce(with_check,'') as check from pg_policies where schemaname=any($1::text[]) order by 1,2,3", [schemas]);
    const grants = await client.query("select table_schema as schema,table_name as table,grantee,privilege_type,is_grantable from information_schema.role_table_grants where table_schema=any($1::text[]) and grantee=any($2::text[]) order by 1,2,3,4", [schemas, ["PUBLIC", "anon", "authenticated", "service_role", "shipwithali_application", "shipwithali_worker", "shipwithali_backup"]]);
    const indexes = await client.query("select schemaname as schema,tablename as table,indexname as name,indexdef from pg_indexes where schemaname=any($1::text[]) order by 1,2,3", [schemas]);
    const constraints = await client.query("select n.nspname as schema,c.relname as table,con.conname as name,con.contype as type,pg_get_constraintdef(con.oid,true) as definition,con.convalidated as validated from pg_constraint con join pg_class c on c.oid=con.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname=any($1::text[]) order by 1,2,3", [schemas]);
    const functions = await client.query("select n.nspname as schema,p.proname as name,pg_get_function_identity_arguments(p.oid) as args,p.prosecdef as security_definer,coalesce(p.proconfig,'{}') as config,r.rolname as owner,r.rolcanlogin as owner_can_login,r.rolsuper as owner_superuser,r.rolbypassrls as owner_bypass_rls,has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_execute,has_function_privilege('shipwithali_application',p.oid,'EXECUTE') as application_execute,has_function_privilege('shipwithali_backup',p.oid,'EXECUTE') as backup_execute,has_function_privilege('shipwithali_worker',p.oid,'EXECUTE') as worker_execute from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname=any($1::text[]) order by 1,2,3", [schemas]);
    const defaults = await client.query("select n.nspname as schema,d.defaclobjtype as object_type,coalesce(r.rolname,'PUBLIC') as grantee,x.privilege_type from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) x left join pg_roles r on r.oid=x.grantee where n.nspname=any($1::text[]) order by 1,2,3,4", [schemas]);
    if (schemasResult.rowCount !== schemas.length) throw new Error("PHASE7_INTEGRATION_SCHEMA_SNAPSHOT_INCOMPLETE");
    if (objects.rows.filter(row => row.kind === "r" || row.kind === "p").some(row => !row.rls || !row.force_rls)) throw new Error("PHASE7_INTEGRATION_TABLE_RLS_NOT_FORCED");
    if (defaults.rows.some(row => row.grantee === "PUBLIC")) throw new Error("PHASE7_INTEGRATION_PUBLIC_DEFAULT_GRANT_FOUND");
    const summaryRole = roles.rows.find(row => row.rolname === "shipwithali_summary_reader");
    const summaryMembership = await client.query("select pg_has_role('shipwithali_application','shipwithali_summary_reader','MEMBER') as member");
    if (!summaryRole || summaryRole.rolcanlogin || summaryRole.rolsuper || summaryRole.rolbypassrls || summaryMembership.rows[0].member) throw new Error("PHASE7_INTEGRATION_SUMMARY_READER_ROLE_UNSAFE");
    for (const view of objects.rows.filter(row => ["v", "m"].includes(row.kind) && ["interaction", "measurement"].includes(row.schema))) {
      if (view.owner !== "shipwithali_summary_reader" || !view.options.includes("security_barrier=true")) throw new Error(`PHASE7_INTEGRATION_UNRESTRICTED_VIEW_OWNER:${view.schema}.${view.name}`);
    }
    for (const fn of functions.rows.filter(row => row.security_definer && ["interaction", "measurement"].includes(row.schema))) {
      if (!fn.config.some(value => value.startsWith("search_path=")) || fn.owner_can_login || fn.owner_superuser || fn.owner_bypass_rls || fn.anon_execute || fn.authenticated_execute || fn.service_role_execute || fn.application_execute || fn.backup_execute) {
        throw new Error("PHASE7_INTEGRATION_UNSAFE_SECURITY_DEFINER_FOUND");
      }
    }
    return {
      schemas: schemasResult.rows, roles: roles.rows, objects: objects.rows, columns: columns.rows, policies: policies.rows,
      grants: grants.rows, indexes: indexes.rows, constraints: constraints.rows, functions: functions.rows, defaults: defaults.rows,
    };
  });
}

async function insertLegacyFixture(connectionString) {
  await withClient(connectionString, client => client.query(
    "insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Upgrade fixture','Engineer','Historical predecessor row','Contact','https://example.test','Unavailable')",
    [id(1), id(2)]));
}

async function legacyFixtureSnapshot(connectionString) {
  return withClient(connectionString, async client => (await client.query(
    "select portfolio_id::text,owner_id::text,display_name,version from portfolio_config.settings where portfolio_id=$1", [id(1)])).rows);
}

async function executeAndCollectPlan(client, title, sql) {
  const result = await client.query(`explain (analyze, buffers, format json) ${sql}`);
  const plan = result.rows[0]["QUERY PLAN"][0];
  const indexes = collectPlanIndexes(plan.Plan);
  if (!plan.Plan || plan["Planning Time"] === undefined || plan["Execution Time"] === undefined) throw new Error(`PHASE7_INTEGRATION_PLAN_INCOMPLETE:${title}`);
  return { title, nodeType: plan.Plan["Node Type"], indexes: [...new Set(indexes)].sort(), planningMs: plan["Planning Time"], executionMs: plan["Execution Time"], actualRows: plan.Plan["Actual Rows"] };
}

async function seedAndInspectPlans(connectionString) {
  return withClient(connectionString, async client => {
    const p = id(1), owner = id(2), project = id(3);
    await client.query("begin");
    try {
      await client.query(`insert into interaction.reactions(portfolio_id,project_id,visitor_id,kind,updated_at)
        select $1::uuid,$2::uuid,('0196a1b2-7c3d-7e11-9f44-'||lpad(to_hex(i),12,'0'))::uuid,'like',transaction_timestamp()
        from generate_series(1,5000) i`, [p, project]);
      await client.query(`insert into interaction.feedback(feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at)
        select ('0196a1b2-7c3d-7e11-9f55-'||lpad(to_hex(i),12,'0'))::uuid,$1::uuid,$2::uuid,'en','Plan visitor','Plan fixture','approved',1,transaction_timestamp()-(i||' minutes')::interval
        from generate_series(1,5000) i`, [p, project]);
      await client.query(`insert into measurement.daily_aggregates(portfolio_id,utc_day,metric_kind,metric_key,event_count,sum_value,observed_subjects,returning_subjects,policy_version,checkpoint_at)
        select $1::uuid,current_date,'action','metric-'||i,1,0,5,0,'phase7.daily.v1',transaction_timestamp()
        from generate_series(1,5000) i`, [p]);
      await client.query(`insert into measurement.consents(portfolio_id,consent_id,subject,state,notice_version,revision,recorded_at,evidence_expires_at)
        select $1::uuid,('0196a1b2-7c3d-7e11-9f66-'||lpad(to_hex(i),12,'0'))::uuid,null,'denied','phase7-plan',1,
          case when i <= 100 then transaction_timestamp()-interval '20 days' else transaction_timestamp() end,
          case when i <= 100 then transaction_timestamp()-interval '16 days' else transaction_timestamp()+interval '4 days' end
        from generate_series(1,5000) i`, [p]);
      await client.query(`insert into operations.jobs(job_id,job_type,payload_version,payload,available_at,status)
        select ('0196a1b2-7c3d-7e11-9f77-'||lpad(to_hex(i),12,'0'))::uuid,'phase7-plan',1,'{}'::jsonb,transaction_timestamp()-(i||' seconds')::interval,'available'
        from generate_series(1,5000) i`);
      await client.query("analyze interaction.reactions; analyze interaction.feedback; analyze measurement.daily_aggregates; analyze measurement.consents; analyze operations.jobs;");
      const pair = await executeAndCollectPlan(client, "functional visitor pair upsert", `insert into interaction.reactions(portfolio_id,project_id,visitor_id,kind,updated_at) values ('${p}'::uuid,'${project}'::uuid,'0196a1b2-7c3d-7e11-9f44-000000001388'::uuid,'like',statement_timestamp()) on conflict(portfolio_id,project_id,visitor_id) do update set kind=excluded.kind,updated_at=excluded.updated_at`);
      const page = await executeAndCollectPlan(client, "approved Feedback keyset page", `select feedback_id from interaction.feedback where portfolio_id='${p}'::uuid and project_id='${project}'::uuid and locale='en' and moderation_state='approved' order by submitted_at desc,feedback_id desc limit 51`);
      const report = await executeAndCollectPlan(client, "daily aggregate Owner report", `select metric_key,event_count,observed_subjects from measurement.daily_aggregates where portfolio_id='${p}'::uuid and utc_day=current_date and metric_kind='action' and metric_key='metric-5000'`);
      const eligibleBefore = Number((await client.query("select count(*)::int as total from measurement.consents where portfolio_id=$1 and evidence_expires_at <= statement_timestamp()", [p])).rows[0].total);
      const cleanup = await executeAndCollectPlan(client, "bounded expired consent cleanup batch", `with expired as (select portfolio_id,consent_id from measurement.consents where portfolio_id='${p}'::uuid and evidence_expires_at <= statement_timestamp() order by evidence_expires_at,consent_id limit 50 for update) delete from measurement.consents c using expired e where c.portfolio_id=e.portfolio_id and c.consent_id=e.consent_id`);
      const eligibleAfter = Number((await client.query("select count(*)::int as total from measurement.consents where portfolio_id=$1 and evidence_expires_at <= statement_timestamp()", [p])).rows[0].total);
      cleanup.candidateRows = eligibleBefore;
      cleanup.deletedRows = eligibleBefore - eligibleAfter;
      const lease = await executeAndCollectPlan(client, "bounded due-job claim", `select job_id from operations.jobs where status='available' and available_at <= statement_timestamp() and completed_at is null order by available_at,job_id limit 50 for update skip locked`);
      const expectedIndexes = [[pair, "reactions_pkey"], [page, "feedback_project_locale"], [report, "daily_aggregates_pkey"], [cleanup, "consents_expiry"], [lease, "jobs_due_idx"]];
      for (const [plan, index] of expectedIndexes) if (!plan.indexes.includes(index)) throw new Error(`PHASE7_INTEGRATION_EXPECTED_INDEX_MISSING:${plan.title}`);
      if (cleanup.candidateRows < 1 || cleanup.deletedRows < 1 || cleanup.deletedRows > 50) throw new Error(`PHASE7_INTEGRATION_CLEANUP_BATCH_NOT_BOUNDED:${cleanup.candidateRows}:${cleanup.deletedRows}`);
      await client.query("rollback");
      return { fixtureRowsPerRelation: 5000, plans: [pair, page, report, cleanup, lease] };
    } catch (error) { await client.query("rollback").catch(() => {}); throw error; }
  });
}

async function verifyScopedRoles(connectionString, port) {
  await withClient(connectionString, async admin => {
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Scope A','Engineer','Fixture A','Contact','https://example.test/a','Unavailable'),($3,$4,'Scope B','Engineer','Fixture B','Contact','https://example.test/b','Unavailable')", [id(11), id(12), id(21), id(22)]);
    await admin.query("insert into measurement.consents(portfolio_id,consent_id,subject,state,notice_version,revision,recorded_at,evidence_expires_at) values ($1,$2,null,'denied','integration',1,now()-interval '20 days',now()-interval '16 days'),($3,$4,null,'denied','integration',1,now()-interval '20 days',now()-interval '16 days')", [id(11), id(31), id(21), id(32)]);
    await admin.query("insert into measurement.retention_checkpoints(portfolio_id,job_id,work_kind,requested_at,stage,updated_at) values ($1,$2,'detail',now(),'consents',now())", [id(11), id(52)]);
    await admin.query("insert into content.items(content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project','published')", [id(13), id(11)]);
    await admin.query("insert into content.public_routes(route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project','integration-project',now())", [id(61), id(13), id(11)]);
    await admin.query("insert into content.revisions(revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project','en',1,1,'Project','Summary','Body',$4::jsonb,now())", [id(62), id(13), id(11), JSON.stringify({contentType:"project",locale:"en",title:"Project",summary:"Summary",body:"Body"})]);
    await admin.query("insert into content.revision_reviews(review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,'en',1,$5,1,$6,'accepted',now())", [id(63), id(13), id(11), id(62), "a".repeat(64), id(12)]);
    await admin.query("insert into content.language_publications(content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project','en',$3,$4,$5,1,now())", [id(13), id(11), id(62), id(63), id(61)]);
    await admin.query("insert into interaction.reactions(portfolio_id,project_id,visitor_id,kind,updated_at) values ($1,$2,$3,'like',now())", [id(11), id(13), id(64)]);
    await admin.query("insert into interaction.ratings(portfolio_id,project_id,visitor_id,value,updated_at) values ($1,$2,$3,5,now())", [id(11), id(13), id(65)]);
    await admin.query("insert into interaction.feedback(feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at) values ($1,$2,$3,'en','PRIVATE_SENTINEL_NAME','PRIVATE_SENTINEL_PARAGRAPH_208','pending',1,now())", [id(41), id(11), id(13)]);
    const leaked = await admin.query(`select
      exists(select 1 from operations.outbox_events where payload::text like '%PRIVATE_SENTINEL_%') as outbox,
      exists(select 1 from operations.jobs where payload::text like '%PRIVATE_SENTINEL_%') as jobs,
      exists(select 1 from measurement.daily_aggregates where dimensions::text like '%PRIVATE_SENTINEL_%') as dimensions`);
    if (Object.values(leaked.rows[0]).some(Boolean)) throw new Error("PHASE7_INTEGRATION_PRIVATE_SENTINEL_LEAKED");
  });

  const appUrl = connectString("phase7_clean", "phase7_integration_app", port);
  const pool = new Pool({ connectionString: appUrl, max: 1 });
  let pid;
  try {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true)", [id(11), id(12)]);
      pid = (await client.query("select pg_backend_pid()::int as pid")).rows[0].pid;
      const own = await client.query("select portfolio_id::text from portfolio_config.settings order by portfolio_id");
      const ownConsent = await client.query("select portfolio_id::text from measurement.consents order by portfolio_id");
      if (own.rows.length !== 1 || own.rows[0].portfolio_id !== id(11) || ownConsent.rows.length !== 1 || ownConsent.rows[0].portfolio_id !== id(11)) throw new Error("PHASE7_INTEGRATION_OWNER_SCOPE_LEAK");
      await client.query("select set_config('shipwithali.summary_project_id',$1,true),set_config('shipwithali.summary_locale','en',true)", [id(13)]);
      const rawVotes = await client.query("select * from interaction.reactions");
      const safeSummary = await client.query("select * from interaction.current_reaction_counts");
      const safeRating = await client.query("select * from interaction.current_rating_summary");
      if (rawVotes.rows.length !== 0 || safeSummary.rows[0]?.likes !== "1" || safeSummary.rows[0]?.dislikes !== "0" || safeRating.rows[0]?.raters !== "1" || safeRating.rows[0]?.average !== null) throw new Error("PHASE7_INTEGRATION_OWNER_RIGHTS_SUMMARY_FAILED");
      await client.query("select set_config('shipwithali.summary_project_id',$1,true)", [id(23)]);
      const foreignSummary = await client.query("select * from interaction.current_reaction_counts");
      if (foreignSummary.rows[0]?.likes !== "0" || foreignSummary.rows[0]?.dislikes !== "0") throw new Error("PHASE7_INTEGRATION_SUMMARY_SCOPE_LEAK");
      await client.query("commit");
      await client.query("begin");
      const reset = await client.query("select current_setting('shipwithali.portfolio_id',true) as portfolio,current_setting('shipwithali.owner_id',true) as owner");
      if (![null, ""].includes(reset.rows[0].portfolio) || ![null, ""].includes(reset.rows[0].owner)) throw new Error("PHASE7_INTEGRATION_POOL_SCOPE_NOT_CLEARED");
      await client.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true)", [id(21), id(22)]);
      const next = await client.query("select portfolio_id::text from portfolio_config.settings order by portfolio_id");
      if (next.rows.length !== 1 || next.rows[0].portfolio_id !== id(21) || (await client.query("select pg_backend_pid()::int as pid")).rows[0].pid !== pid) throw new Error("PHASE7_INTEGRATION_POOLED_SCOPE_REUSE_FAILED");
      await client.query("rollback");
      let roleEscalationDenied = false;
      try { await client.query("set role shipwithali_summary_reader"); } catch (error) { roleEscalationDenied = error?.code === "42501"; }
      if (!roleEscalationDenied) throw new Error("PHASE7_INTEGRATION_SUMMARY_ROLE_ESCALATION_ALLOWED");
    } finally { client.release(); }
  } finally { await pool.end(); }

  const concurrentPool = new Pool({ connectionString: appUrl, max: 2 });
  const concurrentClients = await Promise.all([concurrentPool.connect(), concurrentPool.connect()]);
  try {
    const scopes = [[id(11), id(12)], [id(21), id(22)]];
    for (let index = 0; index < concurrentClients.length; index++) {
      await concurrentClients[index].query("begin");
      await concurrentClients[index].query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true)", scopes[index]);
    }
    const isolated = await Promise.all(concurrentClients.map(client => client.query("select portfolio_id::text from portfolio_config.settings order by portfolio_id")));
    if (isolated.some((result, index) => result.rows.length !== 1 || result.rows[0].portfolio_id !== scopes[index][0])) throw new Error("PHASE7_INTEGRATION_CONCURRENT_SCOPE_LEAK");
  } finally {
    await Promise.all(concurrentClients.map(client => client.query("rollback").catch(() => {})));
    concurrentClients.forEach(client => client.release());
    await concurrentPool.end();
  }

  const app = new Client({ connectionString: appUrl }); await app.connect();
  try {
    await app.query("begin");
    await app.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true)", [id(11), id(12)]);
    await app.query("select set_config('shipwithali.owner_id','',true)");
    const unscopedFeedback = await app.query("select feedback_id from interaction.feedback");
    const grants = await app.query("select has_table_privilege(current_user,'interaction.feedback','insert') as can_submit_feedback,has_table_privilege(current_user,'measurement.daily_aggregates','select') as can_read_report");
    if (unscopedFeedback.rows.length !== 0 || !grants.rows[0].can_submit_feedback || !grants.rows[0].can_read_report) throw new Error("PHASE7_INTEGRATION_APPLICATION_GRANT_MATRIX_FAILED");
    await app.query("rollback");
  } finally { await app.end(); }

  const worker = new Client({ connectionString: connectString("phase7_clean", "phase7_integration_worker", port) }); await worker.connect();
  try {
    await worker.query("begin");
    await worker.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.worker_id',$2,true)", [id(11), id(51)]);
    const workerRows = await worker.query("select portfolio_id::text from measurement.consents");
    if (workerRows.rows.length !== 1 || workerRows.rows[0].portfolio_id !== id(11)) throw new Error("PHASE7_INTEGRATION_WORKER_SCOPE_LEAK");
    const workerPrivilege = await worker.query("select has_table_privilege(current_user,'interaction.feedback','select') as can_read_text,has_table_privilege(current_user,'measurement.consents','update') as can_update_consent");
    if (workerPrivilege.rows[0].can_read_text || workerPrivilege.rows[0].can_update_consent) throw new Error("PHASE7_INTEGRATION_WORKER_PRIVILEGE_TOO_BROAD");
    const deleteResult = await worker.query("delete from measurement.consents where portfolio_id=$1 and consent_id=$2", [id(11), id(31)]);
    if (deleteResult.rowCount !== 1) throw new Error("PHASE7_INTEGRATION_WORKER_CLEANUP_SCOPE_FAILED");
    await worker.query("rollback");
  } finally { await worker.end(); }

  const matrix = await withClient(connectionString, async admin => {
    const query = await admin.query(`
    select r.rolname as grantee,
      has_schema_privilege(r.rolname,'interaction','usage') as interaction_usage,
      has_schema_privilege(r.rolname,'interaction','create') as interaction_create,
      has_schema_privilege(r.rolname,'measurement','usage') as measurement_usage,
      has_schema_privilege(r.rolname,'measurement','create') as measurement_create,
      coalesce(array_agg(distinct g.privilege_type) filter(where g.privilege_type is not null),'{}') as table_privileges
    from pg_roles r left join information_schema.role_table_grants g on g.grantee=r.rolname and g.table_schema in ('interaction','measurement')
    where r.rolname in ('anon','authenticated','service_role') group by r.rolname order by r.rolname`);
    return query.rows.map(row => ({ grantee: row.grantee, schemaPrivileges: {
      interaction: { usage: row.interaction_usage, create: row.interaction_create },
      measurement: { usage: row.measurement_usage, create: row.measurement_create },
    }, tablePrivileges: row.table_privileges }));
  });
  assertNoPublicSensitiveAccess(matrix);
  return { matrix, applicationScope: "RLS restricts settings and consent; caller cannot read raw Reaction rows, while the narrowly owned no-login/NOBYPASSRLS summary views return only scoped counts and honor the five-rater threshold", pooledScope: "same backend transaction-local Portfolio and Owner settings cleared at commit and replaced on next transaction", workerScope: "worker sees and expires only its scoped consent; no Feedback text read or consent state update", summaryViewSecurity: "security-barrier views are owned by isolated no-login/NOBYPASSRLS shipwithali_summary_reader; caller scope and Content publication facts remain in the view query; application cannot assume that role", privateSentinel: "Feedback name and paragraph absent from outbox, job payloads, and Measurement dimensions" };
}

async function main() {
  const startedAt = new Date().toISOString();
  const current = currentMigrationNames();
  const previous = migrationNamesAt(baseline);
  if (!previous.length || previous.some(name => name >= firstPhase7Migration) || !current.includes(firstPhase7Migration)) throw new Error("PHASE7_INTEGRATION_PREDECESSOR_MIGRATIONS_INVALID");
  for (const name of previous) {
    const currentSql = readFileSync(join(root, "supabase", "migrations", name), "utf8").replace(/\r\n/gu, "\n").trimEnd();
    const baselineSql = historicalMigration(name).replace(/\r\n/gu, "\n").trimEnd();
    if (currentSql !== baselineSql) throw new Error(`PHASE7_INTEGRATION_PREDECESSOR_MIGRATION_DRIFT:${name}`);
  }
  const newNames = current.filter(name => !previous.includes(name));
  if (!newNames.length || newNames.some(name => name < firstPhase7Migration)) throw new Error("PHASE7_INTEGRATION_MIGRATION_DELTA_INVALID");
  const port = await new Promise((ok, fail) => { const server = createServer(); server.once("error", fail); server.listen(0,"127.0.0.1",()=>{const value=server.address().port;server.close(()=>ok(value));}); });
  const temp = join(root, "node_modules", ".cache", `phase7-integration-208-${runId}`);
  const data = join(temp, "data"); mkdirSync(temp,{recursive:true}); mkdirSync("artifacts",{recursive:true}); rmSync(reportPath,{force:true});
  const adminUrl = connectString("postgres","postgres",port); const admin = new Client({connectionString:adminUrl});
  let started=false,connected=false,cleanup=false,result;
  try {
    run(process.execPath,["scripts/validation-environment.mjs"]);
    const postgresVersion=run(exe("postgres"),["--version"]).trim();
    run(exe("initdb"),["-D",data,"--no-locale","-A","trust","-U","postgres"]);
    run(exe("pg_ctl"),["-D",data,"-l",join(temp,"server.log"),"-o",`-h 127.0.0.1 -p ${port} -F`,"-w","start"]);
    started=true;
    await admin.connect(); connected=true;
    await admin.query("create role anon nologin; create role authenticated nologin; create role service_role nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
    await admin.query("create role phase7_integration_app login nosuperuser nocreatedb nocreaterole noreplication nobypassrls; create role phase7_integration_worker login nosuperuser nocreatedb nocreaterole noreplication nobypassrls");
    const p7Schemas = ["measurement","interaction"];
    await admin.query("create database phase7_upgrade");
    await admin.query("create database phase7_clean");
    await admin.query("grant create on database phase7_upgrade to shipwithali_migration");
    await admin.query("grant create on database phase7_clean to shipwithali_migration");
    const oldMigrations = previous.map(name=>({name,historical:true}));
    await applyMigrations(connectString("phase7_upgrade","postgres",port),oldMigrations);
    await insertLegacyFixture(connectString("phase7_upgrade","postgres",port));
    await applyMigrations(connectString("phase7_upgrade","postgres",port),newNames.map(name=>({name,historical:false})));
    await applyMigrations(connectString("phase7_clean","postgres",port),current.map(name=>({name,historical:false})));
    const before = await legacyFixtureSnapshot(connectString("phase7_upgrade","postgres",port));
    if (before.length!==1 || before[0].display_name!=="Upgrade fixture") throw new Error("PHASE7_INTEGRATION_PREDECESSOR_DATA_NOT_PRESERVED");
    const [upgradeCatalog,cleanCatalog]=await Promise.all([catalogSnapshot(connectString("phase7_upgrade","postgres",port)),catalogSnapshot(connectString("phase7_clean","postgres",port))]);
    compareCatalogs(upgradeCatalog,cleanCatalog);
    await admin.query("grant shipwithali_application to phase7_integration_app; grant shipwithali_worker to phase7_integration_worker");
    const cleanUrl=connectString("phase7_clean","postgres",port);
    for (const db of ["phase7_upgrade","phase7_clean"]) {
      for (const schema of p7Schemas) {
        const typeFile=schema==="measurement"?"src/modules/measurement/adapters/database.generated.ts":"src/modules/interaction-moderation/adapters/database.generated.ts";
        const env={...process.env,PHASE7_INTEGRATION_TYPES_URL:connectString(db,"postgres",port)};
        run(process.execPath,["node_modules/kysely-codegen/dist/cli/bin.js","--dialect","postgres","--url","env(PHASE7_INTEGRATION_TYPES_URL)","--default-schema",schema,"--include-pattern",`${schema}.*`,"--date-parser","timestamp","--out-file",typeFile,"--log-level","error","--verify"],{env});
      }
    }
    const scoped=await verifyScopedRoles(cleanUrl,port);
    const plans=await seedAndInspectPlans(cleanUrl);
    const priorEvidence=verifyEvidenceInputs();
    const checks=[runUnitCheck(),...(["lint","contract:verify","typecheck","test:arch","route:inventory","runtime:architecture","runtime:boundary","build"].map(runPackageCheck))];
    const sourceTreeSha256=workingTreeSourceSha256();
    if(sourceTreeSha256!==initialSource) throw new Error("PHASE7_INTEGRATION_SOURCE_CHANGED_DURING_RUN");
    result={ticket:208,runId,sourceRevision:git(["rev-parse","HEAD"]),sourceTreeSha256,startedAt,completedAt:new Date().toISOString(),postgresVersion,
      tools:{node:process.versions.node,npm:(process.env.npm_config_user_agent??"").match(/npm\/([^\s]+)/u)?.[1]??"unavailable"},
      baselineCommit:baseline,migrations:current.map(name=>({name,sha256:createHash("sha256").update(readFileSync(join(root,"supabase","migrations",name))).digest("hex")})),
      cleanUpgrade:{equivalent:true,schemas:schemas.length,relations:cleanCatalog.objects.length,policies:cleanCatalog.policies.length,grants:cleanCatalog.grants.length,predecessorFixturePreserved:true,generatedTypesVerified:p7Schemas},
      restrictedAccess:scoped,queryPlans:plans,roleFlags:cleanCatalog.roles.filter(row=>["shipwithali_application","shipwithali_worker"].includes(row.rolname)),
      securityObjects:{views:cleanCatalog.objects.filter(row=>["v","m"].includes(row.kind)&&["interaction","measurement"].includes(row.schema)),
        securityDefinerFunctions:cleanCatalog.functions.filter(row=>row.security_definer).map(row=>({schema:row.schema,name:row.name,args:row.args,owner:row.owner,ownerCanLogin:row.owner_can_login,ownerSuperuser:row.owner_superuser,ownerBypassRls:row.owner_bypass_rls,config:row.config}))},
      evidenceInputs:priorEvidence,checks,
      criteria:{"T21-01":"clean and pre-Phase-7 upgrade schemas including namespace ACLs, grants, policies, indexes, constraints, defaults and generated interaction/measurement types are equivalent; prior Portfolio row preserved",
        "T21-02":"anonymous/authenticated/service-role have no sensitive-schema usage/create or table access; restricted app/worker logins exercise real RLS and narrow grants",
        "T21-03":"transaction-local Portfolio and Owner context clears and rebinds on a reused pooled backend; concurrent scoped transactions remain isolated",
        "T21-04":"view inventory rejects owner-security views; scoped role and retention-function checks are linked to #204/#206 real PostgreSQL evidence",
        "T21-05":"standard module architecture and HTTP composition are linked to current #207 acceptance evidence",
        "T21-06":"five seeded EXPLAIN ANALYZE plans require pair-upsert/page/report/bounded-nonempty-cleanup/lease indexes",
        "T21-07":"private sentinels stay out of outbox, job payloads and Measurement dimensions; module-specific privacy cases link to #192/#196/#204/#205/#206 evidence",
        "T21-08":"current consent crypto/Owner authorization proof links to #189/#207; real worker/application role behavior executed here",
        "T21-09":"generated Measurement/Interaction type verification executed here; contract, route, architecture and build checks link to #207 evidence",
        "T21-10":"this report binds the final source tree, commit, run, migration checksums, principals, plans, sanitized totals and cleanup"},
      required:{success:true,passed:10,failed:0,skipped:0,failedSuites:0},reproduction:"npm run setup:validation; npm run validation:ready; npm run phase7:focus:integrated",cleanup:true};
    result.cleanup=false;
  } finally {
    let connectionClosed=true;
    if(connected) try {await admin.end();} catch {connectionClosed=false;console.error("PHASE7_INTEGRATION_CONNECTION_CLEANUP_FAILED");process.exitCode=1;}
    let serverStopped=!started;
    if(started) try {run(exe("pg_ctl"),["-D",data,"-m","immediate","-w","stop"]);serverStopped=true;} catch {console.error("PHASE7_INTEGRATION_POSTGRES_CLEANUP_FAILED");process.exitCode=1;}
    let directoryRemoved=false;
    try {rmSync(temp,{recursive:true,force:true});directoryRemoved=true;} catch {console.error("PHASE7_INTEGRATION_DIRECTORY_CLEANUP_FAILED");process.exitCode=1;}
    cleanup=connectionClosed&&serverStopped&&directoryRemoved;
    if(result&&cleanup){result.cleanup=true;mkdirSync("evidence",{recursive:true});writeFileSync(evidencePath,`${JSON.stringify(result,null,2)}\n`);console.log(JSON.stringify({required:result.required,runId,sourceTreeSha256:result.sourceTreeSha256,evidence:evidencePath,cleanup}));}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{
    if (error instanceof Error && /^PHASE7_INTEGRATION_/u.test(error.message)) console.error(error.message);
    else {
      const code = typeof error?.code === "string" && /^[A-Z0-9]{5}$/u.test(error.code) ? error.code : "unavailable";
      const detail = error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/giu,"[database-url]").replace(/\r?\n/gu," | ").slice(-500) : "unavailable";
      console.error(`PHASE7_INTEGRATION_VALIDATION_FAILED:${code}:${detail}`);
    }
    process.exitCode=1;
  });
}
