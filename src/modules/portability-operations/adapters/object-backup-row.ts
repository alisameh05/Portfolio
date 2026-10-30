import type { ObjectBackupAttempt } from "../application/object-backup.js";

export function mapObjectBackupRow(row: Record<string, unknown>): ObjectBackupAttempt {
  return Object.freeze({
    copyId: String(row["copy_id"]), destinationName: String(row["destination_name"]), objectKey: String(row["object_key"]),
    keyVersion: String(row["key_version"]), sourceWatermarkAt: timestamp(row["source_watermark_at"]),
    relationalWatermarkAt: timestamp(row["relational_watermark_at"]), objectCount: Number(row["object_count"]),
    mediaBytes: Number(row["media_bytes"]), exportBytes: Number(row["export_bytes"]), ciphertextBytes: Number(row["ciphertext_bytes"]),
    catalogSha256: String(row["catalog_sha256"]).trim(), ciphertextSha256: String(row["ciphertext_sha256"]).trim(),
    attemptedAt: timestamp(row["attempted_at"]), verifiedAt: row["verified_at"] == null ? null : timestamp(row["verified_at"]),
    committedAt: row["committed_at"] == null ? null : timestamp(row["committed_at"]),
    retentionLifetimeHours: row["retention_lifetime_hours"] == null ? null : Number(row["retention_lifetime_hours"]),
    expiresAt: row["expires_at"] == null ? null : timestamp(row["expires_at"]),
    state: String(row["state"]) as ObjectBackupAttempt["state"], failureCode: row["failure_code"] == null ? null : String(row["failure_code"]),
  });
}
function timestamp(value: unknown): string { return (value instanceof Date ? value : new Date(String(value))).toISOString(); }
