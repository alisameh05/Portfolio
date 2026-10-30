import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { createRelationalBackupService, type RelationalBackupAttempt, type RelationalBackupCatalog } from "../src/modules/portability-operations/application/relational-backup.js";
import { createHttpRelationalBackupDestination } from "../src/modules/portability-operations/adapters/http-relational-backup-destination.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAX_DUMP_BYTES = 1_099_511_627_776;

class BackupFailure extends Error {
  constructor(readonly safeCode: string, readonly variable?: string) { super(safeCode); }
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new BackupFailure("BACKUP_CONFIG_MISSING", name);
  return value;
}
function parseSource() {
  const raw = required("DATABASE_DIRECT_URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new BackupFailure("BACKUP_CONFIG_INVALID", "DATABASE_DIRECT_URL"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new BackupFailure("BACKUP_CONFIG_INVALID", "DATABASE_DIRECT_URL");
  const host = url.hostname.toLowerCase();
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const sslmode = url.searchParams.get("sslmode") || "require";
  if (url.hash || [...url.searchParams.keys()].some(key => key !== "sslmode") ||
      !["require", "verify-ca", "verify-full"].includes(sslmode)) {
    throw new BackupFailure("BACKUP_CONFIG_INVALID", "DATABASE_DIRECT_URL");
  }
  const allowlist = required("BACKUP_SOURCE_ALLOWLIST").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.includes(host + "/" + database)) throw new BackupFailure("BACKUP_SOURCE_NOT_ALLOWLISTED");
  if (["localhost", "127.0.0.1", "::1"].includes(host) && process.env['BACKUP_ALLOW_LOOPBACK_SOURCE'] !== "true") {
    throw new BackupFailure("BACKUP_SOURCE_NOT_ALLOWLISTED");
  }
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (!user || !password || !database) throw new BackupFailure("BACKUP_CONFIG_INVALID", "DATABASE_DIRECT_URL");
  return { url, host, user, password, database, port: url.port || "5432", sslmode };
}
function sourceEnv(source: ReturnType<typeof parseSource>): NodeJS.ProcessEnv {
  return { ...process.env, PGHOST: source.host, PGPORT: source.port, PGUSER: source.user,
    PGPASSWORD: source.password, PGDATABASE: source.database, PGSSLMODE: source.sslmode };
}
function runTool(executable: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: "ignore", windowsHide: true });
    child.once("error", () => reject(new BackupFailure("BACKUP_DUMP_TOOL_FAILED")));
    child.once("exit", code => code === 0 ? resolve() : reject(new BackupFailure("BACKUP_DUMP_TOOL_FAILED")));
  });
}
function runVersion(executable: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], { env, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", data => { output += data; if (output.length > 300) child.kill(); });
    child.once("error", () => reject(new BackupFailure("BACKUP_DUMP_TOOL_FAILED")));
    child.once("exit", code => {
      const version = output.match(/PostgreSQL\) (\d+(?:\.\d+)+)/u)?.[1];
      if (code !== 0 || !version) reject(new BackupFailure("BACKUP_DUMP_TOOL_FAILED"));
      else resolve(version);
    });
  });
}
function sha256(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => JSON.stringify(key) + ":" + canonicalJson(v)).join(",") + "}";
}
async function removeOwnedTemp(tempPath: string, tempRoot: string): Promise<void> {
  const root = await realpath(tempRoot);
  const target = await realpath(tempPath);
  const info = await lstat(target);
  const sameDirectory = process.platform === "win32"
    ? path.dirname(target).toLowerCase() === root.toLowerCase()
    : path.dirname(target) === root;
  if (!sameDirectory || !path.basename(target).startsWith("sw-relational-backup-") || !info.isDirectory() || info.isSymbolicLink()) {
    throw new BackupFailure("BACKUP_CLEANUP_SCOPE_INVALID");
  }
  await rm(target, { recursive: true, force: false });
}
async function capture(source: ReturnType<typeof parseSource>, pgDump: string, pgDumpAll: string, temp: string) {
  const client = new Client({ connectionString: source.url.toString(), connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000, application_name: "phase8-relational-backup" });
  await client.connect();
  let snapshotStarted = false;
  try {
    const v = await client.query("select current_setting('server_version_num')::int as version_num");
    const major = Math.floor(Number(v.rows[0].version_num) / 10000);
    if (![17, 18].includes(major)) throw new BackupFailure("BACKUP_POSTGRES_VERSION_UNSUPPORTED");
    const [dumpVersion, rolesVersion] = await Promise.all([runVersion(pgDump, sourceEnv(source)), runVersion(pgDumpAll, sourceEnv(source))]);
    if (Number(dumpVersion.split(".")[0]) !== major || Number(rolesVersion.split(".")[0]) !== major) {
      throw new BackupFailure("BACKUP_DUMP_TOOL_VERSION_MISMATCH");
    }
    await client.query("begin transaction isolation level repeatable read read only");
    snapshotStarted = true;
    const w = await client.query("select transaction_timestamp() as at, pg_export_snapshot() as snapshot");
    const watermark = new Date(w.rows[0].at).toISOString();
    const inventory = await client.query("select " +
      "(select count(*) from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema')::int as schemas, " +
      "(select array_agg(nspname order by nspname) from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema') as schema_names, " +
      "(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace " +
      "where n.nspname !~ '^pg_' and n.nspname <> 'information_schema' and c.relkind in ('r','p','v','m','S','f'))::int as relations");
    const rolesPath = path.join(temp, "roles.sql");
    const dbPath = path.join(temp, "database.dump");
    const startedAt = new Date().toISOString();
    await runTool(pgDumpAll, ["--globals-only", "--no-role-passwords", "--no-password", "--file", rolesPath], sourceEnv(source));
    await runTool(pgDump, ["--format=custom", "--snapshot", String(w.rows[0].snapshot), "--no-password",
      "--file", dbPath, "--dbname", source.database], sourceEnv(source));
    const completedAt = new Date().toISOString();
    const roles = await readFile(rolesPath);
    const database = await readFile(dbPath);
    const migrations = (await readdir(path.join(ROOT, "supabase", "migrations"))).filter(x => x.endsWith(".sql")).sort();
    const migrationHashes: Record<string, string> = {};
    const migrationSources: Array<{ file: string; sha256: string; sql: string }> = [];
    for (const file of migrations) {
      const sql = await readFile(path.join(ROOT, "supabase", "migrations", file));
      const digest = sha256(sql);
      migrationHashes[file] = digest;
      migrationSources.push({ file, sha256: digest, sql: sql.toString("utf8") });
    }
    const manifest = Buffer.from(JSON.stringify({ format: "SWDB", version: 1, database: source.database,
      rolesBytes: roles.byteLength, databaseBytes: database.byteLength, rolesSha256: sha256(roles),
      databaseSha256: sha256(database), migrationHashes, migrationSources }), "utf8");
    const prefix = Buffer.alloc(8);
    prefix.write("SWDB", 0, "ascii");
    prefix.writeUInt32BE(manifest.byteLength, 4);
    const dump = Buffer.concat([prefix, manifest, roles, database]);
    if (dump.byteLength === 0 || dump.byteLength > MAX_DUMP_BYTES) throw new BackupFailure("BACKUP_DUMP_SIZE_INVALID");
    const catalog: RelationalBackupCatalog = Object.freeze({
      version: 1, scope: Object.freeze([
        ...(inventory.rows[0].schema_names as string[]), "cluster:roles", "repository:migrations",
      ]),
      sourceWatermarkAt: watermark, startedAt, completedAt, dumpTool: path.basename(pgDump) + "+" + path.basename(pgDumpAll),
      dumpToolVersion: dumpVersion + "+" + rolesVersion, schemaCount: Number(inventory.rows[0].schemas),
      relationCount: Number(inventory.rows[0].relations), migrationCount: migrations.length, dumpBytes: dump.byteLength, complete: true,
      managedMetadata: Object.freeze({
        auth: "database-dump; reset custom credentials from protected secrets after restore",
        storage: "database metadata only; object bytes are backed up separately",
      }),
    });
    return { dump, catalog };
  } finally {
    if (snapshotStarted) await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}
function mapRow(row: Record<string, unknown>): RelationalBackupAttempt {
  return Object.freeze({
    copyId: String(row['copy_id']), destinationName: String(row['destination_name']), objectKey: String(row['object_key']),
    keyVersion: String(row['key_version']), dumpTool: String(row['dump_tool']), sourceWatermarkAt: new Date(String(row['source_watermark_at'])).toISOString(),
    dumpBytes: Number(row['dump_bytes']), ciphertextBytes: Number(row['ciphertext_bytes']), catalogSha256: String(row['catalog_sha256']).trim(),
    ciphertextSha256: String(row['ciphertext_sha256']).trim(), attemptedAt: new Date(String(row['attempted_at'])).toISOString(),
    verifiedAt: row['verified_at'] ? new Date(String(row['verified_at'])).toISOString() : null,
    committedAt: row['committed_at'] ? new Date(String(row['committed_at'])).toISOString() : null,
    retentionLifetimeHours: row['retention_lifetime_hours'] == null ? null : Number(row['retention_lifetime_hours']),
    expiresAt: row['expires_at'] ? new Date(String(row['expires_at'])).toISOString() : null,
    state: String(row['state']) as RelationalBackupAttempt["state"], failureCode: row['failure_code'] == null ? null : String(row['failure_code']),
  });
}
async function main() {
  const source = parseSource();
  const rawEnvironment = process.env['BACKUP_ENVIRONMENT']?.trim() || "unknown";
  const incidentEnvironment = ["local", "test", "staging", "production", "unknown"].includes(rawEnvironment) ? rawEnvironment : "unknown";
  const tempRoot = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(tempRoot, "sw-relational-backup-"));
  const client = new Client({ connectionString: source.url.toString(), connectionTimeoutMillis: 10_000 });
  let connected = false;
  let lockHeld = false;
  let lockName: string | null = null;
  let incidentReporter: ((code: string, at: string) => Promise<void>) | undefined;
  try {
    await client.connect();
    connected = true;
    const incidents = {
      async recordFailure(code: string, at: string) {
        const safe = /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "BACKUP_ATTEMPT_FAILED";
        const incidentKey = "backup.relational:" + createHash("sha256").update(safe).digest("hex");
        await client.query("insert into operations.incidents " +
          "(incident_key,category,safe_error_code,severity,first_observed_at,last_observed_at,owner_role,remediation_pointer,environment,delivery_state,next_delivery_at) " +
          "values ($1,'backup',$2,'critical',$3,$3,'backup','runbook:recovery/relational-backup',$4,'pending',$3) " +
          "on conflict (incident_key) do update set last_observed_at=excluded.last_observed_at," +
          "occurrences=case when operations.incidents.resolved_at is null then operations.incidents.occurrences+1 else 1 end," +
          "resolved_at=null,recovery_recorded_at=null,delivery_state='pending',next_delivery_at=excluded.next_delivery_at",
        [incidentKey,safe,at,incidentEnvironment]);
      },
    };
    incidentReporter = incidents.recordFailure;
    let keyText: string;
    let key: { keyVersion: string; bytes: Buffer };
    let name: string;
    let retention: number;
    let pgDump: string;
    let pgDumpAll: string;
    let environment: string;
    try {
      keyText = required("BACKUP_ENCRYPTION_KEY");
      const keyBytes = Buffer.from(keyText, "base64");
      if (keyBytes.byteLength !== 32 || keyBytes.toString("base64").replace(/=+$/u, "") !== keyText.replace(/=+$/u, "")) {
        throw new BackupFailure("BACKUP_CONFIG_INVALID", "BACKUP_ENCRYPTION_KEY");
      }
      key = { keyVersion: required("BACKUP_KEY_VERSION"), bytes: keyBytes };
      name = required("BACKUP_DESTINATION_NAME");
      if (!/^[a-z][a-z0-9-]{2,47}$/u.test(name)) throw new BackupFailure("BACKUP_CONFIG_INVALID", "BACKUP_DESTINATION_NAME");
      retention = Number(required("BACKUP_RETENTION_HOURS"));
      if (!Number.isSafeInteger(retention) || retention < 24 || retention > 8760) {
        throw new BackupFailure("BACKUP_CONFIG_INVALID", "BACKUP_RETENTION_HOURS");
      }
      pgDump = required("PG_DUMP_BIN");
      pgDumpAll = required("PG_DUMPALL_BIN");
      environment = required("BACKUP_ENVIRONMENT");
      if (!["local", "test", "staging", "production", "unknown"].includes(environment)) {
        throw new BackupFailure("BACKUP_CONFIG_INVALID", "BACKUP_ENVIRONMENT");
      }
    } catch (error) {
      await incidents.recordFailure(error instanceof BackupFailure ? error.safeCode : "BACKUP_CONFIG_INVALID", new Date().toISOString())
        .catch(() => undefined);
      throw error;
    }
    let store: ReturnType<typeof createHttpRelationalBackupDestination>;
    try {
      const destinationUrl = required("BACKUP_DESTINATION_URL");
      const destinationHost = new URL(destinationUrl).hostname.toLowerCase();
      if (destinationHost === source.host) throw new BackupFailure("BACKUP_DESTINATION_NOT_INDEPENDENT");
      store = createHttpRelationalBackupDestination({
        name,
        baseUrl: destinationUrl,
        bearerToken: required("BACKUP_DESTINATION_TOKEN"),
        allowLoopbackHttp: process.env['BACKUP_ALLOW_LOOPBACK_DESTINATION'] === "true",
      });
    } catch (error) {
      const code = error instanceof BackupFailure ? error.safeCode : "BACKUP_CONFIG_INVALID";
      await incidents.recordFailure(code, new Date().toISOString()).catch(() => undefined);
      throw error;
    }
    lockName = "phase8.relational-backup:" + name;
    const lock = await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
      [lockName]);
    if (lock.rows[0]?.acquired !== true) {
      await incidents.recordFailure("BACKUP_ALREADY_RUNNING", new Date().toISOString());
      throw new BackupFailure("BACKUP_ALREADY_RUNNING");
    }
    lockHeld = true;
    const catalog = {
      async begin(a: RelationalBackupAttempt) {
        await client.query("insert into operations.relational_backup_copies " +
          "(copy_id,destination_name,object_key,envelope_version,algorithm,key_version,dump_tool,source_watermark_at," +
          "dump_bytes,ciphertext_bytes,catalog_sha256,ciphertext_sha256,state,attempted_at,retention_lifetime_hours,expires_at) " +
          "values ($1,$2,$3,1,'AES-256-GCM',$4,$5,$6,$7,$8,$9,$10,'uploading',$11,$12,$13)",
        [a.copyId,a.destinationName,a.objectKey,a.keyVersion,a.dumpTool,a.sourceWatermarkAt,a.dumpBytes,a.ciphertextBytes,
          a.catalogSha256,a.ciphertextSha256,a.attemptedAt,a.retentionLifetimeHours,a.expiresAt]);
      },
      async markUsable(id: string, verified: string, committed: string) {
        const r = await client.query("update operations.relational_backup_copies set state='usable',verified_at=$2,committed_at=$3 " +
          "where copy_id=$1 and state='uploading' and verified_at is null and committed_at is null", [id,verified,committed]);
        if (r.rowCount !== 1) throw new BackupFailure("BACKUP_CATALOG_COMMIT_FAILED");
      },
      async markFailed(id: string, code: string) {
        await client.query("update operations.relational_backup_copies set state='failed',failure_code=$2 where copy_id=$1 and state='uploading'", [id,code]);
      },
      async currentUsable(destinationName: string) {
        const r = await client.query("select * from operations.relational_backup_copies where destination_name=$1 " +
          "and state='usable' and deletion_acknowledged_at is null and (expires_at is null or expires_at > clock_timestamp()) " +
          "order by committed_at desc,copy_id desc limit 1", [destinationName]);
        return r.rows[0] ? mapRow(r.rows[0]) : null;
      },
    };
    const service = createRelationalBackupService({
      source: { capture: () => capture(source, pgDump, pgDumpAll, temp) }, destination: store, catalog, incidents, key,
      ids: { next: randomUUID }, clock: { now: () => new Date().toISOString() }, retentionLifetimeHours: retention,
    });
    const result = await service.create();
    const expired = await client.query("select copy_id::text,object_key from operations.relational_backup_copies " +
      "where state='usable' and deletion_acknowledged_at is null and expires_at <= clock_timestamp() " +
      "order by expires_at,copy_id limit 100");
    let deletedCount = 0;
    for (const row of expired.rows as Array<{ copy_id: string; object_key: string }>) {
      try {
        await store.delete(row.object_key);
        const deletionAt = new Date().toISOString();
        const acknowledged = await client.query("update operations.relational_backup_copies " +
          "set deletion_acknowledged_at=$2 where copy_id=$1 and state='usable' " +
          "and deletion_acknowledged_at is null and expires_at <= clock_timestamp()", [row.copy_id,deletionAt]);
        if (acknowledged.rowCount !== 1) throw new BackupFailure("BACKUP_CLEANUP_FAILED");
        deletedCount += 1;
      } catch {
        await incidents.recordFailure("BACKUP_CLEANUP_FAILED", new Date().toISOString()).catch(() => undefined);
        throw new BackupFailure("BACKUP_CLEANUP_FAILED");
      }
    }
    const backlog = await client.query("select count(*)::int as count from operations.relational_backup_copies " +
      "where state='usable' and deletion_acknowledged_at is null and expires_at <= clock_timestamp()");
    process.stdout.write(JSON.stringify({
      status: result.state, copyId: result.copyId, sourceWatermarkAt: result.sourceWatermarkAt,
      dumpBytes: result.dumpBytes, ciphertextBytes: result.ciphertextBytes, attemptedAt: result.attemptedAt,
      verifiedAt: result.verifiedAt, committedAt: result.committedAt, destination: result.destinationName,
      keyVersion: result.keyVersion, retentionLifetimeHours: result.retentionLifetimeHours,
      dumpTool: result.catalog.dumpTool, dumpToolVersion: result.catalog.dumpToolVersion,
      schemaCount: result.catalog.schemaCount, relationCount: result.catalog.relationCount,
      migrationCount: result.catalog.migrationCount, complete: result.catalog.complete, scope: result.catalog.scope,
      dumpStartedAt: result.catalog.startedAt, dumpCompletedAt: result.catalog.completedAt,
      expiredCopiesDeleted: deletedCount, expiredCopiesRemaining: Number(backlog.rows[0].count),
    }) + "\n");
  } finally {
    try { await removeOwnedTemp(temp, tempRoot); }
    catch {
      if (incidentReporter) await incidentReporter("BACKUP_CLEANUP_FAILED", new Date().toISOString()).catch(() => undefined);
      if (lockHeld && lockName) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockName]).catch(() => undefined);
      if (connected) await client.end().catch(() => undefined);
      throw new BackupFailure("BACKUP_CLEANUP_FAILED");
    }
    if (lockHeld && lockName) await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockName]).catch(() => undefined);
    if (connected) await client.end().catch(() => undefined);
  }
}
main().catch(error => {
  const code = error instanceof BackupFailure ? error.safeCode : "BACKUP_ATTEMPT_FAILED";
  const variable = error instanceof BackupFailure ? error.variable : undefined;
  process.stderr.write(JSON.stringify({ status: "failed", code, ...(variable ? { variable } : {}) }) + "\n");
  process.exitCode = 1;
});
