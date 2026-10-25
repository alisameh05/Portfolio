import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Client } from "pg";
import { ok } from "@shared/domain";

import { createPostgresOwnerCvExportSnapshotReader } from "../../src/modules/cv-portfolio/adapters/postgres-owner-export-snapshot.js";
import type { OwnerCvExportSnapshotReaderPort } from "../../src/modules/cv-portfolio/application/owner-export-snapshot.js";
import { createPostgresOwnerMediaExportSnapshotReader } from "../../src/modules/media/adapters/postgres-owner-export-snapshot.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId } from "../../src/shared/domain/index.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/domain/index.js";
import type { TransactionContext } from "../../src/runtime/ports.js";

const WORKER_URL = process.env["PHASE8_OWNER_EXPORT_WORKER_URL"];
const APPLICATION_URL = process.env["PHASE8_OWNER_EXPORT_APPLICATION_URL"];
const ADMIN_URL = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const portfolioId = createStableId("Portfolio");
const ownerId = createStableId("Owner");
const scope = { portfolioId, ownerId };

const settings: PortfolioSettings = {
  portfolioId,
  version: 1,
  profile: { displayName: "CV Export", headline: "Private owner profile", bio: "CV export RLS fixture." },
  contactChannels: [],
  globalCta: { label: "Contact", destination: "https://example.test/contact", unavailableFallback: "Email" },
};
const acceptedDocumentBytes = new TextEncoder().encode("synthetic accepted CV PDF bytes");
const acceptedDocumentDigest = createHash("sha256").update(acceptedDocumentBytes).digest("hex");

let admin: Client | undefined;
let worker: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let application: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
let lifecycleStep = "initialization";

async function seedAcceptedMedia(input: { readonly mediaId: string; readonly portfolioId: string; readonly ownerId: string }) {
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
  await admin!.query(`insert into media.assets
      (media_id, portfolio_id, owner_id, kind, original_file_name, declared_media_type, declared_byte_length, declared_sha256)
    values ($1, $2, $3, 'document', 'synthetic-cv.pdf', 'application/pdf', $4, $5)`,
  [input.mediaId, input.portfolioId, input.ownerId, originalBytes.byteLength, originalDigest]);
  await admin!.query(`insert into media.upload_intents
      (upload_intent_id, media_id, media_object_id, portfolio_id, owner_id, expires_at)
    values ($1, $2, $3, $4, $5, '2099-01-01T00:00:00Z')`,
  [uploadIntentId, input.mediaId, sourceObjectId, input.portfolioId, input.ownerId]);
  await admin!.query(`insert into media.processed_objects
      (object_id, portfolio_id, owner_id, media_id, source_object_id, sha256, byte_length, mime_type, object_version)
    values ($1, $2, $3, $4, $5, $6, $7, 'application/pdf', $6),
           ($5, $2, $3, $4, $5, $8, $9, 'application/pdf', $8)`,
  [outputObjectId, input.portfolioId, input.ownerId, input.mediaId, sourceObjectId, outputDigest, outputBytes.byteLength,
    originalDigest, originalBytes.byteLength]);
  await admin!.query(`insert into media.processing_attempts
      (attempt_id, portfolio_id, owner_id, media_id, input_object_id, input_sha256, detected_mime_type,
       detected_byte_length, result, output_object_id, output_sha256, scanner_version, processor_version,
       policy_version, finding_codes, started_at, finished_at)
    values ($1, $2, $3, $4, $5, $6, 'application/pdf', $7, 'passed', $8, $9,
      'fixture-scanner-v1', 'fixture-processor-v1', 'pdf-active-content-deny-1', '[]'::jsonb, $10, $10)`,
  [attemptId, input.portfolioId, input.ownerId, input.mediaId, sourceObjectId, originalDigest,
    originalBytes.byteLength, outputObjectId, outputDigest, acceptedAt]);
  await admin!.query(`insert into media.processing_states
      (media_id, portfolio_id, owner_id, aggregate_version, latest_attempt_id) values ($1, $2, $3, 3, $4)`,
  [input.mediaId, input.portfolioId, input.ownerId, attemptId]);
  await admin!.query(`insert into media.decision_history
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

describe.runIf(Boolean(WORKER_URL && APPLICATION_URL && ADMIN_URL))("Issue #244 CV export PostgreSQL permissions", () => {
  beforeAll(async () => {
    try {
      if (ADMIN_URL === undefined || WORKER_URL === undefined || APPLICATION_URL === undefined) throw new Error("PHASE8_OWNER_EXPORT_DATABASE_REQUIRED");
      admin = new Client({ connectionString: ADMIN_URL });
      await admin.connect();
      worker = createPostgresRuntimeDatabase(WORKER_URL);
      application = createPostgresRuntimeDatabase(APPLICATION_URL);
      const repository = createPostgresPortfolioSettingsRepository();
      lifecycleStep = "worker-settings-read";
      const configured = await worker.transactions.run((context) => repository.getSettings(scope, context));
      if (!configured.ok) {
        lifecycleStep = "application-settings-provision";
        const provisioned = await application.transactions.run((context) => repository.provisionSettings(scope, settings, context));
        if (!provisioned.ok) throw new Error("PHASE8_CV_EXPORT_SETTINGS_REQUIRED");
      }
      lifecycleStep = "create-cv-portfolio-root";
      await admin.query("insert into cv_portfolio.portfolios (portfolio_id, owner_id, aggregate_version) values ($1, $2, 1)",
        [portfolioId, ownerId]);
      lifecycleStep = "ready";
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
        ? error.code : "unknown";
      throw new Error(`PHASE8_CV_EXPORT_POSTGRES_${lifecycleStep.toUpperCase().replaceAll("-", "_")}_FAILED:${code}`);
    }
  });

  afterAll(async () => {
    try {
      lifecycleStep = "cleanup-begin";
      await admin?.query("begin");
      try {
        lifecycleStep = "cleanup-activation-history";
        await admin?.query("delete from cv_portfolio.activation_history where portfolio_id = $1", [portfolioId]);
        lifecycleStep = "cleanup-acceptance-history";
        await admin?.query("delete from cv_portfolio.acceptance_history where portfolio_id = $1", [portfolioId]);
        lifecycleStep = "cleanup-cv-versions";
        await admin?.query("delete from cv_portfolio.versions where portfolio_id = $1", [portfolioId]);
        lifecycleStep = "cleanup-cv-portfolio";
        await admin?.query("delete from cv_portfolio.portfolios where portfolio_id = $1", [portfolioId]);
        lifecycleStep = "cleanup-cv-commit";
        await admin?.query("commit");
      } catch (error) {
        await admin?.query("rollback");
        throw error;
      }
      lifecycleStep = "cleanup-media-rejections";
      await admin?.query("delete from media.rejection_history where owner_id = $1", [ownerId]);
      lifecycleStep = "cleanup-media-decisions";
      await admin?.query("delete from media.decision_history where owner_id = $1", [ownerId]);
      lifecycleStep = "cleanup-media-states";
      await admin?.query("delete from media.processing_states where owner_id = $1", [ownerId]);
      lifecycleStep = "cleanup-media-attempts";
      await admin?.query("delete from media.processing_attempts where owner_id = $1", [ownerId]);
      lifecycleStep = "cleanup-media-objects";
      await admin?.query("delete from media.processed_objects where owner_id = $1", [ownerId]);
      lifecycleStep = "cleanup-media-upload-intents";
      await admin?.query("delete from media.upload_intents where owner_id = $1", [ownerId]);
      lifecycleStep = "cleanup-media-assets";
      await admin?.query("delete from media.assets where owner_id = $1", [ownerId]);
      lifecycleStep = "cleanup-settings";
      await admin?.query("delete from portfolio_config.settings where portfolio_id = $1", [portfolioId]);
      lifecycleStep = "cleanup-complete";
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z0-9]{5}$/.test(error.code)
        ? error.code : "unknown";
      throw new Error(`PHASE8_CV_EXPORT_POSTGRES_${lifecycleStep.toUpperCase().replaceAll("-", "_")}_FAILED:${code}`);
    } finally {
      await worker?.resource.close();
      await application?.resource.close();
      await admin?.end();
    }
  });

  it("reads only the scoped CV projection and denies unrelated purpose, private columns, writes, and anonymous access", async () => {
    const reader = createPostgresOwnerCvExportSnapshotReader();
    const captured = await worker!.transactions.run((context) => reader.readOwnerCvExportSnapshot(scope, context),
      { isolationLevel: "repeatable read" });
    expect(captured).toMatchObject({ ok: true, value: { currentVersionId: null, versions: [], acceptanceHistory: [], activationHistory: [] } });

    const restricted = new Client({ connectionString: WORKER_URL });
    await restricted.connect();
    try {
      await restricted.query("select set_config('shipwithali.portfolio_id', $1, false), set_config('shipwithali.owner_id', $2, false), set_config('shipwithali.worker_purpose', 'cv.owner-export', false)", [portfolioId, ownerId]);
      const scoped = await restricted.query("select current_version_id from cv_portfolio.portfolios where portfolio_id = $1", [portfolioId]);
      expect(scoped.rows).toHaveLength(1);
      await expect(restricted.query("select accepted_by from cv_portfolio.acceptance_history where portfolio_id = $1", [portfolioId]))
        .rejects.toMatchObject({ code: "42501" });
      await expect(restricted.query("update cv_portfolio.portfolios set aggregate_version = 2 where portfolio_id = $1", [portfolioId]))
        .rejects.toMatchObject({ code: "42501" });
      await restricted.query("select set_config('shipwithali.worker_purpose', 'cv.activation', false)");
      const wrongPurpose = await restricted.query("select current_version_id from cv_portfolio.portfolios where portfolio_id = $1", [portfolioId]);
      expect(wrongPurpose.rows).toHaveLength(0);
    } finally {
      await restricted.end();
    }

    await admin!.query("set role anon");
    try {
      await expect(admin!.query("select current_version_id from cv_portfolio.portfolios where portfolio_id = $1", [portfolioId]))
        .rejects.toMatchObject({ code: "42501" });
    } finally {
      await admin!.query("reset role");
    }
  });

  it("preserves accepted versions without Current and rejects an activation/withdrawal race", async () => {
    const firstMediaId = createStableId("MediaAsset");
    const secondMediaId = createStableId("MediaAsset");
    const firstMedia = await seedAcceptedMedia({ mediaId: firstMediaId, portfolioId, ownerId });
    const secondMedia = await seedAcceptedMedia({ mediaId: secondMediaId, portfolioId, ownerId });
    const firstVersionId = createStableId("CvVersion");
    const secondVersionId = createStableId("CvVersion");
    const firstApprovalId = createStableId("CvAcceptance");
    const secondApprovalId = createStableId("CvAcceptance");
    const firstActivationId = createStableId("CvActivation");
    const secondActivationId = createStableId("CvActivation");
    const firstAcceptedAt = "2026-10-18T10:00:00.000Z";
    const secondAcceptedAt = "2026-10-19T10:00:00.000Z";
    await admin!.query("begin");
    try {
      await admin!.query(`insert into cv_portfolio.versions
          (version_id, portfolio_id, owner_id, media_id, media_asset_version, media_decision_id, media_object_id,
           media_sha256, media_object_version, version_number, locale, label, state, registered_at, is_current)
        values ($1, $3, $4, $5, 3, $6, $7, $8, $9, 1, 'en', 'Former CV', 'accepted', '2026-10-17T10:00:00Z', false),
               ($2, $3, $4, $10, 3, $11, $12, $13, $14, 2, 'en', 'Current CV', 'accepted', '2026-10-18T10:00:00Z', false)`,
      [firstVersionId, secondVersionId, portfolioId, ownerId,
        firstMedia.mediaId, firstMedia.mediaDecisionId, firstMedia.mediaObjectId, firstMedia.sha256, firstMedia.objectVersion,
        secondMedia.mediaId, secondMedia.mediaDecisionId, secondMedia.mediaObjectId, secondMedia.sha256, secondMedia.objectVersion]);
      await admin!.query(`insert into cv_portfolio.acceptance_history
          (approval_id, portfolio_id, owner_id, version_id, media_decision_id, media_object_id, media_sha256, media_object_version, accepted_by, accepted_at)
        values ($1, $3, $4, $5, $6, $7, $8, $9, $4, $10),
               ($2, $3, $4, $11, $12, $13, $14, $15, $4, $16)`,
      [firstApprovalId, secondApprovalId, portfolioId, ownerId,
        firstVersionId, firstMedia.mediaDecisionId, firstMedia.mediaObjectId, firstMedia.sha256, firstMedia.objectVersion, firstAcceptedAt,
        secondVersionId, secondMedia.mediaDecisionId, secondMedia.mediaObjectId, secondMedia.sha256, secondMedia.objectVersion, secondAcceptedAt]);
      await admin!.query(`update cv_portfolio.portfolios set aggregate_version = 5, current_version_id = null, ever_activated = false
        where portfolio_id = $1 and owner_id = $2`, [portfolioId, ownerId]);
      await admin!.query("commit");
    } catch (error) {
      await admin!.query("rollback");
      throw error;
    }

    const cvDelegate = createPostgresOwnerCvExportSnapshotReader();
    const retainedWithoutCurrent = await worker!.transactions.run(
      (context) => cvDelegate.readOwnerCvExportSnapshot(scope, context),
      { isolationLevel: "repeatable read" },
    );
    expect(retainedWithoutCurrent.ok).toBe(true);
    if (!retainedWithoutCurrent.ok) throw new Error("PHASE8_CV_EXPORT_NO_CURRENT_READ_FAILED");
    expect(retainedWithoutCurrent.value).toMatchObject({
      currentVersionId: null,
      versions: [{ versionId: secondVersionId, state: "accepted", isCurrent: false },
        { versionId: firstVersionId, state: "accepted", isCurrent: false }],
      acceptanceHistory: [{ versionId: secondVersionId }, { versionId: firstVersionId }],
      activationHistory: [],
    });

    await admin!.query("begin");
    try {
      await admin!.query("update cv_portfolio.versions set is_current = true where version_id = $1", [firstVersionId]);
      await admin!.query(`update cv_portfolio.portfolios set aggregate_version = 6, current_version_id = $3, ever_activated = true
        where portfolio_id = $1 and owner_id = $2`, [portfolioId, ownerId, firstVersionId]);
      await admin!.query(`insert into cv_portfolio.activation_history
        (activation_id, portfolio_id, owner_id, version_id, activated_at) values ($1, $2, $3, $4, '2026-10-21T10:00:00Z')`,
      [firstActivationId, portfolioId, ownerId, firstVersionId]);
      await admin!.query("commit");
    } catch (error) {
      await admin!.query("rollback");
      throw error;
    }

    let signalCvRead!: () => void;
    let resumeCapture!: () => void;
    const cvReadCompleted = new Promise<void>((resolve) => { signalCvRead = resolve; });
    const captureMayContinue = new Promise<void>((resolve) => { resumeCapture = resolve; });
    let pauseFirstRead = true;
    const coordinatedCvReader: OwnerCvExportSnapshotReaderPort = {
      async readOwnerCvExportSnapshot(target, context) {
        const result = await cvDelegate.readOwnerCvExportSnapshot(target, context);
        if (pauseFirstRead) {
          pauseFirstRead = false;
          signalCvRead();
          await captureMayContinue;
        }
        return result;
      },
    };
    const snapshotReader = createOwnerExportSnapshotReader({
      configuration: {} as never,
      content: { async readOwnerExportMediaLocales() { return ok([]); } } as never,
      media: createPostgresOwnerMediaExportSnapshotReader({ database: worker!.database, transactions: worker!.transactions }),
      cv: coordinatedCvReader,
      transactions: worker!.transactions,
      capabilities: { async read() { return { currentCvAvailable: true, externalLinksAvailable: false }; } },
    });
    const capturePromise = snapshotReader.capture({
      portfolioId, ownerId, snapshotId: createStableId("OwnerExportArtifact"), includedScopes: ["cv-metadata"],
    });
    await cvReadCompleted;

    await admin!.query("begin");
    try {
      await admin!.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [firstMediaId]);
      await admin!.query(`update media.processing_states set aggregate_version = 4
        where media_id = $1 and portfolio_id = $2 and owner_id = $3`, [firstMediaId, portfolioId, ownerId]);
      await admin!.query(`insert into media.rejection_history
          (rejection_id, portfolio_id, owner_id, media_id, aggregate_version, reason_code, private_reason, rejected_by, rejected_at)
        values ($1, $2, $3, $4, 4, 'OWNER_REJECTED', 'Synthetic withdrawal race fixture', $3, '2026-10-24T10:00:00Z')`,
      [createStableId("MediaRejection"), portfolioId, ownerId, firstMediaId]);
      await admin!.query("update cv_portfolio.versions set is_current = false where version_id = $1", [firstVersionId]);
      await admin!.query("update cv_portfolio.versions set is_current = true where version_id = $1", [secondVersionId]);
      await admin!.query(`update cv_portfolio.portfolios set aggregate_version = 7, current_version_id = $3
        where portfolio_id = $1 and owner_id = $2`, [portfolioId, ownerId, secondVersionId]);
      await admin!.query(`insert into cv_portfolio.activation_history
        (activation_id, portfolio_id, owner_id, version_id, activated_at) values ($1, $2, $3, $4, '2026-10-24T10:00:00Z')`,
      [secondActivationId, portfolioId, ownerId, secondVersionId]);
      await admin!.query("commit");
    } catch (error) {
      await admin!.query("rollback");
      throw error;
    }
    resumeCapture();

    const captured = await capturePromise;
    expect(captured.ok).toBe(true);
    if (!captured.ok || !("kind" in captured.value) || captured.value.kind !== "owner-export-snapshot-v1") throw new Error("PHASE8_CV_EXPORT_CAPTURE_FAILED");
    expect(captured.value).toMatchObject({
      includedScopes: ["cv-metadata"],
      cv: { currentVersionId: firstVersionId, activationHistory: [{ versionId: firstVersionId }] },
      cvAssets: expect.arrayContaining([expect.objectContaining({ mediaId: firstMediaId }), expect.objectContaining({ mediaId: secondMediaId })]),
    });
    expect(captured.value).not.toHaveProperty("media");

    const staleReadyCheck = await worker!.transactions.run((context) => snapshotReader.revalidateMediaForReady!({
      snapshot: captured.value, portfolioId, ownerId, context,
    }), { isolationLevel: "repeatable read" });
    expect(staleReadyCheck).toBe(false);

    const changedSource = await snapshotReader.capture({
      portfolioId, ownerId, snapshotId: createStableId("OwnerExportArtifact"), includedScopes: ["cv-metadata"],
    });
    expect(changedSource.ok).toBe(false);
  });
});
