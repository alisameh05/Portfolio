import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ActorContext, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../src/runtime/ports.js";
import type { GetMediaAcceptanceFactsQuery } from "../../src/modules/media/application/owner-contracts.js";
import { createMediaAcceptanceApplicationService, type MediaAcceptanceRepositoryPort } from "../../src/modules/media/application/acceptance.js";

const ownerId = "0199a000-0000-7000-8000-000000000001" as StableId<"Owner">;
const firstMediaId = "0199a000-0000-7000-8000-000000000002" as StableId<"MediaAsset">;
const secondMediaId = "0199a000-0000-7000-8000-000000000003" as StableId<"MediaAsset">;
const transaction = { kind: "transaction" } satisfies TransactionContext;
const ownerActor: ActorContext = { kind: "owner", ownerId, sessionId: "session" };
const accessibility = { kind: "described-image", altText: "  A blue square  " } as const;

function repository(): MediaAcceptanceRepositoryPort {
  return {
    accept: vi.fn(async () => ok({ aggregateId: firstMediaId, aggregateVersion: 3, outcome: "media-accepted" as const })),
    getAcceptanceFacts: vi.fn(async ({ mediaAssetIds }: GetMediaAcceptanceFactsQuery) => ok(mediaAssetIds.map((mediaAssetId) => ({
      mediaAssetId, ownerId, assetVersion: 3, accepted: true, safe: true, suitable: true, accessible: true,
      policyVersion: "image-webp-variants-v1",
    })))),
    getAcceptedPdfSnapshot: vi.fn(async () => ok(undefined)),
  };
}

describe("Media acceptance application seam (#152)", () => {
  let repo: MediaAcceptanceRepositoryPort;

  beforeEach(() => { repo = repository(); });

  it("requires the authenticated same-Owner actor before persisting acceptance", async () => {
    const service = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: repo });
    const result = await service.acceptOwnerMediaAsset({
      actor: { kind: "visitor", consent: "unknown" }, idempotencyKey: "accept-1" as never,
      expectedVersion: 2, mediaId: firstMediaId, accessibility,
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it("rejects missing approved descriptions before repository access", async () => {
    const service = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: repo });
    const result = await service.acceptOwnerMediaAsset({
      actor: ownerActor, idempotencyKey: "accept-2" as never, expectedVersion: 2,
      mediaId: firstMediaId, accessibility: { kind: "described-image", altText: "  " },
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_ACCESSIBILITY_INVALID" } });
    expect(repo.accept).not.toHaveBeenCalled();
  });

  it("normalizes approved metadata and keeps the command result safe", async () => {
    const service = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: repo });
    const result = await service.acceptOwnerMediaAsset({
      actor: ownerActor, idempotencyKey: "accept-3" as never, expectedVersion: 2,
      mediaId: firstMediaId, accessibility,
    });

    expect(result).toEqual({ ok: true, value: { aggregateId: firstMediaId, aggregateVersion: 3, outcome: "media-accepted" } });
    expect(repo.accept).toHaveBeenCalledWith(expect.objectContaining({
      actor: ownerActor, accessibility: { kind: "described-image", altText: "A blue square" }, expectedVersion: 2,
    }));
  });

  it("returns one complete fact per distinct ID with a bounded sorted opaque token", async () => {
    const service = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: repo });
    const query = { ownerId, mediaAssetIds: [secondMediaId, firstMediaId, firstMediaId], intendedUse: "supporting-artifact" as const };
    const result = await service.getAcceptanceFacts(query, transaction);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ mediaAssetId }) => mediaAssetId)).toEqual([firstMediaId, secondMediaId]);
    expect(result.value[0]?.consistencyVersion).toMatch(/^media-acceptance-v1:[0-9a-f]{64}$/u);
    expect(result.value[0]?.consistencyVersion).toBe(result.value[1]?.consistencyVersion);
    expect(repo.getAcceptanceFacts).toHaveBeenCalledWith({ ownerId, mediaAssetIds: [firstMediaId, secondMediaId], intendedUse: "supporting-artifact" }, transaction);
  });

  it("fails closed when a fact is missing, duplicated, foreign, or malformed", async () => {
    const repositoryWithInvalidFacts = repository();
    vi.mocked(repositoryWithInvalidFacts.getAcceptanceFacts).mockResolvedValue(ok([{
      mediaAssetId: firstMediaId, ownerId, assetVersion: 0, accepted: true, safe: true, suitable: true,
      accessible: true, policyVersion: "image-webp-variants-v1",
    }]));
    const service = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: repositoryWithInvalidFacts });
    const result = await service.getAcceptanceFacts({ ownerId, mediaAssetIds: [firstMediaId, secondMediaId], intendedUse: "supporting-artifact" }, transaction);

    expect(result).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
  });

  it("rejects duplicate repository facts instead of selecting one arbitrarily", async () => {
    const duplicateRepository = repository();
    const duplicate = { mediaAssetId: firstMediaId, ownerId, assetVersion: 3, accepted: true, safe: true,
      suitable: true, accessible: true, policyVersion: "image-webp-variants-v1" };
    vi.mocked(duplicateRepository.getAcceptanceFacts).mockResolvedValue(ok([duplicate, duplicate]));
    const service = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: duplicateRepository });
    const result = await service.getAcceptanceFacts({ ownerId, mediaAssetIds: [firstMediaId], intendedUse: "supporting-artifact" }, transaction);

    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
  });

  it("rejects facts attributed to another Owner", async () => {
    const foreignRepository = repository();
    vi.mocked(foreignRepository.getAcceptanceFacts).mockResolvedValue(ok([{
      mediaAssetId: firstMediaId, ownerId: "0199a000-0000-7000-8000-000000000099" as StableId<"Owner">,
      assetVersion: 3, accepted: true, safe: true, suitable: true, accessible: true, policyVersion: "image-webp-variants-v1",
    }]));
    const service = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: foreignRepository });
    const result = await service.getAcceptanceFacts({ ownerId, mediaAssetIds: [firstMediaId], intendedUse: "supporting-artifact" }, transaction);

    expect(result).toMatchObject({ ok: false, error: { code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
  });
});
