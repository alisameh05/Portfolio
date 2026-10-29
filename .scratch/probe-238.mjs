// Scratch probe (not committed): stand up a disposable cluster, apply every
// migration, and dump the exact catalog rows needed to declare the #238
// operations transformation. Cleans up after itself.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { Client } from "pg";

const root = resolve(process.cwd());
const runId = `${process.pid}`;
const bin = process.env.PHASE7_POSTGRES_BIN ?? "C:/Program Files/PostgreSQL/18/bin";
const exe = name => join(bin, name + (process.platform === "win32" ? ".exe" : ""));
function run(cmd, args, env = process.env) {
  const result = spawnSync(cmd, args, { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 240_000 });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
const port = await new Promise((resolvePort, reject) => {
  const server = createServer(); server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const value = server.address().port; server.close(() => resolvePort(value)); });
});
const temp = join(tmpdir(), `probe-238-${runId}`);
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
  const policies = await admin.query(
    `select schemaname as schema, tablename as "tableName", policyname as name,
            lower(permissive) as permissive, roles, cmd as command,
            coalesce(qual,'') as "usingPredicate", coalesce(with_check,'') as "withCheck"
       from pg_policies where schemaname = 'operations' and tablename = 'jobs'
         and policyname = 'owner_export_jobs_application_insert'`);
  const grants = await admin.query(
    `select n.nspname as schema, c.relname as object, c.relkind as "objectType",
            coalesce(grantee.rolname,'PUBLIC') as grantee, grantor.rolname as grantor,
            acl.privilege_type as privilege, acl.is_grantable as grantable
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       cross join lateral aclexplode(coalesce(c.relacl, acldefault('r'::"char", c.relowner))) acl
       left join pg_roles grantee on grantee.oid = acl.grantee
       join pg_roles grantor on grantor.oid = acl.grantor
      where n.nspname = 'operations' and c.relname = 'jobs'
        and grantee.rolname = 'shipwithali_application' and acl.privilege_type = 'INSERT'`);
  const checksum = createHash("sha256").update(readFileSync(join(root, "supabase/migrations/20261023090000_reserve_owner_export_requests.sql"))).digest("hex");
  writeFileSync(join(root, ".scratch/transformation-238.json"), JSON.stringify({
    migration: "20261023090000_reserve_owner_export_requests.sql", checksum,
    policies: policies.rows, grants: grants.rows,
  }, null, 2));
  console.error("WROTE_TRANSFORMATION_JSON");
} finally {
  if (connected) await admin.end();
}
