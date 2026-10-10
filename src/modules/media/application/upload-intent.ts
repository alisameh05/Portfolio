import {
  err,
  ok,
  type ActorContext,
  type IdempotencyKey,
  type Rejection,
  type Result,
  type StableId,
} from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { Clock, StableIdGenerator } from "../../../runtime/ports.js";
import { MEDIA_PROCESSING_POLICY } from "../domain/policy.js";
import type { MediaFileKind } from "../domain/types.js";
import type { ExpiredUploadIntentCleanup, MediaUploadIntentRepositoryPort, UploadCapabilityVaultPort } from "../ports/upload-intent.js";

export interface CreateMediaUploadIntentCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly kind: MediaFileKind;
  readonly originalFileName: string;
  readonly declaredMediaType: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface PreparedUploadTarget {
  readonly uploadTarget: string;
  readonly expiresAt: string;
}

export interface MediaUploadTargetPort {
  prepare(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly mediaId: StableId<"MediaAsset">;
    readonly uploadIntentId: StableId<"MediaUploadIntent">;
    readonly mediaObjectId: StableId<"MediaObject">;
    readonly mimeType: string;
    readonly byteLength: number;
  }): Promise<Result<PreparedUploadTarget, Rejection>>;
  removeAbandoned(input: Pick<ExpiredUploadIntentCleanup, "portfolioId" | "mediaId" | "uploadIntentId" | "mediaObjectId">): Promise<Result<void, Rejection>>;
}

export interface MediaUploadIntentApplicationService {
  create(command: CreateMediaUploadIntentCommand): Promise<Result<{
    readonly mediaId: StableId<string>;
    readonly aggregateVersion: 1;
    readonly outcome: "media-upload-intent-created";
    readonly uploadIntentId: StableId<string>;
    readonly uploadTarget: string;
    readonly expiresAt: string;
  }, Rejection>>;
  reconcileAbandoned(): Promise<Result<{ readonly reconciled: number }, Rejection>>;
}

export interface MediaUploadIntentServiceDependencies {
  readonly scope: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
  };
  readonly repository: MediaUploadIntentRepositoryPort;
  readonly target: MediaUploadTargetPort;
  readonly vault: UploadCapabilityVaultPort;
  readonly ids: StableIdGenerator;
  readonly clock: Clock;
}

const TEMPORARY_FAILURE: Rejection = {
  kind: "temporarily_unavailable",
  code: "MEDIA_UPLOAD_INTENT_UNAVAILABLE",
};

const KIND_MIME_TYPES: Readonly<Record<MediaFileKind, readonly string[]>> =
  MEDIA_PROCESSING_POLICY.allowedMimeTypes;

function validateDeclaration(command: CreateMediaUploadIntentCommand): Rejection | undefined {
  const supported = KIND_MIME_TYPES[command.kind];
  if (supported === undefined || !supported.includes(command.declaredMediaType)) {
    return { kind: "validation", code: "MEDIA_UPLOAD_TYPE_UNSUPPORTED" };
  }
  if (!Number.isSafeInteger(command.byteLength) || command.byteLength < 1 ||
      command.byteLength > MEDIA_PROCESSING_POLICY.maxBytesByKind[command.kind]) {
    return { kind: "validation", code: "MEDIA_UPLOAD_SIZE_OUT_OF_BOUNDS" };
  }
  if (!/^[0-9a-f]{64}$/i.test(command.sha256)) {
    return { kind: "validation", code: "MEDIA_UPLOAD_SHA256_INVALID" };
  }
  if (typeof command.originalFileName !== "string" || command.originalFileName.includes("\u0000") || command.originalFileName.length < 1 ||
      command.originalFileName.length > 255) {
    return { kind: "validation", code: "MEDIA_UPLOAD_FILENAME_INVALID" };
  }
  return undefined;
}

function associatedData(input: {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly mediaId: StableId<"MediaAsset">;
  readonly uploadIntentId: StableId<"MediaUploadIntent">;
}): string {
  return ["media-upload-capability-v1", input.portfolioId, input.ownerId, input.mediaId, input.uploadIntentId].join(":");
}

function stableId<T extends string>(ids: StableIdGenerator, kind: T): StableId<T> {
  const raw = ids.generate(kind);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(raw)) {
    throw new Error("MEDIA_ID_GENERATION_FAILED");
  }
  return raw as StableId<T>;
}

function isSecureTarget(value: string): boolean {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
    return url.protocol === "https:" || (url.protocol === "http:" && loopback);
  } catch {
    return false;
  }
}

/** Issues private, scoped upload targets and replays the exact committed receipt. */
export function createMediaUploadIntentApplicationService(
  dependencies: MediaUploadIntentServiceDependencies,
): MediaUploadIntentApplicationService {
  return {
    async reconcileAbandoned(): Promise<Result<{ readonly reconciled: number }, Rejection>> {
      const listed = await dependencies.repository.listExpiredAbandoned({
        ...dependencies.scope,
        now: dependencies.clock.now(),
        limit: 20,
      });
      if (!listed.ok) return listed;
      let reconciled = 0;
      for (const input of listed.value) {
        const removed = await dependencies.target.removeAbandoned({
          portfolioId: input.portfolioId,
          mediaId: input.mediaId,
          uploadIntentId: input.uploadIntentId,
          mediaObjectId: input.mediaObjectId,
        });
        if (!removed.ok) return removed;
        const marked = await dependencies.repository.markCompensated(input);
        if (!marked.ok) return marked;
        reconciled += 1;
      }
      return ok({ reconciled });
    },
    async create(command): Promise<Result<{
      readonly mediaId: StableId<string>;
      readonly aggregateVersion: 1;
      readonly outcome: "media-upload-intent-created";
      readonly uploadIntentId: StableId<string>;
      readonly uploadTarget: string;
      readonly expiresAt: string;
    }, Rejection>> {
      if (command.actor.kind !== "owner" || command.actor.ownerId !== dependencies.scope.ownerId) {
        return err({ kind: "forbidden", code: "MEDIA_OWNER_SCOPE_FORBIDDEN" });
      }
      const declarationFailure = validateDeclaration(command);
      if (declarationFailure !== undefined) return err(declarationFailure);
      if (!dependencies.vault.isAvailable()) return err(TEMPORARY_FAILURE);

      const mediaId = stableId(dependencies.ids, "MediaAsset");
      const uploadIntentId = stableId(dependencies.ids, "MediaUploadIntent");
      const mediaObjectId = stableId(dependencies.ids, "MediaObject");
      const issuedAt = dependencies.clock.now();
      const reservationExpiresAt = new Date(Date.parse(issuedAt) + 2 * 60 * 60 * 1000).toISOString();
      const requestHash = await hashCanonicalRequest({
        ownerId: dependencies.scope.ownerId,
        portfolioId: dependencies.scope.portfolioId,
        kind: command.kind,
        originalFileName: command.originalFileName,
        declaredMediaType: command.declaredMediaType,
        byteLength: command.byteLength,
        sha256: command.sha256.toLowerCase(),
      });
      const reservationInput = {
        ownerId: dependencies.scope.ownerId,
        portfolioId: dependencies.scope.portfolioId,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        mediaId,
        uploadIntentId,
        mediaObjectId,
        reservationExpiresAt,
      } as const;

      let reservation: Awaited<ReturnType<MediaUploadIntentRepositoryPort["reserve"]>>;
      try {
        reservation = await dependencies.repository.reserve(reservationInput);
      } catch {
        return err(TEMPORARY_FAILURE);
      }
      if (!reservation.ok) return reservation;
      if (reservation.value.kind === "conflict") {
        return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
      }
      if (reservation.value.kind === "in-progress") {
        return err({ kind: "temporarily_unavailable", code: "MEDIA_UPLOAD_INTENT_IN_PROGRESS" });
      }
      if (reservation.value.kind === "replay") {
        try {
          const aad = associatedData({
            portfolioId: dependencies.scope.portfolioId,
            ownerId: dependencies.scope.ownerId,
            mediaId: reservation.value.receipt.mediaId,
            uploadIntentId: reservation.value.receipt.uploadIntentId,
          });
          return ok({
            mediaId: reservation.value.receipt.mediaId,
            aggregateVersion: 1,
            outcome: "media-upload-intent-created",
            uploadIntentId: reservation.value.receipt.uploadIntentId,
            uploadTarget: dependencies.vault.open(reservation.value.capability, aad),
            expiresAt: reservation.value.receipt.expiresAt,
          });
        } catch {
          return err(TEMPORARY_FAILURE);
        }
      }

      let prepared: Awaited<ReturnType<MediaUploadTargetPort["prepare"]>>;
      try {
        prepared = await dependencies.target.prepare({
          portfolioId: dependencies.scope.portfolioId,
          mediaId,
          uploadIntentId,
          mediaObjectId,
          mimeType: command.declaredMediaType,
          byteLength: command.byteLength,
        });
      } catch {
        await dependencies.repository.abandon(reservationInput).catch(() => undefined);
        return err(TEMPORARY_FAILURE);
      }
      if (!prepared.ok) {
        await dependencies.repository.abandon(reservationInput).catch(() => undefined);
        return prepared;
      }
      if (!Number.isFinite(Date.parse(prepared.value.expiresAt)) ||
          !isSecureTarget(prepared.value.uploadTarget)) {
        await dependencies.repository.abandon(reservationInput).catch(() => undefined);
        return err(TEMPORARY_FAILURE);
      }

      let sealed: ReturnType<UploadCapabilityVaultPort["seal"]>;
      try {
        sealed = dependencies.vault.seal(prepared.value.uploadTarget, associatedData({
          portfolioId: dependencies.scope.portfolioId,
          ownerId: dependencies.scope.ownerId,
          mediaId,
          uploadIntentId,
        }));
      } catch {
        await dependencies.repository.abandon(reservationInput).catch(() => undefined);
        return err(TEMPORARY_FAILURE);
      }
      let completed: Awaited<ReturnType<MediaUploadIntentRepositoryPort["complete"]>>;
      try {
        completed = await dependencies.repository.complete({
          ...reservationInput,
          kind: command.kind,
          originalFileName: command.originalFileName,
          declaredMediaType: command.declaredMediaType,
          byteLength: command.byteLength,
          sha256: command.sha256.toLowerCase(),
          expiresAt: prepared.value.expiresAt,
          uploadTarget: sealed,
        });
      } catch {
        await dependencies.repository.abandon(reservationInput).catch(() => undefined);
        return err(TEMPORARY_FAILURE);
      }
      if (!completed.ok) {
        await dependencies.repository.abandon(reservationInput).catch(() => undefined);
        return completed;
      }
      return ok({
        mediaId,
        aggregateVersion: 1,
        outcome: "media-upload-intent-created",
        uploadIntentId,
        uploadTarget: prepared.value.uploadTarget,
        expiresAt: prepared.value.expiresAt,
      });
    },
  };
}
