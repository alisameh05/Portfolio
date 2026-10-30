import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { parseStableId, type StableId } from "@shared/domain";
import { createPostgresRuntimeDatabase } from "../src/shared/adapters/postgres/runtime.js";
import { createPostgresOwnerMediaExportSnapshotReader } from "../src/modules/media/adapters/postgres-owner-export-snapshot.js";
import { createPostgresOwnerCvExportSnapshotReader } from "../src/modules/cv-portfolio/adapters/postgres-owner-export-snapshot.js";
import { createPostgresMediaObjectBackupInventory, createPostgresOwnerExportObjectBackupInventory } from "../src/modules/portability-operations/adapters/postgres-object-backup-inventory.js";
import { createPostgresObjectBackupCatalog } from "../src/modules/portability-operations/adapters/postgres-object-backup-catalog.js";
import { createHttpObjectBackupDestination } from "../src/modules/portability-operations/adapters/http-object-backup-destination.js";
import { createSupabaseMediaExportStorage } from "../src/runtime/adapters/supabase-media-export-storage.js";
import { createSupabaseOwnerExportStorage } from "../src/runtime/adapters/supabase-owner-export-storage.js";
import { createOwnerObjectBackupSource } from "../src/modules/portability-operations/application/owner-object-backup-source.js";
import { createObjectBackupService, type ObjectBackupAttempt, type ObjectBackupKey } from "../src/modules/portability-operations/application/object-backup.js";

class BackupFailure extends Error {
  constructor(readonly safeCode: string, readonly variable?: string) { super(safeCode); }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new BackupFailure("OBJECT_BACKUP_CONFIG_MISSING", name);
  return value;
}

function backupKey(): ObjectBackupKey {
  const text = required("BACKUP_ENCRYPTION_KEY");
  const bytes = Buffer.from(text, "base64");
  if (bytes.byteLength !== 32 || bytes.toString("base64").replace(/=+$/u, "") !== text.replace(/=+$/u, "")) {
    throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_ENCRYPTION_KEY");
  }
  const keyVersion = required("BACKUP_KEY_VERSION");
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/u.test(keyVersion)) throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_KEY_VERSION");
  return { keyVersion, bytes };
}

type OwnerScope = Readonly<{ portfolioId: StableId<"Portfolio">; ownerId: StableId<"Owner"> }>;

function ownerScopes(configured: string, authoritative: readonly OwnerScope[]): readonly OwnerScope[] {
  let parsed: unknown;
  try { parsed = JSON.parse(configured) as unknown; }
  catch { throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_OWNER_SCOPES"); }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 10_000) throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_OWNER_SCOPES");
  const seen = new Set<string>();
  const configuredScopes = parsed.map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_OWNER_SCOPES");
    const row = entry as Record<string, unknown>;
    if (typeof row["portfolioId"] !== "string" || typeof row["ownerId"] !== "string") throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_OWNER_SCOPES");
    const portfolioId = parseStableId("Portfolio", row["portfolioId"]), ownerId = parseStableId("Owner", row["ownerId"]);
    if (!portfolioId.ok || !ownerId.ok) throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_OWNER_SCOPES");
    const identity = portfolioId.value + ":" + ownerId.value;
    if (seen.has(identity)) throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_OWNER_SCOPES");
    seen.add(identity);
    return Object.freeze({ portfolioId: portfolioId.value, ownerId: ownerId.value });
  });
  const authoritativeIds = new Set(authoritative.map(scope => scope.portfolioId + ":" + scope.ownerId));
  const configuredIds = new Set(configuredScopes.map(scope => scope.portfolioId + ":" + scope.ownerId));
  if (authoritativeIds.size !== configuredIds.size || [...authoritativeIds].some(identity => !configuredIds.has(identity))) {
    throw new BackupFailure("OBJECT_BACKUP_SCOPE_INVENTORY_MISMATCH", "BACKUP_OWNER_SCOPES");
  }
  return Object.freeze(configuredScopes);
}

async function authoritativeOwnerScopes(client: Client): Promise<readonly OwnerScope[]> {
  const result = await client.query<{ portfolio_id: string; owner_id: string }>(
    "select portfolio_id::text, owner_id::text from operations.object_backup_owner_scopes order by portfolio_id, owner_id");
  if (result.rows.length < 1 || result.rows.length > 10_000) throw new BackupFailure("OBJECT_BACKUP_SCOPE_INVENTORY_INVALID");
  const scopes = result.rows.map(row => {
    const portfolioId = parseStableId("Portfolio", row.portfolio_id), ownerId = parseStableId("Owner", row.owner_id);
    if (!portfolioId.ok || !ownerId.ok) throw new BackupFailure("OBJECT_BACKUP_SCOPE_INVENTORY_INVALID");
    return Object.freeze({ portfolioId: portfolioId.value, ownerId: ownerId.value });
  });
  const identities = new Set(scopes.map(scope => scope.portfolioId + ":" + scope.ownerId));
  if (identities.size !== scopes.length) throw new BackupFailure("OBJECT_BACKUP_SCOPE_INVENTORY_INVALID");
  return Object.freeze(scopes);
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function databaseIdentity(value: string, variable: string): Readonly<{ host: string; database: string }> {
  let url: URL;
  try { url = new URL(value); } catch { throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", variable); }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const sslmode = url.searchParams.get("sslmode") ?? "require";
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !database || !url.username || !url.password || url.hash ||
      [...url.searchParams.keys()].some(name => name !== "sslmode") || !["require", "verify-ca", "verify-full"].includes(sslmode)) {
    throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", variable);
  }
  return Object.freeze({ host: url.hostname.toLowerCase(), database: database.toLowerCase() });
}

async function main(): Promise<void> {
  const workerUrl = required("WORKER_DATABASE_DIRECT_URL");
  const catalogUrl = required("DATABASE_DIRECT_URL");
  const workerIdentity = databaseIdentity(workerUrl, "WORKER_DATABASE_DIRECT_URL");
  const catalogIdentity = databaseIdentity(catalogUrl, "DATABASE_DIRECT_URL");
  const allowlist = required("BACKUP_SOURCE_ALLOWLIST").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  if (!allowlist.includes(workerIdentity.host + "/" + workerIdentity.database) ||
      !allowlist.includes(catalogIdentity.host + "/" + catalogIdentity.database)) {
    throw new BackupFailure("OBJECT_BACKUP_SOURCE_NOT_ALLOWLISTED");
  }
  if (workerIdentity.host !== catalogIdentity.host || workerIdentity.database !== catalogIdentity.database) throw new BackupFailure("OBJECT_BACKUP_DATABASE_IDENTITY_MISMATCH");

  const environment = required("BACKUP_ENVIRONMENT");
  if (!["local", "test", "staging", "production"].includes(environment)) throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_ENVIRONMENT");
  const retention = Number(required("BACKUP_RETENTION_HOURS"));
  if (!Number.isSafeInteger(retention) || retention < 24 || retention > 8760) throw new BackupFailure("OBJECT_BACKUP_CONFIG_INVALID", "BACKUP_RETENTION_HOURS");
  const configuredScopes = required("BACKUP_OWNER_SCOPES");
  const worker = createPostgresRuntimeDatabase(workerUrl, { max: 5, connectionTimeoutMs: 10_000 });
  const catalogClient = new Client({ connectionString: catalogUrl, connectionTimeoutMillis: 10_000, statement_timeout: 30_000,
    application_name: "phase8-object-backup" });
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  let connected = false, lockHeld = false, lockKey: string | null = null, reportIncident: ((code: string, at: string) => Promise<void>) | undefined;
  let serviceOwnsIncidents = false;
  let cleanupFailed = false;
  try {
    await catalogClient.connect(); connected = true;
    const scopes = ownerScopes(configuredScopes, await authoritativeOwnerScopes(catalogClient));
    const incidentEnvironment = environment;
    const incidents = { async recordFailure(code: string, at: string) {
      const safe = /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : "OBJECT_BACKUP_ATTEMPT_FAILED";
      const incidentKey = "backup.object:" + sha256(safe);
      await catalogClient.query("insert into operations.incidents " +
        "(incident_key,category,safe_error_code,severity,first_observed_at,last_observed_at,owner_role,remediation_pointer,environment,delivery_state,next_delivery_at) " +
        "values ($1,'backup',$2,'critical',$3,$3,'backup','runbook:recovery/object-backup',$4,'pending',$3) " +
        "on conflict (incident_key) do update set last_observed_at=excluded.last_observed_at," +
        "occurrences=case when operations.incidents.resolved_at is null then operations.incidents.occurrences+1 else 1 end," +
        "resolved_at=null,recovery_recorded_at=null,delivery_state='pending',next_delivery_at=excluded.next_delivery_at",
      [incidentKey, safe, at, incidentEnvironment]);
    } };
    reportIncident = incidents.recordFailure;
    const destinationName = required("BACKUP_DESTINATION_NAME");
    const destinationUrl = required("BACKUP_DESTINATION_URL");
    const storageUrl = required("SUPABASE_URL");
    const destinationHost = new URL(destinationUrl).hostname.toLowerCase();
    const storageHost = new URL(storageUrl).hostname.toLowerCase();
    if (destinationHost === workerIdentity.host || destinationHost === storageHost) throw new BackupFailure("OBJECT_BACKUP_DESTINATION_NOT_INDEPENDENT");
    const destination = createHttpObjectBackupDestination({ name: destinationName, baseUrl: destinationUrl,
      bearerToken: required("BACKUP_DESTINATION_TOKEN") });
    const key = backupKey();
    const lockName = "phase8.object-backup:" + destinationName;
    lockKey = lockName;
    const lock = await catalogClient.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired", [lockName]);
    if (lock.rows[0]?.acquired !== true) throw new BackupFailure("OBJECT_BACKUP_ALREADY_RUNNING");
    lockHeld = true;

    const transactions = worker.transactions;
    const mediaReader = createPostgresOwnerMediaExportSnapshotReader({ database: worker.database, transactions });
    const cvReader = createPostgresOwnerCvExportSnapshotReader();
    const mediaObjects = createSupabaseMediaExportStorage({ storageUrl, serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY") });
    const exportObjects = createSupabaseOwnerExportStorage({ storageUrl, serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY") });
    const sources = scopes.map(scope => createOwnerObjectBackupSource({
      media: createPostgresMediaObjectBackupInventory({ reader: mediaReader, cvReader, transactions, scope }),
      exports: createPostgresOwnerExportObjectBackupInventory({ database: worker.database, transactions, scope }),
      mediaObjects, exportObjects,
    }));
    const source = { async capture() {
      const snapshots = await Promise.all(sources.map(item => item.capture()));
      const sourceWatermarkAt = snapshots.map(item => item.sourceWatermarkAt).sort()[0]!;
      const relationalWatermarkAt = snapshots.map(item => item.relationalWatermarkAt).sort().at(-1)!;
      return Object.freeze({ sourceWatermarkAt, relationalWatermarkAt, items: Object.freeze(snapshots.flatMap(item => item.items)) });
    } };
    const service = createObjectBackupService({ source, destination, catalog: createPostgresObjectBackupCatalog(catalogClient), incidents, key,
      ids: { next: randomUUID }, clock: { now: () => new Date().toISOString() }, retentionLifetimeHours: retention });
    serviceOwnsIncidents = true;
    const interruptedCopiesCleaned = await service.cleanupInterrupted();
    const result = await service.create(controller.signal);
    const expiredCopiesDeleted = await service.cleanupExpired();
    const remaining = await catalogClient.query("select count(*)::int as count from operations.object_backup_copies " +
      "where destination_name=$1 and state='usable' and deletion_acknowledged_at is null and expires_at <= clock_timestamp()", [destinationName]);
    process.stdout.write(JSON.stringify({ status: result.state, copyId: result.copyId, sourceWatermarkAt: result.sourceWatermarkAt,
      relationalWatermarkAt: result.relationalWatermarkAt, objectCount: result.objectCount, mediaCount: result.catalog.mediaCount,
      exportCount: result.catalog.exportCount, mediaBytes: result.mediaBytes, exportBytes: result.exportBytes,
      ciphertextBytes: result.ciphertextBytes, attemptedAt: result.attemptedAt, verifiedAt: result.verifiedAt,
      committedAt: result.committedAt, keyVersion: result.keyVersion, retentionLifetimeHours: result.retentionLifetimeHours,
      interruptedCopiesCleaned, expiredCopiesDeleted, expiredCopiesRemaining: Number(remaining.rows[0]?.count ?? 0) }) + "\n");
  } catch (error) {
    const code = error instanceof BackupFailure ? error.safeCode : typeof error === "object" && error !== null && "safeCode" in error && typeof (error as {safeCode?: unknown}).safeCode === "string"
      ? (error as {safeCode:string}).safeCode : "OBJECT_BACKUP_ATTEMPT_FAILED";
    if (reportIncident && !serviceOwnsIncidents) await reportIncident(code, new Date().toISOString()).catch(() => undefined);
    process.stderr.write(JSON.stringify({ status: "failed", code, ...(error instanceof BackupFailure && error.variable ? { variable: error.variable } : {}) }) + "\n");
    process.exitCode = 1;
  } finally {
    if (lockHeld && lockKey) await catalogClient.query("select pg_advisory_unlock(hashtextextended($1, 0))", [lockKey]).catch(() => undefined);
    if (connected) await catalogClient.end().catch(() => undefined);
    try { await worker.resource.close(); }
    catch { cleanupFailed = true; }
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    if (cleanupFailed) {
      if (reportIncident) await reportIncident("OBJECT_BACKUP_CLEANUP_FAILED", new Date().toISOString()).catch(() => undefined);
      process.stderr.write(JSON.stringify({ status: "failed", code: "OBJECT_BACKUP_CLEANUP_FAILED" }) + "\n");
      process.exitCode = 1;
    }
  }
}

main().catch(error => {
  const code = error instanceof BackupFailure ? error.safeCode : "OBJECT_BACKUP_ATTEMPT_FAILED";
  process.stderr.write(JSON.stringify({ status: "failed", code, ...(error instanceof BackupFailure && error.variable ? { variable: error.variable } : {}) }) + "\n");
  process.exitCode = 1;
});
