import { createHash } from "node:crypto";
import type { Client } from "pg";
import { createStableId, type StableId } from "../../src/shared/domain/index.js";
export async function seedAcceptedMedia(admin: Client, input: { readonly mediaId: StableId<"MediaAsset">; readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }) {
  const uploadIntentId = createStableId("MediaUploadIntent");
  const sourceObjectId = createStableId("MediaObject");
  const outputObjectId = createStableId("MediaObject");
  const attemptId = createStableId("MediaProcessingAttempt");
  const decisionId = createStableId("MediaDecision");
  const originalBytes = new TextEncoder().encode(`synthetic source PDF ${input.mediaId}`);
  const outputBytes = new TextEncoder().encode(`synthetic accepted PDF ${input.mediaId}`);
  const originalDigest = createHash("sha256").update(originalBytes).digest("hex");
  const outputDigest = createHash("sha256").update(outputBytes).digest("hex");
  const acceptedAt = "2026-10-20T10:00:00.000Z";
  await admin.query(`insert into media.assets
      (media_id, portfolio_id, owner_id, kind, original_file_name, declared_media_type, declared_byte_length, declared_sha256)
    values ($1, $2, $3, 'document', 'synthetic-cv.pdf', 'application/pdf', $4, $5)`,
  [input.mediaId, input.portfolioId, input.ownerId, originalBytes.byteLength, originalDigest]);
  await admin.query(`insert into media.upload_intents
      (upload_intent_id, media_id, media_object_id, portfolio_id, owner_id, expires_at)
    values ($1, $2, $3, $4, $5, '2099-01-01T00:00:00Z')`,
  [uploadIntentId, input.mediaId, sourceObjectId, input.portfolioId, input.ownerId]);
  await admin.query(`insert into media.processed_objects
      (object_id, portfolio_id, owner_id, media_id, source_object_id, sha256, byte_length, mime_type, object_version)
    values ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', $6),
           ($5, $2, $3, $4, $5, $8, $9, 'application/pdf', $8)`,
  [outputObjectId, input.portfolioId, input.ownerId, input.mediaId, sourceObjectId, outputDigest, outputBytes.byteLength,
    originalDigest, originalBytes.byteLength]);
  await admin.query(`insert into media.processing_attempts
      (attempt_id, portfolio_id, owner_id, media_id, input_object_id, input_sha256, detected_mime_type,
       detected_byte_length, result, output_object_id, output_sha256, scanner_version, processor_version,
       policy_version, finding_codes, started_at, finished_at)
    values ($1, $2, $3, $4, $5, $6, 'application/pdf', $7, 'passed', $8, $9,
      'fixture-scanner-v1', 'fixture-processor-v1', 'pdf-active-content-deny-1', '[]'::jsonb, $10, $10)`,
  [attemptId, input.portfolioId, input.ownerId, input.mediaId, sourceObjectId, originalDigest,
    originalBytes.byteLength, outputObjectId, outputDigest, acceptedAt]);
  await admin.query(`insert into media.processing_states
      (media_id, portfolio_id, owner_id, aggregate_version, latest_attempt_id) values ($1, $2, $3, 3, $4)`,
  [input.mediaId, input.portfolioId, input.ownerId, attemptId]);
  await admin.query(`insert into media.decision_history
      (decision_id, portfolio_id, owner_id, media_id, aggregate_version, decision, processing_attempt_id,
       input_object_id, input_sha256, detected_mime_type, detected_byte_length, scanner_version,
       processor_version, processing_policy_version, sealed_outputs, accessibility, ownership_attested_by,
       ownership_attested_at, public_suitability_attested_by, public_suitability_attested_at, decided_by, decided_at)
    values ($1, $2, $3, $4, 3, 'accepted', $5, $6, $7, 'application/pdf', $8,
      'fixture-scanner-v1', 'fixture-processor-v1', 'pdf-active-content-deny-1', $9::jsonb,
      '{"kind":"document","summary":"Synthetic CV PDF."}'::jsonb, $3, $10, $3, $10, $3, $10)`,
  [decisionId, input.portfolioId, input.ownerId, input.mediaId, attemptId, sourceObjectId, originalDigest,
    originalBytes.byteLength, JSON.stringify([{ objectId: outputObjectId, sha256: outputDigest, byteLength: outputBytes.byteLength,
      mimeType: "application/pdf", objectVersion: outputDigest, variantName: "document" }]), acceptedAt]);
  return { mediaId: input.mediaId, mediaAssetVersion: 3, mediaDecisionId: decisionId,
    mediaObjectId: outputObjectId, sha256: outputDigest, objectVersion: outputDigest };
}
