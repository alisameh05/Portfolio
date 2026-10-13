import { err, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { MediaUsage, OwnerMediaCommandReceipt, RejectOwnerMediaAssetApplicationCommand } from "./owner-contracts.js";

export interface MediaRejectionUsageQuery {
  readonly ownerId: StableId<"Owner">;
  readonly mediaAssetId: StableId<"MediaAsset">;
}

export interface MediaRejectionUsagePort {
  getUsage(query: MediaRejectionUsageQuery, transaction: TransactionContext): Promise<Result<MediaUsage, Rejection>>;
}

export interface MediaRejectionRepositoryInput {
  readonly ownerId: StableId<"Owner">;
  readonly mediaId: StableId<"MediaAsset">;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly requestHash: string;
  /** Runs after the exclusive Media lock is held, inside the commit transaction. */
  readonly getUsage: (transaction: TransactionContext) => Promise<Result<MediaUsage, Rejection>>;
  /** Private Owner rationale retained only in Media-owned rejection history. */
  readonly reason: string;
}

export interface MediaRejectionRepositoryPort {
  reject(input: MediaRejectionRepositoryInput): Promise<Result<OwnerMediaCommandReceipt, Rejection>>;
}

export interface MediaRejectionApplicationService {
  rejectOwnerMediaAsset(command: RejectOwnerMediaAssetApplicationCommand): Promise<Result<OwnerMediaCommandReceipt, Rejection>>;
}

function validOwnerActor(actor: ActorContext, ownerId: StableId<"Owner">): boolean {
  return actor.kind === "owner" && actor.ownerId === ownerId;
}

function validIdempotencyKey(key: IdempotencyKey): boolean {
  return typeof key === "string" && /^[\x21-\x7e]{1,128}$/u.test(key);
}

function normalizedReason(reason: string): string | undefined {
  if (typeof reason !== "string" || /[\u0000-\u001f\u007f]/u.test(reason)) return undefined;
  const normalized = reason.trim();
  return normalized.length >= 1 && normalized.length <= 1_000 ? normalized : undefined;
}

export function createMediaRejectionApplicationService(input: {
  readonly scope: { readonly ownerId: StableId<"Owner"> };
  readonly repository: MediaRejectionRepositoryPort;
  readonly usage: MediaRejectionUsagePort;
}): MediaRejectionApplicationService {
  return {
    async rejectOwnerMediaAsset(command) {
      if (!validOwnerActor(command.actor, input.scope.ownerId)) {
        return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      }
      const reason = normalizedReason(command.reason);
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !validIdempotencyKey(command.idempotencyKey) ||
          typeof command.mediaId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(command.mediaId) ||
          reason === undefined) {
        return err({ kind: "validation", code: "MEDIA_REJECTION_INVALID" });
      }
      const requestHash = await hashCanonicalRequest({
        operation: "media-rejection-v1",
        ownerId: input.scope.ownerId,
        mediaId: command.mediaId,
        expectedVersion: command.expectedVersion,
        reason,
      });
      return input.repository.reject({
        ownerId: input.scope.ownerId,
        mediaId: command.mediaId as StableId<"MediaAsset">,
        idempotencyKey: command.idempotencyKey,
        expectedVersion: command.expectedVersion,
        requestHash,
        reason,
        getUsage: (transaction) => input.usage.getUsage({
          ownerId: input.scope.ownerId,
          mediaAssetId: command.mediaId as StableId<"MediaAsset">,
        }, transaction),
      });
    },
  };
}
