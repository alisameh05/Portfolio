import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Client } from "pg";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dockerBindMountUserArgs } from "../../src/runtime/adapters/media-processing-tools.js";
import { handleCreateOwnerMediaUploadIntent } from "../../src/runtime/http/owner-media.js";
import { handleRecordOwnerMediaProcessing } from "../../src/runtime/http/owner-media.js";
import { withOwnerTestAuth } from "../runtime/owner-test-auth.js";
import { createOwnerSecurityTestStub } from "../../src/runtime/http/owner-security.js";
import { handleAcceptOwnerCvVersion, handleActivateOwnerCvVersion, handleGetOwnerCvPortfolio, handleRegisterOwnerCvVersion } from "../../src/runtime/http/owner-cv.js";
import { getOwnerCvApplicationService, getOwnerMediaApplicationService, initializeDatabaseRuntime, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { createOwnerCvApplicationService } from "../../src/modules/cv-portfolio/application/owner-service.js";
import { createPostgresCvPortfolioRepository } from "../../src/modules/cv-portfolio/adapters/postgres-portfolio.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import type { MediaAcceptancePort } from "../../src/modules/content-publishing/application/service.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/index.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresMediaUploadIntentRepository } from "../../src/modules/media/adapters/postgres-upload-intents.js";
import { createPostgresMediaProcessingRepository } from "../../src/modules/media/adapters/postgres-processing.js";
import { createPostgresMediaAcceptanceRepository } from "../../src/modules/media/adapters/postgres-acceptance.js";
import { createUploadCapabilityVault } from "../../src/modules/media/adapters/upload-capability-vault.js";
import { createMediaUploadIntentApplicationService } from "../../src/modules/media/application/upload-intent.js";
import { createMediaProcessingApplicationService, type PdfProcessorPort, type VideoProcessorPort, type MediaImageProcessorPort, type TrustedByteScannerPort, type MediaProcessingRepositoryPort } from "../../src/modules/media/application/processing.js";
import { createMediaAcceptanceApplicationService } from "../../src/modules/media/application/acceptance.js";
import { createMediaRejectionApplicationService } from "../../src/modules/media/application/rejection.js";
import { createPostgresMediaRejectionRepository } from "../../src/modules/media/adapters/postgres-rejection.js";
import type { OwnerMediaAccessibility } from "../../src/modules/media/application/owner-contracts.js";
import { createSupabaseMediaUploadTargetAdapter } from "../../src/runtime/adapters/supabase-media-upload-target.js";
import { createSupabaseMediaProcessingStorage } from "../../src/runtime/adapters/supabase-media-processing-storage.js";
import { createPostgresRuntimeDatabase, resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import { createProductionOwnerMediaService } from "../../src/runtime/fakes/owner-media.js";
import { createStableId } from "../../src/shared/domain/index.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import type { StableId } from "../../src/shared/domain/index.js";

const DATABASE_URL = process.env["PHASE6_UPLOAD_INTENT_DATABASE_URL"];
const STORAGE_URL = process.env["PHASE6_UPLOAD_INTENT_STORAGE_URL"];
const SERVICE_ROLE_KEY = process.env["PHASE6_UPLOAD_INTENT_SERVICE_ROLE_KEY"];
const ANON_KEY = process.env["PHASE6_UPLOAD_INTENT_ANON_KEY"];
const REPLAY_KEY = process.env["PHASE6_UPLOAD_INTENT_REPLAY_KEY"];
const PDF_FIXTURE = process.env["PHASE6_PDF_PROCESSING_FIXTURE"];
const SCANNER_IMAGE = process.env["PHASE6_SCANNER_IMAGE"];
const PDF_PROCESSOR_IMAGE = process.env["PHASE6_PDF_PROCESSOR_IMAGE"];
const SCANNER_VERSION = process.env["PHASE6_SCANNER_VERSION"];
const PDF_PROCESSOR_VERSION = process.env["PHASE6_PDF_PROCESSOR_VERSION"];
const VIDEO_FIXTURE_MP4 = process.env["PHASE6_VIDEO_PROCESSING_MP4_FIXTURE"];
const VIDEO_FIXTURE_WEBM = process.env["PHASE6_VIDEO_PROCESSING_WEBM_FIXTURE"];
const VIDEO_FIXTURE_UNSUPPORTED = process.env["PHASE6_VIDEO_PROCESSING_UNSUPPORTED_FIXTURE"];
const VIDEO_FIXTURE_EXCESSIVE = process.env["PHASE6_VIDEO_PROCESSING_EXCESSIVE_FIXTURE"];
const IMAGE_FIXTURES = {
  "image/png": process.env["PHASE6_IMAGE_FIXTURE_PNG"],
  "image/jpeg": process.env["PHASE6_IMAGE_FIXTURE_JPEG"],
  "image/webp": process.env["PHASE6_IMAGE_FIXTURE_WEBP"],
} as const;
const REQUIRE_IMAGES = process.env["PHASE6_REQUIRE_IMAGES"] === "1";
const REQUIRE_VIDEO = process.env["PHASE6_REQUIRE_VIDEO"] === "1";
const PROCESSING_COUNTS_FILE = process.env["PHASE6_MEDIA_PROCESSING_COUNTS_FILE"];
const REQUIRE_REAL = process.env["PHASE6_REQUIRE_UPLOAD_INTENT"] === "1";
const REQUIRE_ACCEPTANCE = process.env["PHASE6_MEDIA_ACCEPTANCE_ONLY"] === "1";
const REQUIRE_MEDIA_REJECTION = process.env["PHASE6_MEDIA_REJECTION_ONLY"] === "1";
const REQUIRE_FULL_MEDIA = process.env["PHASE6_REQUIRE_FULL_MEDIA"] === "1";
const REQUIRE_CV_ACTIVATION = process.env["PHASE6_CV_ACTIVATION_ONLY"] === "1";
const mediaProcessingCounts = { scannerExecutions: 0, processorExecutions: 0, videoProcessorExecutions: 0, imageProcessorExecutions: 0, acceptanceExecutions: 0,
  cvScenarios: [] as Array<{ readonly name: string; readonly executed: boolean; readonly status: "passed" | "failed" }>,
  cvAcceptanceScenarios: [] as Array<{ readonly name: string; readonly executed: boolean; readonly status: "passed" | "failed" }>,
  cvActivationScenarios: [] as Array<{ readonly name: string; readonly executed: boolean; readonly status: "passed" | "failed" }>,
  mediaRejectionScenarios: [] as Array<{ readonly id: string; readonly name: string; readonly executed: boolean; readonly status: "passed" | "failed" }>,
  rejectionToolCounts: { scannerExecutions: 0, processorExecutions: 0, cleanScannerVerdicts: 0, unsafeScannerVerdicts: 0 } };

if (REQUIRE_REAL && (!DATABASE_URL || !STORAGE_URL || !SERVICE_ROLE_KEY || !ANON_KEY || !REPLAY_KEY || !SCANNER_IMAGE || !SCANNER_VERSION ||
    (!REQUIRE_IMAGES && (!PDF_FIXTURE || !PDF_PROCESSOR_IMAGE || !PDF_PROCESSOR_VERSION)))) {
  throw new Error("PHASE6_UPLOAD_INTENT_SERVICES_REQUIRED");
}
if (REQUIRE_IMAGES && Object.values(IMAGE_FIXTURES).some((path) => !path)) throw new Error("PHASE6_IMAGE_PROCESSING_FIXTURES_REQUIRED");
if (REQUIRE_VIDEO && (!VIDEO_FIXTURE_MP4 || !VIDEO_FIXTURE_WEBM || !VIDEO_FIXTURE_UNSUPPORTED || !VIDEO_FIXTURE_EXCESSIVE)) throw new Error("PHASE6_VIDEO_PROCESSING_FIXTURES_REQUIRED");

const describeReal = DATABASE_URL && STORAGE_URL && SERVICE_ROLE_KEY && ANON_KEY && REPLAY_KEY ? describe : describe.skip;
const bytes = Buffer.from("Phase 6 private Media candidate fixture.", "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const mimeType = "image/png";

function headers(key: string): HeadersInit {
  return { apikey: key, authorization: `Bearer ${key}` };
}

function quoteTestRole(value: string): string {
  if (!/^phase6_upload_[a-z0-9_]+$/.test(value)) throw new Error("PHASE6_UPLOAD_INTENT_ROLE_INVALID");
  return `"${value}"`;
}

function dockerResult(args: readonly string[], input?: Uint8Array, timeoutMs = 30_000): { readonly status: number; readonly stdout: Uint8Array } {
  const result = spawnSync("docker", [...args], { input, encoding: "buffer", timeout: timeoutMs, maxBuffer: 24 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status === null) throw new Error("PHASE6_PROCESSING_TOOL_UNAVAILABLE");
  return { status: result.status, stdout: result.stdout };
}

function dockerScanner(bytes: Uint8Array, timeoutMs = 24_000) {
  const directory = mkdtempSync(join(tmpdir(), "phase6-media-scan-"));
  try {
    writeFileSync(join(directory, "input.bin"), bytes, { flag: "wx", mode: 0o600 });
    const result = dockerResult(["run", "--rm", "--entrypoint", "clamscan", "-v", `${directory}:/scan:ro`, SCANNER_IMAGE!, "--no-summary", "/scan/input.bin"], undefined, timeoutMs);
    if (result.status === 0) return { ok: true as const, value: { verdict: "clean" as const, version: SCANNER_VERSION! } };
    if (result.status === 1) return { ok: true as const, value: { verdict: "unsafe" as const, version: SCANNER_VERSION! } };
    return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_SCANNER_UNAVAILABLE" } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

function dockerScannerMany(files: readonly Uint8Array[], timeoutMs = 24_000) {
  const directory = mkdtempSync(join(tmpdir(), "phase6-media-scan-"));
  try {
    const paths = files.map((bytes, index) => {
      writeFileSync(join(directory, `input-${index}.bin`), bytes, { flag: "wx", mode: 0o600 });
      return `/scan/input-${index}.bin`;
    });
    const result = dockerResult(["run", "--rm", "--entrypoint", "clamscan", "-v", `${directory}:/scan:ro`, SCANNER_IMAGE!, "--no-summary", ...paths], undefined, timeoutMs);
    if (result.status === 0) return { ok: true as const, value: { verdict: "clean" as const, version: SCANNER_VERSION! } };
    if (result.status === 1) return { ok: true as const, value: { verdict: "unsafe" as const, version: SCANNER_VERSION! } };
    return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_SCANNER_UNAVAILABLE" } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const PDF_PREFLIGHT_FOR_TEST = String.raw`
import sys, pikepdf
src, dst = sys.argv[1], sys.argv[2]
try: opened = pikepdf.open(src)
except Exception: raise SystemExit(21)
with opened as pdf:
    if pdf.is_encrypted or len(pdf.pages) < 1 or len(pdf.pages) > 500 or len(pdf.objects) > 100000: raise SystemExit(21)
    root = pdf.Root
    if any(key in root for key in ("/OpenAction", "/AA", "/AcroForm", "/Collection")): raise SystemExit(22)
    names = root.get("/Names", None)
    if names is not None and any(key in names for key in ("/JavaScript", "/EmbeddedFiles")): raise SystemExit(23)
    active = {"/JavaScript", "/Launch", "/GoToR", "/SubmitForm", "/ImportData", "/RichMedia", "/Movie", "/Sound"}
    for obj in pdf.objects:
        if "/S" in obj and str(obj["/S"]) in active: raise SystemExit(24)
        if "/OpenAction" in obj or "/AA" in obj: raise SystemExit(25)
    pdf.save(dst, compress_streams=True)
`;

function dockerPdfProcessor(bytes: Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "phase6-media-pdf-"));
  try {
    writeFileSync(join(directory, "input.pdf"), bytes, { flag: "wx", mode: 0o600 });
    const mount = `${directory}:/work`;
    const checked = dockerResult(["run", "--rm", ...dockerBindMountUserArgs(), "--entrypoint", "python3", "-v", mount, PDF_PROCESSOR_IMAGE!, "-c", PDF_PREFLIGHT_FOR_TEST, "/work/input.pdf", "/work/checked.pdf"]);
    if (checked.status !== 0) return { ok: false as const, error: { kind: "validation" as const, code: "MEDIA_PDF_POLICY_REJECTED" } };
    const processed = dockerResult(["run", "--rm", ...dockerBindMountUserArgs(), "--entrypoint", "ocrmypdf", "-v", mount, PDF_PROCESSOR_IMAGE!, "--skip-text", "--output-type", "pdfa-2", "--optimize", "0", "--jobs", "1", "--quiet", "/work/checked.pdf", "/work/processed.pdf"]);
    if (processed.status !== 0) return { ok: false as const, error: { kind: "validation" as const, code: "MEDIA_PDF_NOT_READABLE" } };
    const outputCheck = dockerResult(["run", "--rm", ...dockerBindMountUserArgs(), "--entrypoint", "python3", "-v", mount, PDF_PROCESSOR_IMAGE!, "-c", PDF_PREFLIGHT_FOR_TEST, "/work/processed.pdf", "/work/verified-output.pdf"]);
    if (outputCheck.status !== 0) return { ok: false as const, error: { kind: "validation" as const, code: "MEDIA_PDF_OUTPUT_INVALID" } };
    const outputBytes = new Uint8Array(readFileSync(join(directory, "verified-output.pdf")));
    return { ok: true as const, value: { bytes: outputBytes, version: PDF_PROCESSOR_VERSION!, policyVersion: "pdf-active-content-deny-1" } };
  } catch { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_PDF_PROCESSOR_UNAVAILABLE" } }; }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function createPdfVariant(base: Uint8Array, mode: "encrypted" | "active"): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "phase6-media-pdf-variant-"));
  try {
    writeFileSync(join(directory, "base.pdf"), base);
    const script = mode === "encrypted"
      ? "import pikepdf,sys; pikepdf.open(sys.argv[1]).save(sys.argv[2], encryption=pikepdf.Encryption(owner='owner-secret', user='user-secret', R=6))"
      : "import pikepdf,sys; p=pikepdf.open(sys.argv[1]); p.Root['/OpenAction']=pikepdf.Dictionary(S=pikepdf.Name('/JavaScript'), JS=pikepdf.String('app.alert(1)')); p.save(sys.argv[2])";
    const generated = dockerResult(["run", "--rm", ...dockerBindMountUserArgs(), "--entrypoint", "python3", "-v", `${directory}:/work`, PDF_PROCESSOR_IMAGE!, "-c", script, "/work/base.pdf", "/work/variant.pdf"]);
    if (generated.status !== 0) throw new Error("PHASE6_PDF_FIXTURE_GENERATION_FAILED");
    return new Uint8Array(readFileSync(join(directory, "variant.pdf")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describeReal("Phase 6 #148 private upload intent with real PostgreSQL and Storage", () => {
  let admin: Client;
  let appClient: Client;
  let appDatabase: ReturnType<typeof createPostgresRuntimeDatabase>;
  let applicationDatabaseUrl: string;
  let databaseRuntimeInitialized = false;
  let roleName: string;
  let storageBase: string;
  let ownerId: StableId<"Owner">;
  let portfolioId: StableId<"Portfolio">;
  let targetAdapter: ReturnType<typeof createSupabaseMediaUploadTargetAdapter>;
  let signingCalls = 0;
  let lastStorageFailure: string | undefined;
  let appNow = Date.now();
  const acceptedMediaIds: StableId<"MediaAsset">[] = [];
  const decorativeMediaIds = new Set<StableId<"MediaAsset">>();
  const rejectionProcessingByMediaId = new Map<string, ReturnType<typeof createMediaProcessingApplicationService>>();

  function createService(target = targetAdapter) {
    return createMediaUploadIntentApplicationService({
      scope: { ownerId, portfolioId },
      repository: createPostgresMediaUploadIntentRepository(appDatabase.database, appDatabase.transactions),
      target,
      vault: createUploadCapabilityVault(REPLAY_KEY),
      ids: createSystemIdGenerator(),
      clock: { now: () => new Date(appNow).toISOString() },
    });
  }

  function createAcceptanceService() {
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: SERVICE_ROLE_KEY! });
    return createMediaAcceptanceApplicationService({
      scope: { ownerId, portfolioId },
      repository: createPostgresMediaAcceptanceRepository({
        database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId },
      }),
      preflight: storage.preflightAcceptedPdfObject,
    });
  }

  function contentMediaAcceptancePort(acceptance = createAcceptanceService()): MediaAcceptancePort {
    return {
      async getAcceptanceFacts(query, transaction) {
        const result = await acceptance.getAcceptanceFacts({
          ownerId: query.ownerId, mediaAssetIds: query.mediaAssetIds, intendedUse: "supporting-artifact",
        }, transaction);
        if (!result.ok) return result;
        return { ok: true, value: {
          consistencyVersion: result.value[0]?.consistencyVersion ?? "media-acceptance-v1:empty",
          facts: result.value.map(({ mediaAssetId, ownerId: factOwnerId, assetVersion, accepted, safe, suitable, accessible }) => ({
            mediaAssetId, ownerId: factOwnerId, accepted, safe, suitable, accessible, version: assetVersion,
          })),
        } };
      },
    };
  }

  function createContentService(
    mediaAcceptance: MediaAcceptancePort,
    repository = createPostgresContentAuthoringRepository(),
  ) {
    const discoveryProjection = createPostgresProjectDiscoveryProjectionWriter();
    return createContentAuthoringService({
      repository,
      operations: createPostgresOperationsPersistence(appDatabase.database),
      scope: { portfolioId, ownerId },
      discoveryProjection,
      mediaAcceptance,
    });
  }

  async function publishContentWithMedia(
    content: ReturnType<typeof createContentService>,
    contentType: "project" | "achievement",
    mediaAssetId: StableId<"MediaAsset">,
    prefix: string,
    onReviewReady?: (input: { readonly contentId: StableId<string>; readonly expectedVersion: number }) => void | Promise<void>,
    expectPublished = true,
  ) {
    const artifactId = createStableId("SupportingArtifact");
    const owner = { kind: "owner" as const, ownerId, sessionId: "phase6-content-media-owner" };
    const payload = contentType === "project" ? {
      contentType: "project" as const, locale: "en" as const, title: `${prefix} Project`,
      summary: "A reviewed project summary.", body: "The published project body.", candidateSlug: `${prefix}-project`,
      caseStudy: { problem: "A real workflow problem.", ownerRole: "Built the workflow.", contributions: ["Shipped the implementation."], outcomes: ["The task completed reliably."], lessons: "Keep evidence current." },
      evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "The accepted Media supports this implementation.", artifactIds: [artifactId] }],
        artifacts: [{ id: artifactId, title: "Accepted PDF evidence", destinationUrl: "https://example.com/evidence", mediaAssetId }] },
      externalLinks: [{ id: createStableId("ExternalLink"), label: "Project details", destination: "https://example.com/details", isAvailableInArabic: true }],
    } : {
      contentType: "achievement" as const, locale: "en" as const, title: `${prefix} Achievement`,
      summary: "A reviewed achievement summary.", body: "The published achievement account.", achievedOn: "2026-10-10",
      evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "The accepted Media supports this milestone.", artifactIds: [artifactId] }],
        artifacts: [{ id: artifactId, title: "Accepted PDF evidence", destinationUrl: "https://example.com/achievement", mediaAssetId }] },
    };
    const created = await content.createContent({ actor: owner, idempotencyKey: `${prefix}-create` as never, correlationId: `${prefix}-create`, payload });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("PHASE6_CONTENT_MEDIA_CREATE_FAILED");
    const preview = await content.previewRevision({ actor: owner, contentId: created.value.contentId, revisionId: created.value.revisionId });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error("PHASE6_CONTENT_MEDIA_PREVIEW_FAILED");
    const reviewed = await content.reviewRevision({ actor: owner, contentId: created.value.contentId, revisionId: created.value.revisionId,
      expectedVersion: created.value.aggregateVersion, idempotencyKey: `${prefix}-review` as never, correlationId: `${prefix}-review`,
      locale: "en", snapshotHash: preview.value.snapshotHash, evidenceVersion: preview.value.evidenceVersion,
      decision: "accepted", findings: ["Reviewed against accepted Media evidence."] });
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) throw new Error("PHASE6_CONTENT_MEDIA_REVIEW_FAILED");
    await onReviewReady?.({ contentId: created.value.contentId, expectedVersion: reviewed.value.aggregateVersion });
    const published = await content.publishLanguageVersion({ actor: owner, contentId: created.value.contentId,
      expectedVersion: reviewed.value.aggregateVersion, idempotencyKey: `${prefix}-publish` as never, correlationId: `${prefix}-publish`,
      locale: "en", revisionId: created.value.revisionId });
    if (expectPublished) expect(published.ok, JSON.stringify(published)).toBe(true);
    return { contentId: created.value.contentId, revisionId: created.value.revisionId, published };
  }

  async function createDraftContentWithMedia(
    content: ReturnType<typeof createContentService>, mediaAssetId: StableId<"MediaAsset">, prefix: string,
  ) {
    const artifactId = createStableId("SupportingArtifact");
    const created = await content.createContent({
      actor: { kind: "owner", ownerId, sessionId: "phase6-content-media-owner" },
      idempotencyKey: `${prefix}-create` as never, correlationId: `${prefix}-create`,
      payload: { contentType: "project", locale: "en", title: `${prefix} Project`,
        summary: "A reviewed project summary.", body: "The project remains in Draft.", candidateSlug: `${prefix}-project`,
        caseStudy: { problem: "A real workflow problem.", ownerRole: "Built the workflow.",
          contributions: ["Shipped the implementation."], outcomes: ["The task completed reliably."], lessons: "Keep evidence current." },
        evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "The Media is referenced by this Draft.", artifactIds: [artifactId] }],
          artifacts: [{ id: artifactId, title: "Draft PDF evidence", destinationUrl: "https://example.com/draft", mediaAssetId }] },
        externalLinks: [{ id: createStableId("ExternalLink"), label: "Project details", destination: "https://example.com/details", isAvailableInArabic: true }] },
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    if (!created.ok) throw new Error("PHASE6_REJECTION_DRAFT_CONTENT_CREATE_FAILED");
    const row = await admin.query("select lifecycle from content.items where content_id = $1::uuid", [created.value.contentId]);
    expect(row.rows).toEqual([{ lifecycle: "draft" }]);
    return { contentId: created.value.contentId, revisionId: created.value.revisionId, aggregateVersion: created.value.aggregateVersion };
  }

  async function publishArabicProjectRevision(
    content: ReturnType<typeof createContentService>,
    contentId: StableId<string>,
    expectedVersion: number,
    mediaAssetId: StableId<"MediaAsset">,
  ) {
    const owner = { kind: "owner" as const, ownerId, sessionId: "phase6-content-media-owner" };
    const artifactId = createStableId("SupportingArtifact");
    const draft = await content.saveRevision({ actor: owner, contentId, expectedVersion,
      idempotencyKey: "phase6-content-media-arabic-save" as never, correlationId: "phase6-content-media-arabic-save",
      locale: "ar", title: "مشروع موثق", summary: "ملخص عربي للمشروع", body: "هذا وصف عربي مستقل للمشروع.",
      draftData: { contentType: "project", caseStudy: { problem: "مشكلة عربية واضحة.", ownerRole: "قاد التنفيذ.",
        contributions: ["بنى الخدمة."], outcomes: ["تحسن سير العمل."], lessons: "قِس أثر العمل." },
        evidence: { claims: [{ claimId: createStableId("EvidenceClaim"), text: "يدعم هذا الملف الدليل المنشور.", artifactIds: [artifactId] }],
          artifacts: [{ id: artifactId, title: "دليل المشروع", destinationUrl: "https://example.com/ar/evidence", mediaAssetId }] },
        externalLinks: [{ id: createStableId("ExternalLink"), label: "تفاصيل المشروع", destination: "https://example.com/ar/details", isAvailableInArabic: true }] },
    });
    expect(draft.ok, JSON.stringify(draft)).toBe(true);
    if (!draft.ok) throw new Error("PHASE6_ARABIC_MEDIA_DRAFT_FAILED");
    const preview = await content.previewRevision({ actor: owner, contentId, revisionId: draft.value.revisionId });
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    if (!preview.ok) throw new Error("PHASE6_ARABIC_MEDIA_PREVIEW_FAILED");
    const reviewed = await content.reviewRevision({ actor: owner, contentId, revisionId: draft.value.revisionId,
      expectedVersion: draft.value.aggregateVersion, idempotencyKey: "phase6-content-media-arabic-review" as never,
      correlationId: "phase6-content-media-arabic-review", locale: "ar", snapshotHash: preview.value.snapshotHash,
      evidenceVersion: preview.value.evidenceVersion, decision: "accepted", findings: [] });
    expect(reviewed.ok, JSON.stringify(reviewed)).toBe(true);
    if (!reviewed.ok) throw new Error("PHASE6_ARABIC_MEDIA_REVIEW_FAILED");
    const published = await content.publishLanguageVersion({ actor: owner, contentId, expectedVersion: reviewed.value.aggregateVersion,
      idempotencyKey: "phase6-content-media-arabic-publish" as never, correlationId: "phase6-content-media-arabic-publish",
      locale: "ar", revisionId: draft.value.revisionId });
    expect(published.ok, JSON.stringify(published)).toBe(true);
    if (!published.ok) throw new Error("PHASE6_ARABIC_MEDIA_PUBLICATION_FAILED");
    const arabic = await content.getPublicProject({ slug: "phase6-accepted-project-project", locale: "ar" });
    expect(arabic).toMatchObject({ ok: true, value: { revisionId: draft.value.revisionId, locale: "ar",
      title: "مشروع موثق", summary: "ملخص عربي للمشروع", body: "هذا وصف عربي مستقل للمشروع." } });
    expect(await content.getPublicProject({ slug: "phase6-accepted-project-project", locale: "en" }))
      .toMatchObject({ ok: true, value: { title: "phase6-accepted-project Project", locale: "en" } });
    return published.value.aggregateVersion;
  }

  async function acceptAndVerify(mediaId: StableId<"MediaAsset">, accessibility: OwnerMediaAccessibility, keySuffix: string) {
    const acceptance = createAcceptanceService();
    const command = {
      actor: { kind: "owner" as const, ownerId, sessionId: "phase6-media-acceptance-owner" },
      idempotencyKey: `phase6-accept-${keySuffix}-${randomBytes(8).toString("hex")}` as never,
      expectedVersion: 2, mediaId, accessibility,
    };
    let releaseRead!: () => void;
    let readReady!: () => void;
    const heldRead = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readLocked = new Promise<void>((resolve) => { readReady = resolve; });
    const read = appDatabase.transactions.run(async (transaction) => {
      const facts = await acceptance.getAcceptanceFacts({ ownerId, mediaAssetIds: [mediaId], intendedUse: "supporting-artifact" }, transaction);
      expect(facts.ok).toBe(true);
      readReady();
      await heldRead;
      return facts;
    });
    await readLocked;
    let acceptanceFinished = false;
    const pendingAcceptance = acceptance.acceptOwnerMediaAsset(command).then((result) => { acceptanceFinished = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(acceptanceFinished).toBe(false);
    releaseRead();
    const beforeAcceptance = await read;
    expect(beforeAcceptance).toMatchObject({ ok: true, value: [{ accepted: false }] });
    const accepted = await pendingAcceptance;
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, value: { aggregateId: mediaId, aggregateVersion: 3, outcome: "media-accepted" } });
    if (accepted.ok) mediaProcessingCounts.acceptanceExecutions += 1;
    const replay = await acceptance.acceptOwnerMediaAsset(command);
    expect(replay).toEqual(accepted);
    const differentKey = await acceptance.acceptOwnerMediaAsset({ ...command, expectedVersion: 3, idempotencyKey: `phase6-accept-new-${randomBytes(8).toString("hex")}` as never });
    expect(differentKey).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
    const use = accessibility.kind === "decorative-image" ? "decorative" as const : "supporting-artifact" as const;
    const facts = await appDatabase.transactions.run((transaction) => acceptance.getAcceptanceFacts({ ownerId, mediaAssetIds: [mediaId], intendedUse: use }, transaction));
    expect(facts).toMatchObject({ ok: true, value: [{ mediaAssetId: mediaId, ownerId, assetVersion: 3, accepted: true, safe: true, suitable: true, accessible: true }] });
    if (!facts.ok) throw new Error("PHASE6_ACCEPTANCE_FACTS_UNAVAILABLE");
    expect(facts.value[0]?.consistencyVersion).toMatch(/^media-acceptance-v1:[0-9a-f]{64}$/u);
    const decision = await admin.query(`select decision, aggregate_version, processing_policy_version, sealed_outputs, accessibility,
        ownership_attested_by::text, ownership_attested_at, public_suitability_attested_by::text, public_suitability_attested_at,
        decided_by::text from media.decision_history where media_id = $1::uuid`, [mediaId]);
    expect(decision.rowCount).toBe(1);
    expect(decision.rows[0]).toMatchObject({ decision: "accepted", aggregate_version: 3, accessibility,
      ownership_attested_by: ownerId, public_suitability_attested_by: ownerId, decided_by: ownerId });
    expect(decision.rows[0]?.sealed_outputs).toEqual(expect.arrayContaining([expect.objectContaining({ objectId: expect.any(String), sha256: expect.any(String), mimeType: expect.any(String) })]));
    expect(new Date(decision.rows[0]?.ownership_attested_at).toISOString()).toBe(new Date(decision.rows[0]?.public_suitability_attested_at).toISOString());
    const event = await admin.query(`select event_type, aggregate_version, payload from operations.outbox_events
      where aggregate_id = $1::uuid and event_type = 'media.asset_accepted.v1'`, [mediaId]);
    expect(event.rows).toEqual([{ event_type: "media.asset_accepted.v1", aggregate_version: 3, payload: { mediaId } }]);
    acceptedMediaIds.push(mediaId);
    if (accessibility.kind === "decorative-image") decorativeMediaIds.add(mediaId);
    const duplicateBatch = await appDatabase.transactions.run((transaction) => acceptance.getAcceptanceFacts({
      ownerId, mediaAssetIds: [mediaId, mediaId], intendedUse: "supporting-artifact",
    }, transaction));
    expect(duplicateBatch).toMatchObject({ ok: true, value: [{ mediaAssetId: mediaId, accepted: true }] });
    return { acceptance, command, accepted };
  }

  async function createAcceptedRejectionCandidate(suffix: string, accept = true): Promise<StableId<"MediaAsset">> {
    const payload = new Uint8Array(readFileSync(PDF_FIXTURE!));
    const media = await createService().create({ actor: { kind: "owner", ownerId, sessionId: "phase6-rejection-owner" },
      idempotencyKey: `phase6-rejection-upload-${suffix}` as never, kind: "document", originalFileName: `rejection-${suffix}.pdf`,
      declaredMediaType: "application/pdf", byteLength: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex") });
    expect(media.ok, JSON.stringify(media)).toBe(true);
    if (!media.ok) throw new Error("PHASE6_REJECTION_UPLOAD_FAILED");
    const uploaded = await fetch(media.value.uploadTarget, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: Buffer.from(payload) });
    expect([200, 201]).toContain(uploaded.status);
    const realStorage = createSupabaseMediaProcessingStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: SERVICE_ROLE_KEY! });
    const processor = { async process(input: Uint8Array) {
      const result = dockerPdfProcessor(input);
      if (REQUIRE_MEDIA_REJECTION) mediaProcessingCounts.rejectionToolCounts.processorExecutions += 1;
      return result;
    } };
    const scanner = { async scan(input: Uint8Array, options?: { readonly timeoutMs?: number }) {
      const result = dockerScanner(input, options?.timeoutMs);
      if (REQUIRE_MEDIA_REJECTION) {
        mediaProcessingCounts.rejectionToolCounts.scannerExecutions += 1;
        if (result.ok && result.value.verdict === "clean") mediaProcessingCounts.rejectionToolCounts.cleanScannerVerdicts += 1;
        if (result.ok && result.value.verdict === "unsafe") mediaProcessingCounts.rejectionToolCounts.unsafeScannerVerdicts += 1;
      }
      return result;
    } };
    const processing = createMediaProcessingApplicationService({ scope: { ownerId },
      repository: createPostgresMediaProcessingRepository({ database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId } }),
      storage: realStorage, scanner, processor, digest: { sha256(input) { return createHash("sha256").update(input).digest("hex"); } },
      ids: createSystemIdGenerator(), clock: { now: () => new Date().toISOString() } });
    rejectionProcessingByMediaId.set(media.value.mediaId, processing);
    const processed = await processing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-rejection-owner" },
      idempotencyKey: `phase6-rejection-process-${suffix}` as never, mediaId: media.value.mediaId, expectedVersion: 1,
      result: "passed", detectedMediaType: "application/pdf", detectedByteLength: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex") });
    expect(processed, JSON.stringify(processed)).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
    if (accept) await acceptAndVerify(media.value.mediaId as StableId<"MediaAsset">,
      { kind: "document", summary: "A readable one page PDF document." }, suffix);
    return media.value.mediaId as StableId<"MediaAsset">;
  }

  it("rejects accepted Media safely and serializes with current usage changes", async () => {
    const actor = { kind: "owner" as const, ownerId, sessionId: "phase6-media-rejection-owner" };
    const media = await getOwnerMediaApplicationService();
    const reason = "Owner confirmed this candidate should not remain available.";
    async function contendAtMediaLock<T extends readonly (() => Promise<unknown>)[]>(mediaId: StableId<"MediaAsset">, commands: T, stageFirst = false, scenario = "unspecified"): Promise<{
      [K in keyof T]: T[K] extends () => Promise<infer Result> ? Result : never
    }> {
      await admin.query("begin");
      const pending: Promise<unknown>[] = [];
      const outcomes: unknown[] = [];
      let released = false;
      try {
        await admin.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [mediaId]);
        const waitFor = async (expected: number, attempts = 160, atLeast = false) => {
          const matches = (waiting: number) => atLeast ? waiting >= expected : waiting === expected;
          let waiting = 0;
          // Once a contender is waiting, leave margin inside the production
          // three-second lock timeout. Scheduling and local query latency can
          // take several hundred milliseconds on the Supabase stack.
          for (let attempt = 0; attempt < attempts; attempt += 1) {
            const result = await admin.query(`select count(distinct activity.pid)::int as count
              from pg_locks lock join pg_stat_activity activity on activity.pid = lock.pid
              where activity.usename = $1 and lock.locktype = 'advisory' and not lock.granted`, [roleName]);
            waiting = Number(result.rows[0]?.count ?? 0);
            if (matches(waiting)) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          if (!matches(waiting)) {
            const sessions = await admin.query(`select pid, state, wait_event_type, wait_event, left(query, 180) as query
              from pg_stat_activity where usename = $1`, [roleName]);
            expect(waiting, `${scenario}: expected ${expected} ungranted Media advisory locks; outcomes=${JSON.stringify(outcomes)}; sessions=${JSON.stringify(sessions.rows)}`)
              .toBe(expected);
          }
        };
        if (stageFirst) {
          pending.push(commands[0]!().then((outcome) => { outcomes[0] = outcome; return outcome; }));
          // CV activation performs its private Storage preflight before the
          // final transaction requests this lock, so allow that first stage to
          // finish without consuming the transaction's lock timeout.
          await waitFor(1, 800);
          for (let index = 1; index < commands.length; index += 1) {
            pending.push(commands[index]!().then((outcome) => { outcomes[index] = outcome; return outcome; }));
          }
        } else {
          for (let index = 0; index < commands.length; index += 1) {
            pending.push(commands[index]!().then((outcome) => { outcomes[index] = outcome; return outcome; }));
          }
        }
        // Both commands have started before the barrier is released. Confirm
        // both independent application sessions are queued on the Media lock.
        // Keep this bounded wait inside the production three-second lock timeout.
        await waitFor(commands.length, 240, true);
        await admin.query("commit");
        released = true;
        return await Promise.all(pending) as {
          [K in keyof T]: T[K] extends () => Promise<infer Result> ? Result : never
        };
      } finally {
        if (!released) await admin.query("rollback");
        if (pending.length > 0) await Promise.allSettled(pending);
      }
    }

    // A candidate with no current Content or CV use can be rejected. The
    // owner private aggregate retains a safe decision while the outbox keeps
    // only a fixed public reason code.
    const unusedId = await createAcceptedRejectionCandidate("unused");
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: unusedId, expectedVersion: 2,
      idempotencyKey: "phase6-rejection-stale-version" as never, reason }))
      .toMatchObject({ ok: false, error: { kind: "precondition_failed", code: "MEDIA_VERSION_MISMATCH" } });
    const unusedCommand = { actor, mediaId: unusedId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-exact-replay" as never, reason };
    const rejected = await media.rejectOwnerMediaAsset(unusedCommand);
    expect(rejected, JSON.stringify(rejected)).toMatchObject({ ok: true, value: { aggregateVersion: 4, outcome: "media-rejected" } });
    expect(await media.rejectOwnerMediaAsset(unusedCommand)).toEqual(rejected);
    // A later aggregate version must not change the meaning of this exact
    // command receipt. Rejected media is terminal, so advance the fixture
    // version directly to exercise receipt-first replay against newer state.
    await admin.query("update media.processing_states set aggregate_version = aggregate_version + 1 where media_id = $1::uuid", [unusedId]);
    expect(await media.rejectOwnerMediaAsset(unusedCommand)).toEqual(rejected);
    expect(await media.rejectOwnerMediaAsset({ ...unusedCommand, reason: "Changed private rationale." }))
      .toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    const forbiddenReaccept = await createAcceptanceService().acceptOwnerMediaAsset({ actor, mediaId: unusedId, expectedVersion: 5,
      idempotencyKey: "phase6-rejection-reaccept" as never, accessibility: { kind: "document", summary: "Readable PDF." } });
    expect(forbiddenReaccept, JSON.stringify(forbiddenReaccept)).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
    const unusedFacts = await admin.query(
      `select (select count(*)::int from media.rejection_history where media_id = $1::uuid) as rejections,
              (select count(*)::int from media.acceptance_commands where media_id = $1::uuid and outcome = 'media-rejected') as receipts,
              (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.asset_rejected.v1') as events,
              (select private_reason from media.rejection_history where media_id = $1::uuid) as private_reason,
              (select payload::text from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.asset_rejected.v1') as event_payload`, [unusedId]);
    expect(unusedFacts.rows[0]).toMatchObject({ rejections: 1, receipts: 1, events: 1, private_reason: reason });
    expect(unusedFacts.rows[0]?.event_payload).not.toContain(reason);
    expect(unusedFacts.rows[0]?.event_payload).toContain("OWNER_REJECTED");
    const retainedOutput = await admin.query(`select object.object_id::text as object_id, object.sha256
      from media.processing_attempts attempt
      join media.processed_objects object on object.object_id = attempt.output_object_id
      where attempt.media_id = $1::uuid and attempt.result = 'passed'`, [unusedId]);
    expect(retainedOutput.rowCount).toBe(1);
    const retainedObject = retainedOutput.rows[0];
    const retainedPath = `/storage/v1/object/media-processed/processed/${portfolioId}/${unusedId}/${String(retainedObject?.object_id)}/${String(retainedObject?.sha256)}.pdf`;
    const retainedPrivateBytes = await storageRequest(retainedPath, { headers: headers(SERVICE_ROLE_KEY!) });
    expect(retainedPrivateBytes.ok).toBe(true);
    const retainedBytes = Buffer.from(await retainedPrivateBytes.arrayBuffer());
    expect(createHash("sha256").update(retainedBytes).digest("hex")).toBe(retainedObject?.sha256);
    const rejectedObjectAnonymousRead = await storageRequest(retainedPath, { headers: headers(ANON_KEY!) });
    expect(rejectedObjectAnonymousRead.status).toBeGreaterThanOrEqual(400);
    const terminalProcessing = await rejectionProcessingByMediaId.get(unusedId)?.record({ actor, mediaId: unusedId,
      expectedVersion: 5, idempotencyKey: "phase6-rejection-reprocess" as never, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: Number((await admin.query(
        "select declared_byte_length from media.assets where media_id = $1::uuid", [unusedId])).rows[0]?.declared_byte_length),
      sha256: String((await admin.query("select declared_sha256 from media.assets where media_id = $1::uuid", [unusedId])).rows[0]?.declared_sha256) });
    expect(terminalProcessing, JSON.stringify(terminalProcessing)).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });

    const pendingBytes = new Uint8Array(readFileSync(PDF_FIXTURE!));
    const pending = await createService().create({ actor, idempotencyKey: "phase6-rejection-pending-upload" as never,
      kind: "document", originalFileName: "pending-rejection.pdf", declaredMediaType: "application/pdf",
      byteLength: pendingBytes.byteLength, sha256: createHash("sha256").update(pendingBytes).digest("hex") });
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("PHASE6_REJECTION_PENDING_UPLOAD_FAILED");
    const processingClaimKeyHash = createHash("sha256").update("phase6-rejection-pending-processing-claim").digest("hex");
    await admin.query(`insert into media.processing_claims
      (portfolio_id, owner_id, media_id, idempotency_key_hash, request_hash, claim_id, lease_expires_at)
      values ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, now() + interval '1 minute')`,
    [portfolioId, ownerId, pending.value.mediaId, processingClaimKeyHash, createHash("sha256").update("processing-claim-request").digest("hex"), createStableId("MediaAsset")]);
    const pendingRejection = await media.rejectOwnerMediaAsset({ actor, mediaId: pending.value.mediaId, expectedVersion: 1,
      idempotencyKey: "phase6-rejection-pending" as never, reason });
    expect(pendingRejection, JSON.stringify(pendingRejection))
      .toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
    expect((await admin.query("select 1 from media.processing_claims where media_id = $1::uuid", [pending.value.mediaId])).rowCount).toBe(0);

    // T12-01 / T12-06: processing has already claimed and sealed this real
    // database candidate when rejection enters its Media-first transaction.
    // The gated usage read holds the Media advisory lock until processing
    // reaches commitAttempt, exercising both sides of the lock order.
    const raceBytes = new Uint8Array(readFileSync(PDF_FIXTURE!));
    const raceHash = createHash("sha256").update(raceBytes).digest("hex");
    const processingRaceUpload = await createService().create({ actor,
      idempotencyKey: "phase6-rejection-processing-race-upload" as never, kind: "document",
      originalFileName: "processing-rejection-race.pdf", declaredMediaType: "application/pdf",
      byteLength: raceBytes.byteLength, sha256: raceHash });
    expect(processingRaceUpload.ok).toBe(true);
    if (!processingRaceUpload.ok) throw new Error("PHASE6_REJECTION_PROCESSING_RACE_UPLOAD_FAILED");
    const raceBaseRepository = createPostgresMediaProcessingRepository({ database: appDatabase.database,
      transactions: appDatabase.transactions, scope: { portfolioId, ownerId } });
    let commitReady!: () => void;
    let allowCommit!: () => void;
    let usageReadStarted!: () => void;
    let allowUsageRead!: () => void;
    const atCommit = new Promise<void>((resolve) => { commitReady = resolve; });
    const commitPermission = new Promise<void>((resolve) => { allowCommit = resolve; });
    const usageEntered = new Promise<void>((resolve) => { usageReadStarted = resolve; });
    const usagePermission = new Promise<void>((resolve) => { allowUsageRead = resolve; });
    let discardedRaceOutput = 0;
    const processingRaceRepository: MediaProcessingRepositoryPort = { ...raceBaseRepository,
      async commitAttempt(command) { commitReady(); await commitPermission; return raceBaseRepository.commitAttempt(command); } };
    const processingRaceService = createMediaProcessingApplicationService({ scope: { ownerId }, repository: processingRaceRepository,
      storage: {
        async readCandidate() { return { ok: true as const, value: raceBytes }; },
        async sealProcessedObject(input) { return { ok: true as const, value: { objectId: input.outputObjectId, sha256: input.sha256 } }; },
        async discardSealedObject() { discardedRaceOutput += 1; },
      },
      scanner: { async scan() { return { ok: true as const, value: { verdict: "clean" as const, version: "phase6-race-scanner" } }; } },
      processor: { async process(input) { return { ok: true as const, value: { bytes: input, version: "phase6-race-processor", policyVersion: "pdf-active-content-deny-1" } }; } },
      digest: { sha256(input) { return createHash("sha256").update(input).digest("hex"); } },
      ids: createSystemIdGenerator(), clock: { now: () => new Date().toISOString() } });
    const processingRace = processingRaceService.record({ actor, mediaId: processingRaceUpload.value.mediaId, expectedVersion: 1,
      idempotencyKey: "phase6-rejection-processing-race-process" as never, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: raceBytes.byteLength, sha256: raceHash });
    await atCommit;
    const rejectionRaceService = createMediaRejectionApplicationService({ scope: { ownerId },
      repository: createPostgresMediaRejectionRepository({ transactions: appDatabase.transactions, scope: { portfolioId, ownerId } }),
      usage: { async getUsage() { usageReadStarted(); await usagePermission; return { ok: true as const,
        value: { hasVisibleContentReference: false, isCurrentCv: false } }; } } });
    const rejectionRace = rejectionRaceService.rejectOwnerMediaAsset({ actor, mediaId: processingRaceUpload.value.mediaId,
      expectedVersion: 1, idempotencyKey: "phase6-rejection-processing-race-reject" as never, reason });
    await usageEntered;
    allowCommit();
    let processingWaitingOnMediaLock = false;
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const waiting = await admin.query(`select count(*)::int as count from pg_locks lock
        join pg_stat_activity activity on activity.pid = lock.pid
        where activity.usename = $1 and lock.locktype = 'advisory' and not lock.granted`, [roleName]);
      if (Number(waiting.rows[0]?.count) > 0) { processingWaitingOnMediaLock = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(processingWaitingOnMediaLock).toBe(true);
    allowUsageRead();
    const [processingRaceResult, processingRejectionRaceResult] = await Promise.all([processingRace, rejectionRace]);
    expect(processingRejectionRaceResult, JSON.stringify(processingRejectionRaceResult)).toMatchObject({ ok: true, value: { aggregateVersion: 2, outcome: "media-rejected" } });
    expect(processingRaceResult).toMatchObject({ ok: false, error: { code: "MEDIA_PROCESSING_CLAIM_EXPIRED" } });
    expect(discardedRaceOutput).toBe(1);
    const processingRaceState = await admin.query(`select state.aggregate_version,
        (select count(*)::int from media.processing_claims where media_id = $1::uuid) as claims,
        (select count(*)::int from media.processing_attempts where media_id = $1::uuid) as attempts,
        (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs,
        (select count(*)::int from media.rejection_history where media_id = $1::uuid) as rejections
      from media.processing_states state where state.media_id = $1::uuid`, [processingRaceUpload.value.mediaId]);
    expect(processingRaceState.rows[0]).toEqual({ aggregate_version: 2, claims: 0, attempts: 0, outputs: 0, rejections: 1 });

    // Current CV use blocks rejection, then switching to another active CV
    // version removes the old media use and makes rejection safe.
    // T12-02 / T12-03: the Current CV protects rejection until replacement is active.
    const currentCvId = await createAcceptedRejectionCandidate("current-cv");
    const replacementCvId = await createAcceptedRejectionCandidate("replacement-cv");
    const cv = await getOwnerCvApplicationService();
    const rejectionState = async (mediaId: StableId<"MediaAsset">) => {
      const state = await admin.query(`select state.aggregate_version,
          (select count(*)::int from media.rejection_history where media_id = $1::uuid) as rejections,
          (select count(*)::int from media.acceptance_commands where media_id = $1::uuid) as receipts,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid) as events
        from media.processing_states state where state.media_id = $1::uuid`, [mediaId]);
      return state.rows[0];
    };
    const cvRoot = await cv.getOwnerCvPortfolio({ actor });
    expect(cvRoot.ok).toBe(true);
    if (!cvRoot.ok) throw new Error("PHASE6_REJECTION_CV_ROOT_UNAVAILABLE");
    const registerCv = async (mediaId: StableId<"MediaAsset">, expectedVersion: number, suffix: string) => {
      const registered = await cv.registerOwnerCvVersion({ actor, mediaId, locale: "en", label: `CV ${suffix}`,
        expectedVersion, idempotencyKey: `phase6-rejection-cv-register-${suffix}` as never });
      expect(registered, JSON.stringify(registered)).toMatchObject({ ok: true });
      if (!registered.ok) throw new Error("PHASE6_REJECTION_CV_REGISTER_FAILED");
      const accepted = await cv.acceptOwnerCvVersion({ actor, versionId: registered.value.versionId,
        expectedVersion: registered.value.aggregateVersion, idempotencyKey: `phase6-rejection-cv-accept-${suffix}` as never });
      expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true });
      if (!accepted.ok) throw new Error("PHASE6_REJECTION_CV_ACCEPT_FAILED");
      const activated = await cv.activateOwnerCvVersion({ actor, versionId: registered.value.versionId,
        expectedVersion: accepted.value.aggregateVersion, idempotencyKey: `phase6-rejection-cv-activate-${suffix}` as never });
      expect(activated, JSON.stringify(activated)).toMatchObject({ ok: true });
      if (!activated.ok) throw new Error("PHASE6_REJECTION_CV_ACTIVATE_FAILED");
      return { versionId: registered.value.versionId, aggregateVersion: activated.value.aggregateVersion };
    };
    const firstCv = await registerCv(currentCvId, cvRoot.value.aggregateVersion, "first");
    const currentCvBeforeBlockedReject = await rejectionState(currentCvId);
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: currentCvId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-current-cv-block" as never, reason }))
      .toMatchObject({ ok: false, error: { code: "MEDIA_IN_USE" } });
    expect(await rejectionState(currentCvId)).toEqual(currentCvBeforeBlockedReject);
    const secondCv = await registerCv(replacementCvId, firstCv.aggregateVersion, "replacement");
    const replacementPortfolio = await cv.getOwnerCvPortfolio({ actor });
    expect(replacementPortfolio).toMatchObject({ ok: true, value: { currentVersionId: secondCv.versionId } });
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: currentCvId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-current-cv-replace" as never, reason }))
      .toMatchObject({ ok: true, value: { outcome: "media-rejected" } });

    // A registered CV that has not yet been approved cannot be approved once
    // its Media asset has been rejected. The failed command must leave the CV
    // root, approval history, receipt, and outbox unchanged.
    const futureCvMediaId = await createAcceptedRejectionCandidate("future-cv-approval");
    const beforeFutureCvPortfolio = await cv.getOwnerCvPortfolio({ actor });
    if (!beforeFutureCvPortfolio.ok) throw new Error("PHASE6_REJECTION_FUTURE_CV_ROOT_UNAVAILABLE");
    const futureCv = await cv.registerOwnerCvVersion({ actor, mediaId: futureCvMediaId, locale: "en", label: "Future CV approval",
      expectedVersion: beforeFutureCvPortfolio.value.aggregateVersion, idempotencyKey: "phase6-rejection-future-cv-register" as never });
    expect(futureCv.ok).toBe(true);
    if (!futureCv.ok) throw new Error("PHASE6_REJECTION_FUTURE_CV_REGISTER_FAILED");
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: futureCvMediaId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-future-cv-reject" as never, reason })).toMatchObject({ ok: true });
    const futureCvBeforeApproval = await cv.getOwnerCvPortfolio({ actor });
    const futureCvHistoryBefore = await admin.query("select count(*)::int as count from cv_portfolio.acceptance_history where version_id = $1::uuid", [futureCv.value.versionId]);
    const futureCvReceiptBefore = await admin.query("select count(*)::int as count from cv_portfolio.acceptance_commands where version_id = $1::uuid", [futureCv.value.versionId]);
    const futureCvOutboxBefore = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type in ('cv.version_accepted.v1', 'cv.current_changed.v1')", [portfolioId]);
    expect(await cv.acceptOwnerCvVersion({ actor, versionId: futureCv.value.versionId, expectedVersion: futureCv.value.aggregateVersion,
      idempotencyKey: "phase6-rejection-future-cv-approve" as never })).toMatchObject({ ok: false, error: { code: "CV_MEDIA_NOT_ELIGIBLE" } });
    expect(await cv.getOwnerCvPortfolio({ actor })).toEqual(futureCvBeforeApproval);
    expect(await admin.query("select count(*)::int as count from cv_portfolio.acceptance_history where version_id = $1::uuid", [futureCv.value.versionId])).toEqual(futureCvHistoryBefore);
    expect(await admin.query("select count(*)::int as count from cv_portfolio.acceptance_commands where version_id = $1::uuid", [futureCv.value.versionId])).toEqual(futureCvReceiptBefore);
    expect(await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type in ('cv.version_accepted.v1', 'cv.current_changed.v1')", [portfolioId])).toEqual(futureCvOutboxBefore);

    // T12-02 / T12-03 / T12-04: visible use blocks, while Hidden, Draft and
    // Archived references do not; restore and later approval still revalidate.
    const contentMediaId = await createAcceptedRejectionCandidate("visible-content");
    const content = createContentService(contentMediaAcceptancePort());
    const publication = await publishContentWithMedia(content, "project", contentMediaId, "phase6-rejection-content");
    const visibleContentBeforeBlockedReject = await rejectionState(contentMediaId);
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: contentMediaId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-visible-block" as never, reason }))
      .toMatchObject({ ok: false, error: { code: "MEDIA_IN_USE" } });
    expect(await rejectionState(contentMediaId)).toEqual(visibleContentBeforeBlockedReject);
    if (!publication.published.ok) throw new Error("PHASE6_REJECTION_CONTENT_PUBLICATION_FAILED");
    const hidden = await content.hideContent({ actor, contentId: publication.contentId,
      expectedVersion: publication.published.value.aggregateVersion, idempotencyKey: "phase6-rejection-hide-content" as never,
      correlationId: "phase6-rejection-hide-content" });
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) throw new Error("PHASE6_REJECTION_CONTENT_HIDE_FAILED");
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: contentMediaId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-hidden-allowed" as never, reason }))
      .toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
    expect(await content.restoreContent({ actor, contentId: publication.contentId, expectedVersion: hidden.value.aggregateVersion,
      idempotencyKey: "phase6-rejection-restore-denied" as never, correlationId: "phase6-rejection-restore-denied" })).toMatchObject({ ok: false });

    const draftMediaId = await createAcceptedRejectionCandidate("draft-reference");
    const draftReference = await createDraftContentWithMedia(content, draftMediaId, "phase6-rejection-draft-reference");
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: draftMediaId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-draft-reference-reject" as never, reason }))
      .toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
    expect(await admin.query("select lifecycle from content.items where content_id = $1::uuid", [draftReference.contentId]))
      .toMatchObject({ rows: [{ lifecycle: "draft" }] });
    const draftPreview = await content.previewRevision({ actor, contentId: draftReference.contentId, revisionId: draftReference.revisionId });
    expect(draftPreview.ok).toBe(true);
    if (!draftPreview.ok) throw new Error("PHASE6_REJECTION_DRAFT_PREVIEW_FAILED");
    const draftReviewed = await content.reviewRevision({ actor, contentId: draftReference.contentId, revisionId: draftReference.revisionId,
      expectedVersion: draftReference.aggregateVersion, idempotencyKey: "phase6-rejection-draft-review" as never,
      correlationId: "phase6-rejection-draft-review", locale: "en", snapshotHash: draftPreview.value.snapshotHash,
      evidenceVersion: draftPreview.value.evidenceVersion, decision: "accepted", findings: [] });
    expect(draftReviewed.ok).toBe(true);
    if (!draftReviewed.ok) throw new Error("PHASE6_REJECTION_DRAFT_REVIEW_FAILED");
    expect(await content.publishLanguageVersion({ actor, contentId: draftReference.contentId,
      expectedVersion: draftReviewed.value.aggregateVersion, idempotencyKey: "phase6-rejection-draft-publish-denied" as never,
      correlationId: "phase6-rejection-draft-publish-denied", locale: "en", revisionId: draftReference.revisionId }))
      .toMatchObject({ ok: false });

    const archivedMediaId = await createAcceptedRejectionCandidate("archived-reference");
    const archivedPublication = await publishContentWithMedia(content, "project", archivedMediaId, "phase6-rejection-archived-reference");
    if (!archivedPublication.published.ok) throw new Error("PHASE6_REJECTION_ARCHIVED_PUBLICATION_FAILED");
    const archived = await content.archiveContent({ actor, contentId: archivedPublication.contentId,
      expectedVersion: archivedPublication.published.value.aggregateVersion, idempotencyKey: "phase6-rejection-archive-reference" as never,
      correlationId: "phase6-rejection-archive-reference" });
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error("PHASE6_REJECTION_ARCHIVE_FAILED");
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: archivedMediaId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-archived-reference-reject" as never, reason }))
      .toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
    expect(await content.restoreContent({ actor, contentId: archivedPublication.contentId, expectedVersion: archived.value.aggregateVersion,
      idempotencyKey: "phase6-rejection-archived-restore-denied" as never, correlationId: "phase6-rejection-archived-restore-denied" }))
      .toMatchObject({ ok: false });

    const futureContentMediaId = await createAcceptedRejectionCandidate("future-content-publication");
    expect(await media.rejectOwnerMediaAsset({ actor, mediaId: futureContentMediaId, expectedVersion: 3,
      idempotencyKey: "phase6-rejection-future-content-reject" as never, reason })).toMatchObject({ ok: true });
    const futureContentBefore = await rejectionState(futureContentMediaId);
    const futurePublication = await publishContentWithMedia(content, "project", futureContentMediaId,
      "phase6-rejection-future-content", undefined, false);
    expect(futurePublication.published).toMatchObject({ ok: false });
    expect(await content.getPublicProject({ slug: "phase6-rejection-future-content-project", locale: "en" })).toMatchObject({ ok: false });
    expect(await rejectionState(futureContentMediaId)).toEqual(futureContentBefore);

    const rollbackMediaId = await createAcceptedRejectionCandidate("rollback", false);
    const rollbackTrigger = `phase6_rejection_fail_${randomBytes(4).toString("hex")}`;
    const rollbackFunction = `${rollbackTrigger}_fn`;
    if (!/^[a-z0-9_]+$/u.test(rollbackTrigger)) throw new Error("PHASE6_REJECTION_TRIGGER_NAME_INVALID");
    await admin.query(`create function operations.${rollbackFunction}() returns trigger language plpgsql as $$ begin
      if new.event_type = 'media.asset_rejected.v1' then raise exception 'phase6 injected rejection outbox failure'; end if;
      return new; end $$`);
    await admin.query(`create trigger ${rollbackTrigger} before insert on operations.outbox_events for each row execute function operations.${rollbackFunction}()`);
    try {
      expect(await media.rejectOwnerMediaAsset({ actor, mediaId: rollbackMediaId, expectedVersion: 2,
        idempotencyKey: "phase6-rejection-rollback" as never, reason }))
        .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
      const rollback = await admin.query(`select state.aggregate_version,
          (select count(*)::int from media.rejection_history where media_id = $1::uuid) as rejections,
          (select count(*)::int from media.acceptance_commands where media_id = $1::uuid and outcome = 'media-rejected') as receipts,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.asset_rejected.v1') as events
        from media.processing_states state where state.media_id = $1::uuid`, [rollbackMediaId]);
      expect(rollback.rows[0]).toEqual({ aggregate_version: 2, rejections: 0, receipts: 0, events: 0 });
    } finally {
      await admin.query(`drop trigger ${rollbackTrigger} on operations.outbox_events`);
      await admin.query(`drop function operations.${rollbackFunction}()`);
    }

    const acceptanceRaceId = await createAcceptedRejectionCandidate("acceptance-race", false);
    const [acceptanceRaceResult, rejectionRaceResult] = await contendAtMediaLock(acceptanceRaceId, [
      () => createAcceptanceService().acceptOwnerMediaAsset({ actor, mediaId: acceptanceRaceId,
        expectedVersion: 2, idempotencyKey: "phase6-rejection-accept-race" as never,
        accessibility: { kind: "document", summary: "A readable one page PDF document." } }),
      () => media.rejectOwnerMediaAsset({ actor, mediaId: acceptanceRaceId, expectedVersion: 2,
        idempotencyKey: "phase6-rejection-command-race" as never, reason }),
    ] as const, false, "Media acceptance versus rejection");
    if (rejectionRaceResult.ok) {
      expect(acceptanceRaceResult).toMatchObject({ ok: false, error: { code: "MEDIA_VERSION_MISMATCH" } });
      expect(await rejectionState(acceptanceRaceId)).toMatchObject({ aggregate_version: 3, rejections: 1, receipts: 1 });
    } else {
      expect(acceptanceRaceResult).toMatchObject({ ok: true, value: { outcome: "media-accepted" } });
      expect(rejectionRaceResult).toMatchObject({ ok: false, error: { code: "MEDIA_VERSION_MISMATCH" } });
      expect(await rejectionState(acceptanceRaceId)).toMatchObject({ aggregate_version: 3, rejections: 0, receipts: 1 });
    }

    const rejectionFirstRaceId = await createAcceptedRejectionCandidate("rejection-first-race", false);
    const [rejectionFirstResult, acceptanceAfterRejectionResult] = await contendAtMediaLock(rejectionFirstRaceId, [
      () => media.rejectOwnerMediaAsset({ actor, mediaId: rejectionFirstRaceId, expectedVersion: 2,
        idempotencyKey: "phase6-rejection-first-race-reject" as never, reason }),
      () => createAcceptanceService().acceptOwnerMediaAsset({ actor, mediaId: rejectionFirstRaceId,
        expectedVersion: 2, idempotencyKey: "phase6-rejection-first-race-accept" as never,
        accessibility: { kind: "document", summary: "A readable one page PDF document." } }),
    ] as const, true, "rejection before Media acceptance");
    expect(rejectionFirstResult).toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
    expect(acceptanceAfterRejectionResult).toMatchObject({ ok: false, error: { code: "MEDIA_VERSION_MISMATCH" } });
    expect(await rejectionState(rejectionFirstRaceId)).toMatchObject({ aggregate_version: 3, rejections: 1, receipts: 1 });

    // Start a rejection from the publish-ready barrier while the real Content
    // publication uses a separate transaction. Shared/exclusive Media locks
    // must serialize the decision with its authoritative current references.
    const raceMediaId = await createAcceptedRejectionCandidate("publish-race");
    let readyToPublish!: () => void;
    let allowPublish!: () => void;
    const publicationReady = new Promise<void>((resolve) => { readyToPublish = resolve; });
    const publishPermission = new Promise<void>((resolve) => { allowPublish = resolve; });
    const pendingPublication = publishContentWithMedia(content, "project", raceMediaId, "phase6-rejection-race", async () => {
      readyToPublish();
      await publishPermission;
    }, false);
    await publicationReady;
    const [raceRejected, racePublication] = await contendAtMediaLock(raceMediaId, [
      () => media.rejectOwnerMediaAsset({ actor, mediaId: raceMediaId, expectedVersion: 3,
        idempotencyKey: "phase6-rejection-race-reject" as never, reason }),
      async () => { allowPublish(); return await pendingPublication; },
    ] as const, true, "Content publication versus rejection");
    const racePublished = racePublication.published;
    expect(racePublished.ok || raceRejected.ok).toBe(true);
    if (racePublished.ok) {
      expect(raceRejected).toMatchObject({ ok: false, error: { code: "MEDIA_IN_USE" } });
      expect(await content.getPublicProject({ slug: "phase6-rejection-race-project", locale: "en" })).toMatchObject({ ok: true });
      expect((await admin.query("select 1 from media.rejection_history where media_id = $1::uuid", [raceMediaId])).rowCount).toBe(0);
    } else {
      expect(raceRejected).toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
      expect(racePublished).toMatchObject({ ok: false, error: { code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
      expect(await content.getPublicProject({ slug: "phase6-rejection-race-project", locale: "en" })).toMatchObject({ ok: false });
      expect((await admin.query("select 1 from media.rejection_history where media_id = $1::uuid", [raceMediaId])).rowCount).toBe(1);
    }

    const restoreRaceMediaId = await createAcceptedRejectionCandidate("restore-race");
    const restoreRacePublication = await publishContentWithMedia(content, "project", restoreRaceMediaId, "phase6-rejection-restore-race");
    if (!restoreRacePublication.published.ok) throw new Error("PHASE6_REJECTION_RESTORE_RACE_PUBLICATION_FAILED");
    const restoreRaceHidden = await content.hideContent({ actor, contentId: restoreRacePublication.contentId,
      expectedVersion: restoreRacePublication.published.value.aggregateVersion,
      idempotencyKey: "phase6-rejection-restore-race-hide" as never, correlationId: "phase6-rejection-restore-race-hide" });
    expect(restoreRaceHidden.ok).toBe(true);
    if (!restoreRaceHidden.ok) throw new Error("PHASE6_REJECTION_RESTORE_RACE_HIDE_FAILED");
    const [restoreRaceResult, rejectDuringRestoreResult] = await contendAtMediaLock(restoreRaceMediaId, [
      () => content.restoreContent({ actor, contentId: restoreRacePublication.contentId,
        expectedVersion: restoreRaceHidden.value.aggregateVersion, idempotencyKey: "phase6-rejection-restore-race-restore" as never,
        correlationId: "phase6-rejection-restore-race-restore" }),
      () => media.rejectOwnerMediaAsset({ actor, mediaId: restoreRaceMediaId, expectedVersion: 3,
        idempotencyKey: "phase6-rejection-restore-race-reject" as never, reason }),
    ] as const, false, "Content restore versus rejection");
    expect(Number(restoreRaceResult.ok) + Number(rejectDuringRestoreResult.ok)).toBe(1);
    if (restoreRaceResult.ok) {
      expect(rejectDuringRestoreResult).toMatchObject({ ok: false, error: { code: "MEDIA_IN_USE" } });
      expect(await admin.query("select lifecycle from content.items where content_id = $1::uuid", [restoreRacePublication.contentId]))
        .toMatchObject({ rows: [{ lifecycle: "published" }] });
      expect((await admin.query("select count(*)::int as count from media.rejection_history where media_id = $1::uuid", [restoreRaceMediaId])).rows[0]?.count).toBe(0);
    } else {
      expect(restoreRaceResult).toMatchObject({ ok: false, error: { code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
      expect(await admin.query("select lifecycle from content.items where content_id = $1::uuid", [restoreRacePublication.contentId]))
        .toMatchObject({ rows: [{ lifecycle: "hidden" }] });
      expect((await admin.query("select count(*)::int as count from media.rejection_history where media_id = $1::uuid", [restoreRaceMediaId])).rows[0]?.count).toBe(1);
    }

    const cvRaceService = createOwnerCvApplicationService({
      ownerId,
      repository: createPostgresCvPortfolioRepository({
        database: appDatabase.database,
        transactions: appDatabase.transactions,
        scope: { portfolioId, ownerId },
        media: createMediaAcceptanceApplicationService({
          scope: { portfolioId, ownerId },
          repository: createPostgresMediaAcceptanceRepository({
            database: appDatabase.database,
            transactions: appDatabase.transactions,
            scope: { portfolioId, ownerId },
          }),
          preflight: async () => ({ ok: true as const, value: undefined }),
        }),
      }),
      ids: createSystemIdGenerator(),
    });
    const cvRaceMediaId = await createAcceptedRejectionCandidate("cv-activation-race");
    const cvRacePortfolio = await cv.getOwnerCvPortfolio({ actor });
    expect(cvRacePortfolio.ok).toBe(true);
    if (!cvRacePortfolio.ok) throw new Error("PHASE6_REJECTION_CV_RACE_ROOT_UNAVAILABLE");
    const cvRegister = await cv.registerOwnerCvVersion({ actor, mediaId: cvRaceMediaId, locale: "en", label: "CV activation race",
      expectedVersion: cvRacePortfolio.value.aggregateVersion, idempotencyKey: "phase6-rejection-cv-race-register" as never });
    expect(cvRegister.ok).toBe(true);
    if (!cvRegister.ok) throw new Error("PHASE6_REJECTION_CV_RACE_REGISTER_FAILED");
    const cvAccept = await cv.acceptOwnerCvVersion({ actor, versionId: cvRegister.value.versionId,
      expectedVersion: cvRegister.value.aggregateVersion, idempotencyKey: "phase6-rejection-cv-race-accept" as never });
    expect(cvAccept.ok).toBe(true);
    if (!cvAccept.ok) throw new Error("PHASE6_REJECTION_CV_RACE_ACCEPT_FAILED");
    const [activationRaceResult, cvRejectionRaceResult] = await contendAtMediaLock(cvRaceMediaId, [
      () => cvRaceService.activateOwnerCvVersion({ actor, versionId: cvRegister.value.versionId,
        expectedVersion: cvAccept.value.aggregateVersion, idempotencyKey: "phase6-rejection-cv-race-activate" as never }),
      () => media.rejectOwnerMediaAsset({ actor, mediaId: cvRaceMediaId, expectedVersion: 3,
        idempotencyKey: "phase6-rejection-cv-race-reject" as never, reason }),
    ] as const, false, "CV activation versus rejection");
    expect(Number(activationRaceResult.ok) + Number(cvRejectionRaceResult.ok)).toBe(1);
    const activationRacePortfolio = await cv.getOwnerCvPortfolio({ actor });
    expect(activationRacePortfolio.ok).toBe(true);
    if (!activationRacePortfolio.ok) throw new Error("PHASE6_REJECTION_CV_RACE_ROOT_UNAVAILABLE");
    if (activationRaceResult.ok) {
      expect(cvRejectionRaceResult).toMatchObject({ ok: false, error: { code: "MEDIA_IN_USE" } });
      expect(activationRacePortfolio.value.currentVersionId).toBe(cvRegister.value.versionId);
      expect((await admin.query("select count(*)::int as count from media.rejection_history where media_id = $1::uuid", [cvRaceMediaId])).rows[0]?.count).toBe(0);
    } else {
      expect(activationRaceResult).toMatchObject({ ok: false, error: { code: "CV_MEDIA_NOT_ELIGIBLE" } });
      expect(cvRejectionRaceResult).toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
      expect(activationRacePortfolio.value.currentVersionId).toBe(secondCv.versionId);
      expect((await admin.query("select count(*)::int as count from media.rejection_history where media_id = $1::uuid", [cvRaceMediaId])).rows[0]?.count).toBe(1);
    }

    const cvAcceptRaceId = await createAcceptedRejectionCandidate("cv-accept-race");
    const cvAcceptRacePortfolio = await cv.getOwnerCvPortfolio({ actor });
    expect(cvAcceptRacePortfolio.ok).toBe(true);
    if (!cvAcceptRacePortfolio.ok) throw new Error("PHASE6_REJECTION_CV_ACCEPT_RACE_ROOT_UNAVAILABLE");
    const cvAcceptRaceRegistration = await cv.registerOwnerCvVersion({ actor, mediaId: cvAcceptRaceId, locale: "en",
      label: "CV acceptance race", expectedVersion: cvAcceptRacePortfolio.value.aggregateVersion,
      idempotencyKey: "phase6-rejection-cv-accept-race-register" as never });
    expect(cvAcceptRaceRegistration.ok).toBe(true);
    if (!cvAcceptRaceRegistration.ok) throw new Error("PHASE6_REJECTION_CV_ACCEPT_RACE_REGISTER_FAILED");
    const [cvAcceptRaceResult, cvRejectDuringAccept] = await contendAtMediaLock(cvAcceptRaceId, [
      () => cvRaceService.acceptOwnerCvVersion({ actor, versionId: cvAcceptRaceRegistration.value.versionId,
        expectedVersion: cvAcceptRaceRegistration.value.aggregateVersion,
        idempotencyKey: "phase6-rejection-cv-accept-race-accept" as never }),
      () => media.rejectOwnerMediaAsset({ actor, mediaId: cvAcceptRaceId, expectedVersion: 3,
        idempotencyKey: "phase6-rejection-cv-accept-race-reject" as never, reason }),
    ] as const, true, "CV acceptance versus rejection");
    expect(cvRejectDuringAccept).toMatchObject({ ok: true, value: { outcome: "media-rejected" } });
    const cvAcceptRacePortfolioAfter = await cv.getOwnerCvPortfolio({ actor });
    expect(cvAcceptRacePortfolioAfter).toMatchObject({ ok: true });
    if (!cvAcceptRacePortfolioAfter.ok) throw new Error("PHASE6_REJECTION_CV_ACCEPT_RACE_ROOT_UNAVAILABLE");
    expect(cvAcceptRacePortfolioAfter.value.currentVersionId).toBe(cvAcceptRacePortfolio.value.currentVersionId);
    if (cvAcceptRaceResult.ok) {
      const activationAfterRejectedMedia = await cv.activateOwnerCvVersion({ actor, versionId: cvAcceptRaceRegistration.value.versionId,
        expectedVersion: cvAcceptRaceResult.value.aggregateVersion,
        idempotencyKey: "phase6-rejection-cv-accept-race-activate-after-reject" as never });
      expect(activationAfterRejectedMedia).toMatchObject({ ok: false, error: { code: "CV_MEDIA_NOT_ELIGIBLE" } });
    } else {
      expect(cvAcceptRaceResult).toMatchObject({ ok: false, error: { code: "CV_MEDIA_NOT_ELIGIBLE" } });
    }

    mediaProcessingCounts.mediaRejectionScenarios = [
      { id: "T12-01", name: "Pending and accepted unused Media rejects; rejected state and history persist and future processing/acceptance fails." },
      { id: "T12-02", name: "Visible Content locale and Current CV use return MEDIA_IN_USE with no rejection mutation." },
      { id: "T12-03", name: "Hiding and archiving Content and activating a replacement Current CV remove the affected use." },
      { id: "T12-04", name: "Draft, Hidden, and Archived references allow rejection; publish, restore, and CV approval revalidate rejected Media." },
      { id: "T12-05", name: "Decision, version, receipt, and event commit atomically; injected failure rolls back and exact replay survives later version changes." },
      { id: "T12-06", name: "Independent publication, restore, CV acceptance, and activation races with rejection serialize to valid outcomes." },
      { id: "T12-07", name: "Accept/reject concurrency, changed-hash reuse, stale versions, and terminal transitions fail safely." },
      { id: "T12-08", name: "Current authoritative usage reads protect writes; retained objects stay private and capability expiry is documented." },
      { id: "T12-09", name: "Private rejection reason is absent from public event data and errors expose safe codes only." },
    ].map((scenario) => ({ ...scenario, executed: true, status: "passed" as const }));
    if (PROCESSING_COUNTS_FILE) writeFileSync(PROCESSING_COUNTS_FILE, JSON.stringify(mediaProcessingCounts));
  }, 600_000);

  function ownerService(uploadIntents: ReturnType<typeof createService>) {
    return {
      ...createProductionOwnerMediaService(),
      createOwnerMediaUploadIntent: uploadIntents.create,
    };
  }

  function ownerSecurity() {
    const stub = createOwnerSecurityTestStub({
      type: "allow",
      actor: { kind: "owner", ownerId, sessionId: "phase6-upload-intent-owner" },
    });
    return { ...stub, appOrigin: "https://example.com" };
  }

  function uploadRequest(key: string, originalFileName = "../../private/\u0001resume.png"): Request {
    return new Request("https://example.com/api/owner/v1/media/upload-intents", {
      method: "POST",
      headers: withOwnerTestAuth({ "content-type": "application/json", "idempotency-key": key }),
      body: JSON.stringify({
        kind: "image",
        originalFileName,
        declaredMediaType: mimeType,
        byteLength: bytes.byteLength,
        sha256,
      }),
    });
  }

  async function issue(key: string, originalFileName?: string, service = createService()): Promise<Response> {
    return await handleCreateOwnerMediaUploadIntent(
      uploadRequest(key, originalFileName),
      { service: ownerService(service), security: ownerSecurity() },
    );
  }

  async function storageRequest(path: string, init?: RequestInit): Promise<Response> {
    return await fetch(new URL(path, storageBase), init);
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL! });
    await admin.connect();
    roleName = `phase6_upload_${process.pid}_${randomBytes(3).toString("hex")}`;
    const password = randomBytes(32).toString("hex");
    await admin.query(`create role ${quoteTestRole(roleName)} login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query(`grant shipwithali_application to ${quoteTestRole(roleName)}`);
    const appUrl = new URL(DATABASE_URL!);
    appUrl.username = roleName;
    appUrl.password = password;
    applicationDatabaseUrl = appUrl.toString();
    appDatabase = createPostgresRuntimeDatabase(appUrl.toString());
    appClient = new Client({ connectionString: appUrl.toString() });
    await appClient.connect();
    storageBase = STORAGE_URL!.replace(/\/$/, "");
    ownerId = createStableId("Owner");
    portfolioId = createStableId("Portfolio");
    const settings = createPortfolioSettingsService({
      repository: createPostgresPortfolioSettingsRepository(),
      transactions: appDatabase.transactions,
      scope: { ownerId, portfolioId },
    });
    const provisioned = await settings.provision({
      profile: { displayName: "Media Upload Test Owner", headline: "Private Media integration", bio: "Disposable local fixture." },
      contactChannels: [{ channel: "email", label: "Email", destination: "mailto:media-test@example.invalid", availableLocales: ["en"] }],
      globalCta: { label: "Contact", destination: "https://example.invalid/contact", unavailableFallback: "Unavailable" },
    });
    expect(provisioned.ok).toBe(true);
    await initializeDatabaseRuntime({
      NODE_ENV: "test",
      APP_BASE_URL: "https://portfolio.example.test",
      DATABASE_URL: applicationDatabaseUrl,
      PORTFOLIO_ID: portfolioId,
      OWNER_ID: ownerId,
      SUPABASE_URL: STORAGE_URL!,
      SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY!,
      MEDIA_UPLOAD_REPLAY_ENCRYPTION_KEY: REPLAY_KEY!,
    }, "application");
    databaseRuntimeInitialized = true;
    const realFetch = fetch;
    targetAdapter = createSupabaseMediaUploadTargetAdapter({
      storageUrl: STORAGE_URL!,
      serviceRoleKey: SERVICE_ROLE_KEY!,
      fetcher: async (input, init) => {
        if (new URL(input.toString()).pathname.includes("/object/upload/sign/")) signingCalls += 1;
        const response = await realFetch(input, init);
        if (!response.ok) {
          const path = new URL(input.toString()).pathname;
          const detail = (await response.clone().text()).replace(/https?:\/\/\S+/gu, "[url]").replace(/(?:Bearer\s+|token=|apikey[=: ]+)\S+/giu, "[credential]").slice(0, 120);
          lastStorageFailure = `${path.includes("/object/upload/sign/") ? "sign" : path.includes("/storage/v1/bucket") ? "bucket" : "other"}:${response.status}:${detail}`;
        }
        return response;
      },
      now: () => appNow,
    });
  }, 60_000);

  afterAll(async () => {
    if (databaseRuntimeInitialized) {
      await getLifecycleCoordinator().shutdown();
      resetRuntimeForTests();
    }
    if (appClient !== undefined) await appClient.end();
    if (appDatabase !== undefined) await appDatabase.resource.close();
    if (admin !== undefined) {
      let cleanupFailed = false;
      try { await admin.query(`alter role ${quoteTestRole(roleName)} nologin`); } catch { cleanupFailed = true; }
      try { await admin.query(`drop role if exists ${quoteTestRole(roleName)}`); } catch { cleanupFailed = true; }
      await admin.end();
      if (cleanupFailed) throw new Error("PHASE6_UPLOAD_INTENT_ROLE_CLEANUP_FAILED");
    }
  });

  it("commits a scoped candidate and replays the same encrypted target without re-signing", async () => {
    const cvService = await getOwnerCvApplicationService();
    for (let round = 0; round < 10; round += 1) {
      await admin.query("delete from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId]);
      const readCodes: string[] = [];
      const observedService = { ...cvService, async getOwnerCvPortfolio(query: Parameters<typeof cvService.getOwnerCvPortfolio>[0]) {
        const result = await cvService.getOwnerCvPortfolio(query);
        readCodes.push(result.ok ? "ok" : result.error.code);
        return result;
      } };
      const responses = await Promise.all([0, 1].map(() => handleGetOwnerCvPortfolio(new Request("https://example.com/api/owner/v1/cv", {
        headers: withOwnerTestAuth({}),
      }), { service: observedService, security: ownerSecurity() })));
      const statuses = responses.map((response) => response.status);
      expect(statuses, `T09-01 concurrent root initialization: ${JSON.stringify({ round, statuses, readCodes })}`).toEqual([200, 200]);
      const roots = await admin.query("select count(*)::int as count from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId]);
      expect(roots.rows[0]?.count).toBe(1);
    }
    const key = `phase6-upload-intent-${randomBytes(16).toString("hex")}`;
    const service = createService();
    const first = await issue(key, undefined, service);
    expect(first.status, `storage=${lastStorageFailure ?? "none"}; body=${JSON.stringify(await first.clone().json())}`).toBe(201);
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    const firstBody = await first.json() as Record<string, unknown>;
    expect(signingCalls).toBe(1);
    const target = String(firstBody["uploadTarget"]);
    expect(target).toContain("/candidate/");
    expect(target).not.toContain("resume.png");
    const replay = await issue(key, undefined, service);
    expect(replay.status).toBe(201);
    const replayBody = await replay.json();
    expect(replayBody).toEqual(firstBody);
    expect(signingCalls).toBe(1);

    appNow += 3 * 60 * 60 * 1000;
    const expiredReplay = await issue(key, undefined, service);
    expect(expiredReplay.status).toBe(201);
    expect(await expiredReplay.json()).toEqual(firstBody);
    expect(signingCalls).toBe(1);

    const conflict = await issue(key, "different-name.png", service);
    expect(conflict.status).toBe(409);
    expect(signingCalls).toBe(1);

    const mediaId = String(firstBody["mediaId"]);
    const intentId = String(firstBody["uploadIntentId"]);
    const persisted = await admin.query(
      `select asset.original_file_name, asset.declared_media_type, asset.declared_byte_length,
              asset.declared_sha256, asset.lifecycle, asset.aggregate_version,
              command.safe_receipt::text as safe_receipt,
              encode(capability.ciphertext, 'base64') as ciphertext
         from media.assets asset
         join media.upload_intents intent on intent.media_id = asset.media_id
         join media.upload_intent_commands command on command.upload_intent_id = intent.upload_intent_id
         join media.upload_intent_capabilities capability on capability.upload_intent_id = intent.upload_intent_id
        where asset.portfolio_id = $1::uuid and asset.owner_id = $2::uuid
          and asset.media_id = $3::uuid and intent.upload_intent_id = $4::uuid`,
      [portfolioId, ownerId, mediaId, intentId],
    );
    expect(persisted.rowCount).toBe(1);
    expect(persisted.rows[0]?.original_file_name).toBe("../../private/\u0001resume.png");
    expect(persisted.rows[0]?.lifecycle).toBe("candidate");
    expect(persisted.rows[0]?.aggregate_version).toBe(1);
    expect(persisted.rows[0]?.safe_receipt).not.toContain("uploadTarget");
    expect(persisted.rows[0]?.safe_receipt).not.toContain("token");
    expect(persisted.rows[0]?.ciphertext).not.toContain(new URL(target).searchParams.get("token"));

    await appClient.query("begin");
    await appClient.query("select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true)", [portfolioId, ownerId]);
    const scoped = await appClient.query("select media_id::text from media.assets where media_id = $1::uuid", [mediaId]);
    expect(scoped.rowCount).toBe(1);
    await appClient.query("select set_config('shipwithali.portfolio_id', $1, true)", [createStableId("Portfolio")]);
    const foreignPortfolio = await appClient.query("select media_id::text from media.assets where media_id = $1::uuid", [mediaId]);
    expect(foreignPortfolio.rowCount).toBe(0);
    await appClient.query("select set_config('shipwithali.portfolio_id', $1, true)", [portfolioId]);
    await appClient.query("select set_config('shipwithali.owner_id', $1, true)", [createStableId("Owner")]);
    const foreignScope = await appClient.query("select media_id::text from media.assets where media_id = $1::uuid", [mediaId]);
    expect(foreignScope.rowCount).toBe(0);
    await appClient.query("rollback");

    const signingCallsBeforeInvalidName = signingCalls;
    const invalidName = await issue(`phase6-upload-intent-nul-${randomBytes(16).toString("hex")}`, "bad\u0000name.png", service);
    expect(invalidName.status).toBe(422);
    expect(signingCalls).toBe(signingCallsBeforeInvalidName);
  });

  it("allows the exact scoped signed upload and denies anonymous and non-Owner Storage reads/writes", async () => {
    const key = `phase6-upload-storage-${randomBytes(16).toString("hex")}`;
    const response = await issue(key);
    expect(response.status, `storage=${lastStorageFailure ?? "none"}; body=${JSON.stringify(await response.clone().json())}`).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    const target = new URL(String(body["uploadTarget"]));
    const objectPath = target.pathname.split("/object/upload/sign/media-candidates/")[1];
    expect(objectPath).toBeDefined();
    const objectUrl = `/storage/v1/object/media-candidates/${objectPath}`;

    const anonymousWrite = await storageRequest(objectUrl, {
      method: "POST", headers: { ...headers(ANON_KEY!), "content-type": mimeType }, body: bytes,
    });
    expect(anonymousWrite.status).toBeGreaterThanOrEqual(400);

    const ownerSignedWrite = await fetch(target, {
      method: "PUT",
      headers: { "content-type": mimeType, "cache-control": "max-age=3600", "x-upsert": "false" },
      body: bytes,
    });
    expect([200, 201].includes(ownerSignedWrite.status), `signed-upload-status=${ownerSignedWrite.status}; body=${JSON.stringify(await ownerSignedWrite.clone().json())}`).toBe(true);

    const targetAgain = await fetch(target, {
      method: "PUT", headers: { "content-type": mimeType, "x-upsert": "false" }, body: bytes,
    });
    expect(targetAgain.status, `replay-upload-status=${targetAgain.status}`).toBeGreaterThanOrEqual(400);

    const altered = new URL(target);
    altered.pathname = altered.pathname.replace(/[^/]+$/u, "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7fff");
    const secondObject = await fetch(altered, { method: "PUT", headers: { "content-type": mimeType }, body: bytes });
    expect(secondObject.status, `altered-object-status=${secondObject.status}`).toBeGreaterThanOrEqual(400);

    const userEmail = `media-non-owner-${randomBytes(5).toString("hex")}@example.invalid`;
    const userPassword = randomBytes(18).toString("base64url");
    const createdUser = await storageRequest("/auth/v1/admin/users", {
      method: "POST",
      headers: { ...headers(SERVICE_ROLE_KEY!), "content-type": "application/json" },
      body: JSON.stringify({ email: userEmail, password: userPassword, email_confirm: true }),
    });
    expect([200, 201].includes(createdUser.status)).toBe(true);
    const signedIn = await storageRequest("/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: ANON_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ email: userEmail, password: userPassword }),
    });
    expect(signedIn.status, JSON.stringify(await signedIn.clone().json())).toBe(200);
    const auth = await signedIn.json() as Record<string, unknown>;
    expect(typeof auth["access_token"]).toBe("string");
    const nonOwnerHeaders = { apikey: ANON_KEY!, authorization: `Bearer ${String(auth["access_token"])}` };
    const nonOwnerRead = await storageRequest(objectUrl, { headers: nonOwnerHeaders });
    expect(nonOwnerRead.status).toBeGreaterThanOrEqual(400);
    const nonOwnerWrite = await storageRequest(objectUrl, {
      method: "POST", headers: { ...nonOwnerHeaders, "content-type": mimeType }, body: bytes,
    });
    expect(nonOwnerWrite.status).toBeGreaterThanOrEqual(400);
    const anonymousRead = await storageRequest(objectUrl, { headers: headers(ANON_KEY!) });
    expect(anonymousRead.status).toBeGreaterThanOrEqual(400);
    const anonymousList = await storageRequest("/storage/v1/object/list/media-candidates", {
      method: "POST", headers: { ...headers(ANON_KEY!), "content-type": "application/json" },
      body: JSON.stringify({ prefix: objectPath, limit: 10, offset: 0 }),
    });
    const listed = anonymousList.ok ? await anonymousList.json() as unknown : undefined;
    expect(anonymousList.status >= 400 || (Array.isArray(listed) && listed.length === 0)).toBe(true);
    const anonymousDelete = await storageRequest("/storage/v1/object/media-candidates", {
      method: "DELETE", headers: { ...headers(ANON_KEY!), "content-type": "application/json" },
      body: JSON.stringify({ prefixes: [objectPath] }),
    });
    // Supabase Storage returns 200 when RLS filters all anonymous delete rows; verify the object is unchanged below.
    expect(anonymousDelete.status).toBe(200);
    const retained = await storageRequest(objectUrl, { headers: headers(SERVICE_ROLE_KEY!) });
    expect(retained.ok).toBe(true);
    expect(Buffer.from(await retained.arrayBuffer())).toEqual(bytes);
  });

  it("rolls back a failed candidate commit and idempotently removes its expired private orphan", async () => {
    const priorCount = await admin.query(
      "select count(*)::int as count from media.assets where portfolio_id = $1::uuid and owner_id = $2::uuid",
      [portfolioId, ownerId],
    );
    const suffix = randomBytes(3).toString("hex");
    const functionName = `test_upload_intent_fail_${suffix}`;
    const triggerName = `test_upload_intent_fail_${suffix}`;
    await admin.query(`create function media.${functionName}() returns trigger language plpgsql as $$ begin if new.owner_id = '${ownerId}'::uuid then raise exception 'UPLOAD_INTENT_COMMIT_INJECTED'; end if; return new; end $$`);
    await admin.query(`create trigger ${triggerName} before insert on media.assets for each row execute function media.${functionName}()`);
    let uploadedPath: string | undefined;
    const faultTarget = {
      async prepare(input: Parameters<typeof targetAdapter.prepare>[0]) {
        const prepared = await targetAdapter.prepare(input);
        if (!prepared.ok) return prepared;
        const target = new URL(prepared.value.uploadTarget);
        uploadedPath = target.pathname.split("/object/upload/sign/media-candidates/")[1];
        const upload = await fetch(target, { method: "PUT", headers: { "content-type": mimeType, "x-upsert": "false" }, body: bytes });
        expect([200, 201].includes(upload.status)).toBe(true);
        return prepared;
      },
      async removeAbandoned(input: Parameters<typeof targetAdapter.removeAbandoned>[0]) {
        return await targetAdapter.removeAbandoned(input);
      },
    };
    const key = `phase6-upload-commit-fault-${randomBytes(16).toString("hex")}`;
    const response = await issue(key, undefined, createService(faultTarget));
    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("uploadTarget");
    expect(body).not.toContain("token=");

    await appClient.query("select set_config('shipwithali.portfolio_id', $1, false), set_config('shipwithali.owner_id', $2, false)", [portfolioId, ownerId]);
    await appClient.query(
      `update media.upload_intent_commands set reservation_expires_at = $1::timestamptz
        where portfolio_id = $2::uuid and owner_id = $3::uuid and idempotency_key_hash = $4`,
      [new Date(appNow - 1000).toISOString(), portfolioId, ownerId, createHash("sha256").update(key).digest("hex")],
    );
    appNow += 3 * 60 * 60 * 1000;
    const reconciled = await createService().reconcileAbandoned();
    expect(reconciled).toEqual({ ok: true, value: { reconciled: 1 } });
    expect(uploadedPath).toBeDefined();
    const afterCleanup = await storageRequest(`/storage/v1/object/media-candidates/${uploadedPath}`, { headers: headers(SERVICE_ROLE_KEY!) });
    expect(afterCleanup.status).toBeGreaterThanOrEqual(400);
    const noRoot = await admin.query(
      "select count(*)::int as count from media.assets where portfolio_id = $1::uuid and owner_id = $2::uuid",
      [portfolioId, ownerId],
    );
    expect(noRoot.rows[0]?.count).toBe(priorCount.rows[0]?.count);

    await admin.query(`drop trigger ${triggerName} on media.assets`);
    await admin.query(`drop function media.${functionName}()`);
  });

  it("processes PDF candidates and real PNG JPEG WebP images through PostgreSQL, private Storage, ClamAV and trusted processors", async () => {
    appNow = Date.now();
    const updatePrivileges = await admin.query(`
      select has_column_privilege('shipwithali_application', 'media.processing_states', 'media_id', 'UPDATE') as state_identity,
             has_column_privilege('shipwithali_application', 'media.processing_states', 'aggregate_version', 'UPDATE') as state_version,
             has_column_privilege('shipwithali_application', 'media.processing_orphans', 'object_id', 'UPDATE') as orphan_identity,
             has_column_privilege('shipwithali_application', 'media.processing_orphans', 'state', 'UPDATE') as orphan_state,
             has_column_privilege('shipwithali_application', 'media.processing_claims', 'portfolio_id', 'UPDATE') as claim_identity,
             has_column_privilege('shipwithali_application', 'media.processing_claims', 'lease_expires_at', 'UPDATE') as claim_lease
    `);
    expect(updatePrivileges.rows[0]).toEqual({ state_identity: false, state_version: true, orphan_identity: false,
      orphan_state: true, claim_identity: false, claim_lease: true });
    const processedFiles: Uint8Array[] = [];
    let scannerExecutions = 0;
    let processorExecutions = 0;
    let imageProcessorExecutions = 0;
    const uploadPdf = async (payload: Uint8Array, suffix: string, originalFileName = `candidate-${suffix}.pdf`, uploadBytes = true, uploadPayload = payload) => {
      const uploadService = createService();
      const issued = await uploadService.create({
        actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
        idempotencyKey: `phase6-pdf-${suffix}-${randomBytes(12).toString("hex")}` as never,
        kind: "document", originalFileName, declaredMediaType: "application/pdf",
        byteLength: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(issued.ok, JSON.stringify({ issued, storage: lastStorageFailure ?? null })).toBe(true);
      if (!issued.ok) throw new Error("PHASE6_PDF_UPLOAD_INTENT_FAILED");
      if (uploadBytes) {
        const uploaded = await fetch(issued.value.uploadTarget, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: Buffer.from(uploadPayload) });
        expect([200, 201].includes(uploaded.status)).toBe(true);
      }
      return issued.value;
    };
    const uploadImage = async (payload: Uint8Array, imageMimeType: "image/png" | "image/jpeg" | "image/webp", suffix: string, originalFileName = `candidate-${suffix}.${imageMimeType === "image/jpeg" ? "jpeg" : imageMimeType.slice("image/".length)}`) => {
      const uploadService = createService();
      const issued = await uploadService.create({
        actor: { kind: "owner", ownerId, sessionId: "phase6-image-processing-owner" },
        idempotencyKey: `phase6-image-${suffix}-${randomBytes(12).toString("hex")}` as never,
        kind: "image", originalFileName, declaredMediaType: imageMimeType,
        byteLength: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(issued.ok, JSON.stringify({ issued, storage: lastStorageFailure ?? null })).toBe(true);
      if (!issued.ok) throw new Error("PHASE6_IMAGE_UPLOAD_INTENT_FAILED");
      const uploaded = await fetch(issued.value.uploadTarget, { method: "PUT", headers: { "content-type": imageMimeType, "x-upsert": "false" }, body: Buffer.from(payload) });
      expect([200, 201].includes(uploaded.status)).toBe(true);
      return issued.value;
    };
    const normalProcessingStorage = createSupabaseMediaProcessingStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: SERVICE_ROLE_KEY! });
    const realProcessor = { async process(input: Uint8Array) { processorExecutions += 1; const result = dockerPdfProcessor(input); if (result.ok) processedFiles.push(result.value.bytes); return result; } };
    const { createSharpMediaImageProcessor } = await import("../../src/runtime/adapters/media-image-processing.js");
    const sharpProcessor = createSharpMediaImageProcessor();
    const realImageProcessor: MediaImageProcessorPort = { async process(input, detectedMimeType) {
      imageProcessorExecutions += 1;
      return await sharpProcessor.process(input, detectedMimeType);
    } };
    const realScanner: TrustedByteScannerPort = {
        async scan(input: Uint8Array, options?: { readonly timeoutMs?: number }) { scannerExecutions += 1; return dockerScanner(input, options?.timeoutMs); },
        async scanMany(inputs: readonly Uint8Array[], options?: { readonly timeoutMs?: number }) { scannerExecutions += inputs.length; return dockerScannerMany(inputs, options?.timeoutMs); },
      };
    const makeMediaProcessing = (storage = normalProcessingStorage, processor: PdfProcessorPort = realProcessor,
      scanner: TrustedByteScannerPort = realScanner,
      repositoryOverride?: ReturnType<typeof createPostgresMediaProcessingRepository>, imageProcessor: MediaImageProcessorPort = realImageProcessor) => createMediaProcessingApplicationService({
      scope: { ownerId }, repository: repositoryOverride ?? createPostgresMediaProcessingRepository({
        database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId },
      }),
      storage,
      scanner,
      processor,
      imageProcessor,
      digest: { sha256(input) { return createHash("sha256").update(input).digest("hex"); } },
      ids: createSystemIdGenerator(), clock: { now: () => new Date(appNow).toISOString() },
    });
    const mediaProcessing = makeMediaProcessing();

    if (Object.values(IMAGE_FIXTURES).every((path) => Boolean(path))) {
      for (const [imageMimeType, fixturePath] of Object.entries(IMAGE_FIXTURES) as ["image/png" | "image/jpeg" | "image/webp", string][]) {
        const imageBytes = new Uint8Array(readFileSync(fixturePath));
        const image = await uploadImage(imageBytes, imageMimeType, imageMimeType.slice("image/".length));
        const imageSha = createHash("sha256").update(imageBytes).digest("hex");
        const imageCommand = { actor: { kind: "owner" as const, ownerId, sessionId: "phase6-image-processing-owner" },
          idempotencyKey: `phase6-image-process-${imageMimeType.replace("/", "-")}-${randomBytes(8).toString("hex")}` as never,
          mediaId: image.mediaId, expectedVersion: 1, result: "passed" as const, detectedMediaType: imageMimeType,
          detectedByteLength: imageBytes.byteLength, sha256: imageSha };
        const scannerCountBefore = scannerExecutions;
        const processorCountBefore = imageProcessorExecutions;
        expect(await mediaProcessing.record(imageCommand)).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
        expect(await mediaProcessing.record(imageCommand)).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
        expect(scannerExecutions - scannerCountBefore).toBe(3);
        expect(imageProcessorExecutions - processorCountBefore).toBe(1);
        const persistedVariants = await admin.query(
        `select variant.variant_name, variant.width, variant.height, variant.source_sha256, attempt.processing_duration_ms,
                  object.object_id::text, object.sha256, object.byte_length, object.mime_type
             from media.processing_attempt_variants variant
             join media.processed_objects object on object.object_id = variant.object_id
             join media.processing_attempts attempt on attempt.attempt_id = variant.attempt_id
            where attempt.portfolio_id = $1::uuid and attempt.owner_id = $2::uuid and attempt.media_id = $3::uuid
            order by variant.variant_name`,
          [portfolioId, ownerId, image.mediaId],
        );
        expect(persistedVariants.rowCount).toBe(2);
        expect(persistedVariants.rows.map((row) => row.variant_name)).toEqual(["display", "thumbnail"]);
        for (const variant of persistedVariants.rows) {
          expect(variant.mime_type).toBe("image/webp");
          expect(Number(variant.processing_duration_ms)).toBeGreaterThanOrEqual(0);
          expect(Number(variant.processing_duration_ms)).toBeLessThan(60_000);
          expect(variant.source_sha256).toBe(imageSha);
          expect(Number(variant.width)).toBeGreaterThan(0);
          expect(Number(variant.height)).toBeGreaterThan(0);
          const variantPath = `/storage/v1/object/media-processed/processed/${portfolioId}/${image.mediaId}/${variant.object_id}/${variant.sha256}.webp`;
          const downloadedVariant = await storageRequest(variantPath, { headers: headers(SERVICE_ROLE_KEY!) });
          expect(downloadedVariant.ok).toBe(true);
          const variantBytes = new Uint8Array(await downloadedVariant.arrayBuffer());
          expect(createHash("sha256").update(variantBytes).digest("hex")).toBe(variant.sha256);
          const anonymousVariant = await storageRequest(variantPath, { headers: headers(ANON_KEY!) });
          expect(anonymousVariant.status).toBeGreaterThanOrEqual(400);
          const overwriteVariant = await storageRequest(variantPath, { method: "POST", headers: { ...headers(SERVICE_ROLE_KEY!), "content-type": "image/webp", "x-upsert": "false" }, body: variantBytes });
          expect(overwriteVariant.status).toBeGreaterThanOrEqual(400);
        }
        const replayed = await admin.query("select count(*)::int as attempts from media.processing_attempts where media_id = $1::uuid", [image.mediaId]);
        expect(replayed.rows[0]?.attempts).toBe(1);
        const freshKeyReprocessing = await mediaProcessing.record({ ...imageCommand,
          idempotencyKey: `phase6-image-fresh-${randomBytes(8).toString("hex")}` as never });
        expect(freshKeyReprocessing.ok).toBe(false);
        if (!freshKeyReprocessing.ok) expect(["conflict", "precondition_failed"]).toContain(freshKeyReprocessing.error.kind);
        const uploadTargetSubstitution = new URL(image.uploadTarget);
        uploadTargetSubstitution.pathname = uploadTargetSubstitution.pathname.replace("/object/upload/sign/media-candidates/candidate/", "/object/upload/sign/media-processed/processed/");
        const substitutedUpload = await fetch(uploadTargetSubstitution, { method: "PUT", headers: { "content-type": "image/webp", "x-upsert": "false" }, body: Buffer.from("substitute") });
        expect(substitutedUpload.status).toBeGreaterThanOrEqual(400);
        const accepted = await acceptAndVerify(image.mediaId as StableId<"MediaAsset">,
          imageMimeType === "image/jpeg" ? { kind: "decorative-image" } : { kind: "described-image", altText: `A ${imageMimeType} image` },
          imageMimeType.replace("/", "-"));
        const scansBeforeReprocess = scannerExecutions;
        const afterAcceptance = await mediaProcessing.record({ ...imageCommand, expectedVersion: 3,
          idempotencyKey: `phase6-image-post-accept-${randomBytes(8).toString("hex")}` as never });
        expect(afterAcceptance).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
        expect(scannerExecutions).toBe(scansBeforeReprocess);
        if (imageMimeType === "image/jpeg") {
          const meaningfulFacts = await appDatabase.transactions.run((transaction) => accepted.acceptance.getAcceptanceFacts({
            ownerId, mediaAssetIds: [image.mediaId as StableId<"MediaAsset">], intendedUse: "supporting-artifact",
          }, transaction));
          expect(meaningfulFacts).toMatchObject({ ok: true, value: [{ accepted: true, safe: true, suitable: true, accessible: false }] });
        }
      }
    }
    if (REQUIRE_IMAGES) {
      const retryBytes = new Uint8Array(readFileSync(IMAGE_FIXTURES["image/png"]!));
      const retryCandidate = await uploadImage(retryBytes, "image/png", "retryable-failure");
      let failFirstScan = true;
      const retryScanner: TrustedByteScannerPort = {
        async scan(input, options) {
          if (failFirstScan) {
            failFirstScan = false;
            return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_SCANNER_UNAVAILABLE" } };
          }
          return realScanner.scan(input, options);
        },
        scanMany: (inputs, options) => realScanner.scanMany!(inputs, options),
      };
      const retryService = makeMediaProcessing(normalProcessingStorage, realProcessor, retryScanner);
      const retryCommand = { actor: { kind: "owner" as const, ownerId, sessionId: "phase6-image-processing-owner" },
        mediaId: retryCandidate.mediaId, expectedVersion: 1, result: "passed" as const, detectedMediaType: "image/png",
        detectedByteLength: retryBytes.byteLength, sha256: createHash("sha256").update(retryBytes).digest("hex") };
      const firstRetry = await retryService.record({ ...retryCommand, idempotencyKey: `phase6-image-retry-failed-${randomBytes(8).toString("hex")}` as never });
      expect(firstRetry).toMatchObject({ ok: false, error: { code: "MEDIA_SCANNER_UNAVAILABLE" } });
      const secondRetry = await retryService.record({ ...retryCommand, expectedVersion: 2, idempotencyKey: `phase6-image-retry-fresh-${randomBytes(8).toString("hex")}` as never });
      expect(secondRetry).toMatchObject({ ok: true, value: { aggregateVersion: 3 } });
      const retryFacts = await admin.query(
        `select (select count(*)::int from media.processing_attempts where media_id = $1::uuid) as attempts,
                (select count(*)::int from media.processing_attempts where media_id = $1::uuid and result = 'passed') as passed,
                (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs`,
        [retryCandidate.mediaId],
      );
      expect(retryFacts.rows[0]).toEqual({ attempts: 2, passed: 1, outputs: 2 });

      const staleBytes = new Uint8Array(readFileSync(IMAGE_FIXTURES["image/png"]!));
      const staleCandidate = await uploadImage(staleBytes, "image/png", "stale-commit");
      const staleOutputs: { readonly objectId: StableId<"MediaObject">; readonly sha256: string }[] = [];
      const staleStorage = {
        preflightAcceptedPdfObject: normalProcessingStorage.preflightAcceptedPdfObject,
        readCandidate: (input: Parameters<typeof normalProcessingStorage.readCandidate>[0]) => normalProcessingStorage.readCandidate(input),
        async sealProcessedObject(input: Parameters<typeof normalProcessingStorage.sealProcessedObject>[0]) {
          const result = await normalProcessingStorage.sealProcessedObject(input);
          if (result.ok) staleOutputs.push({ objectId: result.value.objectId as StableId<"MediaObject">, sha256: result.value.sha256 });
          return result;
        },
        discardSealedObject: (input: Parameters<typeof normalProcessingStorage.discardSealedObject>[0]) => normalProcessingStorage.discardSealedObject(input),
      };
      const staleBaseRepository = createPostgresMediaProcessingRepository({ database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId } });
      const staleOriginalSha256 = createHash("sha256").update(staleBytes).digest("hex");
      const staleSubstitutedSha256 = "f".repeat(64);
      const staleRepository: MediaProcessingRepositoryPort = { ...staleBaseRepository, async commitAttempt(command) {
        await admin.query("update media.assets set declared_sha256 = $2 where media_id = $1::uuid", [staleCandidate.mediaId, staleSubstitutedSha256]);
        return staleBaseRepository.commitAttempt(command);
      } };
      const staleService = makeMediaProcessing(staleStorage, realProcessor, realScanner, staleRepository);
      const staleResult = await staleService.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-image-processing-owner" },
        idempotencyKey: `phase6-image-stale-${randomBytes(8).toString("hex")}` as never, mediaId: staleCandidate.mediaId, expectedVersion: 1,
        result: "passed", detectedMediaType: "image/png", detectedByteLength: staleBytes.byteLength,
        sha256: staleOriginalSha256 });
      expect(staleResult).toMatchObject({ ok: false, error: { code: "MEDIA_CANDIDATE_STALE" } });
      await admin.query("update media.assets set declared_sha256 = $2 where media_id = $1::uuid", [staleCandidate.mediaId, staleOriginalSha256]);
      expect(staleOutputs).toHaveLength(2);
      for (const output of staleOutputs) {
        const objectPath = `/storage/v1/object/media-processed/processed/${portfolioId}/${staleCandidate.mediaId}/${output.objectId}/${output.sha256}.webp`;
        const removed = await storageRequest(objectPath, { headers: headers(SERVICE_ROLE_KEY!) });
        expect([400, 404]).toContain(removed.status);
      }
      const staleFacts = await admin.query(
        `select (select count(*)::int from media.processing_attempts where media_id = $1::uuid) as attempts,
                (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs,
                (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.processing_recorded.v1') as events,
                (select count(*)::int from media.processing_orphans where media_id = $1::uuid and state = 'pending') as orphans`,
        [staleCandidate.mediaId],
      );
      expect(staleFacts.rows[0]).toEqual({ attempts: 0, outputs: 0, events: 0, orphans: 0 });
      if (REQUIRE_ACCEPTANCE && !REQUIRE_FULL_MEDIA) {
        const acceptancePdfBytes = new Uint8Array(readFileSync(PDF_FIXTURE!));
        const acceptancePdf = await uploadPdf(acceptancePdfBytes, "acceptance");
        const acceptancePdfHash = createHash("sha256").update(acceptancePdfBytes).digest("hex");
        const acceptancePdfProcessing = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-media-acceptance-owner" },
          idempotencyKey: "phase6-acceptance-pdf-processing" as never, mediaId: acceptancePdf.mediaId, expectedVersion: 1,
          result: "passed", detectedMediaType: "application/pdf", detectedByteLength: acceptancePdfBytes.byteLength, sha256: acceptancePdfHash });
        expect(acceptancePdfProcessing, JSON.stringify(acceptancePdfProcessing)).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
        await acceptAndVerify(acceptancePdf.mediaId as StableId<"MediaAsset">,
          { kind: "document", summary: "A readable one page PDF document." }, "pdf");
        mediaProcessingCounts.scannerExecutions += scannerExecutions;
        mediaProcessingCounts.processorExecutions += processorExecutions;
        mediaProcessingCounts.imageProcessorExecutions += imageProcessorExecutions;
        if (PROCESSING_COUNTS_FILE) writeFileSync(PROCESSING_COUNTS_FILE, JSON.stringify(mediaProcessingCounts));
        return;
      }
      if (PROCESSING_COUNTS_FILE) writeFileSync(PROCESSING_COUNTS_FILE, JSON.stringify({ scannerExecutions, processorExecutions, imageProcessorExecutions }));
      if (!REQUIRE_VIDEO) return;
    }

    const scansBeforePdfProcessing = scannerExecutions;
    const pdfBytes = new Uint8Array(readFileSync(PDF_FIXTURE!));
    const { createClamAvScanner } = await import("../../src/runtime/adapters/media-processing-tools.js");
    // Exercise the production default, including container startup and cleanup.
    const productionScan = await createClamAvScanner().scan(pdfBytes);
    expect(productionScan, JSON.stringify(productionScan)).toMatchObject({ ok: true, value: { verdict: "clean" } });
    const { createOcrMyPdfProcessor, runWithBoundedOutput } = await import("../../src/runtime/adapters/media-processing-tools.js");
    const productionResult = await createOcrMyPdfProcessor().process(pdfBytes);
    expect(productionResult.ok, JSON.stringify(productionResult)).toBe(true);
    if (process.platform === "win32") {
      const timeoutDirectory = mkdtempSync(join(tmpdir(), "phase6-pdf-timeout-"));
      try {
        await expect(runWithBoundedOutput("python3", ["-c", "import time; time.sleep(10)"], join(timeoutDirectory, "never-written.pdf"),
          { maxBytes: 20 * 1024 * 1024, timeoutMs: 100, python: "python3" })).rejects.toThrow();
      } finally { rmSync(timeoutDirectory, { recursive: true, force: true }); }
      const quotaDirectory = mkdtempSync(join(tmpdir(), "phase6-pdf-output-quota-"));
      const quotaPath = join(quotaDirectory, "oversized.pdf");
      try {
        const childCode = "import sys,time; f=open(sys.argv[1],'ab',buffering=0); exec('while True:\\n f.write(bytes([120,120])); time.sleep(0.01)')";
        const worker = `import subprocess,sys,time; subprocess.Popen([sys.executable, '-c', ${JSON.stringify(childCode)}, sys.argv[1]]); time.sleep(1000)`;
        await expect(runWithBoundedOutput("python3", ["-c", worker, quotaPath], quotaPath,
          { maxBytes: 8, timeoutMs: 5_000, python: "python3" })).rejects.toBeDefined();
        expect(statSync(quotaPath).size).toBeLessThanOrEqual(8);
        const stoppedSize = statSync(quotaPath).size;
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(statSync(quotaPath).size).toBe(stoppedSize);
      } finally {
        rmSync(quotaDirectory, { recursive: true, force: true });
      }
    }

    const safe = await uploadPdf(pdfBytes, "safe");
    const safeHash = createHash("sha256").update(pdfBytes).digest("hex");
    const forgedClaims = await uploadPdf(pdfBytes, "forged-claims");
    const forgedResult = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
      idempotencyKey: "phase6-pdf-forged-claims" as never, mediaId: forgedClaims.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: "f".repeat(64) });
    expect(forgedResult).toMatchObject({ ok: true });
    const forgedFacts = await admin.query(
      `select (select result from media.processing_attempts where media_id = $1::uuid) as result,
              (select finding_codes from media.processing_attempts where media_id = $1::uuid) as finding_codes,
              (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs,
              (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.processing_recorded.v1') as events`,
      [forgedClaims.mediaId],
    );
    expect(forgedFacts.rows[0], JSON.stringify(forgedFacts.rows[0])).toEqual({ result: "failed", finding_codes: ["MEDIA_CALLER_FACTS_MISMATCH"], outputs: 0, events: 1 });
    const missingCandidate = await uploadPdf(pdfBytes, "missing-object", undefined, false);
    const missingResult = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
      idempotencyKey: "phase6-pdf-missing-object" as never, mediaId: missingCandidate.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash });
    expect(missingResult).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_STORAGE_UNAVAILABLE" } });
    const missingFacts = await admin.query("select result, finding_codes from media.processing_attempts where media_id = $1::uuid", [missingCandidate.mediaId]);
    expect(missingFacts.rows[0]).toEqual({ result: "failed", finding_codes: ["MEDIA_STORAGE_UNAVAILABLE"] });

    const replacement = Buffer.from(pdfBytes);
    replacement[replacement.byteLength - 1] = replacement[replacement.byteLength - 1]! ^ 1;
    expect(replacement.byteLength).toBe(pdfBytes.byteLength);
    expect(replacement.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const substitutedCandidate = await uploadPdf(pdfBytes, "substituted-object", undefined, true, replacement);
    const substituteResult = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
      idempotencyKey: "phase6-pdf-substituted-object" as never, mediaId: substitutedCandidate.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash });
    expect(substituteResult).toMatchObject({ ok: true });
    const substituteFacts = await admin.query("select result, finding_codes from media.processing_attempts where media_id = $1::uuid", [substitutedCandidate.mediaId]);
    expect(substituteFacts.rows[0]).toEqual({ result: "failed", finding_codes: ["MEDIA_DECLARATION_MISMATCH"] });
    const scannerUnavailableCandidate = await uploadPdf(pdfBytes, "scanner-unavailable");
    const unavailableScanner = { async scan() {
      return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_SCANNER_UNAVAILABLE" } };
    } };
    const scannerUnavailableService = makeMediaProcessing(normalProcessingStorage, realProcessor, unavailableScanner);
    const scannerUnavailableResult = await scannerUnavailableService.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
      idempotencyKey: "phase6-pdf-scanner-unavailable" as never, mediaId: scannerUnavailableCandidate.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash });
    expect(scannerUnavailableResult).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_SCANNER_UNAVAILABLE" } });
    const scannerUnavailableFacts = await admin.query(
      `select (select result from media.processing_attempts where media_id = $1::uuid) as result,
              (select finding_codes from media.processing_attempts where media_id = $1::uuid) as finding_codes,
              (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs`,
      [scannerUnavailableCandidate.mediaId],
    );
    expect(scannerUnavailableFacts.rows[0]).toEqual({ result: "failed", finding_codes: ["MEDIA_SCANNER_UNAVAILABLE"], outputs: 0 });
    let applicationResult: Awaited<ReturnType<typeof mediaProcessing.record>> | undefined;
    const operationService = { ...createProductionOwnerMediaService(), recordOwnerMediaProcessing: async (command: Parameters<typeof mediaProcessing.record>[0]) => {
      applicationResult = await mediaProcessing.record(command);
      return applicationResult;
    } };
    const operationResponse = await handleRecordOwnerMediaProcessing(new Request(`https://example.com/api/owner/v1/media/${safe.mediaId}/commands/record-processing`, {
      method: "POST", headers: withOwnerTestAuth({ "content-type": "application/json", "idempotency-key": "phase6-pdf-process-safe-key", "if-match": '"1"' }),
      body: JSON.stringify({ result: "passed", detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash }),
    }), { mediaId: safe.mediaId }, { service: operationService, security: ownerSecurity() });
    expect(operationResponse.status, JSON.stringify({ problem: await operationResponse.clone().json(), applicationResult })).toBe(200);
    const operationBody = await operationResponse.json();
    expect(operationBody).toMatchObject({ aggregateId: safe.mediaId, aggregateVersion: 2, outcome: "media-processing-recorded" });
    expect(JSON.stringify(operationBody)).not.toContain("uploadTarget");
    expect(JSON.stringify(operationBody)).not.toContain("token=");
    expect(scannerExecutions - scansBeforePdfProcessing).toBe(2);
    const sameKeyReplay = await mediaProcessing.record({
      actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" }, idempotencyKey: "phase6-pdf-process-safe-key" as never,
      mediaId: safe.mediaId, expectedVersion: 1, result: "passed", detectedMediaType: "application/pdf",
      detectedByteLength: pdfBytes.byteLength, sha256: safeHash,
    });
    expect(sameKeyReplay).toMatchObject({ ok: true, value: { aggregateId: safe.mediaId, aggregateVersion: 2, outcome: "media-processing-recorded" } });
    expect(scannerExecutions - scansBeforePdfProcessing).toBe(2);
    expect(processedFiles).toHaveLength(1);
    const freshKeyReplay = await mediaProcessing.record({
      actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" }, idempotencyKey: "phase6-pdf-process-safe-fresh-key" as never,
      mediaId: safe.mediaId, expectedVersion: 2, result: "passed", detectedMediaType: "application/pdf",
      detectedByteLength: pdfBytes.byteLength, sha256: safeHash,
    });
    expect(freshKeyReplay).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
    expect(scannerExecutions - scansBeforePdfProcessing).toBe(2);
    expect(processedFiles).toHaveLength(1);
    const terminalFacts = await admin.query(
      `select (select count(*)::int from media.processing_attempts where media_id = $1::uuid) as attempts,
              (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs,
              (select count(*)::int from media.processing_commands where media_id = $1::uuid) as commands,
              (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.processing_recorded.v1') as events`,
      [safe.mediaId],
    );
    expect(terminalFacts.rows[0]).toEqual({ attempts: 1, outputs: 1, commands: 1, events: 1 });
    const incompatibleAcceptance = await createAcceptanceService().acceptOwnerMediaAsset({
      actor: { kind: "owner", ownerId, sessionId: "phase6-media-acceptance-owner" },
      idempotencyKey: "phase6-accept-pdf-wrong-kind" as never, expectedVersion: 2,
      mediaId: safe.mediaId, accessibility: { kind: "video", summary: "Wrong asset metadata." },
    });
    expect(incompatibleAcceptance).toMatchObject({ ok: false, error: { code: "MEDIA_ACCESSIBILITY_KIND_MISMATCH" } });
    const acceptedPdf = await acceptAndVerify(safe.mediaId as StableId<"MediaAsset">,
      { kind: "document", summary: "A readable one page PDF document." }, "pdf");
    const scansBeforePdfReprocess = scannerExecutions;
    const pdfReprocess = await mediaProcessing.record({ ...acceptedPdf.command, expectedVersion: 3,
      result: "passed", detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash,
      idempotencyKey: `phase6-pdf-post-accept-${randomBytes(8).toString("hex")}` as never });
    expect(pdfReprocess).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
    expect(scannerExecutions).toBe(scansBeforePdfReprocess);
    const pdfMeaningfulFacts = await appDatabase.transactions.run((transaction) => acceptedPdf.acceptance.getAcceptanceFacts({
      ownerId, mediaAssetIds: [safe.mediaId as StableId<"MediaAsset">], intendedUse: "supporting-artifact",
    }, transaction));
    expect(pdfMeaningfulFacts).toMatchObject({ ok: true, value: [{ accepted: true, safe: true, suitable: true, accessible: true }] });

    const cvService = await getOwnerCvApplicationService();
    const cvOwner = { kind: "owner" as const, ownerId, sessionId: "phase6-cv-registration-owner" };
    const cvReadResults: string[] = [];
    const observedCvService = { ...cvService, async getOwnerCvPortfolio(query: Parameters<typeof cvService.getOwnerCvPortfolio>[0]) {
      const result = await cvService.getOwnerCvPortfolio(query);
      cvReadResults.push(result.ok ? "ok" : result.error.code);
      return result;
    } };
    const getCvThroughHttp = () => handleGetOwnerCvPortfolio(new Request("https://example.com/api/owner/v1/cv", {
      method: "GET", headers: withOwnerTestAuth({}),
    }), { service: observedCvService, security: ownerSecurity() });
    const cvChecks: Array<{ readonly name: string; readonly executed: boolean; readonly status: "passed" | "failed" }> = [];
    const cvScenario = (name: string, passed: boolean) => {
      cvChecks.push({ name, executed: true, status: passed ? "passed" : "failed" });
      expect(passed, name).toBe(true);
    };

    await admin.query("delete from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId]);
    const [emptyResponseA, emptyResponseB] = await Promise.all([getCvThroughHttp(), getCvThroughHttp()]);
    const safeProblemCode = async (response: Response): Promise<string> => {
      if (response.status === 200) return "ok";
      const body: unknown = await response.clone().json().catch(() => undefined);
      return typeof body === "object" && body !== null && "code" in body && typeof body.code === "string"
        ? body.code : "unknown-problem";
    };
    const safeReadResults = cvReadResults.map((code) => code === "ok" || code === "CV_PORTFOLIO_READ_FAILED" || code === "CV_PORTFOLIO_NOT_CONFIGURED" ? code : "other-safe-error");
    expect(emptyResponseA.status, `T09-01 first authenticated read returned HTTP ${emptyResponseA.status} (${await safeProblemCode(emptyResponseA)}; repo=${safeReadResults.join(",")})`).toBe(200);
    expect(emptyResponseB.status, `T09-01 second authenticated read returned HTTP ${emptyResponseB.status} (${await safeProblemCode(emptyResponseB)}; repo=${safeReadResults.join(",")})`).toBe(200);
    const emptyCvA = await emptyResponseA.json();
    const emptyCvB = await emptyResponseB.json();
    expect(emptyCvA).toMatchObject({ aggregateVersion: 1, currentVersionId: null, versions: [], activationHistory: [] });
    expect(emptyCvB).toMatchObject({ aggregateVersion: 1, currentVersionId: null, versions: [], activationHistory: [] });
    const rootCount = await admin.query("select count(*)::int as count from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId]);
    cvScenario("T09-01 concurrent authenticated reads initialize one empty version-1 scoped root", Number(rootCount.rows[0]?.count) === 1);
    const noScopeRead = await appDatabase.transactions.run(async (transaction) => {
      const executor = resolvePostgresTransaction(transaction);
      await sql`select set_config('shipwithali.portfolio_id', '', true), set_config('shipwithali.owner_id', '', true)`.execute(executor);
      return sql<{ readonly count: number | string }>`select count(*) as count from cv_portfolio.versions`.execute(executor);
    });
    const wrongOwnerRead = await appDatabase.transactions.run(async (transaction) => {
      const executor = resolvePostgresTransaction(transaction);
      await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true), set_config('shipwithali.owner_id', ${createStableId("Owner")}, true)`.execute(executor);
      return sql<{ readonly count: number | string }>`select count(*) as count from cv_portfolio.versions`.execute(executor);
    });
    const cvDatabasePolicy = await admin.query(`select
        (select count(*)::int from pg_class where oid in (
          'cv_portfolio.portfolios'::regclass, 'cv_portfolio.versions'::regclass,
          'cv_portfolio.registration_commands'::regclass, 'cv_portfolio.activation_history'::regclass)
          and relrowsecurity and relforcerowsecurity) as rls_tables,
        (select count(*)::int from pg_policies where schemaname = 'cv_portfolio'
          and policyname in ('cv_portfolios_owner_scope', 'cv_versions_owner_scope',
            'cv_registration_commands_owner_scope', 'cv_activation_history_owner_scope')) as policies,
        (select count(*)::int from pg_indexes where schemaname = 'cv_portfolio'
          and indexname in ('cv_versions_owner_history_idx', 'cv_activation_history_owner_recent_idx')) as indexes,
        (select count(*)::int from pg_constraint where conrelid = 'cv_portfolio.versions'::regclass
          and contype = 'f') as scoped_foreign_keys,
        (select count(*)::int from pg_constraint where conrelid = 'cv_portfolio.versions'::regclass
          and contype = 'c') as version_checks,
        has_table_privilege('shipwithali_application', 'cv_portfolio.versions', 'SELECT') as app_read,
        has_table_privilege('anon', 'cv_portfolio.versions', 'SELECT') as anon_read`);
    cvScenario("T09-09 same-scope foreign keys, English and snapshot constraints, forced RLS, default-deny roles and bounded indexes exist",
      Number(noScopeRead.rows[0]?.count) === 0 && Number(wrongOwnerRead.rows[0]?.count) === 0 &&
      cvDatabasePolicy.rows[0]?.rls_tables === 4 && cvDatabasePolicy.rows[0]?.policies === 4 &&
      cvDatabasePolicy.rows[0]?.indexes >= 2 && cvDatabasePolicy.rows[0]?.scoped_foreign_keys >= 2 &&
      cvDatabasePolicy.rows[0]?.version_checks >= 6 &&
      cvDatabasePolicy.rows[0]?.app_read === true && cvDatabasePolicy.rows[0]?.anon_read === false);

    const registerCv = (overrides: Partial<Parameters<typeof cvService.registerOwnerCvVersion>[0]> = {}) =>
      cvService.registerOwnerCvVersion({
        actor: cvOwner,
        idempotencyKey: "phase6-cv-register-primary" as never,
        expectedVersion: 1,
        mediaId: safe.mediaId as StableId<"MediaAsset">,
        locale: "en",
        label: "  CV October 2026  ",
        ...overrides,
      });
    const registerCvThroughHttp = (options: { readonly idempotencyKey?: string; readonly ifMatch?: string; readonly mediaId?: string } = {}) => handleRegisterOwnerCvVersion(new Request("https://example.com/api/owner/v1/cv/versions", {
      method: "POST",
      headers: withOwnerTestAuth({ "content-type": "application/json", "idempotency-key": options.idempotencyKey ?? "phase6-cv-register-primary", "if-match": options.ifMatch ?? "\"1\"" }),
      body: JSON.stringify({ mediaId: options.mediaId ?? safe.mediaId, locale: "en", label: "  CV October 2026  " }),
    }), { service: cvService, security: ownerSecurity() });
    const acceptCvThroughHttp = (options: { readonly versionId: string; readonly idempotencyKey?: string; readonly ifMatch?: string }) =>
      handleAcceptOwnerCvVersion(new Request(`https://example.com/api/owner/v1/cv/versions/${options.versionId}/commands/accept`, {
        method: "POST", headers: withOwnerTestAuth({ "idempotency-key": options.idempotencyKey ?? `phase6-cv-accept-${options.versionId}`,
          "if-match": options.ifMatch ?? `"${expectedCvVersion}"` }),
      }), { versionId: options.versionId }, { service: cvService, security: ownerSecurity() });
    const activateCvThroughHttp = (options: { readonly versionId: string; readonly idempotencyKey: string; readonly ifMatch: string }) =>
      handleActivateOwnerCvVersion(new Request(`https://example.com/api/owner/v1/cv/versions/${options.versionId}/commands/activate`, {
        method: "POST", headers: withOwnerTestAuth({ "idempotency-key": options.idempotencyKey, "if-match": options.ifMatch }),
      }), { versionId: options.versionId }, { service: cvService, security: ownerSecurity() });
    await admin.query("select pg_advisory_lock(hashtextextended($1::text, 0))", [safe.mediaId]);
    const concurrentRegistrations = Promise.all([registerCvThroughHttp(), registerCvThroughHttp()]);
    let waitingForMediaLock = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const waiting = await admin.query(`select count(*)::int as count from pg_stat_activity
        where usename = $1 and wait_event_type = 'Lock' and query ilike '%pg_advisory_xact_lock_shared%'`, [roleName]);
      waitingForMediaLock = Number(waiting.rows[0]?.count ?? 0);
      if (waitingForMediaLock === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await admin.query("select pg_advisory_unlock(hashtextextended($1::text, 0))", [safe.mediaId]);
    const [httpRegistrationA, httpRegistrationB] = await concurrentRegistrations;
    expect(waitingForMediaLock, "both Owner requests must pass the initial receipt lookup and wait at the shared Media lock").toBe(2);
    const [httpReceiptA, httpReceiptB] = await Promise.all([httpRegistrationA.json(), httpRegistrationB.json()]);
    expect(httpRegistrationA.status).toBe(201);
    expect(httpRegistrationB.status).toBe(201);
    expect(httpReceiptA).toEqual(httpReceiptB);
    const cvRegistration = { ok: true as const, value: httpReceiptA };
    expect(cvRegistration).toMatchObject({ ok: true, value: { aggregateVersion: 2, outcome: "cv-version-registered" } });
    if (!cvRegistration.ok) throw new Error("PHASE6_CV_REGISTRATION_FAILED");
    const savedCv = await admin.query(`select version_id::text, media_id::text, media_asset_version, version_number, locale, label, state
      from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid`, [portfolioId, ownerId]);
    expect(savedCv.rows).toMatchObject([{
      media_id: safe.mediaId,
      media_asset_version: 3,
      version_number: 1,
      locale: "en",
      label: "CV October 2026",
      state: "registered",
    }]);
    expect(savedCv.rows[0]?.version_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect((await admin.query("select count(*)::int as count from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId])).rows[0]?.count).toBe(0);
    const registeredEvent = await admin.query(`select count(*)::int as count from operations.outbox_events
      where aggregate_id = $1::uuid and event_type = 'cv.version_registered.v1'`, [portfolioId]);
    const registrationReceiptCount = await admin.query("select count(*)::int as count from cv_portfolio.registration_commands where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId]);
    cvScenario("T09-02 concurrent authenticated Owner POSTs replay one shared receipt after both miss the initial lookup",
      waitingForMediaLock === 2 && httpRegistrationA.status === 201 && httpRegistrationB.status === 201 &&
      JSON.stringify(httpReceiptA) === JSON.stringify(httpReceiptB) && savedCv.rowCount === 1 &&
      registrationReceiptCount.rows[0]?.count === 1 && registeredEvent.rows[0]?.count === 1);
    cvScenario("T09-03 and T09-05 accepted same-Owner PDF facts are snapshot-bound to a UUIDv7 English registered version",
      savedCv.rowCount === 1 && savedCv.rows[0]?.media_asset_version === 3 && savedCv.rows[0]?.version_number === 1 &&
      savedCv.rows[0]?.state === "registered" && registrationReceiptCount.rows[0]?.count === 1 && registeredEvent.rows[0]?.count === 1);
    cvScenario("T09-06 registration increments the root and records one event without accepting or activating the CV",
      cvRegistration.value.aggregateVersion === 2 && savedCv.rows[0]?.state === "registered" &&
      (await cvService.getOwnerCvPortfolio({ actor: cvOwner })).ok);
    const emptyNotCurrent = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
    expect(emptyNotCurrent).toMatchObject({ ok: true, value: { aggregateVersion: 2, currentVersionId: null } });

    const replay = await registerCv();
    const changedReplay = await registerCv({ label: "A different CV" });
    const staleRegistration = await registerCv({ idempotencyKey: "phase6-cv-register-stale" as never, expectedVersion: 1 });
    const beforeStaleHttp = await admin.query(`select portfolio.aggregate_version,
      (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid) as versions,
      (select count(*)::int from cv_portfolio.registration_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
      (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_registered.v1') as events
      from cv_portfolio.portfolios portfolio where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId]);
    const staleHttpRegistration = await registerCvThroughHttp({ idempotencyKey: "phase6-cv-register-stale-http", ifMatch: "\"1\"" });
    const staleHttpProblem = await staleHttpRegistration.json();
    const afterStaleHttp = await admin.query(`select portfolio.aggregate_version,
      (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid) as versions,
      (select count(*)::int from cv_portfolio.registration_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
      (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_registered.v1') as events
      from cv_portfolio.portfolios portfolio where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId]);
    cvScenario("T09-07 exact replay preserves the original receipt; changed intent conflicts and a fresh stale root version fails",
      JSON.stringify(replay) === JSON.stringify(cvRegistration) &&
      (!changedReplay.ok && changedReplay.error.code === "IDEMPOTENCY_CONFLICT") &&
      (!staleRegistration.ok && staleRegistration.error.kind === "precondition_failed") &&
      staleHttpRegistration.status === 412 && staleHttpProblem?.type === "urn:shipwithali:problem:precondition-failed" &&
      staleHttpProblem?.code === "failed_precondition" &&
      JSON.stringify(afterStaleHttp.rows[0]) === JSON.stringify(beforeStaleHttp.rows[0]));

    const mutationCountsBeforeRejectedIntents = await admin.query(`select
      (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid) as versions,
      (select count(*)::int from cv_portfolio.registration_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
      (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_registered.v1') as events`, [portfolioId, ownerId]);
    const unprocessedPdf = await uploadPdf(pdfBytes, "cv-unprocessed");
    const unprocessedRegistration = await registerCv({
      idempotencyKey: "phase6-cv-register-unprocessed" as never,
      expectedVersion: 2,
      mediaId: unprocessedPdf.mediaId as StableId<"MediaAsset">,
    });
    const wrongKindFacts = await admin.query(`select asset.media_id::text, asset.kind
      from media.assets asset
      join media.processing_states state on state.media_id = asset.media_id
        and state.portfolio_id = asset.portfolio_id and state.owner_id = asset.owner_id
      join media.decision_history decision on decision.media_id = asset.media_id
        and decision.portfolio_id = asset.portfolio_id and decision.owner_id = asset.owner_id
        and decision.aggregate_version = state.aggregate_version and decision.decision = 'accepted'
      where asset.media_id = any($1::uuid[]) and asset.kind = 'image'
      order by asset.media_id limit 1`, [acceptedMediaIds]);
    const wrongKindId = wrongKindFacts.rows[0]?.media_id as StableId<"MediaAsset"> | undefined;
    const wrongKindRegistration = wrongKindId === undefined ? undefined : await registerCv({
      idempotencyKey: "phase6-cv-register-image" as never,
      expectedVersion: 2,
      mediaId: wrongKindId,
    });
    const missingRegistration = await registerCv({
      idempotencyKey: "phase6-cv-register-missing" as never,
      expectedVersion: 2,
      mediaId: createStableId("MediaAsset"),
    });
    const foreignActorRegistration = await cvService.registerOwnerCvVersion({
      actor: { kind: "owner", ownerId: createStableId("Owner"), sessionId: "foreign" },
      idempotencyKey: "phase6-cv-register-foreign" as never,
      expectedVersion: 2,
      mediaId: safe.mediaId as StableId<"MediaAsset">,
      locale: "en",
      label: "Foreign scope",
    });
    const wrongLocale = await cvService.registerOwnerCvVersion({
      actor: cvOwner,
      idempotencyKey: "phase6-cv-register-arabic" as never,
      expectedVersion: 2,
      mediaId: safe.mediaId as StableId<"MediaAsset">,
      locale: "ar" as "en",
      label: "Arabic CV",
    });
    const mutationCountsAfterRejectedIntents = await admin.query(`select
      (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid) as versions,
      (select count(*)::int from cv_portfolio.registration_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
      (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_registered.v1') as events`, [portfolioId, ownerId]);
    cvScenario("T09-04 unprocessed raw PDF, accepted non-PDF image, missing, foreign Owner, and non-English intents reject without writes",
      !unprocessedRegistration.ok && (!wrongKindRegistration || !wrongKindRegistration.ok) && wrongKindFacts.rows[0]?.kind === "image" &&
      !missingRegistration.ok && !foreignActorRegistration.ok && !wrongLocale.ok &&
      JSON.stringify(mutationCountsAfterRejectedIntents.rows[0]) === JSON.stringify(mutationCountsBeforeRejectedIntents.rows[0]));

    let expectedCvVersion = 2;
    for (let index = 0; index < 101; index += 1) {
      const added = await registerCv({
        idempotencyKey: `phase6-cv-register-history-${index}` as never,
        expectedVersion: expectedCvVersion,
        label: `CV retained ${index}`,
      });
      expect(added.ok, `bounded CV history registration ${index}`).toBe(true);
      if (!added.ok) throw new Error("PHASE6_CV_HISTORY_SETUP_FAILED");
      expectedCvVersion = added.value.aggregateVersion;
    }
    const cvVersionIds = Array.from({ length: 101 }, () => createStableId("CvActivation"));
    for (let index = 0; index < cvVersionIds.length; index += 1) {
      await admin.query(`insert into cv_portfolio.activation_history (activation_id, portfolio_id, owner_id, version_id, activated_at)
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, transaction_timestamp() - ($5::int * interval '1 second'))`,
      [cvVersionIds[index], portfolioId, ownerId, cvRegistration.value.versionId, index]);
    }
    const boundedCvView = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
    const retainedCvCount = await admin.query("select count(*)::int as count from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId]);
    cvScenario("T09-08 Owner projections return deterministic latest-100 version and activation views without deleting retained rows",
      boundedCvView.ok && boundedCvView.value.versions.length === 100 && boundedCvView.value.activationHistory.length === 100 &&
      Number(retainedCvCount.rows[0]?.count) === 102 && boundedCvView.value.versions[0]?.label === "CV retained 100");

    // Reject the next event without rejecting the retained events that prove
    // successful registrations earlier in this same disposable database.
    await admin.query(`alter table operations.outbox_events add constraint phase6_cv_outbox_failure
      check (event_type <> 'cv.version_registered.v1') not valid`);
    try {
      const failedCommit = await registerCv({ idempotencyKey: "phase6-cv-register-rollback" as never,
        expectedVersion: expectedCvVersion, label: "Rollback probe" });
      expect(failedCommit).toMatchObject({ ok: false, error: { code: "CV_REGISTRATION_COMMIT_FAILED" } });
    } finally {
      await admin.query("alter table operations.outbox_events drop constraint phase6_cv_outbox_failure");
    }
    const afterRollback = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
    cvScenario("T09-06 root, version, receipt and event roll back together when outbox insertion fails",
      afterRollback.ok && afterRollback.value.aggregateVersion === expectedCvVersion &&
      afterRollback.value.versions.length === 100 &&
      Number((await admin.query("select count(*)::int as count from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId])).rows[0]?.count) === 102);

    const cvAcceptanceChecks: Array<{ readonly name: string; readonly executed: boolean; readonly status: "passed" | "failed" }> = [];
    const cvAcceptanceScenario = (name: string, passed: boolean) => {
      cvAcceptanceChecks.push({ name, executed: true, status: passed ? "passed" : "failed" });
      expect(passed, name).toBe(true);
    };
    const cvAcceptVersionId = cvRegistration.value.versionId as string;
    const invalidAcceptOwner = await cvService.acceptOwnerCvVersion({ actor: { kind: "owner", ownerId: createStableId("Owner"), sessionId: "foreign-cv-accept" },
      idempotencyKey: "phase6-cv-accept-foreign" as never, expectedVersion: expectedCvVersion, versionId: cvRegistration.value.versionId });
    const missingAccept = await cvService.acceptOwnerCvVersion({ actor: cvOwner, idempotencyKey: "phase6-cv-accept-missing" as never,
      expectedVersion: expectedCvVersion, versionId: createStableId("CvVersion") as never });
    const foreignPortfolioId = createStableId("Portfolio");
    const foreignOwnerId = createStableId("Owner");
    const foreignVersionId = createStableId("CvVersion");
    const foreignSnapshot = await admin.query(`select media_id, media_asset_version, media_decision_id, media_object_id,
        media_sha256, media_object_version from cv_portfolio.versions where version_id = $1::uuid`, [cvRegistration.value.versionId]);
    if (!foreignSnapshot.rows[0]) throw new Error("PHASE6_CV_FOREIGN_VERSION_FIXTURE_FAILED");
    await admin.query("begin");
    try {
      await admin.query("set local session_replication_role = replica");
      await admin.query(`insert into cv_portfolio.portfolios (portfolio_id, owner_id, aggregate_version) values ($1::uuid, $2::uuid, 1)`,
        [foreignPortfolioId, foreignOwnerId]);
      await admin.query(`insert into cv_portfolio.versions
          (version_id, portfolio_id, owner_id, media_id, media_asset_version, media_decision_id, media_object_id,
           media_sha256, media_object_version, version_number, locale, label, state)
        values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::uuid, $7::uuid, $8, $9, 1, 'en', 'Foreign private CV', 'registered')`,
      [foreignVersionId, foreignPortfolioId, foreignOwnerId, foreignSnapshot.rows[0].media_id,
        foreignSnapshot.rows[0].media_asset_version, foreignSnapshot.rows[0].media_decision_id,
        foreignSnapshot.rows[0].media_object_id, foreignSnapshot.rows[0].media_sha256, foreignSnapshot.rows[0].media_object_version]);
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
    const foreignVersionAccept = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
      idempotencyKey: "phase6-cv-accept-foreign-version" as never, expectedVersion: expectedCvVersion, versionId: foreignVersionId });
    const foreignVersionCount = await admin.query("select count(*)::int as count from cv_portfolio.versions where version_id = $1::uuid", [foreignVersionId]);
    await admin.query("delete from cv_portfolio.versions where version_id = $1::uuid", [foreignVersionId]);
    await admin.query("delete from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid", [foreignPortfolioId, foreignOwnerId]);
    const noMutationBeforeAccept = await admin.query(`select portfolio.aggregate_version,
        (select count(*)::int from cv_portfolio.acceptance_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
        (select count(*)::int from cv_portfolio.acceptance_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
        (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_accepted.v1') as events
      from cv_portfolio.portfolios portfolio where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId]);
    cvAcceptanceScenario("T10-01 only the configured Owner can accept a same-Portfolio registered English PDF; missing and foreign versions disclose no private facts",
      !invalidAcceptOwner.ok && invalidAcceptOwner.error.code === "OWNER_REQUIRED" && !missingAccept.ok &&
      missingAccept.error.kind === "not_found" && !foreignVersionAccept.ok && foreignVersionAccept.error.kind === "not_found" &&
      Number(foreignVersionCount.rows[0]?.count) === 1 && Number(noMutationBeforeAccept.rows[0]?.aggregate_version) === expectedCvVersion &&
      noMutationBeforeAccept.rows[0]?.histories === 0 && noMutationBeforeAccept.rows[0]?.receipts === 0 && noMutationBeforeAccept.rows[0]?.events === 0);

    await admin.query("select pg_advisory_lock(hashtextextended($1::text, 0))", [safe.mediaId]);
    const acceptanceRequest = acceptCvThroughHttp({ versionId: cvAcceptVersionId, idempotencyKey: "phase6-cv-accept-primary" });
    let waitingForAcceptanceMediaLock = 0;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const waiting = await admin.query(`select count(*)::int as count from pg_stat_activity
        where usename = $1 and wait_event_type = 'Lock' and query ilike '%pg_advisory_xact_lock_shared%'`, [roleName]);
      waitingForAcceptanceMediaLock = Number(waiting.rows[0]?.count ?? 0);
      if (waitingForAcceptanceMediaLock === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await admin.query("select pg_advisory_unlock(hashtextextended($1::text, 0))", [safe.mediaId]);
    const acceptanceResponse = await acceptanceRequest;
    const acceptanceBody = await acceptanceResponse.json();
    const acceptedSnapshot = await admin.query(`select version.media_decision_id::text as version_decision_id,
        history.media_decision_id::text as history_decision_id, version.media_object_id::text as version_object_id,
        history.media_object_id::text as history_object_id, output.object_id::text as live_object_id,
        version.media_sha256 as version_sha256, history.media_sha256 as history_sha256, output.sha256 as live_sha256,
        version.media_object_version as version_object_version, history.media_object_version as history_object_version,
        output.object_version as live_object_version, version.media_asset_version, decision.aggregate_version as decision_version
      from cv_portfolio.versions version
      join cv_portfolio.acceptance_history history on history.version_id = version.version_id
      join media.decision_history decision on decision.decision_id = version.media_decision_id
      join media.processed_objects output on output.object_id = version.media_object_id
      where version.version_id = $1::uuid and version.portfolio_id = $2::uuid and version.owner_id = $3::uuid`,
    [cvAcceptVersionId, portfolioId, ownerId]);
    const afterFirstAcceptance = await admin.query(`select portfolio.aggregate_version, portfolio.current_version_id::text as current_version_id,
        version.state,
        (select count(*)::int from cv_portfolio.acceptance_history where version_id = $3::uuid) as histories,
        (select count(*)::int from cv_portfolio.acceptance_commands where version_id = $3::uuid) as receipts,
        (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_accepted.v1') as events,
        (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as current_events
      from cv_portfolio.portfolios portfolio join cv_portfolio.versions version on version.version_id = $3::uuid
      where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId, cvAcceptVersionId]);
    const savedAcceptance = afterFirstAcceptance.rows[0];
    const snapshotRow = acceptedSnapshot.rows[0];
    cvAcceptanceScenario("T10-02 current accepted, safe, suitable and accessible Media facts retain the exact PDF object/hash/version under the shared Media lock",
      waitingForAcceptanceMediaLock === 1 && acceptanceResponse.status === 200 &&
      acceptanceBody.aggregateId === cvAcceptVersionId && acceptanceBody.aggregateVersion === expectedCvVersion + 1 &&
      acceptanceBody.outcome === "cv-version-accepted" && snapshotRow?.version_decision_id === snapshotRow?.history_decision_id &&
      snapshotRow?.version_object_id === snapshotRow?.history_object_id && snapshotRow?.version_object_id === snapshotRow?.live_object_id &&
      snapshotRow?.version_sha256 === snapshotRow?.history_sha256 && snapshotRow?.version_sha256 === snapshotRow?.live_sha256 &&
      snapshotRow?.version_object_version === snapshotRow?.history_object_version &&
      snapshotRow?.version_object_version === snapshotRow?.live_object_version &&
      snapshotRow?.media_asset_version === snapshotRow?.decision_version && savedAcceptance?.state === "accepted");
    cvAcceptanceScenario("T10-04 approval, history, root increment, exact receipt and minimal event commit together while Current CV remains empty",
      savedAcceptance?.aggregate_version === expectedCvVersion + 1 && savedAcceptance?.histories === 1 && savedAcceptance?.receipts === 1 &&
      savedAcceptance?.events === 1 && savedAcceptance?.current_events === 0 && savedAcceptance?.current_version_id === null &&
      JSON.stringify((await admin.query(`select payload from operations.outbox_events where aggregate_id = $1::uuid
        and event_type = 'cv.version_accepted.v1'`, [portfolioId])).rows[0]?.payload) === JSON.stringify({ versionId: cvAcceptVersionId }));

    const acceptedDuplicate = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
      idempotencyKey: "phase6-cv-accept-duplicate-new-key" as never, expectedVersion: expectedCvVersion,
      versionId: cvRegistration.value.versionId });
    cvAcceptanceScenario("T10-06 a new key cannot approve an already accepted CV version",
      !acceptedDuplicate.ok && acceptedDuplicate.error.kind === "conflict" && acceptedDuplicate.error.code === "CV_VERSION_NOT_ACCEPTABLE");

    const malformedFactRepository = createPostgresMediaAcceptanceRepository({
      database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId },
    });
    const malformedFactService = (mode: "incomplete" | "duplicate" | "version-inconsistent") => {
      const mediaRepository = {
        ...malformedFactRepository,
        async getAcceptanceFacts(query: Parameters<typeof malformedFactRepository.getAcceptanceFacts>[0], transaction: Parameters<typeof malformedFactRepository.getAcceptanceFacts>[1]) {
          const facts = await malformedFactRepository.getAcceptanceFacts(query, transaction);
          if (!facts.ok) return facts;
          if (mode === "incomplete") return { ok: true as const, value: [] };
          if (mode === "duplicate") return { ok: true as const, value: [...facts.value, ...facts.value] };
          return { ok: true as const, value: facts.value.map((fact) => ({ ...fact, assetVersion: fact.assetVersion + 1 })) };
        },
      };
      const acceptance = createMediaAcceptanceApplicationService({ scope: { ownerId }, repository: mediaRepository });
      const media = mode === "version-inconsistent" ? {
        ...acceptance,
        async getAcceptedPdfSnapshot(query: Parameters<typeof acceptance.getAcceptedPdfSnapshot>[0], transaction: Parameters<typeof acceptance.getAcceptedPdfSnapshot>[1]) {
          const result = await acceptance.getAcceptedPdfSnapshot(query, transaction);
          return result.ok && result.value.status === "accepted"
            ? { ok: true as const, value: { ...result.value, snapshot: { ...result.value.snapshot, assetVersion: result.value.snapshot.assetVersion + 1 } } }
            : result;
        },
      } : acceptance;
      const cvRepository = createPostgresCvPortfolioRepository({
        database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId }, media,
      });
      return createOwnerCvApplicationService({ ownerId, repository: cvRepository });
    };
    for (const mode of ["incomplete", "duplicate", "version-inconsistent"] as const) {
      const current = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      expect(current.ok).toBe(true);
      if (!current.ok) throw new Error("PHASE6_CV_ACCEPTANCE_ROOT_READ_FAILED");
      const candidate = await registerCv({ idempotencyKey: `phase6-cv-register-${mode}` as never,
        expectedVersion: current.value.aggregateVersion, label: `CV ${mode} facts fixture` });
      expect(candidate.ok).toBe(true);
      if (!candidate.ok) throw new Error("PHASE6_CV_ACCEPTANCE_FACTS_FIXTURE_FAILED");
      const beforeMalformedAcceptance = await admin.query(`select portfolio.aggregate_version,
          (select count(*)::int from cv_portfolio.acceptance_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from cv_portfolio.acceptance_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_accepted.v1') as events,
          version.state
        from cv_portfolio.portfolios portfolio join cv_portfolio.versions version on version.version_id = $3::uuid
        where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId, candidate.value.versionId]);
      const malformedResult = await malformedFactService(mode).acceptOwnerCvVersion({ actor: cvOwner,
        idempotencyKey: `phase6-cv-accept-${mode}` as never, expectedVersion: current.value.aggregateVersion + 1,
        versionId: candidate.value.versionId });
      const afterMalformedAcceptance = await admin.query(`select portfolio.aggregate_version,
          (select count(*)::int from cv_portfolio.acceptance_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from cv_portfolio.acceptance_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_accepted.v1') as events,
          version.state
        from cv_portfolio.portfolios portfolio join cv_portfolio.versions version on version.version_id = $3::uuid
        where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId, candidate.value.versionId]);
      cvAcceptanceScenario(`T10-03 ${mode} Media acceptance facts fail without changing CV approval state`,
        !malformedResult.ok && JSON.stringify(afterMalformedAcceptance.rows[0]) === JSON.stringify(beforeMalformedAcceptance.rows[0]) &&
        afterMalformedAcceptance.rows[0]?.state === "registered");
    }

    const secondRegistration = await registerCv({ idempotencyKey: "phase6-cv-register-acceptance-second" as never,
      expectedVersion: expectedCvVersion + 4, label: "CV acceptance rollback fixture" });
    expect(secondRegistration).toMatchObject({ ok: true });
    if (!secondRegistration.ok) throw new Error("PHASE6_CV_ACCEPTANCE_FIXTURE_REGISTRATION_FAILED");
    const rootBeforeAcceptanceRollback = expectedCvVersion + 5;
    const rollbackSnapshot = () => admin.query(`select portfolio.aggregate_version, version.state,
        (select count(*)::int from cv_portfolio.acceptance_history where version_id = $3::uuid) as histories,
        (select count(*)::int from cv_portfolio.acceptance_commands where version_id = $3::uuid) as receipts,
        (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.version_accepted.v1') as events
      from cv_portfolio.portfolios portfolio join cv_portfolio.versions version on version.version_id = $3::uuid
      where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId, secondRegistration.value.versionId]);
    for (const fault of ["history", "receipt"] as const) {
      const table = fault === "history" ? "cv_portfolio.acceptance_history" : "cv_portfolio.acceptance_commands";
      const constraint = `phase6_cv_acceptance_${fault}_failure`;
      await admin.query(`alter table ${table} add constraint ${constraint}
        check (version_id <> '${secondRegistration.value.versionId}'::uuid) not valid`);
      let failedWrite;
      try {
        failedWrite = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
          idempotencyKey: `phase6-cv-accept-${fault}-rollback` as never, expectedVersion: rootBeforeAcceptanceRollback,
          versionId: secondRegistration.value.versionId });
      } finally {
        await admin.query(`alter table ${table} drop constraint ${constraint}`);
      }
      const afterFailedWrite = await rollbackSnapshot();
      cvAcceptanceScenario(`T10-04 injected ${fault} failure rolls back CV state, root version, approval and success receipt`,
        !failedWrite?.ok && failedWrite?.error.code === "CV_ACCEPTANCE_COMMIT_FAILED" &&
        afterFailedWrite.rows[0]?.aggregate_version === rootBeforeAcceptanceRollback &&
        afterFailedWrite.rows[0]?.state === "registered" && afterFailedWrite.rows[0]?.histories === 0 &&
        afterFailedWrite.rows[0]?.receipts === 0 && afterFailedWrite.rows[0]?.events === 1);
    }
    await admin.query(`alter table operations.outbox_events add constraint phase6_cv_acceptance_outbox_failure
      check (event_type <> 'cv.version_accepted.v1') not valid`);
    let failedAcceptanceCommit;
    try {
      failedAcceptanceCommit = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
        idempotencyKey: "phase6-cv-accept-rollback" as never, expectedVersion: rootBeforeAcceptanceRollback,
        versionId: secondRegistration.value.versionId });
    } finally {
      await admin.query("alter table operations.outbox_events drop constraint phase6_cv_acceptance_outbox_failure");
    }
    const afterAcceptanceRollback = await rollbackSnapshot();
    cvAcceptanceScenario("T10-04 injected outbox failure rolls back CV state, approval history, root version and success receipt",
      !failedAcceptanceCommit?.ok && failedAcceptanceCommit?.error.code === "CV_ACCEPTANCE_COMMIT_FAILED" &&
      afterAcceptanceRollback.rows[0]?.aggregate_version === rootBeforeAcceptanceRollback &&
      afterAcceptanceRollback.rows[0]?.state === "registered" && afterAcceptanceRollback.rows[0]?.histories === 0 &&
      afterAcceptanceRollback.rows[0]?.receipts === 0 && afterAcceptanceRollback.rows[0]?.events === 1);

    const staleRootAcceptance = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
      idempotencyKey: "phase6-cv-accept-stale-root" as never, expectedVersion: rootBeforeAcceptanceRollback - 1,
      versionId: secondRegistration.value.versionId });
    cvAcceptanceScenario("T10-06 a fresh stale shared-root If-Match fails without creating an approval",
      !staleRootAcceptance.ok && staleRootAcceptance.error.kind === "precondition_failed" && staleRootAcceptance.error.currentVersion === rootBeforeAcceptanceRollback &&
      afterAcceptanceRollback.rows[0]?.state === "registered");

    const thirdRegistration = await registerCv({ idempotencyKey: "phase6-cv-register-acceptance-stale-media" as never,
      expectedVersion: rootBeforeAcceptanceRollback, label: "CV stale Media fixture" });
    expect(thirdRegistration).toMatchObject({ ok: true });
    if (!thirdRegistration.ok) throw new Error("PHASE6_CV_STALE_MEDIA_FIXTURE_REGISTRATION_FAILED");
    const rejectDecisionId = createStableId("MediaDecision");
    await admin.query(`with changed as (
        update media.processing_states set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
         where media_id = $1::uuid and portfolio_id = $2::uuid and owner_id = $3::uuid
         returning aggregate_version
      )
      insert into media.decision_history
        (decision_id, portfolio_id, owner_id, media_id, aggregate_version, decision, processing_attempt_id,
         input_object_id, input_sha256, detected_mime_type, detected_byte_length, scanner_version, processor_version,
         processing_policy_version, sealed_outputs, accessibility, ownership_attested_by, ownership_attested_at,
         public_suitability_attested_by, public_suitability_attested_at, decided_by, decided_at, reason_code)
      select $4::uuid, decision.portfolio_id, decision.owner_id, decision.media_id, changed.aggregate_version,
             'rejected', decision.processing_attempt_id, decision.input_object_id, decision.input_sha256,
             decision.detected_mime_type, decision.detected_byte_length, decision.scanner_version, decision.processor_version,
             decision.processing_policy_version, decision.sealed_outputs, decision.accessibility,
             decision.owner_id, transaction_timestamp(), decision.owner_id, transaction_timestamp(), decision.owner_id,
             transaction_timestamp(), 'OWNER_REJECTED'
        from changed join media.decision_history decision on decision.media_id = $1::uuid
          and decision.portfolio_id = $2::uuid and decision.owner_id = $3::uuid
          and decision.aggregate_version = changed.aggregate_version - 1 and decision.decision = 'accepted'`,
    [safe.mediaId, portfolioId, ownerId, rejectDecisionId]);
    const staleMediaAcceptance = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
      idempotencyKey: "phase6-cv-accept-stale-media" as never, expectedVersion: rootBeforeAcceptanceRollback + 1,
      versionId: thirdRegistration.value.versionId });
    const replayAfterLaterChanges = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
      idempotencyKey: "phase6-cv-accept-primary" as never, expectedVersion: expectedCvVersion,
      versionId: cvRegistration.value.versionId });
    const changedKeyIntent = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
      idempotencyKey: "phase6-cv-accept-primary" as never, expectedVersion: expectedCvVersion,
      versionId: secondRegistration.value.versionId });
    cvAcceptanceScenario("T10-03 a rejected Media asset changed after registration cannot be accepted from stale snapshot facts",
      !staleMediaAcceptance.ok && staleMediaAcceptance.error.kind === "conflict" && staleMediaAcceptance.error.code === "CV_MEDIA_NOT_ELIGIBLE");
    cvAcceptanceScenario("T10-06 exact replay returns the original receipt before later root/Media checks; changed intent conflicts",
      JSON.stringify(replayAfterLaterChanges) === JSON.stringify({ ok: true, value: acceptanceBody }) &&
      !changedKeyIntent.ok && changedKeyIntent.error.kind === "conflict" && changedKeyIntent.error.code === "IDEMPOTENCY_CONFLICT");

    // The invalidation above is a temporary fixture mutation. Restore the shared
    // accepted Media candidate so later image/video suites still start clean.
    await admin.query("delete from media.decision_history where decision_id = $1::uuid and media_id = $2::uuid", [rejectDecisionId, safe.mediaId]);
    await admin.query(`update media.processing_states set aggregate_version = aggregate_version - 1
      where media_id = $1::uuid and portfolio_id = $2::uuid and owner_id = $3::uuid`, [safe.mediaId, portfolioId, ownerId]);

    const privateAcceptanceAccess = await appDatabase.transactions.run(async (transaction) => {
      const executor = resolvePostgresTransaction(transaction);
      await sql`select set_config('shipwithali.portfolio_id', '', true), set_config('shipwithali.owner_id', '', true)`.execute(executor);
      const rows = await sql<{ readonly histories: number | string; readonly receipts: number | string }>`select
          (select count(*) from cv_portfolio.acceptance_history) as histories,
          (select count(*) from cv_portfolio.acceptance_commands) as receipts`.execute(executor);
      return rows.rows[0];
    });
    const acceptancePolicies = await admin.query(`select
        (select count(*)::int from pg_class where oid in ('cv_portfolio.acceptance_history'::regclass,
          'cv_portfolio.acceptance_commands'::regclass) and relrowsecurity and relforcerowsecurity) as rls_tables,
        (select count(*)::int from pg_policies where schemaname = 'cv_portfolio'
          and policyname in ('cv_acceptance_history_owner_scope', 'cv_acceptance_commands_owner_scope')) as policies,
        has_table_privilege('anon', 'cv_portfolio.acceptance_history', 'SELECT') as anon_history_read,
        has_table_privilege('anon', 'cv_portfolio.acceptance_commands', 'SELECT') as anon_receipt_read,
        has_column_privilege('shipwithali_application', 'cv_portfolio.versions', 'state', 'UPDATE') as can_change_state,
        has_column_privilege('shipwithali_application', 'cv_portfolio.versions', 'media_sha256', 'UPDATE') as can_change_snapshot`);
    const acceptedOwnerView = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
    const acceptedPrivateHistory = await admin.query(`select version.state,
        history.media_decision_id::text as media_decision_id, history.media_object_id::text as media_object_id,
        history.media_sha256, history.media_object_version
      from cv_portfolio.versions version join cv_portfolio.acceptance_history history on history.version_id = version.version_id
      where version.version_id = $1::uuid and version.portfolio_id = $2::uuid and version.owner_id = $3::uuid`,
    [cvRegistration.value.versionId, portfolioId, ownerId]);
    const acceptedPublicBoundary = await admin.query(`select current_version_id::text from cv_portfolio.portfolios
      where portfolio_id = $1::uuid and owner_id = $2::uuid`, [portfolioId, ownerId]);
    cvAcceptanceScenario("T10-07 accepted CV snapshot and approval remain private history and never change the empty Current CV pointer",
      acceptedOwnerView.ok && acceptedOwnerView.value.currentVersionId === null && acceptedOwnerView.value.versions.length <= 100 &&
      acceptedPrivateHistory.rows[0]?.state === "accepted" && acceptedPrivateHistory.rows[0]?.media_decision_id === snapshotRow?.version_decision_id &&
      acceptedPrivateHistory.rows[0]?.media_object_id === snapshotRow?.version_object_id &&
      acceptedPrivateHistory.rows[0]?.media_sha256 === snapshotRow?.version_sha256 &&
      acceptedPrivateHistory.rows[0]?.media_object_version === snapshotRow?.version_object_version &&
      acceptedPublicBoundary.rows[0]?.current_version_id === null && savedAcceptance?.histories === 1);
    cvAcceptanceScenario("T10-08 strict response and Owner views expose no PDF content or Media snapshot; approval tables use scoped forced RLS and append-only access",
      acceptanceBody.outcome === "cv-version-accepted" && Object.keys(acceptanceBody).sort().join(",") === "aggregateId,aggregateVersion,outcome" &&
      !JSON.stringify(acceptanceBody).includes("sha256") && !JSON.stringify(acceptanceBody).includes("fileName") &&
      acceptedOwnerView.ok && !JSON.stringify(acceptedOwnerView.value).includes("media_sha256") &&
      Number(privateAcceptanceAccess?.histories) === 0 && Number(privateAcceptanceAccess?.receipts) === 0 &&
      acceptancePolicies.rows[0]?.rls_tables === 2 && acceptancePolicies.rows[0]?.policies === 2 &&
      acceptancePolicies.rows[0]?.anon_history_read === false && acceptancePolicies.rows[0]?.anon_receipt_read === false &&
      acceptancePolicies.rows[0]?.can_change_state === true && acceptancePolicies.rows[0]?.can_change_snapshot === false);

    // Model an already-current accepted version. Activation is a separate
    // operation; this acceptance must leave the existing pointer and its event
    // history untouched.
    await admin.query("begin");
    try {
      await admin.query(`update cv_portfolio.versions set is_current = true where version_id = $1::uuid`, [cvRegistration.value.versionId]);
      await admin.query(`update cv_portfolio.portfolios set current_version_id = $3::uuid
        where portfolio_id = $1::uuid and owner_id = $2::uuid`, [portfolioId, ownerId, cvRegistration.value.versionId]);
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
    const currentBeforeReplacement = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
    expect(currentBeforeReplacement.ok).toBe(true);
    if (!currentBeforeReplacement.ok) throw new Error("PHASE6_CV_ACCEPTANCE_CURRENT_ROOT_READ_FAILED");
    const existingCurrentEvents = await admin.query(`select count(*)::int as count from operations.outbox_events
      where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1'`, [portfolioId]);
    const replacementRegistration = await registerCv({ idempotencyKey: "phase6-cv-register-with-current" as never,
      expectedVersion: currentBeforeReplacement.value.aggregateVersion, label: "CV accepted while another version is current" });
    expect(replacementRegistration.ok).toBe(true);
    if (!replacementRegistration.ok) throw new Error("PHASE6_CV_ACCEPTANCE_CURRENT_FIXTURE_FAILED");
    const replacementAcceptance = await cvService.acceptOwnerCvVersion({ actor: cvOwner,
      idempotencyKey: "phase6-cv-accept-with-current" as never,
      expectedVersion: currentBeforeReplacement.value.aggregateVersion + 1, versionId: replacementRegistration.value.versionId });
    const currentAfterReplacement = await admin.query(`select current_version_id::text as current_version_id,
        aggregate_version, (select count(*)::int from operations.outbox_events
          where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as current_events
      from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid`, [portfolioId, ownerId]);
    cvAcceptanceScenario("T10-05 accepting another registered version leaves an existing Current CV pointer and its event history unchanged",
      replacementAcceptance.ok && currentAfterReplacement.rows[0]?.current_version_id === cvRegistration.value.versionId &&
      currentAfterReplacement.rows[0]?.aggregate_version === currentBeforeReplacement.value.aggregateVersion + 2 &&
      currentAfterReplacement.rows[0]?.current_events === existingCurrentEvents.rows[0]?.count);
    await admin.query("begin");
    try {
      await admin.query("set local session_replication_role = replica");
      await admin.query(`update cv_portfolio.versions set is_current = false
        where version_id = $1::uuid`, [cvRegistration.value.versionId]);
      await admin.query(`update cv_portfolio.portfolios set current_version_id = null, ever_activated = false
        where portfolio_id = $1::uuid and owner_id = $2::uuid`, [portfolioId, ownerId]);
      await admin.query("commit");
    } catch (error) {
      await admin.query("rollback");
      throw error;
    }
    expect(cvAcceptanceChecks.every((item) => item.status === "passed")).toBe(true);
    mediaProcessingCounts.cvAcceptanceScenarios = cvAcceptanceChecks;

    if (REQUIRE_CV_ACTIVATION) {
      const cvActivationChecks: Array<{ readonly name: string; readonly executed: boolean; readonly status: "passed" | "failed" }> = [];
      const cvActivationScenario = (name: string, passed: boolean) => {
        cvActivationChecks.push({ name, executed: true, status: passed ? "passed" : "failed" });
        expect(passed, name).toBe(true);
      };
      const initialActivationView = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      if (!initialActivationView.ok) throw new Error("PHASE6_CV_ACTIVATION_EMPTY_ROOT_READ_FAILED");
      const initialActivationRoot = await admin.query(`select current_version_id::text as current_version_id,
          ever_activated, (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid and is_current) as current_flags
        from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid`, [portfolioId, ownerId]);
      cvActivationScenario("T11-01 an unactivated portfolio has zero current flags; the first activation creates one coherent accepted English current version",
        initialActivationView.value.currentVersionId === null && initialActivationRoot.rows[0]?.current_version_id === null &&
        initialActivationRoot.rows[0]?.ever_activated === false && initialActivationRoot.rows[0]?.current_flags === 0 &&
        initialActivationView.value.versions.every((version) => !version.isCurrent));

      const initialActivationKey = "phase6-cv-activate-first";
      const firstActivationResponse = await activateCvThroughHttp({ versionId: cvRegistration.value.versionId,
        idempotencyKey: initialActivationKey, ifMatch: `"${initialActivationView.value.aggregateVersion}"` });
      const firstActivationBody = await firstActivationResponse.json();
      const firstActivationView = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const firstActivationState = await admin.query(`select portfolio.aggregate_version, portfolio.current_version_id::text as current_version_id,
          portfolio.ever_activated, version.is_current,
          (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events
        from cv_portfolio.portfolios portfolio join cv_portfolio.versions version
          on version.version_id = portfolio.current_version_id and version.portfolio_id = portfolio.portfolio_id and version.owner_id = portfolio.owner_id
        where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid`, [portfolioId, ownerId]);
      const firstActivationEvent = await admin.query(`select payload from operations.outbox_events
        where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1'`, [portfolioId]);
      const firstEventPayload = firstActivationEvent.rows[0]?.payload as Record<string, unknown> | undefined;
      cvActivationScenario("T11-03 first activation atomically persists the pointer, current flag, retained history, safe receipt and minimal event",
        firstActivationResponse.status === 200 && firstActivationBody.outcome === "current-cv-activated" &&
        firstActivationView.ok && firstActivationView.value.currentVersionId === cvRegistration.value.versionId &&
        firstActivationView.value.versions.find(({ versionId }) => versionId === cvRegistration.value.versionId)?.isCurrent === true &&
        firstActivationState.rows[0]?.current_version_id === cvRegistration.value.versionId &&
        firstActivationState.rows[0]?.ever_activated === true && firstActivationState.rows[0]?.is_current === true &&
        firstActivationState.rows[0]?.histories === 1 && firstActivationState.rows[0]?.events === 1 &&
        Object.keys(firstEventPayload ?? {}).sort().join(",") === "activatedAt,newCurrentCvId" &&
        firstEventPayload?.["newCurrentCvId"] === cvRegistration.value.versionId);

      const rejectedDirectMutations: boolean[] = [];
      for (const mutation of [
        { statement: "update cv_portfolio.portfolios set current_version_id = null where portfolio_id = $1::uuid and owner_id = $2::uuid", parameters: [portfolioId, ownerId] },
        { statement: "update cv_portfolio.versions set state = 'registered' where version_id = $1::uuid and portfolio_id = $2::uuid and owner_id = $3::uuid", parameters: [cvRegistration.value.versionId, portfolioId, ownerId] },
        { statement: "update cv_portfolio.portfolios set current_version_id = $3::uuid where portfolio_id = $1::uuid and owner_id = $2::uuid", parameters: [portfolioId, ownerId, createStableId("CvVersion")] },
        { statement: "update cv_portfolio.portfolios set current_version_locale = 'ar' where portfolio_id = $1::uuid and owner_id = $2::uuid", parameters: [portfolioId, ownerId] },
        { statement: "update cv_portfolio.versions set is_current = true where version_id = $1::uuid and portfolio_id = $2::uuid and owner_id = $3::uuid", parameters: [replacementRegistration.value.versionId, portfolioId, ownerId] },
        { statement: "update cv_portfolio.portfolios set owner_id = $3::uuid where portfolio_id = $1::uuid and owner_id = $2::uuid", parameters: [portfolioId, ownerId, createStableId("Owner")] },
      ]) {
        await appClient.query("begin");
        try {
          await appClient.query("select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true)", [portfolioId, ownerId]);
          await appClient.query(mutation.statement, mutation.parameters);
          await appClient.query("set constraints all immediate");
          await appClient.query("commit");
          rejectedDirectMutations.push(false);
        } catch {
          await appClient.query("rollback");
          rejectedDirectMutations.push(true);
        }
      }
      cvActivationScenario("T11-02 constrained application-role SQL rejects clearing the active pointer, downgrading an accepted current CV, unknown references and cross-Owner scope changes",
        rejectedDirectMutations.length === 6 && rejectedDirectMutations.every(Boolean));

      let releaseActivationMediaLock!: () => void;
      let activationMediaLockReady!: () => void;
      const heldActivationMediaLock = new Promise<void>((resolve) => { releaseActivationMediaLock = resolve; });
      const activationMediaLockStarted = new Promise<void>((resolve) => { activationMediaLockReady = resolve; });
      const activationMediaLock = appDatabase.transactions.run(async (transaction) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${safe.mediaId}::text, 0))`
          .execute(resolvePostgresTransaction(transaction));
        activationMediaLockReady();
        await heldActivationMediaLock;
      });
      await activationMediaLockStarted;
      const competingActivationVersion = replacementRegistration.value.versionId;
      const competingIfMatch = `"${firstActivationView.ok ? firstActivationView.value.aggregateVersion : 0}"`;
      const competingActivations = Promise.all([
        activateCvThroughHttp({ versionId: competingActivationVersion, idempotencyKey: "phase6-cv-activate-race-a", ifMatch: competingIfMatch }),
        activateCvThroughHttp({ versionId: competingActivationVersion, idempotencyKey: "phase6-cv-activate-race-b", ifMatch: competingIfMatch }),
      ]);
      let waitingForActivationMediaLock = 0;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const waiting = await admin.query(`select count(*)::int as count from pg_stat_activity
          where usename = $1 and wait_event_type = 'Lock' and query ilike '%pg_advisory_xact_lock_shared%'`, [roleName]);
        waitingForActivationMediaLock = Number(waiting.rows[0]?.count ?? 0);
        if (waitingForActivationMediaLock === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      releaseActivationMediaLock();
      await activationMediaLock;
      const competingResponses = await competingActivations;
      const competingBodies = await Promise.all(competingResponses.map(async (response) => await response.json() as Record<string, unknown>));
      const competingSuccesses = competingResponses.filter((response) => response.status === 200).length;
      const competingPreconditions = competingBodies.filter((body) => body["code"] === "CV_PORTFOLIO_VERSION_MISMATCH").length;
      const afterCompetingView = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      cvActivationScenario("T11-04 independent same-version activations serialize on the shared Media lock and one fresh root version wins",
        waitingForActivationMediaLock === 2 && competingSuccesses === 1 && competingPreconditions === 1 &&
        afterCompetingView.ok && afterCompetingView.value.currentVersionId === competingActivationVersion &&
        afterCompetingView.value.versions.filter(({ isCurrent }) => isCurrent).length === 1);

      const replayOfFirstActivation = await activateCvThroughHttp({ versionId: cvRegistration.value.versionId,
        idempotencyKey: initialActivationKey, ifMatch: `"${initialActivationView.value.aggregateVersion}"` });
      const replayOfFirstBody = await replayOfFirstActivation.json();
      const changedActivationIntent = await activateCvThroughHttp({ versionId: competingActivationVersion,
        idempotencyKey: initialActivationKey, ifMatch: `"${initialActivationView.value.aggregateVersion}"` });
      const changedActivationBody = await changedActivationIntent.json() as Record<string, unknown>;
      const staleActivation = await activateCvThroughHttp({ versionId: cvRegistration.value.versionId,
        idempotencyKey: "phase6-cv-activate-stale", ifMatch: `"${initialActivationView.value.aggregateVersion}"` });
      const staleActivationBody = await staleActivation.json() as Record<string, unknown>;
      cvActivationScenario("T11-06 exact replay returns the earlier receipt after replacement; changed-key intent and fresh stale versions conflict",
        replayOfFirstActivation.status === 200 && replayOfFirstBody.aggregateVersion === initialActivationView.value.aggregateVersion + 1 &&
        changedActivationIntent.status === 409 && changedActivationBody["code"] === "IDEMPOTENCY_CONFLICT" &&
        staleActivation.status === 412 && staleActivationBody["code"] === "CV_PORTFOLIO_VERSION_MISMATCH");

      if (!afterCompetingView.ok) throw new Error("PHASE6_CV_ACTIVATION_CURRENT_VIEW_FAILED");
      const historyAndEventCountBeforeNoop = await admin.query(`select
          (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events`,
      [portfolioId, ownerId]);
      const noOpKey = "phase6-cv-activate-noop";
      const noOpActivation = await activateCvThroughHttp({ versionId: competingActivationVersion, idempotencyKey: noOpKey,
        ifMatch: `"${afterCompetingView.value.aggregateVersion}"` });
      const noOpBody = await noOpActivation.json();
      const noOpReplay = await activateCvThroughHttp({ versionId: competingActivationVersion, idempotencyKey: noOpKey,
        ifMatch: `"${afterCompetingView.value.aggregateVersion}"` });
      const noOpAfter = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const historyAndEventCountAfterNoop = await admin.query(`select
          (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events`,
      [portfolioId, ownerId]);
      cvActivationScenario("T11-07 activation of the already-current version records and replays a receipt without changing root version, history or events",
        noOpActivation.status === 200 && noOpBody.aggregateVersion === afterCompetingView.value.aggregateVersion && noOpReplay.status === 200 &&
        noOpAfter.ok && noOpAfter.value.aggregateVersion === afterCompetingView.value.aggregateVersion &&
        historyAndEventCountAfterNoop.rows[0]?.histories === historyAndEventCountBeforeNoop.rows[0]?.histories &&
        historyAndEventCountAfterNoop.rows[0]?.events === historyAndEventCountBeforeNoop.rows[0]?.events);

      const beforeReactivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      if (!beforeReactivation.ok) throw new Error("PHASE6_CV_REACTIVATION_VIEW_FAILED");
      const reactivatePrior = await activateCvThroughHttp({ versionId: cvRegistration.value.versionId,
        idempotencyKey: "phase6-cv-reactivate-prior", ifMatch: `"${beforeReactivation.value.aggregateVersion}"` });
      const afterReactivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      cvActivationScenario("T11-08 an eligible retained prior CV version can be reactivated with a fresh key and root version",
        reactivatePrior.status === 200 && afterReactivation.ok && afterReactivation.value.aggregateVersion === beforeReactivation.value.aggregateVersion + 1 &&
        afterReactivation.value.currentVersionId === cvRegistration.value.versionId &&
        afterReactivation.value.activationHistory.filter(({ versionId }) => versionId === cvRegistration.value.versionId).length >= 2);

      const observerBaseline = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      if (!observerBaseline.ok) throw new Error("PHASE6_CV_ACTIVATION_OBSERVER_BASELINE_FAILED");
      const observerTriggerFunction = "phase6_cv_activation_observer_barrier";
      const observerTrigger = "phase6_cv_activation_observer_barrier_trigger";
      await admin.query(`create function cv_portfolio.${observerTriggerFunction}() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(781560156); return new; end $$`);
      await admin.query(`create trigger ${observerTrigger} before update of current_version_id on cv_portfolio.portfolios
        for each row when (old.current_version_id is distinct from new.current_version_id)
        execute function cv_portfolio.${observerTriggerFunction}()`);
      await admin.query("begin");
      await admin.query("select pg_advisory_xact_lock(781560156)");
      try {
        const observerActivationPromise = activateCvThroughHttp({ versionId: competingActivationVersion,
          idempotencyKey: "phase6-cv-activate-observer", ifMatch: `\"${observerBaseline.value.aggregateVersion}\"` });
        let observerReachedBarrier = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await admin.query(`select count(*)::int as count from pg_stat_activity
            where usename = $1 and wait_event_type = 'Lock' and query ilike '%current_version_id%'`, [roleName]);
          if (Number(waiting.rows[0]?.count ?? 0) > 0) { observerReachedBarrier = true; break; }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const duringReplacement = await admin.query(`select portfolio.current_version_id::text as current_version_id,
            count(*) filter (where version.is_current)::int as current_flags
          from cv_portfolio.portfolios portfolio join cv_portfolio.versions version
            on version.portfolio_id = portfolio.portfolio_id and version.owner_id = portfolio.owner_id
          where portfolio.portfolio_id = $1::uuid and portfolio.owner_id = $2::uuid
          group by portfolio.current_version_id`, [portfolioId, ownerId]);
        const observerSawOld = observerReachedBarrier && duringReplacement.rows[0]?.current_version_id === cvRegistration.value.versionId &&
          duringReplacement.rows[0]?.current_flags === 1;
        await admin.query("commit");
        const observerActivation = await observerActivationPromise;
        const observerAfter = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
        cvActivationScenario("T11-05 an independent committed observer sees the old current CV during an uncommitted replacement and the new one after commit",
          observerSawOld && observerActivation.status === 200 && observerAfter.ok &&
          observerAfter.value.currentVersionId === competingActivationVersion &&
          observerAfter.value.versions.filter(({ isCurrent }) => isCurrent).length === 1);
      } catch (error) {
        await admin.query("rollback");
        throw error;
      } finally {
        await admin.query(`drop trigger ${observerTrigger} on cv_portfolio.portfolios`);
        await admin.query(`drop function cv_portfolio.${observerTriggerFunction}()`);
      }

      const rejectionDecisionId = createStableId("MediaDecision");
      await admin.query(`with changed as (
          update media.processing_states set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where media_id = $1::uuid and portfolio_id = $2::uuid and owner_id = $3::uuid returning aggregate_version
        )
        insert into media.decision_history
          (decision_id, portfolio_id, owner_id, media_id, aggregate_version, decision, processing_attempt_id,
           input_object_id, input_sha256, detected_mime_type, detected_byte_length, scanner_version, processor_version,
           processing_policy_version, sealed_outputs, accessibility, ownership_attested_by, ownership_attested_at,
           public_suitability_attested_by, public_suitability_attested_at, decided_by, decided_at, reason_code)
        select $4::uuid, decision.portfolio_id, decision.owner_id, decision.media_id, changed.aggregate_version,
               'rejected', decision.processing_attempt_id, decision.input_object_id, decision.input_sha256,
               decision.detected_mime_type, decision.detected_byte_length, decision.scanner_version, decision.processor_version,
               decision.processing_policy_version, decision.sealed_outputs, decision.accessibility,
               decision.owner_id, transaction_timestamp(), decision.owner_id, transaction_timestamp(), decision.owner_id,
               transaction_timestamp(), 'OWNER_REJECTED'
          from changed join media.decision_history decision on decision.media_id = $1::uuid
            and decision.portfolio_id = $2::uuid and decision.owner_id = $3::uuid
            and decision.aggregate_version = changed.aggregate_version - 1 and decision.decision = 'accepted'`,
      [safe.mediaId, portfolioId, ownerId, rejectionDecisionId]);
      const beforeRejectedActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const rejectedActivation = beforeRejectedActivation.ok ? await activateCvThroughHttp({ versionId: cvRegistration.value.versionId,
        idempotencyKey: "phase6-cv-activate-media-rejected", ifMatch: `"${beforeRejectedActivation.value.aggregateVersion}"` }) : undefined;
      const rejectedActivationBody = rejectedActivation ? await rejectedActivation.json() as Record<string, unknown> : undefined;
      const afterRejectedActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const rejectedActivationCounts = await admin.query(`select
          (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from cv_portfolio.activation_commands where portfolio_id = $1::uuid and owner_id = $2::uuid and idempotency_key_hash = $3) as receipts,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events`,
      [portfolioId, ownerId, createHash("sha256").update("phase6-cv-activate-media-rejected").digest("hex")]);
      await admin.query("delete from media.decision_history where decision_id = $1::uuid and media_id = $2::uuid", [rejectionDecisionId, safe.mediaId]);
      await admin.query(`update media.processing_states set aggregate_version = aggregate_version - 1
        where media_id = $1::uuid and portfolio_id = $2::uuid and owner_id = $3::uuid`, [safe.mediaId, portfolioId, ownerId]);
      cvActivationScenario("T11-09 rejected current Media facts block activation and preserve the current pointer, history, receipt and event",
        rejectedActivation?.status === 409 && rejectedActivationBody?.["code"] === "CV_MEDIA_NOT_ELIGIBLE" &&
        beforeRejectedActivation.ok && afterRejectedActivation.ok && beforeRejectedActivation.value.currentVersionId === afterRejectedActivation.value.currentVersionId &&
        beforeRejectedActivation.value.aggregateVersion === afterRejectedActivation.value.aggregateVersion &&
        rejectedActivationCounts.rows[0]?.histories === beforeRejectedActivation.value.activationHistory.length &&
        rejectedActivationCounts.rows[0]?.receipts === 0 && rejectedActivationCounts.rows[0]?.events === historyAndEventCountAfterNoop.rows[0]?.events + 1);

      const unsafeAttempt = await admin.query(`select attempt.attempt_id::text as attempt_id, attempt.finding_codes
        from media.processing_states state join media.processing_attempts attempt on attempt.attempt_id = state.latest_attempt_id
        where state.media_id = $1::uuid and state.portfolio_id = $2::uuid and state.owner_id = $3::uuid`, [safe.mediaId, portfolioId, ownerId]);
      const originalFindings = unsafeAttempt.rows[0]?.finding_codes;
      if (!unsafeAttempt.rows[0]?.attempt_id) throw new Error("PHASE6_CV_ACTIVATION_UNSAFE_FIXTURE_FAILED");
      await admin.query("update media.processing_attempts set finding_codes = '[\"T11_TEST_UNSAFE\"]'::jsonb where attempt_id = $1::uuid", [unsafeAttempt.rows[0].attempt_id]);
      const beforeUnsafeActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const unsafeActivation = beforeUnsafeActivation.ok ? await activateCvThroughHttp({ versionId: cvRegistration.value.versionId,
        idempotencyKey: "phase6-cv-activate-media-unsafe", ifMatch: `"${beforeUnsafeActivation.value.aggregateVersion}"` }) : undefined;
      const afterUnsafeActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const unsafeActivationBody = unsafeActivation ? await unsafeActivation.json() as Record<string, unknown> : undefined;
      await admin.query("update media.processing_attempts set finding_codes = $2::jsonb where attempt_id = $1::uuid",
        [unsafeAttempt.rows[0].attempt_id, JSON.stringify(originalFindings)]);
      cvActivationScenario("T11-09 unsafe processing evidence blocks activation without changing Current CV",
        unsafeActivation?.status === 409 && unsafeActivationBody?.["code"] === "CV_MEDIA_NOT_ELIGIBLE" &&
        beforeUnsafeActivation.ok && afterUnsafeActivation.ok &&
        afterUnsafeActivation.value.currentVersionId === beforeUnsafeActivation.value.currentVersionId &&
        afterUnsafeActivation.value.aggregateVersion === beforeUnsafeActivation.value.aggregateVersion);

      const acceptedDecision = await admin.query(`select decision.decision_id::text as decision_id, decision.accessibility
        from media.processing_states state join media.decision_history decision
          on decision.media_id = state.media_id and decision.portfolio_id = state.portfolio_id
          and decision.owner_id = state.owner_id and decision.aggregate_version = state.aggregate_version
        where state.media_id = $1::uuid and state.portfolio_id = $2::uuid and state.owner_id = $3::uuid`, [safe.mediaId, portfolioId, ownerId]);
      if (!acceptedDecision.rows[0]?.decision_id) throw new Error("PHASE6_CV_ACTIVATION_ACCESSIBILITY_FIXTURE_FAILED");
      await admin.query("update media.decision_history set accessibility = '{\"kind\":\"video\",\"summary\":\"invalid fixture\"}'::jsonb where decision_id = $1::uuid", [acceptedDecision.rows[0].decision_id]);
      const beforeInaccessibleActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const inaccessibleActivation = beforeInaccessibleActivation.ok ? await activateCvThroughHttp({ versionId: cvRegistration.value.versionId,
        idempotencyKey: "phase6-cv-activate-media-inaccessible-facts", ifMatch: `"${beforeInaccessibleActivation.value.aggregateVersion}"` }) : undefined;
      const afterInaccessibleActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const inaccessibleActivationBody = inaccessibleActivation ? await inaccessibleActivation.json() as Record<string, unknown> : undefined;
      await admin.query("update media.decision_history set accessibility = $2::jsonb where decision_id = $1::uuid",
        [acceptedDecision.rows[0].decision_id, JSON.stringify(acceptedDecision.rows[0].accessibility)]);
      cvActivationScenario("T11-09 inaccessible acceptance facts block activation without changing Current CV",
        inaccessibleActivation?.status === 409 && inaccessibleActivationBody?.["code"] === "CV_MEDIA_NOT_ELIGIBLE" &&
        beforeInaccessibleActivation.ok && afterInaccessibleActivation.ok &&
        afterInaccessibleActivation.value.currentVersionId === beforeInaccessibleActivation.value.currentVersionId &&
        afterInaccessibleActivation.value.aggregateVersion === beforeInaccessibleActivation.value.aggregateVersion);

      const assertPreflightFailurePreservesActivation = async (input: {
        readonly scenario: string;
        readonly key: string;
        readonly result: "missing" | "outage" | "inaccessible" | "binding";
      }) => {
        const mediaAcceptance = createAcceptanceService();
        const media = {
          ...mediaAcceptance,
          async getAcceptedPdfSnapshot(query: Parameters<typeof mediaAcceptance.getAcceptedPdfSnapshot>[0], transaction: Parameters<typeof mediaAcceptance.getAcceptedPdfSnapshot>[1]) {
            const accepted = await mediaAcceptance.getAcceptedPdfSnapshot(query, transaction);
            if (!accepted.ok || accepted.value.status !== "accepted") return accepted;
            if (input.result === "inaccessible") return { ok: true as const, value: { status: "not-eligible" as const } };
            if (input.result === "binding") return { ok: true as const, value: { status: "accepted" as const,
              snapshot: { ...accepted.value.snapshot, objectId: createStableId("MediaObject") } } };
            return accepted;
          },
          async preflightAcceptedPdfObject() {
            return input.result === "missing"
              ? { ok: false as const, error: { kind: "conflict" as const, code: "CV_MEDIA_NOT_ELIGIBLE" } }
              : input.result === "outage"
                ? { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_STORAGE_UNAVAILABLE" } }
                : { ok: true as const, value: undefined };
          },
        };
        const repository = createPostgresCvPortfolioRepository({
          database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId }, media,
        });
        const service = createOwnerCvApplicationService({ ownerId, repository });
        const before = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
        if (!before.ok) throw new Error("PHASE6_CV_ACTIVATION_PREFLIGHT_BASELINE_FAILED");
        const beforeCounts = await admin.query(`select
            (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
            (select count(*)::int from cv_portfolio.activation_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
            (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events,
            (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid and is_current) as current_flags`, [portfolioId, ownerId]);
        const activation = await service.activateOwnerCvVersion({ actor: cvOwner, idempotencyKey: input.key as never,
          expectedVersion: before.value.aggregateVersion, versionId: competingActivationVersion });
        const after = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
        const afterCounts = await admin.query(`select
            (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
            (select count(*)::int from cv_portfolio.activation_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
            (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events,
            (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid and is_current) as current_flags`, [portfolioId, ownerId]);
        const expected = input.result === "outage" ? "MEDIA_STORAGE_UNAVAILABLE" : "CV_MEDIA_NOT_ELIGIBLE";
        cvActivationScenario(input.scenario,
          !activation.ok && activation.error.code === expected && after.ok &&
          after.value.currentVersionId === before.value.currentVersionId && after.value.aggregateVersion === before.value.aggregateVersion &&
          JSON.stringify(beforeCounts.rows[0]) === JSON.stringify(afterCounts.rows[0]));
      };
      await assertPreflightFailurePreservesActivation({
        scenario: "T11-09 a missing accepted PDF object blocks activation without changing pointer, flags, history, receipts or outbox",
        key: "phase6-cv-activate-media-object-missing", result: "missing",
      });
      await assertPreflightFailurePreservesActivation({
        scenario: "T11-09 a Storage outage during the real accepted-Media activation path preserves Current CV state",
        key: "phase6-cv-activate-media-outage", result: "outage",
      });
      await assertPreflightFailurePreservesActivation({
        scenario: "T11-09 inaccessible accepted Media blocks activation without changing the portfolio",
        key: "phase6-cv-activate-media-inaccessible", result: "inaccessible",
      });
      await assertPreflightFailurePreservesActivation({
        scenario: "T11-09 an immutable object binding mismatch blocks activation without changing the portfolio",
        key: "phase6-cv-activate-media-binding", result: "binding",
      });

      const beforeRegisteredTarget = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      if (!beforeRegisteredTarget.ok) throw new Error("PHASE6_CV_ACTIVATION_INVALID_STATE_BASELINE_FAILED");
      const registeredOnlyTarget = await registerCv({ idempotencyKey: "phase6-cv-register-unaccepted-target" as never,
        expectedVersion: beforeRegisteredTarget.value.aggregateVersion, label: "CV registered but not accepted" });
      if (!registeredOnlyTarget.ok) throw new Error("PHASE6_CV_ACTIVATION_INVALID_STATE_FIXTURE_FAILED");
      const afterRegisteredTarget = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      if (!afterRegisteredTarget.ok) throw new Error("PHASE6_CV_ACTIVATION_INVALID_STATE_AFTER_REGISTER_FAILED");
      const registeredTargetActivation = await activateCvThroughHttp({ versionId: registeredOnlyTarget.value.versionId,
        idempotencyKey: "phase6-cv-activate-unaccepted-target", ifMatch: `"${afterRegisteredTarget.value.aggregateVersion}"` });
      const registeredTargetBody = await registeredTargetActivation.json() as Record<string, unknown>;
      const afterInvalidStateActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      cvActivationScenario("T11-09 registered but unaccepted CV versions cannot become Current and do not mutate the portfolio",
        registeredTargetActivation.status === 409 && registeredTargetBody["code"] === "CV_VERSION_NOT_ACTIVATABLE" &&
        afterInvalidStateActivation.ok && afterInvalidStateActivation.value.aggregateVersion === afterRegisteredTarget.value.aggregateVersion &&
        afterInvalidStateActivation.value.currentVersionId === afterRegisteredTarget.value.currentVersionId);

      const foreignActivationPortfolioId = createStableId("Portfolio");
      const foreignActivationOwnerId = createStableId("Owner");
      const foreignSettings = createPortfolioSettingsService({ repository: createPostgresPortfolioSettingsRepository(),
        transactions: appDatabase.transactions, scope: { ownerId: foreignActivationOwnerId, portfolioId: foreignActivationPortfolioId } });
      const foreignProvision = await foreignSettings.provision({
        profile: { displayName: "Foreign CV Test Owner", headline: "Private CV scope fixture", bio: "Disposable local integration fixture." },
        contactChannels: [{ channel: "email", label: "Email", destination: "mailto:foreign-cv@example.invalid", availableLocales: ["en"] }],
        globalCta: { label: "Contact", destination: "https://example.invalid/foreign-contact", unavailableFallback: "Unavailable" },
      });
      expect(foreignProvision.ok).toBe(true);
      const foreignUploadService = createMediaUploadIntentApplicationService({
        scope: { ownerId: foreignActivationOwnerId, portfolioId: foreignActivationPortfolioId },
        repository: createPostgresMediaUploadIntentRepository(appDatabase.database, appDatabase.transactions),
        target: targetAdapter,
        vault: createUploadCapabilityVault(REPLAY_KEY),
        ids: createSystemIdGenerator(),
        clock: { now: () => new Date(appNow).toISOString() },
      });
      const foreignPdfHash = createHash("sha256").update(pdfBytes).digest("hex");
      const foreignUpload = await foreignUploadService.create({ actor: { kind: "owner", ownerId: foreignActivationOwnerId, sessionId: "foreign-cv-fixture" },
        idempotencyKey: "phase6-foreign-cv-media-upload" as never, kind: "document", originalFileName: "foreign-cv.pdf",
        declaredMediaType: "application/pdf", byteLength: pdfBytes.byteLength, sha256: foreignPdfHash });
      if (!foreignUpload.ok) throw new Error("PHASE6_CV_FOREIGN_MEDIA_UPLOAD_FAILED");
      const foreignBytesUploaded = await fetch(foreignUpload.value.uploadTarget, {
        method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: Buffer.from(pdfBytes),
      });
      expect([200, 201]).toContain(foreignBytesUploaded.status);
      const foreignMediaProcessing = createMediaProcessingApplicationService({
        scope: { ownerId: foreignActivationOwnerId },
        repository: createPostgresMediaProcessingRepository({ database: appDatabase.database, transactions: appDatabase.transactions,
          scope: { portfolioId: foreignActivationPortfolioId, ownerId: foreignActivationOwnerId } }),
        storage: normalProcessingStorage,
        scanner: realScanner,
        processor: realProcessor,
        imageProcessor: realImageProcessor,
        digest: { sha256(input) { return createHash("sha256").update(input).digest("hex"); } },
        ids: createSystemIdGenerator(), clock: { now: () => new Date(appNow).toISOString() },
      });
      const foreignMediaProcessed = await foreignMediaProcessing.record({
        actor: { kind: "owner", ownerId: foreignActivationOwnerId, sessionId: "foreign-cv-fixture" },
        idempotencyKey: "phase6-foreign-cv-media-process" as never, mediaId: foreignUpload.value.mediaId,
        expectedVersion: 1, result: "passed", detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: foreignPdfHash,
      });
      if (!foreignMediaProcessed.ok) throw new Error("PHASE6_CV_FOREIGN_MEDIA_PROCESSING_FAILED");
      const foreignMediaAcceptance = createMediaAcceptanceApplicationService({
        scope: { ownerId: foreignActivationOwnerId, portfolioId: foreignActivationPortfolioId },
        repository: createPostgresMediaAcceptanceRepository({ database: appDatabase.database, transactions: appDatabase.transactions,
          scope: { portfolioId: foreignActivationPortfolioId, ownerId: foreignActivationOwnerId } }),
        preflight: normalProcessingStorage.preflightAcceptedPdfObject,
      });
      const foreignMediaAccepted = await foreignMediaAcceptance.acceptOwnerMediaAsset({
        actor: { kind: "owner", ownerId: foreignActivationOwnerId, sessionId: "foreign-cv-fixture" },
        idempotencyKey: "phase6-foreign-cv-media-accept" as never, mediaId: foreignUpload.value.mediaId,
        expectedVersion: foreignMediaProcessed.value.aggregateVersion, accessibility: { kind: "document", summary: "Accepted foreign PDF fixture." },
      });
      if (!foreignMediaAccepted.ok) throw new Error("PHASE6_CV_FOREIGN_MEDIA_ACCEPTANCE_FAILED");
      const foreignCvService = createOwnerCvApplicationService({ ownerId: foreignActivationOwnerId,
        repository: createPostgresCvPortfolioRepository({ database: appDatabase.database, transactions: appDatabase.transactions,
          scope: { portfolioId: foreignActivationPortfolioId, ownerId: foreignActivationOwnerId }, media: foreignMediaAcceptance }) });
      const foreignCvRoot = await foreignCvService.getOwnerCvPortfolio({ actor: { kind: "owner", ownerId: foreignActivationOwnerId, sessionId: "foreign-cv-fixture" } });
      if (!foreignCvRoot.ok) throw new Error("PHASE6_CV_FOREIGN_ROOT_FAILED");
      const foreignCvRegistration = await foreignCvService.registerOwnerCvVersion({
        actor: { kind: "owner", ownerId: foreignActivationOwnerId, sessionId: "foreign-cv-fixture" },
        idempotencyKey: "phase6-foreign-cv-register" as never, expectedVersion: foreignCvRoot.value.aggregateVersion,
        mediaId: foreignUpload.value.mediaId, locale: "en", label: "Foreign accepted CV",
      });
      if (!foreignCvRegistration.ok) throw new Error("PHASE6_CV_FOREIGN_REGISTRATION_FAILED");
      const foreignCvAccepted = await foreignCvService.acceptOwnerCvVersion({
        actor: { kind: "owner", ownerId: foreignActivationOwnerId, sessionId: "foreign-cv-fixture" },
        idempotencyKey: "phase6-foreign-cv-approve" as never, expectedVersion: foreignCvRegistration.value.aggregateVersion,
        versionId: foreignCvRegistration.value.versionId,
      });
      if (!foreignCvAccepted.ok) throw new Error("PHASE6_CV_FOREIGN_APPROVAL_FAILED");
      const foreignActivationVersionId = foreignCvRegistration.value.versionId;
      const beforeForeignActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      if (!beforeForeignActivation.ok) throw new Error("PHASE6_CV_FOREIGN_ACTIVATION_STATE_FAILED");
      const foreignActivationCountsBefore = await admin.query(`select
          (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from cv_portfolio.activation_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events,
          (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid and is_current) as current_flags`, [portfolioId, ownerId]);
      const foreignActivation = await activateCvThroughHttp({ versionId: foreignActivationVersionId,
        idempotencyKey: "phase6-cv-activate-foreign-target", ifMatch: `"${beforeForeignActivation.value.aggregateVersion}"` });
      const foreignActivationBody = await foreignActivation.json() as Record<string, unknown>;
      const afterForeignActivation = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      const foreignActivationCountsAfter = await admin.query(`select
          (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
          (select count(*)::int from cv_portfolio.activation_commands where portfolio_id = $1::uuid and owner_id = $2::uuid) as receipts,
          (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events,
          (select count(*)::int from cv_portfolio.versions where portfolio_id = $1::uuid and owner_id = $2::uuid and is_current) as current_flags`, [portfolioId, ownerId]);
      await admin.query("delete from cv_portfolio.acceptance_history where version_id = $1::uuid", [foreignActivationVersionId]);
      await admin.query("delete from cv_portfolio.activation_history where version_id = $1::uuid", [foreignActivationVersionId]);
      await admin.query("delete from cv_portfolio.acceptance_commands where version_id = $1::uuid", [foreignActivationVersionId]);
      await admin.query("delete from cv_portfolio.registration_commands where version_id = $1::uuid", [foreignActivationVersionId]);
      await admin.query("delete from cv_portfolio.activation_commands where version_id = $1::uuid", [foreignActivationVersionId]);
      await admin.query("delete from cv_portfolio.versions where version_id = $1::uuid", [foreignActivationVersionId]);
      await admin.query("delete from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid", [foreignActivationPortfolioId, foreignActivationOwnerId]);
      cvActivationScenario("T11-09 a valid accepted foreign Owner CV is not found and cannot mutate this Owner's pointer, flags, history, receipts or outbox",
        foreignActivation.status === 404 && foreignActivationBody["code"] === "CV_VERSION_NOT_FOUND" && afterForeignActivation.ok &&
        afterForeignActivation.value.aggregateVersion === beforeForeignActivation.value.aggregateVersion &&
        afterForeignActivation.value.currentVersionId === beforeForeignActivation.value.currentVersionId &&
        JSON.stringify(foreignActivationCountsBefore.rows[0]) === JSON.stringify(foreignActivationCountsAfter.rows[0]));

      const currentUsage = await appDatabase.transactions.run((transaction) => cvService.getCurrentCvMediaUsage({
        ownerId, mediaAssetId: safe.mediaId as StableId<"MediaAsset">, transaction,
      }));
      const nonCurrentUsage = await appDatabase.transactions.run((transaction) => cvService.getCurrentCvMediaUsage({
        ownerId, mediaAssetId: createStableId("MediaAsset"), transaction,
      }));
      cvActivationScenario("T11-10 the CV-owned current-Media use query returns an authoritative scoped result in the caller transaction",
        currentUsage.ok && currentUsage.value && nonCurrentUsage.ok && !nonCurrentUsage.value);

      const activationRootBeforeFaults = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
      if (!activationRootBeforeFaults.ok) throw new Error("PHASE6_CV_ACTIVATION_FAULT_BASELINE_FAILED");
      const activationFaults = [
        { name: "old current flag", table: "cv_portfolio.versions", event: "before update of is_current", when: "old.is_current and not new.is_current" },
        { name: "new current flag", table: "cv_portfolio.versions", event: "before update of is_current", when: "not old.is_current and new.is_current" },
        { name: "authoritative pointer", table: "cv_portfolio.portfolios", event: "before update of current_version_id", when: undefined },
        { name: "activation history", table: "cv_portfolio.activation_history", event: "before insert", when: undefined },
        { name: "activation receipt", table: "cv_portfolio.activation_commands", event: "before insert", when: undefined },
        { name: "outbox event", table: "operations.outbox_events", event: "before insert", when: undefined },
      ] as const;
      for (const [index, fault] of activationFaults.entries()) {
        const functionName = `phase6_cv_activation_fault_${index}`;
        const triggerName = `phase6_cv_activation_fault_trigger_${index}`;
        await admin.query(`create function cv_portfolio.${functionName}() returns trigger language plpgsql as $$ begin raise exception 'CV_ACTIVATION_INJECTED'; end $$`);
        await admin.query(`create trigger ${triggerName} ${fault.event} on ${fault.table} for each row ${fault.when === undefined ? "" : `when (${fault.when})`} execute function cv_portfolio.${functionName}()`);
        try {
          const expected = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
          if (!expected.ok) throw new Error("PHASE6_CV_ACTIVATION_FAULT_VERSION_FAILED");
          const failedActivation = await activateCvThroughHttp({ versionId: competingActivationVersion,
            idempotencyKey: `phase6-cv-activation-fault-${index}`, ifMatch: `"${expected.value.aggregateVersion}"` });
          const failureBody = await failedActivation.json() as Record<string, unknown>;
          const afterFault = await cvService.getOwnerCvPortfolio({ actor: cvOwner });
          const persistedAfterFault = await admin.query(`select
              (select count(*)::int from cv_portfolio.activation_history where portfolio_id = $1::uuid and owner_id = $2::uuid) as histories,
              (select count(*)::int from cv_portfolio.activation_commands where portfolio_id = $1::uuid and owner_id = $2::uuid and idempotency_key_hash = $3) as receipts,
              (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'cv.current_changed.v1') as events`,
          [portfolioId, ownerId, createHash("sha256").update(`phase6-cv-activation-fault-${index}`).digest("hex")]);
          cvActivationScenario(`T11-05 ${fault.name} failure rolls back root, current flags, history, receipt and event`,
            failedActivation.status === 503 && failureBody["code"] === "CV_ACTIVATION_COMMIT_FAILED" && afterFault.ok &&
            afterFault.value.aggregateVersion === expected.value.aggregateVersion && afterFault.value.currentVersionId === expected.value.currentVersionId &&
            afterFault.value.versions.filter(({ isCurrent }) => isCurrent).length === 1 &&
            persistedAfterFault.rows[0]?.histories === expected.value.activationHistory.length &&
            persistedAfterFault.rows[0]?.receipts === 0 && persistedAfterFault.rows[0]?.events === historyAndEventCountAfterNoop.rows[0]?.events + 1);
        } finally {
          await admin.query(`drop trigger ${triggerName} on ${fault.table}`);
          await admin.query(`drop function cv_portfolio.${functionName}()`);
        }
      }

      expect(cvActivationChecks.every((item) => item.status === "passed")).toBe(true);
      mediaProcessingCounts.cvActivationScenarios = cvActivationChecks;
    }

    expect(cvChecks.every((item) => item.status === "passed")).toBe(true);
    mediaProcessingCounts.cvScenarios = cvChecks;

    const acceptanceBatch = await appDatabase.transactions.run((transaction) => acceptedPdf.acceptance.getAcceptanceFacts({
      ownerId, mediaAssetIds: [...acceptedMediaIds].reverse().concat(acceptedMediaIds[0]!), intendedUse: "supporting-artifact",
    }, transaction));
    expect(acceptanceBatch.ok).toBe(true);
    if (acceptanceBatch.ok) {
      expect(acceptanceBatch.value).toHaveLength(acceptedMediaIds.length);
      expect(acceptanceBatch.value.map(({ mediaAssetId }) => mediaAssetId)).toEqual([...acceptedMediaIds].sort());
      expect(acceptanceBatch.value.every(({ consistencyVersion }) => consistencyVersion === acceptanceBatch.value[0]?.consistencyVersion)).toBe(true);
      expect(acceptanceBatch.value.find(({ mediaAssetId }) => decorativeMediaIds.has(mediaAssetId))?.accessible).toBe(false);
    }

    const describedImageId = acceptedMediaIds.find((mediaId) => !decorativeMediaIds.has(mediaId) && mediaId !== safe.mediaId) as StableId<"MediaAsset"> | undefined;
    expect(describedImageId).toBeDefined();
    if (!describedImageId) throw new Error("PHASE6_CONTENT_MEDIA_IMAGE_FIXTURE_REQUIRED");
    let withholdAccessibility = false;
    const realAcceptancePort = contentMediaAcceptancePort(acceptedPdf.acceptance);
    const publicationLockOrder: string[] = [];
    const changingAcceptancePort: MediaAcceptancePort = {
      async getAcceptanceFacts(query, transaction) {
        publicationLockOrder.push("media-shared-locks");
        const result = await realAcceptancePort.getAcceptanceFacts(query, transaction);
        if (!withholdAccessibility || !result.ok) return result;
        return { ok: true, value: { ...result.value, facts: result.value.facts.map((fact) => ({ ...fact, accessible: false })) } };
      },
    };
    const baseContentRepository = createPostgresContentAuthoringRepository();
    let continueProjectWrite!: () => void;
    let projectWriteReached!: () => void;
    const projectWriteHeld = new Promise<void>((resolve) => { continueProjectWrite = resolve; });
    const projectWriteStarted = new Promise<void>((resolve) => { projectWriteReached = resolve; });
    const publicationRepository = new Proxy(baseContentRepository, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver) as unknown;
        if (property !== "publishProjectLanguage" || typeof method !== "function") return typeof method === "function" ? method.bind(target) : method;
        return async (...args: Parameters<typeof target.publishProjectLanguage>) => {
          publicationLockOrder.push("content-root-write");
          const result = await target.publishProjectLanguage(...args);
          projectWriteReached();
          await projectWriteHeld;
          return result;
        };
      },
    });
    const content = createContentService(changingAcceptancePort, publicationRepository);
    const decorativeMediaId = [...decorativeMediaIds][0];
    if (!decorativeMediaId) throw new Error("PHASE6_CONTENT_MEDIA_DECORATIVE_FIXTURE_REQUIRED");
    const decorativeContent = await publishContentWithMedia(content, "project", decorativeMediaId,
      "phase6-decorative-only-content", undefined, false);
    expect(decorativeContent.published).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
    expect(await admin.query(`select count(*)::int as publications from content.language_publications where content_id = $1::uuid`,
      [decorativeContent.contentId])).toMatchObject({ rows: [{ publications: 0 }] });

    let releaseExclusiveMediaLock!: () => void;
    let exclusiveMediaLockReady!: () => void;
    const exclusiveMediaLockHeld = new Promise<void>((resolve) => { releaseExclusiveMediaLock = resolve; });
    const exclusiveMediaLockStarted = new Promise<void>((resolve) => { exclusiveMediaLockReady = resolve; });
    const exclusiveMediaLock = appDatabase.transactions.run(async (transaction) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${safe.mediaId}::text, 0))`
        .execute(resolvePostgresTransaction(transaction));
      exclusiveMediaLockReady();
      await exclusiveMediaLockHeld;
    });
    await exclusiveMediaLockStarted;
    const timedOutProject = await publishContentWithMedia(content, "project", safe.mediaId as StableId<"MediaAsset">,
      "phase6-media-lock-timeout", undefined, false);
    expect(timedOutProject.published).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_ACCEPTANCE_LOCK_TIMEOUT" } });
    releaseExclusiveMediaLock();
    await exclusiveMediaLock;
    const timeoutState = await admin.query(`select
      (select lifecycle from content.items where content_id = $1::uuid) as lifecycle,
      (select count(*)::int from content.language_publications where content_id = $1::uuid) as publications,
      (select count(*)::int from content.publication_history where content_id = $1::uuid) as history,
      (select count(*)::int from content.public_routes where content_id = $1::uuid) as routes,
      (select count(*)::int from content.public_project_locales where content_id = $1::uuid) as projection,
      (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.language_version_published.v1') as events`,
    [timedOutProject.contentId]);
    expect(timeoutState.rows[0]).toEqual({ lifecycle: "draft", publications: 0, history: 0, routes: 0, projection: 0, events: 0 });

    let projectContentId: StableId<string> | undefined;
    const publicationOrderStart = publicationLockOrder.length;
    const pendingProject = publishContentWithMedia(content, "project", safe.mediaId as StableId<"MediaAsset">, "phase6-accepted-project",
      (ready) => { projectContentId = ready.contentId; });
    await projectWriteStarted;
    expect(publicationLockOrder.slice(publicationOrderStart)).toEqual(["media-shared-locks", "content-root-write"]);
    expect(projectContentId).toBeDefined();
    const publicationNotCommitted = await admin.query("select lifecycle from content.items where content_id = $1::uuid", [projectContentId]);
    expect(publicationNotCommitted.rows[0]?.lifecycle).toBe("draft");
    const publicationLockProbe = await appDatabase.transactions.run(async (transaction) => {
      const rows = await sql<{ acquired: boolean }>`
        select pg_try_advisory_xact_lock(hashtextextended(${safe.mediaId}::text, 0)) as acquired
      `.execute(resolvePostgresTransaction(transaction));
      return rows.rows[0]?.acquired;
    });
    expect(publicationLockProbe).toBe(false);
    continueProjectWrite();
    const project = await pendingProject;
    expect(project.published.ok).toBe(true);
    if (!project.published.ok) throw new Error("PHASE6_REAL_MEDIA_PROJECT_PUBLICATION_FAILED");
    const englishProjectAggregateVersion = project.published.value.aggregateVersion;
    const achievement = await publishContentWithMedia(content, "achievement", describedImageId, "phase6-accepted-achievement");
    expect(achievement.published.ok).toBe(true);
    if (!achievement.published.ok) throw new Error("PHASE6_REAL_MEDIA_ACHIEVEMENT_PUBLICATION_FAILED");
    const contentHashMismatchSha256 = "a".repeat(64);
    expect(contentHashMismatchSha256).not.toBe(safeHash);
    await admin.query("update media.assets set declared_sha256 = $2 where media_id = $1::uuid", [safe.mediaId, contentHashMismatchSha256]);
    try {
      const hashMismatch = await publishContentWithMedia(content, "project", safe.mediaId as StableId<"MediaAsset">,
        "phase6-media-hash-mismatch", undefined, false);
      expect(hashMismatch.published).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
      expect(await admin.query("select lifecycle, (select count(*)::int from content.language_publications where content_id = i.content_id) as publications from content.items i where content_id = $1::uuid",
        [hashMismatch.contentId])).toMatchObject({ rows: [{ lifecycle: "draft", publications: 0 }] });
    } finally {
      await admin.query("update media.assets set declared_sha256 = $2 where media_id = $1::uuid", [safe.mediaId, safeHash]);
    }
    expect(await content.getPublicProject({ slug: "phase6-accepted-project-project", locale: "en" }))
      .toMatchObject({ ok: true, value: { title: "phase6-accepted-project Project" } });
    const arabicAggregateVersion = await publishArabicProjectRevision(content, project.contentId,
      englishProjectAggregateVersion, safe.mediaId as StableId<"MediaAsset">);
    expect(arabicAggregateVersion).toBeGreaterThan(englishProjectAggregateVersion);
    expect(await content.getPublicAchievementTimeline({ locale: "en", limit: 10 }))
      .toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ contentId: achievement.contentId })]) });

    const achievementHidden = await content.hideContent({ actor: { kind: "owner", ownerId, sessionId: "phase6-content-media-owner" },
      contentId: achievement.contentId, expectedVersion: achievement.published.value.aggregateVersion,
      idempotencyKey: "phase6-accepted-achievement-hide" as never, correlationId: "phase6-accepted-achievement-hide" });
    expect(achievementHidden.ok).toBe(true);
    if (!achievementHidden.ok) throw new Error("PHASE6_MEDIA_ACHIEVEMENT_HIDE_FAILED");
    const hiddenAchievementTimeline = await content.getPublicAchievementTimeline({ locale: "en", limit: 10 });
    expect(hiddenAchievementTimeline.ok).toBe(true);
    if (hiddenAchievementTimeline.ok) expect(hiddenAchievementTimeline.value.map(({ contentId }) => contentId)).not.toContain(achievement.contentId);
    const achievementRestored = await content.restoreContent({ actor: { kind: "owner", ownerId, sessionId: "phase6-content-media-owner" },
      contentId: achievement.contentId, expectedVersion: achievementHidden.value.aggregateVersion,
      idempotencyKey: "phase6-accepted-achievement-restore" as never, correlationId: "phase6-accepted-achievement-restore" });
    expect(achievementRestored.ok).toBe(true);
    if (!achievementRestored.ok) throw new Error("PHASE6_MEDIA_ACHIEVEMENT_RESTORE_FAILED");
    expect(await content.getPublicAchievementTimeline({ locale: "en", limit: 10 }))
      .toMatchObject({ ok: true, value: expect.arrayContaining([expect.objectContaining({ contentId: achievement.contentId })]) });

    const visibleUsage = async (mediaAssetId: StableId<"MediaAsset">) => await appDatabase.transactions.run((transaction) =>
      content.getVisibleMediaUsage({ ownerId, mediaAssetIds: [mediaAssetId] }, transaction));
    expect(await visibleUsage(safe.mediaId as StableId<"MediaAsset">))
      .toMatchObject({ ok: true, value: { facts: [{ mediaAssetId: safe.mediaId, inUse: true }] } });
    const owner = { kind: "owner" as const, ownerId, sessionId: "phase6-content-media-owner" };
    const hidden = await content.hideContent({ actor: owner, contentId: project.contentId,
      expectedVersion: arabicAggregateVersion, idempotencyKey: "phase6-accepted-project-hide" as never,
      correlationId: "phase6-accepted-project-hide" });
    expect(hidden.ok).toBe(true);
    expect(await visibleUsage(safe.mediaId as StableId<"MediaAsset">))
      .toMatchObject({ ok: true, value: { facts: [{ mediaAssetId: safe.mediaId, inUse: false }] } });

    withholdAccessibility = true;
    const rejectedRestore = await content.restoreContent({ actor: owner, contentId: project.contentId,
      expectedVersion: hidden.ok ? hidden.value.aggregateVersion : 0, idempotencyKey: "phase6-accepted-project-restore-stale" as never,
      correlationId: "phase6-accepted-project-restore-stale" });
    expect(rejectedRestore).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" } });
    expect(await content.getOwnerContentAggregate({ actor: owner, contentId: project.contentId }))
      .toMatchObject({ ok: true, value: { lifecycle: "hidden" } });
    expect(await content.getPublicProject({ slug: "phase6-accepted-project-project", locale: "en" }))
      .toMatchObject({ ok: false, error: { kind: "not_found" } });

    withholdAccessibility = false;
    const baseRestoreRepository = createPostgresContentAuthoringRepository();
    let continueRestore!: () => void;
    let restoreWriteReached!: () => void;
    const restoreWriteHeld = new Promise<void>((resolve) => { continueRestore = resolve; });
    const restoreWriteStarted = new Promise<void>((resolve) => { restoreWriteReached = resolve; });
    const restoreRepository = new Proxy(baseRestoreRepository, {
      get(target, property, receiver) {
        const method = Reflect.get(target, property, receiver) as unknown;
        if (property !== "changeLifecycle" || typeof method !== "function") return typeof method === "function" ? method.bind(target) : method;
        return async (...args: Parameters<typeof target.changeLifecycle>) => {
          if (args[0].lifecycle !== "published") return await target.changeLifecycle(...args);
          publicationLockOrder.push("content-lifecycle-write");
          const result = await target.changeLifecycle(...args);
          restoreWriteReached();
          await restoreWriteHeld;
          return result;
        };
      },
    });
    const restoringContent = createContentService(changingAcceptancePort, restoreRepository);
    const restoreOrderStart = publicationLockOrder.length;
    const pendingRestore = restoringContent.restoreContent({ actor: owner, contentId: project.contentId,
      expectedVersion: hidden.ok ? hidden.value.aggregateVersion : 0, idempotencyKey: "phase6-accepted-project-restore" as never,
      correlationId: "phase6-accepted-project-restore" });
    await restoreWriteStarted;
    expect(publicationLockOrder.slice(restoreOrderStart)).toEqual([
      "media-shared-locks", "media-shared-locks", "content-lifecycle-write",
    ]);
    const restoreLockProbe = await appDatabase.transactions.run(async (transaction) => {
      const rows = await sql<{ acquired: boolean }>`
        select pg_try_advisory_xact_lock(hashtextextended(${safe.mediaId}::text, 0)) as acquired
      `.execute(resolvePostgresTransaction(transaction));
      return rows.rows[0]?.acquired;
    });
    expect(restoreLockProbe).toBe(false);
    const restoreNotCommitted = await admin.query("select lifecycle from content.items where content_id = $1::uuid", [project.contentId]);
    expect(restoreNotCommitted.rows[0]?.lifecycle).toBe("hidden");
    continueRestore();
    const restored = await pendingRestore;
    expect(restored.ok).toBe(true);
    expect(await visibleUsage(safe.mediaId as StableId<"MediaAsset">))
      .toMatchObject({ ok: true, value: { facts: [{ mediaAssetId: safe.mediaId, inUse: true }] } });

    const acceptanceRollback = await uploadPdf(pdfBytes, "acceptance-rollback");
    const rollbackProcessing = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-media-acceptance-owner" },
      idempotencyKey: `phase6-accept-rollback-process-${randomBytes(8).toString("hex")}` as never,
      mediaId: acceptanceRollback.mediaId, expectedVersion: 1, result: "passed", detectedMediaType: "application/pdf",
      detectedByteLength: pdfBytes.byteLength, sha256: safeHash });
    expect(rollbackProcessing).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
    const rollbackSuffix = randomBytes(3).toString("hex");
    const rollbackFunction = `test_accept_outbox_fail_${rollbackSuffix}`;
    const rollbackTrigger = `test_accept_outbox_fail_${rollbackSuffix}`;
    await admin.query(`create function operations.${rollbackFunction}() returns trigger language plpgsql as $$ begin if new.event_type = 'media.asset_accepted.v1' and new.aggregate_id = '${acceptanceRollback.mediaId}'::uuid then raise exception 'MEDIA_ACCEPTANCE_OUTBOX_INJECTED'; end if; return new; end $$`);
    await admin.query(`create trigger ${rollbackTrigger} before insert on operations.outbox_events for each row execute function operations.${rollbackFunction}()`);
    try {
      const failedAcceptance = await createAcceptanceService().acceptOwnerMediaAsset({
        actor: { kind: "owner", ownerId, sessionId: "phase6-media-acceptance-owner" },
        idempotencyKey: `phase6-accept-rollback-${randomBytes(8).toString("hex")}` as never,
        expectedVersion: 2, mediaId: acceptanceRollback.mediaId, accessibility: { kind: "document", summary: "Rollback fixture." },
      });
      expect(failedAcceptance).toMatchObject({ ok: false, error: { code: "MEDIA_ACCEPTANCE_COMMIT_FAILED" } });
      const rolledBack = await admin.query(`select
        (select aggregate_version from media.processing_states where media_id = $1::uuid) as aggregate_version,
        (select count(*)::int from media.decision_history where media_id = $1::uuid) as decisions,
        (select count(*)::int from media.acceptance_commands where media_id = $1::uuid) as receipts,
        (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.asset_accepted.v1') as events`, [acceptanceRollback.mediaId]);
      expect(rolledBack.rows[0]).toEqual({ aggregate_version: 2, decisions: 0, receipts: 0, events: 0 });
    } finally {
      await admin.query(`drop trigger ${rollbackTrigger} on operations.outbox_events`);
      await admin.query(`drop function operations.${rollbackFunction}()`);
    }

    const concurrent = await uploadPdf(pdfBytes, "concurrent");
    const concurrentKey = "phase6-pdf-process-concurrent-key" as never;
    let enteredScanner!: () => void;
    let releaseScanner!: () => void;
    const scannerEntered = new Promise<void>((resolve) => { enteredScanner = resolve; });
    const scannerRelease = new Promise<void>((resolve) => { releaseScanner = resolve; });
    let firstScan = true;
    const blockingScanner = { async scan(input: Uint8Array) {
      scannerExecutions += 1;
      if (firstScan) { firstScan = false; enteredScanner(); await scannerRelease; }
      return dockerScanner(input);
    } };
    const concurrentService = makeMediaProcessing(normalProcessingStorage, realProcessor, blockingScanner);
    const concurrentPayload = { actor: { kind: "owner" as const, ownerId, sessionId: "phase6-pdf-processing-owner" }, idempotencyKey: concurrentKey,
      mediaId: concurrent.mediaId, expectedVersion: 1, result: "passed" as const, detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash };
    const firstConcurrent = concurrentService.record(concurrentPayload);
    await scannerEntered;
    const secondConcurrent = await concurrentService.record(concurrentPayload);
    expect(secondConcurrent).toMatchObject({ ok: false, error: { code: "MEDIA_PROCESSING_IN_PROGRESS" } });
    releaseScanner();
    expect((await firstConcurrent).ok).toBe(true);
    const concurrentFacts = await admin.query(
      `select (select count(*)::int from media.processing_attempts where media_id = $1::uuid) as attempts,
              (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs,
              (select count(*)::int from media.processing_commands where media_id = $1::uuid) as commands,
              (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.processing_recorded.v1') as events`,
      [concurrent.mediaId],
    );
    expect(concurrentFacts.rows[0]).toEqual({ attempts: 1, outputs: 1, commands: 1, events: 1 });

    const extensionMismatch = await uploadPdf(pdfBytes, "extension-mismatch", "candidate-extension-mismatch.png");
    const extensionResult = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
      idempotencyKey: "phase6-pdf-process-extension-key" as never, mediaId: extensionMismatch.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash });
    expect(extensionResult).toMatchObject({ ok: false, error: { code: "MEDIA_EXTENSION_MISMATCH" } });
    expect((await admin.query("select count(*)::int as count from media.processing_attempts where media_id = $1::uuid", [extensionMismatch.mediaId])).rows[0]?.count).toBe(0);

    const persisted = await admin.query(
      `select attempt.result, attempt.input_object_id::text, attempt.input_sha256, attempt.detected_mime_type,
              attempt.detected_byte_length, attempt.scanner_version, attempt.processor_version, attempt.policy_version,
              attempt.finding_codes, object.object_id::text, object.sha256, object.byte_length
         from media.processing_attempts attempt join media.processed_objects object on object.object_id = attempt.output_object_id
        where attempt.portfolio_id = $1::uuid and attempt.owner_id = $2::uuid and attempt.media_id = $3::uuid`,
      [portfolioId, ownerId, safe.mediaId],
    );
    expect(persisted.rowCount).toBe(1);
    expect(persisted.rows[0]).toMatchObject({ result: "passed", detected_mime_type: "application/pdf", finding_codes: [] });
    expect(Number(persisted.rows[0]?.detected_byte_length)).toBe(pdfBytes.byteLength);
    expect(persisted.rows[0]?.scanner_version).toBe(SCANNER_VERSION);
    expect(persisted.rows[0]?.processor_version).toBe(PDF_PROCESSOR_VERSION);
    const sealedObjectId = String(persisted.rows[0]?.object_id);
    const sealedHash = String(persisted.rows[0]?.sha256);
    const sealedPath = `/storage/v1/object/media-processed/processed/${portfolioId}/${safe.mediaId}/${sealedObjectId}/${sealedHash}.pdf`;
    const sealedBytes = await storageRequest(sealedPath, { headers: headers(SERVICE_ROLE_KEY!) });
    expect(sealedBytes.ok).toBe(true);
    const downloadedOutput = new Uint8Array(await sealedBytes.arrayBuffer());
    expect(Buffer.from(downloadedOutput)).toEqual(Buffer.from(processedFiles[0]!));
    expect(createHash("sha256").update(downloadedOutput).digest("hex")).toBe(sealedHash);
    const anonymousProcessedRead = await storageRequest(sealedPath, { headers: headers(ANON_KEY!) });
    expect(anonymousProcessedRead.status).toBeGreaterThanOrEqual(400);
    const anonymousProcessedWrite = await storageRequest(sealedPath, { method: "POST", headers: { ...headers(ANON_KEY!), "content-type": "application/pdf", "x-upsert": "false" }, body: Buffer.from(downloadedOutput) });
    expect(anonymousProcessedWrite.status).toBeGreaterThanOrEqual(400);
    const overwriteProcessed = await storageRequest(sealedPath, { method: "POST", headers: { ...headers(SERVICE_ROLE_KEY!), "content-type": "application/pdf", "x-upsert": "false" }, body: Buffer.from(downloadedOutput) });
    expect(overwriteProcessed.status).toBeGreaterThanOrEqual(400);
    const forgedUploadTarget = new URL(safe.uploadTarget);
    forgedUploadTarget.pathname = forgedUploadTarget.pathname.replace("/object/upload/sign/media-candidates/candidate/", "/object/upload/sign/media-processed/processed/");
    const uploadTokenSubstitution = await fetch(forgedUploadTarget, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: Buffer.from(downloadedOutput) });
    expect(uploadTokenSubstitution.status).toBeGreaterThanOrEqual(400);
    const anonymousProcessedDelete = await storageRequest("/storage/v1/object/media-processed", { method: "DELETE", headers: { ...headers(ANON_KEY!), "content-type": "application/json" }, body: JSON.stringify({ prefixes: [`processed/${portfolioId}/${safe.mediaId}/${sealedObjectId}/${sealedHash}.pdf`] }) });
    expect([200, 204].includes(anonymousProcessedDelete.status)).toBe(true);
    const retainedOutput = await storageRequest(sealedPath, { headers: headers(SERVICE_ROLE_KEY!) });
    expect(retainedOutput.ok).toBe(true);
    expect(Buffer.from(await retainedOutput.arrayBuffer())).toEqual(Buffer.from(downloadedOutput));
    await appClient.query("begin");
    await appClient.query("select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true)", [portfolioId, ownerId]);
    expect((await appClient.query("select attempt_id from media.processing_attempts where media_id = $1::uuid", [safe.mediaId])).rowCount).toBe(1);
    await appClient.query("select set_config('shipwithali.owner_id', $1, true)", [createStableId("Owner")]);
    expect((await appClient.query("select attempt_id from media.processing_attempts where media_id = $1::uuid", [safe.mediaId])).rowCount).toBe(0);
    await appClient.query("rollback");

    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    const compressedEicar = deflateSync(eicar);
    const malwareBytes = new Uint8Array(Buffer.concat([
      Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${compressedEicar.byteLength} /Filter /FlateDecode >>\nstream\n`),
      compressedEicar,
      Buffer.from("\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"),
    ]));
    const malware = await uploadPdf(malwareBytes, "signature");
    const processedCountBeforeMalware = processedFiles.length;
    const malwareResult = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
      idempotencyKey: "phase6-pdf-process-eicar-key" as never, mediaId: malware.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: malwareBytes.byteLength, sha256: createHash("sha256").update(malwareBytes).digest("hex") });
    expect(malwareResult.ok).toBe(true);
    expect(processedFiles).toHaveLength(processedCountBeforeMalware);
    const malwareAttempt = await admin.query("select result, finding_codes from media.processing_attempts where portfolio_id = $1::uuid and owner_id = $2::uuid and media_id = $3::uuid", [portfolioId, ownerId, malware.mediaId]);
    expect(malwareAttempt.rows[0], JSON.stringify(malwareAttempt.rows[0])).toMatchObject({ result: "failed", finding_codes: ["MEDIA_UNSAFE_CONTENT"] });

    const malformed = new TextEncoder().encode("%PDF-1.7\nnot a readable PDF\n%%EOF");
    const encrypted = createPdfVariant(pdfBytes, "encrypted");
    const active = createPdfVariant(pdfBytes, "active");
    for (const [name, payload] of [["malformed", malformed], ["encrypted", encrypted], ["active", active]] as const) {
      const candidateUpload = await uploadPdf(payload, name);
      const result = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
        idempotencyKey: `phase6-pdf-process-${name}-key` as never, mediaId: candidateUpload.mediaId, expectedVersion: 1, result: "passed",
        detectedMediaType: "application/pdf", detectedByteLength: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex") });
      expect(result.ok).toBe(true);
      const attempt = await admin.query("select result, finding_codes from media.processing_attempts where portfolio_id = $1::uuid and owner_id = $2::uuid and media_id = $3::uuid", [portfolioId, ownerId, candidateUpload.mediaId]);
      expect(attempt.rows[0]?.result).toBe("failed");
      expect(attempt.rows[0]?.finding_codes).toContain("MEDIA_PDF_POLICY_REJECTED");
    }

    const retry = await uploadPdf(pdfBytes, "retry");
    const retryPayload = { actor: { kind: "owner" as const, ownerId, sessionId: "phase6-pdf-processing-owner" },
      mediaId: retry.mediaId, result: "passed" as const, detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength,
      sha256: safeHash };
    const unavailableProcessor = makeMediaProcessing(normalProcessingStorage, { async process() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_PROCESSOR_UNAVAILABLE" } }; } });
    expect(await unavailableProcessor.record({ ...retryPayload, idempotencyKey: "phase6-pdf-retry-first" as never, expectedVersion: 1 }))
      .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_PROCESSOR_UNAVAILABLE" } });
    expect(await unavailableProcessor.record({ ...retryPayload, idempotencyKey: "phase6-pdf-retry-first" as never, expectedVersion: 1 }))
      .toMatchObject({ ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_PROCESSOR_UNAVAILABLE" } });
    const successfulRetry = await mediaProcessing.record({ ...retryPayload, idempotencyKey: "phase6-pdf-retry-second" as never, expectedVersion: 2 });
    expect(successfulRetry).toMatchObject({ ok: true, value: { aggregateVersion: 3 } });
    const retainedAttempts = await admin.query("select result, finding_codes from media.processing_attempts where portfolio_id = $1::uuid and owner_id = $2::uuid and media_id = $3::uuid order by finished_at", [portfolioId, ownerId, retry.mediaId]);
    expect(retainedAttempts.rowCount).toBe(2);
    expect(retainedAttempts.rows.map((row) => row.result)).toEqual(["failed", "passed"]);
    await admin.query(
      `update media.processing_attempts set finished_at = (
         select max(started_at) + interval '1 second' from media.processing_attempts where media_id = $1::uuid
       ) where media_id = $1::uuid`,
      [retry.mediaId],
    );
    const scansBeforeTerminalRetry = scannerExecutions;
    expect(await mediaProcessing.record({ ...retryPayload, idempotencyKey: "phase6-pdf-retry-terminal-tie" as never, expectedVersion: 3 }))
      .toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
    expect(scannerExecutions).toBe(scansBeforeTerminalRetry);

    const staleCandidate = await uploadPdf(pdfBytes, "stale-commit");
    const staleAsset = await admin.query("select declared_sha256 from media.assets where media_id = $1::uuid", [staleCandidate.mediaId]);
    const originalDeclaredSha256 = staleAsset.rows[0]?.declared_sha256 as string | undefined;
    if (originalDeclaredSha256 === undefined) throw new Error("MEDIA_STALE_CANDIDATE_MISSING");
    const substitutedSha256 = originalDeclaredSha256 === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    const staleRepository = createPostgresMediaProcessingRepository({
      database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId },
    });
    const racingRepository: typeof staleRepository = {
      ...staleRepository,
      async commitAttempt(command) {
        await admin.query("update media.assets set declared_sha256 = $2 where media_id = $1::uuid", [staleCandidate.mediaId, substitutedSha256]);
        return staleRepository.commitAttempt(command);
      },
    };
    const staleService = makeMediaProcessing(normalProcessingStorage, realProcessor, undefined, racingRepository);
    let staleResult: Awaited<ReturnType<typeof staleService.record>>;
    try {
      staleResult = await staleService.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
        idempotencyKey: "phase6-pdf-stale-commit" as never, mediaId: staleCandidate.mediaId, expectedVersion: 1, result: "passed",
        detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash });
      expect(staleResult).toMatchObject({ ok: false });
      const staleFacts = await admin.query(
        `select (select count(*)::int from media.processing_attempts where media_id = $1::uuid and result = 'passed') as passed_attempts,
                (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs,
                (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.processing_recorded.v1') as events,
                (select count(*)::int from media.processing_orphans where media_id = $1::uuid and state = 'pending') as orphans`,
        [staleCandidate.mediaId],
      );
      expect(staleFacts.rows[0]).toEqual({ passed_attempts: 0, outputs: 0, events: 0, orphans: 0 });
    } finally {
      await admin.query("update media.assets set declared_sha256 = $2 where media_id = $1::uuid", [staleCandidate.mediaId, originalDeclaredSha256]);
    }

    const rollbackCandidate = await uploadPdf(pdfBytes, "rollback");
    const suffix = randomBytes(3).toString("hex");
    const functionName = `test_pdf_outbox_fail_${suffix}`;
    const triggerName = `test_pdf_outbox_fail_${suffix}`;
    await admin.query(`create function operations.${functionName}() returns trigger language plpgsql as $$ begin if new.event_type = 'media.processing_recorded.v1' and new.aggregate_id = '${rollbackCandidate.mediaId}'::uuid then raise exception 'MEDIA_OUTBOX_COMMIT_INJECTED'; end if; return new; end $$`);
    await admin.query(`create trigger ${triggerName} before insert on operations.outbox_events for each row execute function operations.${functionName}()`);
    try {
      const deleteFailureStorage = createSupabaseMediaProcessingStorage({
        storageUrl: STORAGE_URL!, serviceRoleKey: SERVICE_ROLE_KEY!,
        fetcher: async (input, init) => {
          const path = new URL(input.toString()).pathname;
          if (init?.method === "DELETE" && path.includes("/object/media-processed")) return new Response("unavailable", { status: 503 });
          return await fetch(input, init);
        },
      });
      const faulted = makeMediaProcessing(deleteFailureStorage);
      const failure = await faulted.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
        idempotencyKey: "phase6-pdf-process-outbox-fault" as never, mediaId: rollbackCandidate.mediaId, expectedVersion: 1, result: "passed",
        detectedMediaType: "application/pdf", detectedByteLength: pdfBytes.byteLength, sha256: safeHash });
      expect(failure).toMatchObject({ ok: false, error: { code: "MEDIA_PROCESSING_COMMIT_FAILED" } });
      const rollbackState = await admin.query(
        `select (select count(*)::int from media.processing_attempts where media_id = $1::uuid) as attempts,
                (select count(*)::int from media.processing_states where media_id = $1::uuid) as states,
                (select count(*)::int from media.processing_commands where media_id = $1::uuid) as receipts,
                (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.processing_recorded.v1') as events,
                (select count(*)::int from media.processing_orphans where media_id = $1::uuid and state = 'pending') as orphans`,
        [rollbackCandidate.mediaId],
      );
      expect(rollbackState.rows[0]).toEqual({ attempts: 0, states: 0, receipts: 0, events: 0, orphans: 1 });
      const orphan = await admin.query("select object_id::text, sha256 from media.processing_orphans where media_id = $1::uuid and state = 'pending'", [rollbackCandidate.mediaId]);
      const reconciled = await mediaProcessing.reconcileOrphanedOutputs();
      expect(reconciled).toEqual({ ok: true, value: { reconciled: 1 } });
      const orphanPath = `/storage/v1/object/media-processed/processed/${portfolioId}/${rollbackCandidate.mediaId}/${orphan.rows[0]?.object_id}/${orphan.rows[0]?.sha256}.pdf`;
      expect((await storageRequest(orphanPath, { headers: headers(SERVICE_ROLE_KEY!) })).status).toBeGreaterThanOrEqual(400);
      expect((await admin.query("select state from media.processing_orphans where media_id = $1::uuid", [rollbackCandidate.mediaId])).rows[0]?.state).toBe("reconciled");
    } finally {
      await admin.query(`drop trigger ${triggerName} on operations.outbox_events`);
      await admin.query(`drop function operations.${functionName}()`);
    }
    mediaProcessingCounts.scannerExecutions += scannerExecutions;
    mediaProcessingCounts.processorExecutions += processorExecutions;
    mediaProcessingCounts.imageProcessorExecutions += imageProcessorExecutions;
    if (PROCESSING_COUNTS_FILE) writeFileSync(PROCESSING_COUNTS_FILE, JSON.stringify(mediaProcessingCounts));
  }, REQUIRE_FULL_MEDIA ? 600_000 : 300_000);
  it("processes MP4 and WebM candidates with real PostgreSQL, private Storage, ClamAV and FFmpeg", async () => {
    appNow = Date.now();
    const acceptedCountBeforeVideos = acceptedMediaIds.length;
    const { createClamAvScanner, createFfmpegVideoProcessor } = await import("../../src/runtime/adapters/media-processing-tools.js");
    const realScanner = createClamAvScanner({ maxBytes: 50 * 1024 * 1024, timeoutMs: 25_000 });
    const realVideoProcessor = createFfmpegVideoProcessor();
    let videoProcessorExecutions = 0;
    let scannerExecutions = 0;
    let lastVideoProcessorOutcome = "not-run";
    let lastScannerOutcome = "not-run";
    const videoProcessor: VideoProcessorPort = { async process(input, options) {
      videoProcessorExecutions += 1;
      const result = await realVideoProcessor.process(input, options);
      lastVideoProcessorOutcome = result.ok ? "passed" : result.error.code;
      return result;
    } };
    const realByteScanner = { async scan(input: Uint8Array, options?: { readonly timeoutMs?: number }) {
      scannerExecutions += 1;
      const result = await realScanner.scan(input, options);
      lastScannerOutcome = result.ok ? result.value.verdict : result.error.code;
      return result;
    } };
    const storage = createSupabaseMediaProcessingStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: SERVICE_ROLE_KEY! });
    const processing = createMediaProcessingApplicationService({
      scope: { ownerId }, repository: createPostgresMediaProcessingRepository({
        database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId },
      }), storage, scanner: realByteScanner,
      processor: { async process() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_PDF_PROCESSOR_UNAVAILABLE" } }; } },
      videoProcessor, digest: { sha256(input) { return createHash("sha256").update(input).digest("hex"); } },
      ids: createSystemIdGenerator(), clock: { now: () => new Date(appNow).toISOString() },
    });
    const uploadVideo = async (payload: Uint8Array, mime: "video/mp4" | "video/webm", suffix: string, originalFileName = `candidate-${suffix}.${mime === "video/mp4" ? "mp4" : "webm"}`) => {
      const issued = await createService().create({
        actor: { kind: "owner", ownerId, sessionId: "phase6-video-processing-owner" },
        idempotencyKey: `phase6-video-${suffix}-${randomBytes(12).toString("hex")}` as never,
        kind: "video", originalFileName, declaredMediaType: mime, byteLength: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(issued.ok, JSON.stringify({ issued, storage: lastStorageFailure ?? null })).toBe(true);
      if (!issued.ok) throw new Error("PHASE6_VIDEO_UPLOAD_INTENT_FAILED");
      const uploaded = await fetch(issued.value.uploadTarget, { method: "PUT", headers: { "content-type": mime, "x-upsert": "false" }, body: Buffer.from(payload) });
      expect([200, 201].includes(uploaded.status)).toBe(true);
      return issued.value;
    };
    const fixtureEntries = [
      { path: VIDEO_FIXTURE_MP4!, mime: "video/mp4" as const },
      { path: VIDEO_FIXTURE_WEBM!, mime: "video/webm" as const },
    ];
    for (const fixture of fixtureEntries) {
      const source = new Uint8Array(readFileSync(fixture.path));
      const upload = await uploadVideo(source, fixture.mime, fixture.mime.slice(6));
      const sourceHash = createHash("sha256").update(source).digest("hex");
      const command = { actor: { kind: "owner" as const, ownerId, sessionId: "phase6-video-processing-owner" },
        idempotencyKey: `phase6-video-process-${fixture.mime.slice(6)}-${randomBytes(12).toString("hex")}` as never,
        mediaId: upload.mediaId, expectedVersion: 1, result: "passed" as const, detectedMediaType: fixture.mime,
        detectedByteLength: source.byteLength, sha256: sourceHash };
      const result = await processing.record(command);
      expect(result, `processor/scan ${fixture.mime}: ${JSON.stringify(result)}; scanner calls=${scannerExecutions} (${lastScannerOutcome}); video processor calls=${videoProcessorExecutions} (${lastVideoProcessorOutcome})`).toMatchObject({ ok: true, value: { aggregateVersion: 2 } });
      const saved = await admin.query(
        `select attempt.result, attempt.detected_mime_type, attempt.detected_byte_length, attempt.input_sha256,
                attempt.scanner_version, attempt.processor_version, attempt.policy_version, attempt.output_variants,
                output.variant_name, output.mime_type, output.sha256, output.byte_length, output.object_version,
                output.width, output.height, output.codec, output.object_id::text
           from media.processing_attempts attempt
           join media.processing_attempt_outputs output on output.attempt_id = attempt.attempt_id
          where attempt.media_id = $1::uuid`, [upload.mediaId]);
      expect(saved.rowCount).toBe(1);
      expect(saved.rows[0]).toMatchObject({ result: "passed", detected_mime_type: fixture.mime, detected_byte_length: String(source.byteLength),
        input_sha256: sourceHash, variant_name: "normalized", mime_type: fixture.mime, width: expect.any(Number), height: expect.any(Number),
        codec: fixture.mime === "video/mp4" ? "h264" : "vp9" });
      expect(saved.rows[0]?.scanner_version).not.toBe("unavailable");
      expect(saved.rows[0]?.processor_version).toMatch(/^ffmpeg version 7\.1/u);
      expect(saved.rows[0]?.policy_version).toBe("mp4-webm-bounded-variants-1");
      const objectPath = `/storage/v1/object/media-processed/processed/${portfolioId}/${upload.mediaId}/${saved.rows[0]?.object_id}/${saved.rows[0]?.sha256}.${fixture.mime === "video/mp4" ? "mp4" : "webm"}`;
      const anonymous = await storageRequest(objectPath, { headers: headers(ANON_KEY!) });
      expect(anonymous.status).toBeGreaterThanOrEqual(400);
      const privateRead = await storageRequest(objectPath, { headers: headers(SERVICE_ROLE_KEY!) });
      expect(privateRead.status).toBe(200);
      const outputBytes = new Uint8Array(await privateRead.arrayBuffer());
      expect(createHash("sha256").update(outputBytes).digest("hex")).toBe(saved.rows[0]?.sha256);
      const uploadCapability = new URL(upload.uploadTarget);
      uploadCapability.pathname = objectPath;
      for (const upsert of ["false", "true"]) {
        const substitutedWrite = await fetch(uploadCapability, { method: "PUT", headers: { ...headers(ANON_KEY!), "content-type": fixture.mime, "x-upsert": upsert }, body: outputBytes });
        expect(substitutedWrite.status, `candidate upload token cannot modify a sealed output (upsert=${upsert})`).toBeGreaterThanOrEqual(400);
      }
      const lifecycle = await admin.query("select lifecycle from media.assets where media_id = $1::uuid", [upload.mediaId]);
      expect(lifecycle.rows[0]?.lifecycle).toBe("candidate");
      const outputsBeforeReplay = await admin.query("select count(*)::int as count from media.processing_attempt_outputs where media_id = $1::uuid", [upload.mediaId]);
      const replay = await processing.record(command);
      expect(replay).toEqual(result);
      expect(videoProcessorExecutions).toBe(fixtureEntries.indexOf(fixture) + 1);
      expect((await admin.query("select count(*)::int as count from media.processing_attempts where media_id = $1::uuid", [upload.mediaId])).rows[0]?.count).toBe(1);
      expect((await admin.query("select count(*)::int as count from media.processing_attempt_outputs where media_id = $1::uuid", [upload.mediaId])).rows[0]?.count).toBe(outputsBeforeReplay.rows[0]?.count);
      await acceptAndVerify(upload.mediaId as StableId<"MediaAsset">,
        { kind: "video", summary: `A short ${fixture.mime} clip.` }, fixture.mime.slice(6));
      const scansBeforeReprocess = scannerExecutions;
      const afterAcceptance = await processing.record({ ...command, expectedVersion: 3,
        idempotencyKey: `phase6-video-post-accept-${randomBytes(8).toString("hex")}` as never });
      expect(afterAcceptance).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
      expect(scannerExecutions).toBe(scansBeforeReprocess);
    }
    const acceptedVideoId = acceptedMediaIds[acceptedCountBeforeVideos];
    expect(acceptedVideoId).toBeDefined();
    const cvService = await getOwnerCvApplicationService();
    const currentCvRoot = await admin.query("select aggregate_version from cv_portfolio.portfolios where portfolio_id = $1::uuid and owner_id = $2::uuid", [portfolioId, ownerId]);
    const videoRegistration = await cvService.registerOwnerCvVersion({
      actor: { kind: "owner", ownerId, sessionId: "phase6-cv-registration-owner" },
      idempotencyKey: "phase6-cv-register-accepted-video" as never,
      expectedVersion: Number(currentCvRoot.rows[0]?.aggregate_version),
      mediaId: acceptedVideoId!, locale: "en", label: "A video is not a CV PDF",
    });
    expect(videoRegistration).toMatchObject({ ok: false, error: { kind: "validation" } });
    const videoAcceptance = createAcceptanceService();
    const videoBatch = await appDatabase.transactions.run((transaction) => videoAcceptance.getAcceptanceFacts({
      ownerId, mediaAssetIds: [...acceptedMediaIds].reverse().concat(acceptedMediaIds.at(-1)!), intendedUse: "decorative",
    }, transaction));
    expect(videoBatch.ok).toBe(true);
    if (videoBatch.ok) {
      expect(videoBatch.value).toHaveLength(acceptedMediaIds.length);
      expect(videoBatch.value.every((fact) => fact.accepted && fact.safe && fact.suitable && fact.accessible)).toBe(true);
    }

    const malformed = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisommalformed")]);
    const malformedUpload = await uploadVideo(malformed, "video/mp4", "malformed");
    const malformedResult = await processing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-video-processing-owner" },
      idempotencyKey: "phase6-video-malformed" as never, mediaId: malformedUpload.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "video/mp4", detectedByteLength: malformed.byteLength, sha256: createHash("sha256").update(malformed).digest("hex") });
    expect(malformedResult).toMatchObject({ ok: true, value: { aggregateVersion: 2, outcome: "media-processing-recorded" } });
    expect((await admin.query("select result, finding_codes from media.processing_attempts where media_id = $1::uuid", [malformedUpload.mediaId])).rows[0])
      .toMatchObject({ result: "failed", finding_codes: ["MEDIA_VIDEO_INPUT_INVALID"] });

    const mismatchSource = new Uint8Array(readFileSync(VIDEO_FIXTURE_MP4!));
    const mismatchUpload = await uploadVideo(mismatchSource, "video/mp4", "extension-mismatch", "mismatch.webm");
    const mismatchResult = await processing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-video-processing-owner" },
      idempotencyKey: "phase6-video-extension-mismatch" as never, mediaId: mismatchUpload.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "video/mp4", detectedByteLength: mismatchSource.byteLength, sha256: createHash("sha256").update(mismatchSource).digest("hex") });
    expect(mismatchResult).toMatchObject({ ok: true });
    expect((await admin.query("select result, finding_codes from media.processing_attempts where media_id = $1::uuid", [mismatchUpload.mediaId])).rows[0])
      .toMatchObject({ result: "failed", finding_codes: ["MEDIA_EXTENSION_MISMATCH"] });
    const processRejectedFixture = async (fixturePath: string, suffix: string, expectedCode: string, sourceMime: "video/mp4" | "video/webm" = "video/mp4") => {
      const source = new Uint8Array(readFileSync(fixturePath));
      const upload = await uploadVideo(source, sourceMime, suffix);
      const failed = await processing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-video-processing-owner" },
        idempotencyKey: `phase6-video-${suffix}` as never, mediaId: upload.mediaId, expectedVersion: 1, result: "passed",
        detectedMediaType: sourceMime, detectedByteLength: source.byteLength, sha256: createHash("sha256").update(source).digest("hex") });
      expect(failed).toMatchObject({ ok: true });
      const facts = await admin.query("select result, finding_codes from media.processing_attempts where media_id = $1::uuid", [upload.mediaId]);
      expect(facts.rows[0]).toMatchObject({ result: "failed", finding_codes: [expectedCode] });
      expect((await admin.query("select count(*)::int as count from media.processed_objects where media_id = $1::uuid", [upload.mediaId])).rows[0]?.count).toBe(0);
    };
    await processRejectedFixture(VIDEO_FIXTURE_UNSUPPORTED!, "unsupported-codec", "MEDIA_VIDEO_INPUT_UNSUPPORTED");
    await processRejectedFixture(VIDEO_FIXTURE_EXCESSIVE!, "excessive-frames", "MEDIA_VIDEO_INPUT_UNSUPPORTED");
    const unsafe = new Uint8Array(readFileSync(VIDEO_FIXTURE_MP4!));
    const unsafeUpload = await uploadVideo(unsafe, "video/mp4", "unsafe-content");
    // ClamAV 1.4.3 cleanly scanned MP4 even with EICAR in mdat/free/subtitle data in local probes; inject an unsafe verdict here to verify fail-closed behavior.
    const unsafeProcessing = createMediaProcessingApplicationService({
      scope: { ownerId }, repository: createPostgresMediaProcessingRepository({
        database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId },
      }), storage,
      scanner: { async scan() { return { ok: true as const, value: { verdict: "unsafe" as const, version: SCANNER_VERSION! } }; } },
      processor: { async process() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_PDF_PROCESSOR_UNAVAILABLE" } }; } },
      videoProcessor, digest: { sha256(input) { return createHash("sha256").update(input).digest("hex"); } },
      ids: createSystemIdGenerator(), clock: { now: () => new Date(appNow).toISOString() },
    });
    const unsafeResult = await unsafeProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-video-processing-owner" },
      idempotencyKey: "phase6-video-unsafe-content" as never, mediaId: unsafeUpload.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "video/mp4", detectedByteLength: unsafe.byteLength, sha256: createHash("sha256").update(unsafe).digest("hex") });
    expect(unsafeResult, JSON.stringify(unsafeResult)).toMatchObject({ ok: true });
    expect((await admin.query("select result, finding_codes from media.processing_attempts where media_id = $1::uuid", [unsafeUpload.mediaId])).rows[0])
      .toMatchObject({ result: "failed", finding_codes: ["MEDIA_UNSAFE_CONTENT"] });
    expect((await admin.query("select count(*)::int as count from media.processed_objects where media_id = $1::uuid", [unsafeUpload.mediaId])).rows[0]?.count).toBe(0);
    const rejectedUnsafeRegistration = await cvService.registerOwnerCvVersion({
      actor: { kind: "owner", ownerId, sessionId: "phase6-cv-registration-owner" },
      idempotencyKey: "phase6-cv-register-rejected-unsafe" as never,
      expectedVersion: Number(currentCvRoot.rows[0]?.aggregate_version),
      mediaId: unsafeUpload.mediaId as StableId<"MediaAsset">, locale: "en", label: "Rejected unsafe media",
    });
    expect(rejectedUnsafeRegistration).toMatchObject({ ok: false, error: { kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" } });
    const oversized = await realVideoProcessor.process(new Uint8Array(50 * 1024 * 1024 + 1));
    expect(oversized).toMatchObject({ ok: false, error: { kind: "validation", code: "MEDIA_BYTES_OUT_OF_BOUNDS" } });
    expect(videoProcessorExecutions).toBe(5);
    mediaProcessingCounts.scannerExecutions += scannerExecutions;
    mediaProcessingCounts.videoProcessorExecutions += videoProcessorExecutions;
    if (PROCESSING_COUNTS_FILE) writeFileSync(PROCESSING_COUNTS_FILE, JSON.stringify(mediaProcessingCounts));
  }, 300_000);
});
