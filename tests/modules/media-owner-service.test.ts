import { describe, expect, it, vi } from "vitest";
import { ok, type StableId } from "@shared/domain";
import { createOwnerMediaApplicationService } from "../../src/modules/media/application/owner-service.js";
import type { OwnerMediaAggregateView } from "../../src/modules/media/application/owner-contracts.js";

const ownerId = "0199a000-0000-7000-8000-000000000001" as StableId<"Owner">;
const mediaId = "0199a000-0000-7000-8000-000000000002" as StableId<"MediaAsset">;
const actor = { kind: "owner" as const, ownerId, sessionId: "owner-media-service" };
const aggregate: OwnerMediaAggregateView = {
  mediaId, aggregateVersion: 1, kind: "image", originalFileName: "private.png", declaredMediaType: "image/png",
  byteLength: 12, state: "upload-pending", processingHistory: [], decisionHistory: [],
  processingHistoryTruncated: false, decisionHistoryTruncated: false,
};

describe("Owner Media production application composition (#161)", () => {
  it("authorizes aggregate reads before the scoped repository and delegates all four commands", async () => {
    const read = vi.fn(async () => ok(aggregate));
    const upload = vi.fn(async () => ok({ mediaId, aggregateVersion: 1 as const, outcome: "media-upload-intent-created" as const,
      uploadIntentId: mediaId, uploadTarget: "https://storage.example/upload", expiresAt: "2026-10-14T00:00:00.000Z" }));
    const processing = vi.fn(async () => ok({ aggregateId: mediaId, aggregateVersion: 2, outcome: "media-processing-recorded" as const }));
    const acceptance = vi.fn(async () => ok({ aggregateId: mediaId, aggregateVersion: 3, outcome: "media-accepted" as const }));
    const rejection = vi.fn(async () => ok({ aggregateId: mediaId, aggregateVersion: 4, outcome: "media-rejected" as const }));
    const service = createOwnerMediaApplicationService({
      ownerId,
      aggregateRepository: { getOwnerMediaAggregate: read },
      uploadIntent: { createOwnerMediaUploadIntent: upload },
      processing: { recordOwnerMediaProcessing: processing },
      acceptance: { acceptOwnerMediaAsset: acceptance },
      rejection: { rejectOwnerMediaAsset: rejection },
    });

    expect(await service.getOwnerMediaAggregate({ actor: { kind: "visitor", consent: "unknown" }, mediaId })).toMatchObject({ ok: false, error: { code: "OWNER_REQUIRED" } });
    expect(read).not.toHaveBeenCalled();
    expect(await service.getOwnerMediaAggregate({ actor, mediaId })).toEqual({ ok: true, value: aggregate });
    await service.createOwnerMediaUploadIntent({ actor, idempotencyKey: "upload" as never, kind: "image", originalFileName: "private.png",
      declaredMediaType: "image/png", byteLength: 12, sha256: "a".repeat(64) });
    await service.recordOwnerMediaProcessing({ actor, idempotencyKey: "process" as never, expectedVersion: 1, mediaId,
      result: "passed", detectedMediaType: "image/png", detectedByteLength: 12, sha256: "a".repeat(64) });
    await service.acceptOwnerMediaAsset({ actor, idempotencyKey: "accept" as never, expectedVersion: 2, mediaId,
      accessibility: { kind: "described-image", altText: "A blue square" } });
    await service.rejectOwnerMediaAsset({ actor, idempotencyKey: "reject" as never, expectedVersion: 3, mediaId, reason: "No longer needed" });

    expect(upload).toHaveBeenCalledTimes(1);
    expect(processing).toHaveBeenCalledTimes(1);
    expect(acceptance).toHaveBeenCalledTimes(1);
    expect(rejection).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith({ ownerId, mediaId });
  });

  it("rejects malformed Media IDs before any database read", async () => {
    const read = vi.fn(async () => ok(aggregate));
    const service = createOwnerMediaApplicationService({
      ownerId, aggregateRepository: { getOwnerMediaAggregate: read },
      uploadIntent: { createOwnerMediaUploadIntent: vi.fn() },
      processing: { recordOwnerMediaProcessing: vi.fn() },
      acceptance: { acceptOwnerMediaAsset: vi.fn() },
      rejection: { rejectOwnerMediaAsset: vi.fn() },
    });
    expect(await service.getOwnerMediaAggregate({ actor, mediaId: "not-an-id" as never })).toMatchObject({ ok: false, error: { code: "MEDIA_ID_INVALID" } });
    expect(read).not.toHaveBeenCalled();
  });
});
