import { describe, expect, it } from "vitest";
import {
  effectiveMediaProcessingLimits,
  MEDIA_PROCESSING_POLICY,
  type GetMediaAcceptanceFactsQuery,
  type MediaAcceptanceFact,
  type MediaDeliveryPurpose,
  type OwnerMediaApplicationService,
  type MediaProcessorPort,
  type MediaObjectStoragePort,
  type MediaReadApplicationService,
} from "../../src/modules/media/index.js";
import type {
  CvPortfolioRootView,
  CvPortfolioApplicationService,
  CvStoragePort,
  CvCurrentDeliveryPort,
  CurrentCvDownloadQuery,
  OwnerCvApplicationService,
} from "../../src/modules/cv-portfolio/index.js";
import type { TransactionContext } from "../../src/runtime/ports.js";

const mediaOwnerOperations = [
  "getOwnerMediaAggregate",
  "createOwnerMediaUploadIntent",
  "recordOwnerMediaProcessing",
  "acceptOwnerMediaAsset",
  "rejectOwnerMediaAsset",
] as const satisfies ReadonlyArray<keyof OwnerMediaApplicationService>;

const mediaReadOperations = [
  "getAcceptanceFacts",
  "getUsage",
  "resolveDelivery",
] as const satisfies ReadonlyArray<keyof MediaReadApplicationService>;

const cvOwnerOperations = [
  "getOwnerCvPortfolio",
  "registerOwnerCvVersion",
  "acceptOwnerCvVersion",
  "activateOwnerCvVersion",
] as const satisfies ReadonlyArray<keyof OwnerCvApplicationService>;

const cvPortfolioOperations = [
  "getOwnerCvPortfolio",
  "registerOwnerCvVersion",
  "acceptOwnerCvVersion",
  "activateOwnerCvVersion",
  "getRoot",
  "downloadCurrentCv",
] as const satisfies ReadonlyArray<keyof CvPortfolioApplicationService>;

const dispositionQuery: CurrentCvDownloadQuery = {
  actor: { kind: "visitor", consent: "unknown" },
  locale: "en",
  disposition: "attachment",
};

const initialRoot: CvPortfolioRootView = {
  aggregateVersion: 1,
  currentVersionId: null,
  registeredVersionCount: 0,
};

const acceptanceQuery: GetMediaAcceptanceFactsQuery = {
  ownerId: "owner" as GetMediaAcceptanceFactsQuery["ownerId"],
  mediaAssetIds: ["asset" as GetMediaAcceptanceFactsQuery["mediaAssetIds"][number]],
  intendedUse: "supporting-artifact",
};
const transaction = { kind: "transaction" } satisfies TransactionContext;
type AcceptanceFactTransaction = Parameters<MediaReadApplicationService["getAcceptanceFacts"]>[1];

const fact: MediaAcceptanceFact = {
  mediaAssetId: "asset" as MediaAcceptanceFact["mediaAssetId"],
  ownerId: acceptanceQuery.ownerId,
  assetVersion: 2,
  accepted: true,
  safe: true,
  suitable: true,
  accessible: true,
  consistencyVersion: "media-acceptance-v1:0000000000000000000000000000000000000000000000000000000000000000",
};

const deliveryPurpose: MediaDeliveryPurpose = "current-cv";
type ProcessorInput = Parameters<MediaProcessorPort["processAsset"]>[0];
type UploadResult = Awaited<ReturnType<MediaObjectStoragePort["generateUploadTarget"]>>;
type UploadTarget = Extract<UploadResult, { readonly ok: true }>["value"];
type CvDownload = Parameters<CvCurrentDeliveryPort["getDownloadTarget"]>[1];
const processorInput: ProcessorInput = {
  objectId: "object" as ProcessorInput["objectId"],
  kind: "image",
  detectedMimeType: "image/png",
  byteSize: 128,
  sha256: "0".repeat(64),
};
const uploadTarget: UploadTarget = {
  uploadUrl: "https://storage.example/upload",
  objectId: "object" as UploadTarget["objectId"],
  expiresAt: "2099-10-10T19:00:00.000Z",
};
const cvDownloadDisposition: CvDownload = "attachment";

describe("Media and CV module contracts (#147)", () => {
  it("retains the five Media, four Owner CV, and purpose-aware read operations", () => {
    expect(mediaOwnerOperations).toHaveLength(5);
    expect(mediaReadOperations).toHaveLength(3);
    expect(cvOwnerOperations).toHaveLength(4);
    expect(cvPortfolioOperations).toHaveLength(6);
    expect(dispositionQuery.disposition).toBe("attachment");
    expect(initialRoot.currentVersionId).toBeNull();
    expect(fact).toMatchObject({ accepted: true, safe: true, suitable: true, accessible: true });
    expect(transaction.kind satisfies AcceptanceFactTransaction["kind"]).toBe("transaction");
    expect(deliveryPurpose).toBe("current-cv");
    expect(processorInput.kind).toBe("image");
    expect(cvDownloadDisposition).toBe("attachment");
    expect(uploadTarget.objectId).toBe("object");
  });

  it("records the approved file policies and never widens adapter limits", () => {
    expect(MEDIA_PROCESSING_POLICY.allowedMimeTypes).toEqual({
      image: ["image/png", "image/jpeg", "image/webp"],
      video: ["video/mp4", "video/webm"],
      document: ["application/pdf"],
    });
    expect(MEDIA_PROCESSING_POLICY.maxBytesByKind).toEqual({
      image: 10 * 1024 * 1024,
      video: 50 * 1024 * 1024,
      document: 20 * 1024 * 1024,
    });
    expect(MEDIA_PROCESSING_POLICY.maxImagePixels).toBe(40_000_000);
    expect(MEDIA_PROCESSING_POLICY.maxVariants).toBe(8);
    expect(MEDIA_PROCESSING_POLICY.maxProcessingAttemptMs).toBe(60_000);

    expect(effectiveMediaProcessingLimits({
      maxBytesByKind: { image: 20_000_000, video: 25_000_000, document: 30_000_000 },
      maxImagePixels: 50_000_000,
      maxVariants: 12,
      maxProcessingAttemptMs: 90_000,
    })).toEqual({
      maxBytesByKind: { image: 10_485_760, video: 25_000_000, document: 20_971_520 },
      maxImagePixels: 40_000_000,
      maxVariants: 8,
      maxProcessingAttemptMs: 60_000,
    });
  });

});
