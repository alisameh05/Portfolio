import type { ObjectBackupAttempt, ObjectBackupCatalogPort } from "../application/object-backup.js";
import { mapObjectBackupRow } from "./object-backup-row.js";

export interface ObjectBackupSqlExecutor {
  query<T extends Record<string, unknown> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

/** Backup-role adapter; only the protected catalog ledger is persisted in PostgreSQL. */
export function createPostgresObjectBackupCatalog(database: ObjectBackupSqlExecutor): ObjectBackupCatalogPort {
  return {
    async begin(attempt: ObjectBackupAttempt) {
      await database.query("insert into operations.object_backup_copies " +
        "(copy_id,destination_name,object_key,envelope_version,algorithm,key_version,source_watermark_at,relational_watermark_at," +
        "object_count,media_bytes,export_bytes,ciphertext_bytes,catalog_sha256,ciphertext_sha256,state,attempted_at,retention_lifetime_hours,expires_at) " +
        "values ($1,$2,$3,1,'AES-256-GCM',$4,$5,$6,$7,$8,$9,$10,$11,$12,'uploading',$13,$14,$15)",
      [attempt.copyId,attempt.destinationName,attempt.objectKey,attempt.keyVersion,attempt.sourceWatermarkAt,attempt.relationalWatermarkAt,
        attempt.objectCount,attempt.mediaBytes,attempt.exportBytes,attempt.ciphertextBytes,attempt.catalogSha256,attempt.ciphertextSha256,
        attempt.attemptedAt,attempt.retentionLifetimeHours,attempt.expiresAt]);
    },
    async finalizeUploading(attempt: ObjectBackupAttempt) {
      const result = await database.query("update operations.object_backup_copies set object_count=$2,media_bytes=$3,export_bytes=$4," +
        "ciphertext_bytes=$5,catalog_sha256=$6,ciphertext_sha256=$7 where copy_id=$1 and state='uploading'",
      [attempt.copyId,attempt.objectCount,attempt.mediaBytes,attempt.exportBytes,attempt.ciphertextBytes,attempt.catalogSha256,attempt.ciphertextSha256]);
      if (result.rowCount !== 1) throw new Error("OBJECT_BACKUP_CATALOG_FINALIZE_FAILED");
    },
    async markUsable(copyId, verifiedAt, committedAt) {
      const result = await database.query("update operations.object_backup_copies set state='usable',verified_at=$2,committed_at=$3 " +
        "where copy_id=$1 and state='uploading' and verified_at is null and committed_at is null", [copyId,verifiedAt,committedAt]);
      if (result.rowCount !== 1) throw new Error("OBJECT_BACKUP_CATALOG_COMMIT_FAILED");
    },
    async markFailed(copyId, failureCode) {
      const result = await database.query("update operations.object_backup_copies set state='failed',failure_code=$2 " +
        "where copy_id=$1 and state='uploading'", [copyId,failureCode]);
      if (result.rowCount !== 1) throw new Error("OBJECT_BACKUP_CATALOG_COMMIT_FAILED");
    },
    async currentUsable(destinationName) {
      const result = await database.query("select * from operations.object_backup_copies where destination_name=$1 and state='usable' " +
        "and deletion_acknowledged_at is null and (expires_at is null or expires_at > clock_timestamp()) " +
        "order by committed_at desc,copy_id desc limit 1", [destinationName]);
      return result.rows[0] ? mapObjectBackupRow(result.rows[0]) : null;
    },
    async listUsable(destinationName, limit) {
      const result = await database.query("select * from operations.object_backup_copies where destination_name=$1 and state='usable' " +
        "and deletion_acknowledged_at is null and (expires_at is null or expires_at > clock_timestamp()) " +
        "order by committed_at desc,copy_id desc limit $2", [destinationName,limit]);
      return Object.freeze(result.rows.map(mapObjectBackupRow));
    },
    async listStaleUploading(destinationName, attemptedBefore, limit) {
      const result = await database.query("select * from operations.object_backup_copies where destination_name=$1 and state='uploading' " +
        "and attempted_at < $2::timestamptz order by attempted_at,copy_id limit $3", [destinationName,attemptedBefore,limit]);
      return Object.freeze(result.rows.map(mapObjectBackupRow));
    },
    async listExpired(destinationName, limit) {
      const result = await database.query("select * from operations.object_backup_copies where destination_name=$1 " +
        "and deletion_acknowledged_at is null and (state='failed' or (state='usable' and expires_at <= clock_timestamp())) order by expires_at,copy_id limit $2", [destinationName,limit]);
      return Object.freeze(result.rows.map(mapObjectBackupRow));
    },
    async acknowledgeDeletion(copyId, deletedAt) {
      const result = await database.query("update operations.object_backup_copies set deletion_acknowledged_at=$2 " +
        "where copy_id=$1 and deletion_acknowledged_at is null and (state='failed' or (state='usable' and expires_at <= clock_timestamp()))", [copyId,deletedAt]);
      if (result.rowCount !== 1) throw new Error("OBJECT_BACKUP_CLEANUP_COMMIT_FAILED");
    },
  };
}
