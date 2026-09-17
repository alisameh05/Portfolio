import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  zAcceptOwnerMediaAssetBody,
  zAcceptOwnerMediaAssetHeaders,
  zAcceptOwnerCvVersionHeaders,
  zActivateOwnerCvVersionHeaders,
  zApproveOwnerFeedbackBody,
  zApproveOwnerFeedbackHeaders,
  zCvPortfolioView,
  zCreateOwnerMediaUploadIntentBody,
  zCreateOwnerMediaUploadIntentHeaders,
  zMediaAggregateView,
  zFeedbackModerationView,
  zRejectOwnerFeedbackBody,
  zRegisterOwnerCvVersionBody,
  zRegisterOwnerCvVersionHeaders,
  zSuppressOwnerFeedbackBody,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";

type ExampleOperation = {
  requestBody: {
    content: { "application/json": { examples: Record<string, { value: unknown }> } };
  };
};
const bundle = JSON.parse(
  readFileSync("openapi/generated/owner-v1.json", "utf8"),
) as { paths: Record<string, Record<string, ExampleOperation>> };
const requestExample = (path: string, method: string, name: string) =>
  bundle.paths[path]![method]!.requestBody.content["application/json"].examples[name]!.value;

const ids = {
  media: "01890f3e-7b2f-7cc0-98cf-5a2890378ef1",
  cvVersion: "01890f3e-7b2f-7cc0-98cf-5a2890378ef2",
  feedback: "01890f3e-7b2f-7cc0-98cf-5a2890378ef3",
  priorCvVersion: "01890f3e-7b2f-7cc0-98cf-5a2890378ef4",
};

describe("generated Owner Media validators", () => {
  it("accepts declared upload and acceptance examples", () => {
    expect(zCreateOwnerMediaUploadIntentBody.safeParse(requestExample(
      "/api/owner/v1/media/upload-intents", "post", "projectImage",
    )).success).toBe(true);
    expect(zAcceptOwnerMediaAssetBody.safeParse(requestExample(
      "/api/owner/v1/media/{mediaId}/commands/accept", "post", "describedImage",
    )).success).toBe(true);
  });

  it("distinguishes creation from existing-aggregate concurrency", () => {
    expect(zCreateOwnerMediaUploadIntentHeaders.safeParse({
      "Idempotency-Key": "media-upload-1",
    }).success).toBe(true);
    expect(zCreateOwnerMediaUploadIntentHeaders.safeParse({
      "Idempotency-Key": "media-upload-1",
      "If-Match": '"1"',
    }).success).toBe(false);
    expect(zAcceptOwnerMediaAssetHeaders.safeParse({
      "Idempotency-Key": "media-accept-1",
      "If-Match": '"2"',
    }).success).toBe(true);
    expect(zAcceptOwnerMediaAssetHeaders.safeParse({
      "Idempotency-Key": "media-accept-1",
    }).success).toBe(false);
  });

  it("keeps Media commands and history closed and provider-neutral", () => {
    expect(zCreateOwnerMediaUploadIntentBody.safeParse({
      kind: "image",
      originalFileName: "portfolio-result.png",
      declaredMediaType: "image/png",
      byteLength: 204800,
      sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      storageBucket: "public-assets",
    }).success).toBe(false);
    expect(zAcceptOwnerMediaAssetBody.safeParse({
      accessibilityMetadata: {
        kind: "described-image",
        altText: "Dashboard showing the validated portfolio result.",
        providerKey: "object-123",
      },
    }).success).toBe(false);
    expect(zMediaAggregateView.safeParse({
      mediaId: ids.media,
      aggregateVersion: 3,
      kind: "image",
      originalFileName: "portfolio-result.png",
      declaredMediaType: "image/png",
      byteLength: 204800,
      state: "accepted",
      processingHistory: [
        {
          result: "failed",
          detectedMediaType: "application/octet-stream",
          detectedByteLength: 204800,
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          findings: ["Declared and detected media types differ."],
          recordedAt: "2026-09-17T17:55:00Z",
        },
        {
          result: "passed",
          detectedMediaType: "image/png",
          detectedByteLength: 204800,
          sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          findings: [],
          recordedAt: "2026-09-17T18:00:00Z",
        },
      ],
      decisionHistory: [{ decision: "accepted", decidedAt: "2026-09-17T18:05:00Z" }],
    }).success).toBe(true);
    expect(zMediaAggregateView.safeParse({
      mediaId: ids.media,
      aggregateVersion: 3,
      kind: "image",
      originalFileName: "portfolio-result.png",
      declaredMediaType: "image/png",
      byteLength: 204800,
      state: "accepted",
      processingHistory: [],
      decisionHistory: [],
      supabaseObjectKey: "media/private/object",
    }).success).toBe(false);
  });
});

describe("generated Owner Feedback moderation validators", () => {
  it("requires a closed auditable reason for every decision", () => {
    expect(zApproveOwnerFeedbackBody.safeParse({ reason: "Constructive and relevant." }).success).toBe(true);
    expect(zRejectOwnerFeedbackBody.safeParse({ reason: "Contains private contact details." }).success).toBe(true);
    expect(zSuppressOwnerFeedbackBody.safeParse({ reason: "Permission was withdrawn." }).success).toBe(true);
    expect(zApproveOwnerFeedbackBody.safeParse({}).success).toBe(false);
    expect(zRejectOwnerFeedbackBody.safeParse({
      reason: "Contains private contact details.",
      moderatorUserId: "provider-user-123",
    }).success).toBe(false);
  });

  it("requires idempotency and optimistic concurrency for moderation", () => {
    expect(zApproveOwnerFeedbackHeaders.safeParse({
      "Idempotency-Key": "feedback-approve-1",
      "If-Match": '"1"',
    }).success).toBe(true);
    expect(zApproveOwnerFeedbackHeaders.safeParse({
      "Idempotency-Key": "feedback-approve-1",
    }).success).toBe(false);
  });

  it("retains Feedback decision history without provider or deletion fields", () => {
    expect(zFeedbackModerationView.safeParse({
      feedbackId: ids.feedback,
      aggregateVersion: 3,
      state: "suppressed",
      authorName: "Portfolio visitor",
      paragraph: "Clear evidence and useful implementation detail.",
      submittedAt: "2026-09-17T18:00:00Z",
      decisionHistory: [
        {
          decision: "approved",
          reason: "Constructive and relevant.",
          decidedAt: "2026-09-17T18:05:00Z",
        },
        {
          decision: "suppressed",
          reason: "Permission was withdrawn.",
          decidedAt: "2026-09-17T19:05:00Z",
        },
      ],
    }).success).toBe(true);
    expect(zFeedbackModerationView.safeParse({
      feedbackId: ids.feedback,
      aggregateVersion: 3,
      state: "deleted",
      authorName: "Portfolio visitor",
      paragraph: "Clear evidence and useful implementation detail.",
      submittedAt: "2026-09-17T18:00:00Z",
      decisionHistory: [],
    }).success).toBe(false);
    expect(zFeedbackModerationView.safeParse({
      feedbackId: ids.feedback,
      aggregateVersion: 3,
      state: "pending",
      authorName: "Portfolio visitor",
      paragraph: "Clear evidence and useful implementation detail.",
      submittedAt: "2026-09-17T18:00:00Z",
      decisionHistory: [],
      supabaseUserId: "provider-user-123",
    }).success).toBe(false);
  });
});

describe("generated Owner CV Portfolio validators", () => {
  it("accepts the declared English CV registration example", () => {
    expect(zRegisterOwnerCvVersionBody.safeParse(requestExample(
      "/api/owner/v1/cv/versions", "post", "englishCv",
    )).success).toBe(true);
  });

  it("requires concurrency for every CV Portfolio mutation", () => {
    expect(zRegisterOwnerCvVersionHeaders.safeParse({
      "Idempotency-Key": "cv-register-1",
      "If-Match": '"1"',
    }).success).toBe(true);
    expect(zRegisterOwnerCvVersionHeaders.safeParse({
      "Idempotency-Key": "cv-register-1",
    }).success).toBe(false);
    expect(zAcceptOwnerCvVersionHeaders.safeParse({
      "Idempotency-Key": "cv-accept-1",
      "If-Match": '"2"',
    }).success).toBe(true);
    expect(zActivateOwnerCvVersionHeaders.safeParse({
      "Idempotency-Key": "cv-activate-1",
      "If-Match": '"3"',
    }).success).toBe(true);
  });

  it("models one English Current CV pointer while retaining version history", () => {
    expect(zRegisterOwnerCvVersionBody.safeParse({
      mediaId: ids.media,
      locale: "ar",
      label: "Arabic CV",
    }).success).toBe(false);
    expect(zRegisterOwnerCvVersionBody.safeParse({
      mediaId: ids.media,
      locale: "en",
      label: "CV September 2026",
      storageObjectKey: "cv/object.pdf",
    }).success).toBe(false);
    expect(zCvPortfolioView.safeParse({
      aggregateVersion: 4,
      currentVersionId: ids.cvVersion,
      versions: [
        {
          versionId: ids.priorCvVersion,
          mediaId: ids.media,
          locale: "en",
          label: "CV August 2026",
          state: "accepted",
          isCurrent: false,
        },
        {
          versionId: ids.cvVersion,
          mediaId: ids.media,
          locale: "en",
          label: "CV September 2026",
          state: "accepted",
          isCurrent: true,
        },
      ],
      activationHistory: [
        { versionId: ids.priorCvVersion, activatedAt: "2026-08-01T10:00:00Z" },
        { versionId: ids.cvVersion, activatedAt: "2026-09-01T10:00:00Z" },
      ],
    }).success).toBe(true);
    expect(zCvPortfolioView.safeParse({
      aggregateVersion: 4,
      currentVersionId: ids.cvVersion,
      versions: [{
        versionId: ids.cvVersion,
        mediaId: ids.media,
        locale: "en",
        label: "CV September 2026",
        state: "accepted",
        isCurrent: true,
        supabaseBucket: "cv",
      }],
      activationHistory: [],
    }).success).toBe(false);
  });
});
