import { beforeEach, describe, expect, it, vi } from "vitest";
import { ok, type ActorContext, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../src/runtime/ports.js";
import { createMediaRejectionApplicationService, type MediaRejectionRepositoryPort } from "../../src/modules/media/application/rejection.js";

const ownerId = "0199a000-0000-7000-8000-000000000001" as StableId<"Owner">;
const mediaId = "0199a000-0000-7000-8000-000000000002" as StableId<"MediaAsset">;
const transaction = { kind: "transaction" } satisfies TransactionContext;
const ownerActor: ActorContext = { kind: "owner", ownerId, sessionId: "session" };

function repository(): MediaRejectionRepositoryPort {
  return {
    reject: vi.fn(async () => ok({ aggregateId: mediaId, aggregateVersion: 4, outcome: "media-rejected" as const })),
  };
}

describe("Media rejection application seam (#157)", () => {
  let repo: MediaRejectionRepositoryPort;

  beforeEach(() => { repo = repository(); });

  it("requires the authenticated same-Owner actor before querying usage or persisting", async () => {
    const getUsage = vi.fn(async () => ok({ hasVisibleContentReference: false, isCurrentCv: false }));
    const service = createMediaRejectionApplicationService({ scope: { ownerId }, repository: repo, usage: { getUsage } });
    const result = await service.rejectOwnerMediaAsset({
      actor: { kind: "visitor", consent: "unknown" }, idempotencyKey: "reject-1" as never,
      expectedVersion: 3, mediaId, reason: "No longer needed",
    });

    expect(result).toMatchObject({ ok: false, error: { kind: "forbidden", code: "OWNER_REQUIRED" } });
    expect(getUsage).not.toHaveBeenCalled();
    expect(repo.reject).not.toHaveBeenCalled();
  });

  it.each(["", " \n ", "x".repeat(1001), "unsafe\u0000reason"])("rejects invalid private reason %j before repository access", async (reason) => {
    const getUsage = vi.fn(async () => ok({ hasVisibleContentReference: false, isCurrentCv: false }));
    const service = createMediaRejectionApplicationService({ scope: { ownerId }, repository: repo, usage: { getUsage } });
    const result = await service.rejectOwnerMediaAsset({ actor: ownerActor, idempotencyKey: "reject-2" as never,
      expectedVersion: 3, mediaId, reason });

    expect(result).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_REJECTION_INVALID" } });
    expect(getUsage).not.toHaveBeenCalled();
    expect(repo.reject).not.toHaveBeenCalled();
  });

  it("normalizes the private reason and passes a same-transaction usage check into the repository", async () => {
    const usage = { hasVisibleContentReference: false, isCurrentCv: false };
    const getUsage = vi.fn(async (_query, suppliedTransaction) => {
      expect(suppliedTransaction).toBe(transaction);
      return ok(usage);
    });
    vi.mocked(repo.reject).mockImplementation(async (input) => {
      const checked = await input.getUsage(transaction);
      expect(checked).toEqual({ ok: true, value: usage });
      return ok({ aggregateId: mediaId, aggregateVersion: 4, outcome: "media-rejected" });
    });
    const service = createMediaRejectionApplicationService({ scope: { ownerId }, repository: repo, usage: { getUsage } });
    const result = await service.rejectOwnerMediaAsset({ actor: ownerActor, idempotencyKey: "reject-3" as never,
      expectedVersion: 3, mediaId, reason: "  Duplicate upload  " });

    expect(result).toEqual({ ok: true, value: { aggregateId: mediaId, aggregateVersion: 4, outcome: "media-rejected" } });
    expect(repo.reject).toHaveBeenCalledWith(expect.objectContaining({ ownerId, mediaId, expectedVersion: 3,
      reason: "Duplicate upload", getUsage: expect.any(Function) }));
    expect(getUsage).toHaveBeenCalledWith({ ownerId, mediaAssetId: mediaId }, transaction);
  });
});
