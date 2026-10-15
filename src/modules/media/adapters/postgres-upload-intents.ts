import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { err, ok, parseStableId, type Rejection, type StableId } from "@shared/domain";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type {
  CompleteUploadIntentInput,
  ExpiredUploadIntentCleanup,
  MediaUploadIntentRepositoryPort,
  SealedUploadCapability,
  UploadIntentReceiptRecord,
  UploadIntentReservation,
  UploadIntentReservationInput,
} from "../ports/upload-intent.js";

interface CommandRow {
  readonly request_hash: string;
  readonly command_state: "preparing" | "completed" | "abandoned" | "compensated";
  readonly reservation_expires_at: Date | string;
  readonly media_id: string;
  readonly upload_intent_id: string;
  readonly media_object_id: string;
  readonly safe_receipt: unknown;
}

interface CapabilityRow {
  readonly encryption_version: number;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authentication_tag: Uint8Array;
}

interface CleanupRow {
  readonly portfolio_id: string;
  readonly owner_id: string;
  readonly idempotency_key_hash: string;
  readonly media_id: string;
  readonly upload_intent_id: string;
  readonly media_object_id: string;
}

function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function canonicalTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PostgresInfrastructureError();
  return date.toISOString();
}

function safeReceipt(value: unknown): UploadIntentReceiptRecord {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; } catch { throw new PostgresInfrastructureError(); }
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new PostgresInfrastructureError();
  }
  const record = candidate as Record<string, unknown>;
  if (typeof record["mediaId"] !== "string" || typeof record["uploadIntentId"] !== "string") {
    throw new PostgresInfrastructureError();
  }
  const mediaId = parseStableId("MediaAsset", record["mediaId"]);
  const uploadIntentId = parseStableId("MediaUploadIntent", record["uploadIntentId"]);
  if (!mediaId.ok || !uploadIntentId.ok || typeof record["expiresAt"] !== "string" ||
      !Number.isFinite(Date.parse(record["expiresAt"]))) throw new PostgresInfrastructureError();
  return { mediaId: mediaId.value, uploadIntentId: uploadIntentId.value, expiresAt: record["expiresAt"] };
}

function sealedCapability(row: CapabilityRow): SealedUploadCapability {
  if (row.encryption_version !== 1 || row.nonce.byteLength !== 12 || row.authentication_tag.byteLength !== 16 ||
      row.ciphertext.byteLength < 1 || row.ciphertext.byteLength > 8192) {
    throw new PostgresInfrastructureError();
  }
  return {
    version: 1,
    nonce: Buffer.from(row.nonce).toString("base64"),
    ciphertext: Buffer.from(row.ciphertext).toString("base64"),
    authenticationTag: Buffer.from(row.authentication_tag).toString("base64"),
  };
}

async function setTrustedScope(
  context: TransactionContext,
  scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> },
): Promise<void> {
  const executor = resolvePostgresTransaction(context);
  await sql`
    select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
           set_config('shipwithali.owner_id', ${scope.ownerId}, true)
  `.execute(executor);
}

function toCleanup(row: CleanupRow): ExpiredUploadIntentCleanup {
  const portfolioId = parseStableId("Portfolio", row.portfolio_id);
  const ownerId = parseStableId("Owner", row.owner_id);
  const mediaId = parseStableId("MediaAsset", row.media_id);
  const uploadIntentId = parseStableId("MediaUploadIntent", row.upload_intent_id);
  const mediaObjectId = parseStableId("MediaObject", row.media_object_id);
  if (!portfolioId.ok || !ownerId.ok || !mediaId.ok || !uploadIntentId.ok || !mediaObjectId.ok ||
      !/^[0-9a-f]{64}$/.test(row.idempotency_key_hash)) throw new PostgresInfrastructureError();
  return {
    portfolioId: portfolioId.value,
    ownerId: ownerId.value,
    idempotencyKeyHash: row.idempotency_key_hash,
    mediaId: mediaId.value,
    uploadIntentId: uploadIntentId.value,
    mediaObjectId: mediaObjectId.value,
  };
}

export function createPostgresMediaUploadIntentRepository(
  database: Kysely<DB>,
  transactions: TransactionRunner,
): MediaUploadIntentRepositoryPort {
  return {
    async reserve(input): Promise<ReturnType<MediaUploadIntentRepositoryPort["reserve"]> extends Promise<infer T> ? T : never> {
      const hashedKey = keyHash(input.idempotencyKey);
      try {
        return await transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setTrustedScope(context, input);
          const inserted = await sql<{ inserted: boolean }>`
            insert into media.upload_intent_commands (
              portfolio_id, owner_id, idempotency_key_hash, request_hash,
              media_id, upload_intent_id, media_object_id, command_state,
              reservation_expires_at
            ) values (
              ${input.portfolioId}::uuid, ${input.ownerId}::uuid, ${hashedKey}, ${input.requestHash},
              ${input.mediaId}::uuid, ${input.uploadIntentId}::uuid, ${input.mediaObjectId}::uuid,
              'preparing', ${input.reservationExpiresAt}::timestamptz
            ) on conflict do nothing returning true as inserted
          `.execute(executor);
          if (inserted.rows.length === 1) return ok({ kind: "reserved" } as UploadIntentReservation);

          const existing = await sql<CommandRow>`
            select request_hash, command_state, reservation_expires_at, media_id::text,
                   upload_intent_id::text, media_object_id::text, safe_receipt
              from media.upload_intent_commands
             where portfolio_id = ${input.portfolioId}::uuid and owner_id = ${input.ownerId}::uuid
               and idempotency_key_hash = ${hashedKey}
             for update
          `.execute(executor);
          const row = existing.rows[0];
          if (row === undefined) throw new PostgresInfrastructureError();
          if (row.request_hash !== input.requestHash) return ok({ kind: "conflict" } as UploadIntentReservation);
          if (row.command_state === "completed") {
            const stored = await sql<CapabilityRow>`
              select encryption_version, nonce, ciphertext, authentication_tag
                from media.upload_intent_capabilities
               where upload_intent_id = ${row.upload_intent_id}::uuid
                 and portfolio_id = ${input.portfolioId}::uuid and owner_id = ${input.ownerId}::uuid
            `.execute(executor);
            const capability = stored.rows[0];
            if (capability === undefined) throw new PostgresInfrastructureError();
            return ok({ kind: "replay", receipt: safeReceipt(row.safe_receipt), capability: sealedCapability(capability) } as UploadIntentReservation);
          }
          if (row.command_state === "preparing" && Date.parse(canonicalTime(row.reservation_expires_at)) > Date.now()) {
            return ok({ kind: "in-progress" } as UploadIntentReservation);
          }

          await sql`
            update media.upload_intent_commands
               set media_id = ${input.mediaId}::uuid,
                   upload_intent_id = ${input.uploadIntentId}::uuid,
                   media_object_id = ${input.mediaObjectId}::uuid,
                   command_state = 'preparing',
                   reservation_expires_at = ${input.reservationExpiresAt}::timestamptz,
                   safe_receipt = null, completed_at = null
             where portfolio_id = ${input.portfolioId}::uuid and owner_id = ${input.ownerId}::uuid
               and idempotency_key_hash = ${hashedKey}
          `.execute(executor);
          return ok({ kind: "reserved" } as UploadIntentReservation);
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_UPLOAD_INTENT_UNAVAILABLE" });
      }
    },

    async complete(input): Promise<ReturnType<MediaUploadIntentRepositoryPort["complete"]> extends Promise<infer T> ? T : never> {
      try {
        return await transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setTrustedScope(context, input);
          const reservation = await sql<CommandRow>`
            select request_hash, command_state, reservation_expires_at, media_id::text,
                   upload_intent_id::text, media_object_id::text, safe_receipt
              from media.upload_intent_commands
             where portfolio_id = ${input.portfolioId}::uuid and owner_id = ${input.ownerId}::uuid
               and idempotency_key_hash = ${keyHash(input.idempotencyKey)}
             for update
          `.execute(executor);
          const row = reservation.rows[0];
          if (row === undefined || row.request_hash !== input.requestHash || row.command_state !== "preparing" ||
              row.media_id !== input.mediaId || row.upload_intent_id !== input.uploadIntentId || row.media_object_id !== input.mediaObjectId) {
            return err({ kind: "conflict", code: "MEDIA_UPLOAD_INTENT_RESERVATION_LOST" });
          }

          await sql`
            insert into media.assets (
              media_id, portfolio_id, owner_id, aggregate_version, kind, original_file_name,
              declared_media_type, declared_byte_length, declared_sha256, lifecycle
            ) values (
              ${input.mediaId}::uuid, ${input.portfolioId}::uuid, ${input.ownerId}::uuid, 1,
              ${input.kind}, ${input.originalFileName}, ${input.declaredMediaType},
              ${input.byteLength}, ${input.sha256}, 'candidate'
            )
          `.execute(executor);
          await sql`
            insert into media.upload_intents (
              upload_intent_id, media_id, media_object_id, portfolio_id, owner_id, expires_at
            ) values (
              ${input.uploadIntentId}::uuid, ${input.mediaId}::uuid, ${input.mediaObjectId}::uuid,
              ${input.portfolioId}::uuid, ${input.ownerId}::uuid, ${input.expiresAt}::timestamptz
            )
          `.execute(executor);
          await sql`
            insert into media.upload_intent_capabilities (
              upload_intent_id, portfolio_id, owner_id, encryption_version, nonce, ciphertext, authentication_tag
            ) values (
              ${input.uploadIntentId}::uuid, ${input.portfolioId}::uuid, ${input.ownerId}::uuid, 1,
              ${Buffer.from(input.uploadTarget.nonce, "base64")},
              ${Buffer.from(input.uploadTarget.ciphertext, "base64")},
              ${Buffer.from(input.uploadTarget.authenticationTag, "base64")}
            )
          `.execute(executor);
          const receipt = {
            mediaId: input.mediaId,
            aggregateVersion: 1,
            outcome: "media-upload-intent-created",
            uploadIntentId: input.uploadIntentId,
            expiresAt: input.expiresAt,
          };
          await sql`
            update media.upload_intent_commands
               set command_state = 'completed', safe_receipt = ${JSON.stringify(receipt)}::jsonb,
                   completed_at = transaction_timestamp()
             where portfolio_id = ${input.portfolioId}::uuid and owner_id = ${input.ownerId}::uuid
               and idempotency_key_hash = ${keyHash(input.idempotencyKey)}
          `.execute(executor);
          return ok(undefined);
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_UPLOAD_INTENT_UNAVAILABLE" });
      }
    },

    async abandon(input): Promise<void> {
      try {
        await transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setTrustedScope(context, input);
          await sql`
            update media.upload_intent_commands
               set command_state = 'abandoned'
             where portfolio_id = ${input.portfolioId}::uuid and owner_id = ${input.ownerId}::uuid
               and idempotency_key_hash = ${keyHash(input.idempotencyKey)}
               and request_hash = ${input.requestHash}
               and media_id = ${input.mediaId}::uuid
               and upload_intent_id = ${input.uploadIntentId}::uuid
               and media_object_id = ${input.mediaObjectId}::uuid
               and command_state = 'preparing'
          `.execute(executor);
        });
      } catch {
        // Failed compensation stays private and is picked up by expiry reconciliation.
      }
    },

    async listExpiredAbandoned(input) {
      try {
        return await transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setTrustedScope(context, input);
          const rows = await sql<CleanupRow>`
            select command.portfolio_id::text, command.owner_id::text,
                   command.idempotency_key_hash, command.media_id::text,
                   command.upload_intent_id::text, command.media_object_id::text
              from media.upload_intent_commands command
             where command.portfolio_id = ${input.portfolioId}::uuid
               and command.owner_id = ${input.ownerId}::uuid
               and command.command_state in ('preparing', 'abandoned')
               and command.reservation_expires_at <= ${input.now}::timestamptz
               and not exists (
                 select 1 from media.assets asset
                  where asset.media_id = command.media_id
                    and asset.portfolio_id = command.portfolio_id
                    and asset.owner_id = command.owner_id
               )
             order by command.reservation_expires_at, command.media_id
             limit ${input.limit}
          `.execute(executor);
          return ok(rows.rows.map(toCleanup));
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_UPLOAD_RECONCILIATION_UNAVAILABLE" });
      }
    },

    async markCompensated(input) {
      try {
        return await transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setTrustedScope(context, input);
          await sql`
            update media.upload_intent_commands command
               set command_state = 'compensated'
             where command.portfolio_id = ${input.portfolioId}::uuid
               and command.owner_id = ${input.ownerId}::uuid
               and command.idempotency_key_hash = ${input.idempotencyKeyHash}
               and command.media_id = ${input.mediaId}::uuid
               and command.upload_intent_id = ${input.uploadIntentId}::uuid
               and command.media_object_id = ${input.mediaObjectId}::uuid
               and command.command_state in ('preparing', 'abandoned')
               and not exists (
                 select 1 from media.assets asset
                  where asset.media_id = command.media_id
                    and asset.portfolio_id = command.portfolio_id
                    and asset.owner_id = command.owner_id
               )
          `.execute(executor);
          return ok(undefined);
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_UPLOAD_RECONCILIATION_UNAVAILABLE" });
      }
    },
  };
}
