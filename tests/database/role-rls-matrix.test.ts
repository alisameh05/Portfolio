import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env["PHASE3_DATABASE_URL"];
if (process.env["PHASE3_REQUIRE_DATABASE"] === "1" && !DATABASE_URL) {
  throw new Error("PHASE3_DATABASE_URL is required for the Phase 3 integration gate.");
}

const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const ROOT = process.cwd();

const KNOWN_ROLES = Object.freeze([
  "anon",
  "authenticated",
  "shipwithali_application",
  "shipwithali_worker",
  "shipwithali_backup",
  "shipwithali_migration",
]);

const IDEMPOTENCY_INSERT = `insert into operations.idempotency_records (
  operation_scope, actor_scope, key_hash, request_hash, status, expires_at
) values (
  'phase3.role.probe', repeat('a', 64), repeat('b', 64), repeat('c', 64),
  'reserved', transaction_timestamp() + interval '1 day'
)`;

const OUTBOX_INSERT = `insert into operations.outbox_events (
  event_id, event_type, schema_version, aggregate_id, aggregate_version,
  payload, correlation_id, occurred_at, available_at
) values (
  '018f4f7d-5000-7000-8000-000000000001', 'phase3.role.probe', 1,
  '018f4f7d-5000-7000-8000-000000000002', 1, '{}'::jsonb,
  'phase3-role-probe', transaction_timestamp(), transaction_timestamp()
)`;

const JOB_INSERT = `insert into operations.jobs (
  job_id, job_type, payload_version, payload, available_at
) values (
  '018f4f7d-5000-7000-8000-000000000003', 'phase3.role.probe', 1,
  '{}'::jsonb, transaction_timestamp()
)`;

const REDRIVE_AUDIT_INSERT = `with original as (
  insert into operations.jobs (job_id, job_type, payload_version, payload, available_at)
  values ('018f4f7d-5000-7000-8000-000000000004', 'phase3.role.probe', 1, '{}'::jsonb, transaction_timestamp()) returning job_id
), replacement as (
  insert into operations.jobs (job_id, job_type, payload_version, payload, available_at)
  values ('018f4f7d-5000-7000-8000-000000000005', 'phase3.role.probe', 1, '{}'::jsonb, transaction_timestamp()) returning job_id
)
insert into operations.job_redrive_audit (original_job_id,replacement_job_id,operator_scope_hash,policy_version,payload_sha256)
select original.job_id, replacement.job_id, repeat('a',64), 'phase7-handlers-v1', repeat('b',64) from original, replacement`;

const OUTBOX_CLAIM = `select event_id from operations.outbox_events
   where completed_at is null
   order by available_at, event_id limit 1 for update skip locked`;

/** Every matrix row: the connected role, the attempted statement, and whether it must succeed. */
const MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["anon", "select idempotency", "select count(*) from operations.idempotency_records", false],
  ["anon", "select outbox", "select count(*) from operations.outbox_events", false],
  ["anon", "select jobs", "select count(*) from operations.jobs", false],
  ["anon", "select incidents", "select count(*) from operations.incidents", false],
  ["anon", "select redrive audit", "select count(*) from operations.job_redrive_audit", false],
  ["anon", "insert outbox", OUTBOX_INSERT, false],
  ["anon", "read public projection", "select count(*) from public_read.__phase3_role_probe_view", false],
  ["authenticated", "select idempotency", "select count(*) from operations.idempotency_records", false],
  ["authenticated", "select outbox", "select count(*) from operations.outbox_events", false],
  ["authenticated", "select jobs", "select count(*) from operations.jobs", false],
  ["authenticated", "select incidents", "select count(*) from operations.incidents", false],
  ["authenticated", "select redrive audit", "select count(*) from operations.job_redrive_audit", false],
  ["authenticated", "insert outbox", OUTBOX_INSERT, false],
  ["authenticated", "read public projection", "select count(*) from public_read.__phase3_role_probe_view", false],
  ["shipwithali_application", "select idempotency", "select count(*) from operations.idempotency_records", true],
  ["shipwithali_application", "insert idempotency", IDEMPOTENCY_INSERT, true],
  [
    "shipwithali_application",
    "update idempotency",
    "update operations.idempotency_records set expires_at = expires_at where false",
    true,
  ],
  [
    "shipwithali_application",
    "delete idempotency",
    "delete from operations.idempotency_records where false",
    false,
  ],
  ["shipwithali_application", "insert outbox", OUTBOX_INSERT, true],
  ["shipwithali_application", "select outbox", "select count(*) from operations.outbox_events", false],
  [
    "shipwithali_application",
    "update outbox",
    "update operations.outbox_events set available_at = available_at where false",
    false,
  ],
  ["shipwithali_application", "select jobs", "select count(*) from operations.jobs", false],
  ["shipwithali_application", "select incidents", "select count(*) from operations.incidents", false],
  ["shipwithali_application", "select redrive audit", "select count(*) from operations.job_redrive_audit", false],
  ["shipwithali_application", "insert jobs", JOB_INSERT, false],
  [
    "shipwithali_application",
    "claim outbox lease",
    OUTBOX_CLAIM,
    false,
  ],
  [
    "shipwithali_application",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  [
    "shipwithali_application",
    "read future object",
    "select count(*) from operations.__phase3_role_probe",
    false,
  ],
  [
    "shipwithali_application",
    "read unrelated module object",
    "select count(*) from content.__phase3_role_probe",
    false,
  ],
  ["shipwithali_worker", "select jobs", "select count(*) from operations.jobs", true],
  ["shipwithali_worker", "select incidents", "select count(*) from operations.incidents", true],
  ["shipwithali_worker", "select redrive audit", "select count(*) from operations.job_redrive_audit", true],
  ["shipwithali_worker", "insert redrive audit", REDRIVE_AUDIT_INSERT, true],
  ["shipwithali_worker", "insert incidents", "insert into operations.incidents (incident_key,category,safe_error_code,severity) values ('probe:1','job','PROBE_FAILURE','critical')", true],
  ["shipwithali_worker", "update incident counters", "update operations.incidents set occurrences = occurrences where false", true],
  ["shipwithali_worker", "rewrite incident identity", "update operations.incidents set category = category where false", false],
  ["shipwithali_worker", "insert jobs", JOB_INSERT, true],
  [
    "shipwithali_worker",
    "update jobs",
    "update operations.jobs set available_at = available_at where false",
    true,
  ],
  ["shipwithali_worker", "delete jobs", "delete from operations.jobs where false", false],
  ["shipwithali_worker", "select outbox", "select count(*) from operations.outbox_events", true],
  [
    "shipwithali_worker",
    "update outbox",
    "update operations.outbox_events set available_at = available_at where false",
    true,
  ],
  ["shipwithali_worker", "insert outbox", OUTBOX_INSERT, false],
  ["shipwithali_worker", "select idempotency", "select count(*) from operations.idempotency_records", false],
  ["shipwithali_worker", "insert idempotency", IDEMPOTENCY_INSERT, false],
  [
    "shipwithali_worker",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  [
    "shipwithali_worker",
    "create future module table",
    "create table content.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  ["shipwithali_worker", "read future object", "select count(*) from operations.__phase3_role_probe", false],
  ["shipwithali_worker", "claim outbox lease", OUTBOX_CLAIM, true],
  [
    "shipwithali_worker",
    "read unrelated module object",
    "select count(*) from content.__phase3_role_probe",
    false,
  ],
  ["shipwithali_backup", "select idempotency", "select count(*) from operations.idempotency_records", true],
  ["shipwithali_backup", "select outbox", "select count(*) from operations.outbox_events", true],
  ["shipwithali_backup", "select jobs", "select count(*) from operations.jobs", true],
  ["shipwithali_backup", "select incidents", "select count(*) from operations.incidents", true],
  ["shipwithali_backup", "select redrive audit", "select count(*) from operations.job_redrive_audit", true],
  ["shipwithali_backup", "insert outbox", OUTBOX_INSERT, false],
  [
    "shipwithali_backup",
    "delete outbox",
    "delete from operations.outbox_events where false",
    false,
  ],
  [
    "shipwithali_backup",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  ["shipwithali_migration", "select outbox", "select count(*) from operations.outbox_events", true],
  [
    "shipwithali_migration",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    true,
  ],
];

interface RoleAttempt {
  readonly sessionUser: string;
  readonly currentUser: string;
  readonly allowed: boolean;
  readonly rows: Array<Record<string, unknown>>;
}

let probeSequence = 0;
let probeTableOid = 0;
let probeSequenceOid = 0;
let probeFunctionOid = 0;

function adminClient() {
  return new Client({ connectionString: DATABASE_URL ?? "" });
}

/**
 * Connect as a disposable login whose only membership is the role under test,
 * then assert as that role. Probe names and passwords use closed alphabets, so
 * interpolating them into administration statements is injection-safe. Every
 * failure surfaces a stable code: raw provider errors and credentials never
 * enter test output.
 */
async function attemptAs(role: string | null, statement: string): Promise<RoleAttempt> {
  if (role !== null && !KNOWN_ROLES.includes(role)) throw new Error("ROLE_MATRIX_UNKNOWN_ROLE");
  const admin = adminClient();
  await admin.connect();
  const login = `phase3_probe_${process.pid}_${probeSequence++}`;
  const password = randomBytes(24).toString("hex");
  const probe = new Client({
    connectionString: buildLoginUrl(DATABASE_URL ?? "", login, password),
  });
  try {
    try {
      await admin.query(
        `create role "${login}" login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
      );
      if (role !== null) await admin.query(`grant ${role} to "${login}"`);
    } catch {
      throw new Error("ROLE_MATRIX_PROBE_SETUP_FAILED");
    }
    await probe.connect();
    await probe.query("begin");
    if (role !== null) await probe.query(`set role ${role}`);
    const identity = await probe.query("select session_user, current_user");
    const sessionUser = String(identity.rows[0]?.["session_user"] ?? "");
    const currentUser = String(identity.rows[0]?.["current_user"] ?? "");
    if (sessionUser !== login || currentUser !== (role ?? login)) {
      throw new Error("ROLE_MATRIX_IDENTITY_MISMATCH");
    }
    let allowed = true;
    let rows: Array<Record<string, unknown>> = [];
    try {
      const result = await probe.query(statement);
      rows = result.rows as Array<Record<string, unknown>>;
    } catch {
      allowed = false;
    }
    await probe.query("rollback");
    return { sessionUser, currentUser, allowed, rows };
  } finally {
    try {
      await probe.end();
    } catch {
      // Probe teardown must not mask the recorded matrix outcome.
    }
    try {
      await admin.query(`drop role if exists "${login}"`);
    } catch {
      // Best effort: a leaked probe login holds no grants and cannot reach data.
    }
    await admin.end();
  }
}

function buildLoginUrl(base: string, login: string, password: string) {
  const url = new URL(base);
  url.username = login;
  url.password = password;
  return url.toString();
}

function migrationSources() {
  return readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(join(ROOT, "supabase", "migrations", name), "utf8"))
    .join("\n");
}

function phase3MigrationSources() {
  return readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((name) => /(?:establish_database_security_baseline|create_operations_primitives)\.sql$/u.test(name))
    .sort()
    .map((name) => readFileSync(join(ROOT, "supabase", "migrations", name), "utf8"))
    .join("\n");
}

describeDatabase("Phase 3 role, grant, and RLS matrix (#53)", () => {
  beforeAll(async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      await admin.query("set role shipwithali_migration");
      await admin.query("drop function if exists operations.__phase3_role_probe_function()");
      await admin.query("drop table if exists operations.__phase3_role_probe");
      await admin.query("drop sequence if exists operations.__phase3_role_probe_sequence");
      await admin.query("drop function if exists operations.__phase3_role_probe_function()");
      await admin.query("drop view if exists public_read.__phase3_role_probe_view");
      await admin.query("drop table if exists content.__phase3_role_probe");
      await admin.query("create table operations.__phase3_role_probe (id integer)");
      await admin.query("create sequence operations.__phase3_role_probe_sequence");
      await admin.query(
        "create function operations.__phase3_role_probe_function() returns integer language sql immutable as 'select 1'",
      );
      // PostgreSQL 17 does not apply default-privilege entries to new functions
      // (their system default stays PUBLIC EXECUTE), so every created function
      // must carry an explicit object-level revoke exactly as future migrations
      // are required to do. Tables and sequences below rely on true defaults.
      await admin.query(
        "revoke all on function operations.__phase3_role_probe_function() from public, anon, authenticated",
      );
      // A disposable public_read object proves anonymous and authenticated
      // clients gain no implicit projection access; a content table proves
      // capability roles cannot reach unrelated module objects.
      await admin.query(
        "create view public_read.__phase3_role_probe_view with (security_barrier = true) as select 1 as probe",
      );
      await admin.query("create table content.__phase3_role_probe (id integer)");
      await admin.query("reset role");
      const oids = await admin.query(
        `select to_regclass('operations.__phase3_role_probe')::oid as tbl,
                to_regclass('operations.__phase3_role_probe_sequence')::oid as seq,
                to_regprocedure('operations.__phase3_role_probe_function()')::oid as fn`,
      );
      probeTableOid = Number(oids.rows[0]?.["tbl"]);
      probeSequenceOid = Number(oids.rows[0]?.["seq"]);
      probeFunctionOid = Number(oids.rows[0]?.["fn"]);
      if (
        !Number.isInteger(probeTableOid) ||
        !Number.isInteger(probeSequenceOid) ||
        !Number.isInteger(probeFunctionOid)
      ) {
        throw new Error("ROLE_MATRIX_SETUP_FAILED");
      }
    } catch {
      throw new Error("ROLE_MATRIX_SETUP_FAILED");
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      await admin.query("set role shipwithali_migration");
      await admin.query("drop table if exists operations.__phase3_role_probe");
      await admin.query("drop sequence if exists operations.__phase3_role_probe_sequence");
      await admin.query("drop function if exists operations.__phase3_role_probe_function()");
      await admin.query("drop view if exists public_read.__phase3_role_probe_view");
      await admin.query("drop table if exists content.__phase3_role_probe");
      await admin.query("reset role");
    } finally {
      await admin.end();
    }
  });

  it.each(MATRIX)("%s can %s: %s", async (role, label, statement, expected) => {
    const attempt = await attemptAs(role, statement);
    expect(attempt.currentUser, `${role} ${label}`).toBe(role);
    expect(attempt.allowed, `${role} ${label}`).toBe(expected);
  });

  it("denies every base-table path to logins holding no capability", async () => {
    for (const statement of [
      "select count(*) from operations.idempotency_records",
      "select count(*) from operations.outbox_events",
      "select count(*) from operations.jobs",
      OUTBOX_INSERT,
    ]) {
      const attempt = await attemptAs(null, statement);
      expect(attempt.currentUser).toBe(attempt.sessionUser);
      expect(attempt.allowed, statement).toBe(false);
    }
  });

  it("denies schema usage to public clients and confines capabilities to operations", async () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ["anon", "operations", false],
      ["anon", "public_read", false],
      ["authenticated", "operations", false],
      ["authenticated", "public_read", false],
      ["shipwithali_application", "operations", true],
      ["shipwithali_application", "public_read", false],
      ["shipwithali_worker", "operations", true],
      ["shipwithali_worker", "public_read", false],
      ["shipwithali_backup", "operations", true],
      ["shipwithali_backup", "public_read", false],
    ];
    for (const [role, schema, expected] of cases) {
      const attempt = await attemptAs(
        role,
        `select has_schema_privilege('${schema}', 'USAGE') as has_access`,
      );
      expect(attempt.rows[0]?.["has_access"], `${role} ${schema}`).toBe(expected);
    }
  });

  it("grants PUBLIC no privileges on application tables or probe routines", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const tables = await admin.query(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'operations'
            and table_name in ('idempotency_records', 'outbox_events', 'jobs', '__phase3_role_probe')
            and grantee = 'PUBLIC'`,
      );
      expect(tables.rows).toEqual([]);
      const routines = await admin.query(
        `select grantee, privilege_type from information_schema.role_routine_grants
          where routine_schema = 'operations'
            and routine_name = '__phase3_role_probe_function'
            and grantee = 'PUBLIC'`,
      );
      expect(routines.rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it("grants new objects no access to public, anonymous, authenticated, application, worker, or backup", async () => {
    // OID literals avoid schema-name resolution, which itself requires USAGE.
    const inspections = [
      `select has_table_privilege(${probeTableOid}::oid, 'SELECT') as has_access`,
      `select has_sequence_privilege(${probeSequenceOid}::oid, 'USAGE') as has_access`,
      `select has_function_privilege(${probeFunctionOid}::oid, 'EXECUTE') as has_access`,
    ];
    for (const role of [
      "anon",
      "authenticated",
      "shipwithali_application",
      "shipwithali_worker",
      "shipwithali_backup",
    ]) {
      for (const statement of inspections) {
        const attempt = await attemptAs(role, statement);
        expect(attempt.rows[0]?.["has_access"], `${role} ${statement}`).toBe(false);
      }
    }
    for (const statement of inspections) {
      const attempt = await attemptAs(null, statement);
      expect(attempt.rows[0]?.["has_access"], `public ${statement}`).toBe(false);
    }
  });

  it("enables and forces RLS on every Phase 3 application table", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const tables = await admin.query(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'operations'
            and c.relname in ('idempotency_records', 'outbox_events', 'jobs', 'incidents', 'job_redrive_audit')
          order by c.relname`,
      );
      expect(tables.rows.map((row) => row["relname"])).toEqual([
        "idempotency_records",
        "incidents",
        "job_redrive_audit",
        "jobs",
        "outbox_events",
      ]);
      for (const row of tables.rows) {
        expect(row["relrowsecurity"], String(row["relname"])).toBe(true);
        expect(row["relforcerowsecurity"], String(row["relname"])).toBe(true);
      }
    } finally {
      await admin.end();
    }
  });

  it("publishes exactly the declared application and worker policies", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const policies = await admin.query(
        `select tablename, policyname, roles, cmd
           from pg_policies
          where schemaname = 'operations'
            and policyname <> 'measurement_event_jobs_application_insert'
          order by tablename, policyname`,
      );
      expect(
        policies.rows.map((row) => [
          row["tablename"],
          row["policyname"],
          row["cmd"],
          String(row["roles"]),
        ]),
      ).toEqual([
        ["idempotency_records", "idempotency_application_insert_policy", "INSERT", "{shipwithali_application}"],
        ["idempotency_records", "idempotency_application_select_policy", "SELECT", "{shipwithali_application}"],
        ["idempotency_records", "idempotency_application_update_policy", "UPDATE", "{shipwithali_application}"],
        ["idempotency_records", "operations_backup_policy_idempotency", "SELECT", "{shipwithali_backup}"],
        ["incidents", "incidents_worker_insert_policy", "INSERT", "{shipwithali_worker}"],
        ["incidents", "incidents_worker_select_policy", "SELECT", "{shipwithali_worker}"],
        ["incidents", "incidents_worker_update_policy", "UPDATE", "{shipwithali_worker}"],
        ["incidents", "operations_backup_policy_incidents", "SELECT", "{shipwithali_backup}"],
        ["job_redrive_audit", "job_redrive_audit_worker_insert_policy", "INSERT", "{shipwithali_worker}"],
        ["job_redrive_audit", "job_redrive_audit_worker_select_policy", "SELECT", "{shipwithali_worker}"],
        ["job_redrive_audit", "operations_backup_policy_job_redrive_audit", "SELECT", "{shipwithali_backup}"],
        ["jobs", "jobs_worker_insert_policy", "INSERT", "{shipwithali_worker}"],
        ["jobs", "jobs_worker_select_policy", "SELECT", "{shipwithali_worker}"],
        ["jobs", "jobs_worker_update_policy", "UPDATE", "{shipwithali_worker}"],
        ["jobs", "operations_backup_policy_jobs", "SELECT", "{shipwithali_backup}"],
        ["outbox_events", "operations_backup_policy_outbox", "SELECT", "{shipwithali_backup}"],
        ["outbox_events", "outbox_application_insert_policy", "INSERT", "{shipwithali_application}"],
        ["outbox_events", "outbox_worker_select_policy", "SELECT", "{shipwithali_worker}"],
        ["outbox_events", "outbox_worker_update_policy", "UPDATE", "{shipwithali_worker}"],
      ]);
    } finally {
      await admin.end();
    }
  });

  it("ships no privilege-elevated functions in Phase 3 operations", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const elevated = await admin.query(
        `select n.nspname, p.proname
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'operations'
            and p.prosecdef
          order by n.nspname, p.proname`,
      );
      expect(elevated.rows).toEqual([]);
    } finally {
      await admin.end();
    }
    expect(phase3MigrationSources().toLowerCase()).not.toMatch(/security\s+definer/);
  });

  it("keeps migration and backup capabilities out of application runtime configuration", () => {
    const configuration = readFileSync(join(ROOT, "src", "bootstrap", "configuration.ts"), "utf8");
    const composition = readFileSync(join(ROOT, "src", "bootstrap", "composition-root.ts"), "utf8");
    for (const source of [configuration, composition]) {
      expect(source).not.toMatch(/env\["DATABASE_DIRECT_URL"\]/);
      expect(source).not.toMatch(/shipwithali_migration/);
      expect(source).not.toMatch(/shipwithali_backup/);
    }
    expect(composition).toMatch(/env\["DATABASE_URL"\]/);
  });

  it("grants executor membership only to the migration role", () => {
    const sources = migrationSources().toLowerCase();
    expect(sources).toMatch(/grant shipwithali_migration to current_user/);
    expect(sources).not.toMatch(/grant\s+.+\s+to\s+(?:anon|authenticated)/);
    expect(sources).not.toMatch(/grant\s+shipwithali_(?:application|worker|backup)\s+to\s+current_user/);
  });
});
