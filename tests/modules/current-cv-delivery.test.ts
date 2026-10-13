import { describe, expect, it, vi } from "vitest";
import { createCurrentCvDeliveryService } from "../../src/modules/cv-portfolio/index.js";
import type { CurrentCvSnapshot } from "../../src/modules/cv-portfolio/index.js";

const snapshotA: CurrentCvSnapshot = {
  portfolioId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80910" as never,
  mediaAssetId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80911" as never,
  objectId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80912" as never,
  sha256: "a".repeat(64), objectVersion: "a".repeat(64),
};
const snapshotB: CurrentCvSnapshot = {
  ...snapshotA, mediaAssetId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80913" as never,
  objectId: "018f0f3e-7b91-7cc2-a3b4-c5d6e7f80914" as never,
  sha256: "b".repeat(64), objectVersion: "b".repeat(64),
};
const visitor = { actor: { kind: "visitor" as const, consent: "unknown" as const }, locale: "en" as const,
  disposition: "inline" as const };

describe("Current CV application delivery", () => {
  it("resolves the committed current snapshot on every request and preserves disposition", async () => {
    let current = snapshotA;
    const readCurrent = vi.fn(async () => ({ ok: true as const, value: current }));
    const stream = vi.fn(async ({ snapshot }: { snapshot: CurrentCvSnapshot }) => ({
      ok: true as const, value: (async function* () { yield new TextEncoder().encode(snapshot.sha256); })(),
    }));
    const createDownloadTarget = vi.fn(async () => ({ ok: true as const,
      value: { url: "https://storage.example/current", expiresAt: new Date(Date.now() + 60_000).toISOString() } }));
    const service = createCurrentCvDeliveryService({ repository: { getCurrentCvSnapshot: readCurrent },
      storage: { stream, createDownloadTarget } });

    const first = await service.downloadCurrentCv(visitor);
    expect(first.ok && first.value.kind === "stream" && first.value.bytes).toBeDefined();
    current = snapshotB;
    const second = await service.downloadCurrentCv({ ...visitor, disposition: "attachment" });
    expect(second.ok && second.value.kind === "stream" && second.value.disposition).toBe("attachment");
    expect(readCurrent).toHaveBeenCalledTimes(2);
    expect(stream.mock.calls.map(([arg]) => arg.snapshot)).toEqual([snapshotA, snapshotB]);
    expect(createDownloadTarget).not.toHaveBeenCalled();
  });

  it("can use a signed redirect while retaining the requested disposition", async () => {
    const createDownloadTarget = vi.fn(async ({ disposition }: { disposition: string }) => ({
      ok: true as const, value: { url: `https://storage.example/cv?disposition=${disposition}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString() },
    }));
    const service = createCurrentCvDeliveryService({ repository: { async getCurrentCvSnapshot() {
      return { ok: true as const, value: snapshotA };
    } }, storage: { async stream() { throw new Error("redirect should not stream"); }, createDownloadTarget }, mode: "redirect" });
    const result = await service.downloadCurrentCv({ ...visitor, disposition: "attachment" });
    expect(result.ok && result.value.kind === "redirect" && result.value.disposition).toBe("attachment");
    expect(createDownloadTarget).toHaveBeenCalledWith({ snapshot: snapshotA, disposition: "attachment" });
  });

  it("returns no-current and dependency failures without fabricating a file", async () => {
    const notFound = createCurrentCvDeliveryService({ repository: { async getCurrentCvSnapshot() {
      return { ok: false as const, error: { kind: "not_found" as const, code: "CURRENT_CV_NOT_FOUND" } };
    } }, storage: { async stream() { throw new Error("no file expected"); }, async createDownloadTarget() { throw new Error("no target expected"); } } });
    const noCurrent = await notFound.downloadCurrentCv(visitor);
    expect(noCurrent).toMatchObject({ ok: false, error: { kind: "not_found" } });

    const storageFailure = createCurrentCvDeliveryService({ repository: { async getCurrentCvSnapshot() {
      return { ok: true as const, value: snapshotA };
    } }, storage: { async stream() { return { ok: false as const,
      error: { kind: "temporarily_unavailable" as const, code: "CURRENT_CV_STORAGE_UNAVAILABLE" } }; },
      async createDownloadTarget() { throw new Error("unused"); } } });
    expect(await storageFailure.downloadCurrentCv(visitor)).toMatchObject({ ok: false,
      error: { kind: "temporarily_unavailable" } });
  });
});
