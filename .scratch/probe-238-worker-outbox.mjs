// Scratch probe (not committed): stand up a disposable native PostgreSQL
// cluster on this branch's exact migration sequence, capture the exact catalog
// rows needed to declare the amended #238 worker outbox append, and verify the
// role behavior live. The server STAYS RUNNING for follow-up validation until
// the process is killed with the STOP marker removed via SIGINT handler.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";
import { migrationSha256 } from "../scripts/migration-checksum.mjs";

const root = resolve(process.cwd());

// Readiness marker: the caller waits for this file, does the follow-up
// validation against the printed URL, then checks the cluster down with
// `<marker>.stop`.
const runId = process.env["PROBE_238_RUN_ID"] ?? `${process.pid}`;
const bin = process.env.PHASE7_POSTGRES_BIN ?? "C:/Program Files/PostgreSQL/18/bin";
const exe = name => join(bin, name + (process.platform === "win32" ? ".exe" : ""));
const run = (cmd, args, options = {}) => {
  const result = spawnSync(cmd, args, { cwd: root, env: process.env, encoding: "utf8", windowsHide: true, timeout: 240_000, ...options });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
};
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const temp = join(tmpdir(), `probe-238-worker-outbox-${runId}`);
const data = join(temp, "data");
mkdirSync(temp, { recursive: true });
const adminUrl = `postgres://postgres@127.0.0.1:${port}/postgres`;
const admin = new Client({ connectionString: adminUrl });
let connected = false;
try {
  run(exe("initdb"), ["-D", data, "--no-locale", "-A", "trust", "-U", "postgres"]);
  appendFileSync(join(data, "postgresql.conf"), "unix_socket_directories = ''\n");
  run(exe("pg_ctl"), ["-D", data, "-l", join(temp, "server.log"), "-o", `-h 127.0.0.1 -p ${port} -F`, "-w", "start"]);
  await admin.connect(); connected = true;
  await admin.query("create role anon nologin; create role authenticated nologin; create role shipwithali_migration nologin nosuperuser nobypassrls; grant create on database postgres to shipwithali_migration");
  const migrations = readdirSync(join(root, "supabase/migrations")).filter(n => n.endsWith(".sql")).sort();
  for (const name of migrations) {
    try { await admin.query(readFileSync(join(root, "supabase/migrations", name), "utf8")); }
    catch (error) {
      console.error("MIGRATION_FAILED:" + name + ":" + String(error.message).replace(/\r?\n/g, " | "));
      process.exit(2);
    }
  }
  console.error("ALL_MIGRATIONS_APPLIED");

  const outboxPolicy = await admin.query(
    `select schemaname as schema, tablename as "tableName", policyname as name,
            lower(permissive) as permissive, roles, cmd as command,
            coalesce(qual,'') as "usingPredicate", coalesce(with_check,'') as "withCheck"
       from pg_policies where schemaname = 'operations' and tablename = 'outbox_events'
         and policyname = 'owner_export_outbox_worker_insert'`);
  const outboxGrant = await admin.query(
    `select n.nspname as schema, c.relname as object, c.relkind as "objectType",
            coalesce(grantee.rolname,'PUBLIC') as grantee, grantor.rolname as grantor,
            acl.privilege_type as privilege, acl.is_grantable as grantable
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) acl
       left join pg_roles grantee on grantee.oid = acl.grantee
       join pg_roles grantor on grantor.oid = acl.grantor
      where n.nspname = 'operations' and c.relname = 'outbox_events'
        and grantee.rolname = 'shipwithali_worker' and acl.privilege_type = 'INSERT'`);
  const checksum = migrationSha256(readFileSync(join(root, "supabase/migrations/20261023090000_reserve_owner_export_requests.sql"), "utf8"));
  writeFileSync(join(root, `.scratch/transformation-238-worker-outbox.json`), JSON.stringify({
    migration: "20261023090000_reserve_owner_export_requests.sql",
    checksum,
    outboxPolicy: outboxPolicy.rows[0],
    outboxGrant: outboxGrant.rows[0],
  }, null, 2));
  console.error("WROTE_TRANSFORMATION_JSON checksum=" + checksum);
  console.error("PHASE3_DATABASE_URL=" + adminUrl);

  // Live role behavior spot-check with worker-owned probe logins.
  const probe = async (role, statement, settings = "") => {
    const login = "worker_outbox_probe";
    const suffix = role === null ? "" : "shipwithali_migration";
    await admin.query(`drop role if exists "${login}"`);
    await admin.query(`create role "${login}" login nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    if (role !== null) await admin.query(`grant ${role} to "${login}"`);
    const client = new Client({ host: "127.0.0.1", port, user: login, database: "postgres" });
    await client.connect();
    try {
      if (role !== null) await client.query(`set role ${role}`);
      if (settings) await client.query(settings);
      try { await client.query(statement); return { allowed: true }; }
      catch (error) { return { allowed: false, reason: error.code ?? "" }; }
    } catch (error) {
      return { allowed: false, reason: error.code ?? "connect" };
    } finally {
      await client.end().catch(() => {});
      await admin.query(`drop role if exists "${login}"`);
    }
  };
  const exportId = "018f4f7d-5000-7000-8000-000000000180";
  const eventId = "018f4f7d-5000-7000-8000-000000000190";
  const goodEvent = `insert into operations.outbox_events (
    event_id, event_type, schema_version, aggregate_id, aggregate_version, payload,
    correlation_id, occurred_at, available_at
  ) values (
    '${eventId}', 'portability.export_produced.v1', 1, '${exportId}', 1,
    '{"exportId":"${exportId}","manifest":{"schemaVersion":"1.0","exportId":"${exportId}","checksumSha256":"${"a".repeat(64)}","recordCounts":{"taxonomy":2}}}'::jsonb,
    '${exportId}', transaction_timestamp(), transaction_timestamp()
  )`;
  const foreignEvent = `insert into operations.outbox_events (
    event_id, event_type, schema_version, aggregate_id, aggregate_version, payload,
    correlation_id, occurred_at, available_at
  ) values (
    '018f4f7d-5000-7000-8000-000000000191', 'portability.export_produced.v1', 1, '${exportId}', 1,
    '{"exportId":"018f4f7d-5000-7000-8000-000000000181","manifest":{"schemaVersion":"1.0","exportId":"${exportId}","checksumSha256":"${"a".repeat(64)}","recordCounts":{}}}'::jsonb,
    '${exportId}', transaction_timestamp(), transaction_timestamp()
  )`;
  const missingManifest = `insert into operations.outbox_events (
    event_id, event_type, schema_version, aggregate_id, aggregate_version, payload,
    correlation_id, occurred_at, available_at
  ) values (
    '018f4f7d-5000-7000-8000-000000000192', 'portability.export_produced.v1', 1, '${exportId}', 1,
    '{"exportId":"${exportId}"}'::jsonb,
    '${exportId}', transaction_timestamp(), transaction_timestamp()
  )`;
  const applicationEvent = `insert into operations.outbox_events (
    event_id, event_type, schema_version, aggregate_id, aggregate_version, payload,
    correlation_id, occurred_at, available_at
  ) values (
    '018f4f7d-5000-7000-8000-000000000193', 'portability.export_produced.v1', 1, '${exportId}', 1,
    '{"exportId":"${exportId}"}'::jsonb,
    '${exportId}', transaction_timestamp(), transaction_timestamp()
  )`;
  const probeClientId = "018f4f7d-5000-7000-8000-000000000170";
  const workerInsertOnOwnerExports = `insert into portability.owner_exports (
    export_id, portfolio_id, owner_id, included_scopes, status, schema_version, requested_at
  ) values (
    '${probeClientId}', '${probeClientId}', '${probeClientId}', array['portfolio-content'], 'requested', '1.0', transaction_timestamp()
  )`;
  const results = {
    workerInsertsProducedEvent: await probe("shipwithali_worker", goodEvent),
    workerRejectedForeignEvent: await probe("shipwithali_worker", foreignEvent),
    workerRejectedMissingManifest: await probe("shipwithali_worker", missingManifest),
    workerRejectedGenericProbe: await probe("shipwithali_worker",
      `insert into operations.outbox_events (event_id, event_type, schema_version, aggregate_id, aggregate_version, payload, correlation_id, occurred_at, available_at)
       values ('018f4f7d-5000-7000-8000-000000000001', 'phase3.role.probe', 1, '018f4f7d-5000-7000-8000-000000000002', 1, '{}'::jsonb, 'probe', transaction_timestamp(), transaction_timestamp())`),
    applicationStillAllowed: await probe("shipwithali_application", applicationEvent),
    workerDeniedOwnerExportInsert: await probe("shipwithali_worker", workerInsertOnOwnerExports),
    backupDeniedInsert: await probe("shipwithali_backup", applicationEvent),
    anonDenied: await probe(null, applicationEvent),
  };
  const residue = await admin.query("select count(*)::int as count from operations.outbox_events");
  results.tableResidueCount = residue.rows[0]?.count;
  console.error("PROBE_RESULTS=" + JSON.stringify(results, null, 1));
  const expected = {
    workerInsertsProducedEvent: true,
    workerRejectedForeignEvent: false,
    workerRejectedMissingManifest: false,
    workerRejectedGenericProbe: false,
    applicationStillAllowed: true,
    workerDeniedOwnerExportInsert: false,
    backupDeniedInsert: false,
    anonDenied: false,
    tableResidueCount: 1,
  };
  const mismatches = Object.entries(expected).filter(([key, value]) => results[key] !== value);
  if (mismatches.length > 0) {
    console.error("MISMATCHES=" + JSON.stringify(mismatches));
    process.exit(3);
  }
  console.error("PROBE_BEHAVIOR_OK staying up; stop with .stop marker");
  // Keep the server alive (the caller validates against it), then stop it on request.
  const stopFile = join(temp, "stop.marker");
  await new Promise((resolveHold) => {
    const poll = setInterval(() => {
      try { if (readFileSync(stopFile, "utf8") !== undefined) { clearInterval(poll); resolveHold(); } }
      catch { /* keep waiting */ }
      if (process.env["PROBE_238_STOP"] === "1") { clearInterval(poll); resolveHold(); }
    }, 1000);
  });
} finally {
  if (connected) {
    await admin.end().catch(() => {});
  }
}
