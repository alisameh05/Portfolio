import { describe, expect, it, vi } from "vitest";
import { createOwnerCvApplicationService, type CvPortfolioRepositoryPort } from "../../src/modules/cv-portfolio/index.js";
import type { RegisterOwnerCvVersionApplicationCommand } from "../../src/modules/cv-portfolio/index.js";
import type { StableId } from "../../src/shared/domain/index.js";

const ownerId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1" as StableId<"Owner">;
const mediaId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0" as StableId<"MediaAsset">;
const versionId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ed1" as StableId<"CvVersion">;
const command: RegisterOwnerCvVersionApplicationCommand = {
  actor: { kind: "owner", ownerId, sessionId: "session" },
  idempotencyKey: "register-cv-once" as never,
  expectedVersion: 1,
  mediaId,
  locale: "en",
  label: " CV September 2026 ",
};

function repository(): CvPortfolioRepositoryPort {
  return {
    getOwnerCvPortfolio: vi.fn(async () => ({
      ok: true as const,
      value: { aggregateVersion: 1, currentVersionId: null, versions: [], activationHistory: [] },
    })),
    registerOwnerCvVersion: vi.fn(async (input) => ({
      ok: true as const,
      value: { versionId: input.versionId, aggregateVersion: input.expectedVersion + 1, outcome: "cv-version-registered" as const },
    })),
  };
}

describe("Owner CV registration application service (#154)", () => {
  it("trims the label and delegates a portfolio-versioned, idempotent registration", async () => {
    const persistence = repository();
    const service = createOwnerCvApplicationService({ ownerId, repository: persistence });

    const result = await service.registerOwnerCvVersion(command);

    expect(result).toMatchObject({
      ok: true,
      value: { aggregateVersion: 2, outcome: "cv-version-registered" },
    });
    expect(persistence.registerOwnerCvVersion).toHaveBeenCalledWith(expect.objectContaining({
      ownerId,
      expectedVersion: 1,
      mediaId,
      locale: "en",
      label: "CV September 2026",
      idempotencyKey: command.idempotencyKey,
      versionId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
    }));
  });

  it("rejects other Owners before either history reads or writes", async () => {
    const persistence = repository();
    const service = createOwnerCvApplicationService({ ownerId, repository: persistence });

    const result = await service.getOwnerCvPortfolio({ actor: { kind: "owner", ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec2" as StableId<"Owner">, sessionId: "foreign" } });

    expect(result).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(persistence.getOwnerCvPortfolio).not.toHaveBeenCalled();
  });

  it.each([
    { ...command, expectedVersion: 0 },
    { ...command, label: " " },
    { ...command, label: "bad\u0000label" },
    { ...command, label: "x".repeat(121) },
    { ...command, locale: "ar" as "en" },
  ])("rejects malformed registration intent before persistence", async (invalid) => {
    const persistence = repository();
    const service = createOwnerCvApplicationService({ ownerId, repository: persistence });

    const result = await service.registerOwnerCvVersion(invalid);

    expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(persistence.registerOwnerCvVersion).not.toHaveBeenCalled();
  });

  it("returns the initially empty portfolio without changing its root version", async () => {
    const persistence = repository();
    const service = createOwnerCvApplicationService({ ownerId, repository: persistence });

    const result = await service.getOwnerCvPortfolio({ actor: command.actor });

    expect(result).toMatchObject({
      ok: true,
      value: { aggregateVersion: 1, currentVersionId: null, versions: [], activationHistory: [] },
    });
  });
});
