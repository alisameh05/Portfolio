import { describe, expect, it } from "vitest";
import {
  createMediaDeliveryApplicationService,
  type MediaDeliveryCandidate,
} from "../../src/modules/media/index.js";
import { unsafeStableId } from "../../src/shared/domain/index.js";
import { isTransactionRollback, type TransactionContext, type TransactionRollback, type TransactionRunner } from "../../src/runtime/ports.js";

const ownerId = unsafeStableId<"Owner">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0");
const mediaAssetId = unsafeStableId<"MediaAsset">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1");
const objectId = unsafeStableId<"MediaObject">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec2");
const query = { mediaAssetId, purpose: "project" as const, locale: "ar" as const };
const candidate: MediaDeliveryCandidate = {
  mediaAssetId,
  ownerId,
  assetVersion: 3,
  accessibility: { nonVisualDescription: "Project demonstration", isDecorative: false },
  variants: [{ objectId, name: "display", mimeType: "image/webp", byteLength: 512,
    sha256: "a".repeat(64), objectVersion: "a".repeat(64), width: 320, height: 240 }],
};

function transactions(): TransactionRunner {
  return { async run<T>(operation: (context: TransactionContext) => T | TransactionRollback<T> | Promise<T | TransactionRollback<T>>) {
    const result = await operation({ kind: "transaction" });
    return isTransactionRollback(result) ? result.value : result;
  } };
}

describe("Media delivery application service", () => {
  it("does not sign Media when its requested-locale public use is no longer visible", async () => {
    let repositoryReads = 0;
    let signingCalls = 0;
    const service = createMediaDeliveryApplicationService({
      ownerId,
      transactions: transactions(),
      use: { async isCurrentlyUsed() { return { ok: true, value: false }; } },
      repository: {
        async getEligibleDeliveryCandidate() { repositoryReads += 1; return { ok: true, value: candidate }; },
      },
      storage: {
        async createSignedDeliveryTarget() {
          signingCalls += 1;
          return { ok: true, value: { url: "http://127.0.0.1:54321/storage/v1/object/sign/media-processed/x?token=secret", expiresAt: "2026-10-13T12:05:00.000Z" } };
        },
      },
      now: () => Date.parse("2026-10-13T12:00:00.000Z"),
    });

    const result = await service.resolveDelivery(query);

    expect(result).toMatchObject({ ok: false, error: { kind: "not_found", code: "MEDIA_DELIVERY_NOT_VISIBLE" } });
    expect(repositoryReads).toBe(0);
    expect(signingCalls).toBe(0);
  });

  it("returns stable accepted descriptors with only expiring delivery capabilities", async () => {
    const signed = "http://127.0.0.1:54321/storage/v1/object/sign/media-processed/x?token=secret";
    const expiresAt = "2026-10-13T12:05:00.000Z";
    const service = createMediaDeliveryApplicationService({
      ownerId,
      transactions: transactions(),
      use: { async isCurrentlyUsed(received, context) {
        expect(received).toEqual(query);
        expect(context.kind).toBe("transaction");
        return { ok: true, value: true };
      } },
      repository: { async getEligibleDeliveryCandidate(received) {
        expect(received).toMatchObject({ mediaAssetId, ownerId, purpose: "project", locale: "ar" });
        return { ok: true, value: candidate };
      } },
      storage: { async createSignedDeliveryTarget(input) {
        expect(input).toMatchObject({ mediaAssetId, purpose: "project", locale: "ar", variant: { objectId, name: "display" } });
        return { ok: true, value: { url: signed, expiresAt } };
      } },
      now: () => Date.parse("2026-10-13T12:00:00.000Z"),
    });

    const result = await service.resolveDelivery(query);

    expect(result).toEqual({ ok: true, value: {
      mediaAssetId,
      purpose: "project",
      locale: "ar",
      variants: [{ objectId, name: "display", mimeType: "image/webp", byteLength: 512,
        width: 320, height: 240, url: signed, expiresAt }],
      accessibility: candidate.accessibility,
    } });
    expect(JSON.stringify(result)).not.toContain("portfolio-result.png");
  });

  it("discards signed targets if the approved public use is withdrawn during signing", async () => {
    let useReads = 0;
    let signingCalls = 0;
    const service = createMediaDeliveryApplicationService({
      ownerId,
      transactions: transactions(),
      use: { async isCurrentlyUsed() {
        useReads += 1;
        return { ok: true, value: useReads === 1 };
      } },
      repository: { async getEligibleDeliveryCandidate() { return { ok: true, value: candidate }; } },
      storage: { async createSignedDeliveryTarget() {
        signingCalls += 1;
        return { ok: true, value: {
          url: "http://127.0.0.1:54321/storage/v1/object/sign/media-processed/x?token=opaque",
          expiresAt: "2026-10-13T12:05:00.000Z",
        } };
      } },
      now: () => Date.parse("2026-10-13T12:00:00.000Z"),
    });

    const result = await service.resolveDelivery(query);

    expect(result).toMatchObject({ ok: false, error: { kind: "not_found", code: "MEDIA_DELIVERY_NOT_VISIBLE" } });
    expect(useReads).toBe(2);
    expect(signingCalls).toBe(1);
  });

  it("discards signed targets if the accepted Media snapshot changes during signing", async () => {
    let candidateReads = 0;
    const changedCandidate = { ...candidate, assetVersion: candidate.assetVersion + 1 };
    const service = createMediaDeliveryApplicationService({
      ownerId,
      transactions: transactions(),
      use: { async isCurrentlyUsed() { return { ok: true, value: true }; } },
      repository: { async getEligibleDeliveryCandidate() {
        candidateReads += 1;
        return { ok: true, value: candidateReads === 1 ? candidate : changedCandidate };
      } },
      storage: { async createSignedDeliveryTarget() {
        return { ok: true, value: {
          url: "http://127.0.0.1:54321/storage/v1/object/sign/media-processed/x?token=opaque",
          expiresAt: "2026-10-13T12:05:00.000Z",
        } };
      } },
      now: () => Date.parse("2026-10-13T12:00:00.000Z"),
    });

    const result = await service.resolveDelivery(query);

    expect(result).toMatchObject({ ok: false, error: { kind: "not_found", code: "MEDIA_DELIVERY_NOT_VISIBLE" } });
    expect(candidateReads).toBe(2);
  });

  it("does not return a capability when the visible use resolves to foreign or unaccepted Media", async () => {
    let signingCalls = 0;
    const service = createMediaDeliveryApplicationService({
      ownerId,
      transactions: transactions(),
      use: { async isCurrentlyUsed() { return { ok: true, value: true }; } },
      repository: { async getEligibleDeliveryCandidate() {
        return { ok: false, error: { kind: "not_found", code: "MEDIA_DELIVERY_NOT_VISIBLE" } };
      } },
      storage: { async createSignedDeliveryTarget() {
        signingCalls += 1;
        return { ok: true, value: {
          url: "http://127.0.0.1:54321/storage/v1/object/sign/media-processed/x?token=opaque",
          expiresAt: "2026-10-13T12:05:00.000Z",
        } };
      } },
      now: () => Date.parse("2026-10-13T12:00:00.000Z"),
    });

    const result = await service.resolveDelivery(query);

    expect(result).toMatchObject({ ok: false, error: { kind: "not_found", code: "MEDIA_DELIVERY_NOT_VISIBLE" } });
    expect(signingCalls).toBe(0);
  });
});
