/**
 * fakes/owner-media.ts — Phase 2 #31 deterministic Owner Media fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real storage, scanning, processing, acceptance, and delivery
 * behavior remain later-phase work.
 *
 * Declared upload and delivery references stay provider-neutral opaque
 * HTTPS URLs. They never expose signed secrets and are never logged: the
 * adapter logs only trace identifiers, statuses, and stable codes.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import type {
  AcceptOwnerMediaAssetApplicationCommand,
  CreateOwnerMediaUploadIntentApplicationCommand,
  GetOwnerMediaAggregateQuery,
  OwnerMediaAggregateView,
  OwnerMediaApplicationService,
  OwnerMediaCommandReceipt,
  OwnerMediaUploadIntentView,
  RecordOwnerMediaProcessingApplicationCommand,
  RejectOwnerMediaAssetApplicationCommand,
} from "../../modules/media/index.js";

export type OwnerMediaFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerMediaTestFake extends OwnerMediaApplicationService {
  readonly calls: {
    readonly getOwnerMediaAggregate: ReadonlyArray<GetOwnerMediaAggregateQuery>;
    readonly createOwnerMediaUploadIntent: ReadonlyArray<CreateOwnerMediaUploadIntentApplicationCommand>;
    readonly recordOwnerMediaProcessing: ReadonlyArray<RecordOwnerMediaProcessingApplicationCommand>;
    readonly acceptOwnerMediaAsset: ReadonlyArray<AcceptOwnerMediaAssetApplicationCommand>;
    readonly rejectOwnerMediaAsset: ReadonlyArray<RejectOwnerMediaAssetApplicationCommand>;
  };
}

export const OWNER_MEDIA_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0";
export const OWNER_MEDIA_UPLOAD_INTENT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1";
const EXPIRES_AT = "2026-09-22T01:00:00.000Z";
const RECORDED_AT = "2026-09-22T00:00:00.000Z";

function uploadTarget(intentId: string): string {
  return `https://uploads.example.invalid/intents/${intentId}`;
}

function aggregateView(mediaId: StableId<string>): OwnerMediaAggregateView {
  return {
    mediaId,
    aggregateVersion: 1,
    kind: "image",
    originalFileName: "portfolio-result.png",
    declaredMediaType: "image/png",
    byteLength: 204800,
    state: "upload-pending",
    processingHistory: [],
    processingHistoryTruncated: true,
    decisionHistory: [],
    decisionHistoryTruncated: true,
  };
}

function invalidAggregateView(mediaId: StableId<string>): OwnerMediaAggregateView {
  return {
    mediaId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    kind: "image",
    originalFileName: "portfolio-result.png",
    declaredMediaType: "image/png",
    byteLength: 204800,
    state: "upload-pending",
    processingHistory: [
      {
        result: "passed",
        detectedMediaType: "image/png",
        detectedByteLength: 204800,
        sha256: "not-a-sha256" as unknown as string,
        findings: [`media:${mediaId}`],
        recordedAt: RECORDED_AT,
      },
    ],
    decisionHistory: [],
  };
}

function intentView(mediaId: StableId<string>): OwnerMediaUploadIntentView {
  return {
    mediaId,
    aggregateVersion: 1,
    outcome: "media-upload-intent-created",
    uploadIntentId: OWNER_MEDIA_UPLOAD_INTENT_ID as StableId<string>,
    uploadTarget: uploadTarget(OWNER_MEDIA_UPLOAD_INTENT_ID),
    expiresAt: EXPIRES_AT,
  };
}

function invalidIntentView(): OwnerMediaUploadIntentView {
  return {
    mediaId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1 as unknown as 1,
    outcome: "media-upload-intent-created",
    uploadIntentId: "not-a-uuid" as unknown as StableId<string>,
    uploadTarget: "not-a-url",
    expiresAt: "not-a-datetime",
  };
}

function receipt(
  aggregateId: string,
  aggregateVersion: number,
  outcome: OwnerMediaCommandReceipt["outcome"],
): OwnerMediaCommandReceipt {
  return {
    aggregateId: aggregateId as StableId<string>,
    aggregateVersion,
    outcome,
  };
}

function invalidReceipt(): OwnerMediaCommandReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "media-accepted",
  };
}

export function createOwnerMediaTestFake(mode: OwnerMediaFakeMode): OwnerMediaTestFake {
  const getCalls: GetOwnerMediaAggregateQuery[] = [];
  const intentCalls: CreateOwnerMediaUploadIntentApplicationCommand[] = [];
  const recordCalls: RecordOwnerMediaProcessingApplicationCommand[] = [];
  const acceptCalls: AcceptOwnerMediaAssetApplicationCommand[] = [];
  const rejectCalls: RejectOwnerMediaAssetApplicationCommand[] = [];
  return {
    get calls() {
      return {
        getOwnerMediaAggregate: getCalls,
        createOwnerMediaUploadIntent: intentCalls,
        recordOwnerMediaProcessing: recordCalls,
        acceptOwnerMediaAsset: acceptCalls,
        rejectOwnerMediaAsset: rejectCalls,
      };
    },
    async getOwnerMediaAggregate(query: GetOwnerMediaAggregateQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: aggregateView(query.mediaId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidAggregateView(query.mediaId) };
      }
    },
    async createOwnerMediaUploadIntent(command: CreateOwnerMediaUploadIntentApplicationCommand) {
      intentCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: intentView(OWNER_MEDIA_ID as StableId<string>),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidIntentView() };
      }
    },
    async recordOwnerMediaProcessing(command: RecordOwnerMediaProcessingApplicationCommand) {
      recordCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.mediaId, command.expectedVersion + 1, "media-processing-recorded"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async acceptOwnerMediaAsset(command: AcceptOwnerMediaAssetApplicationCommand) {
      acceptCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.mediaId, command.expectedVersion + 1, "media-accepted"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async rejectOwnerMediaAsset(command: RejectOwnerMediaAssetApplicationCommand) {
      rejectCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.mediaId, command.expectedVersion + 1, "media-rejected"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the five Owner Media operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerMediaService(): OwnerMediaApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async getOwnerMediaAggregate(_query: GetOwnerMediaAggregateQuery) {
      return failure;
    },
    async createOwnerMediaUploadIntent(_command: CreateOwnerMediaUploadIntentApplicationCommand) {
      return failure;
    },
    async recordOwnerMediaProcessing(_command: RecordOwnerMediaProcessingApplicationCommand) {
      return failure;
    },
    async acceptOwnerMediaAsset(_command: AcceptOwnerMediaAssetApplicationCommand) {
      return failure;
    },
    async rejectOwnerMediaAsset(_command: RejectOwnerMediaAssetApplicationCommand) {
      return failure;
    },
  };
}
