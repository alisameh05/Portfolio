import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCreateOwnerMediaUploadIntent } from "../../src/runtime/http/owner-media.js";
import { handleRecordOwnerMediaProcessing } from "../../src/runtime/http/owner-media.js";
import { withOwnerTestAuth } from "../runtime/owner-test-auth.js";
import { createOwnerSecurityTestStub } from "../../src/runtime/http/owner-security.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresMediaUploadIntentRepository } from "../../src/modules/media/adapters/postgres-upload-intents.js";
import { createPostgresMediaProcessingRepository } from "../../src/modules/media/adapters/postgres-processing.js";
import { createUploadCapabilityVault } from "../../src/modules/media/adapters/upload-capability-vault.js";
import { createMediaUploadIntentApplicationService } from "../../src/modules/media/application/upload-intent.js";
import { createMediaProcessingApplicationService, type PdfProcessorPort } from "../../src/modules/media/application/processing.js";
import { createSupabaseMediaUploadTargetAdapter } from "../../src/runtime/adapters/supabase-media-upload-target.js";
import { createSupabaseMediaProcessingStorage } from "../../src/runtime/adapters/supabase-media-processing-storage.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
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
const PROCESSING_COUNTS_FILE = process.env["PHASE6_MEDIA_PROCESSING_COUNTS_FILE"];
const REQUIRE_REAL = process.env["PHASE6_REQUIRE_UPLOAD_INTENT"] === "1";

if (REQUIRE_REAL && (!DATABASE_URL || !STORAGE_URL || !SERVICE_ROLE_KEY || !ANON_KEY || !REPLAY_KEY || !PDF_FIXTURE || !SCANNER_IMAGE || !PDF_PROCESSOR_IMAGE || !SCANNER_VERSION || !PDF_PROCESSOR_VERSION)) {
  throw new Error("PHASE6_UPLOAD_INTENT_SERVICES_REQUIRED");
}

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

function dockerResult(args: readonly string[], input?: Uint8Array): { readonly status: number; readonly stdout: Uint8Array } {
  const result = spawnSync("docker", [...args], { input, encoding: "buffer", timeout: 15_000, maxBuffer: 24 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status === null) throw new Error("PHASE6_PROCESSING_TOOL_UNAVAILABLE");
  return { status: result.status, stdout: result.stdout };
}

function dockerScanner(bytes: Uint8Array) {
  const directory = mkdtempSync(join(tmpdir(), "phase6-media-scan-"));
  try {
    writeFileSync(join(directory, "input.bin"), bytes, { flag: "wx", mode: 0o600 });
    const result = dockerResult(["run", "--rm", "--entrypoint", "clamscan", "-v", `${directory}:/scan:ro`, SCANNER_IMAGE!, "--no-summary", "/scan/input.bin"]);
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
    const checked = dockerResult(["run", "--rm", "--entrypoint", "python3", "-v", mount, PDF_PROCESSOR_IMAGE!, "-c", PDF_PREFLIGHT_FOR_TEST, "/work/input.pdf", "/work/checked.pdf"]);
    if (checked.status !== 0) return { ok: false as const, error: { kind: "validation" as const, code: "MEDIA_PDF_POLICY_REJECTED" } };
    const processed = dockerResult(["run", "--rm", "--entrypoint", "ocrmypdf", "-v", mount, PDF_PROCESSOR_IMAGE!, "--skip-text", "--output-type", "pdfa-2", "--optimize", "0", "--jobs", "1", "--quiet", "/work/checked.pdf", "/work/processed.pdf"]);
    if (processed.status !== 0) return { ok: false as const, error: { kind: "validation" as const, code: "MEDIA_PDF_NOT_READABLE" } };
    const outputCheck = dockerResult(["run", "--rm", "--entrypoint", "python3", "-v", mount, PDF_PROCESSOR_IMAGE!, "-c", PDF_PREFLIGHT_FOR_TEST, "/work/processed.pdf", "/work/verified-output.pdf"]);
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
    const generated = dockerResult(["run", "--rm", "--entrypoint", "python3", "-v", `${directory}:/work`, PDF_PROCESSOR_IMAGE!, "-c", script, "/work/base.pdf", "/work/variant.pdf"]);
    if (generated.status !== 0) throw new Error("PHASE6_PDF_FIXTURE_GENERATION_FAILED");
    return new Uint8Array(readFileSync(join(directory, "variant.pdf")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describeReal("Phase 6 #148 private upload intent with real PostgreSQL and Storage", () => {
  let admin: Client;
  let appClient: Client;
  let appDatabase: ReturnType<typeof createPostgresRuntimeDatabase>;
  let roleName: string;
  let storageBase: string;
  let ownerId: StableId<"Owner">;
  let portfolioId: StableId<"Portfolio">;
  let targetAdapter: ReturnType<typeof createSupabaseMediaUploadTargetAdapter>;
  let signingCalls = 0;
  let lastStorageFailure: string | undefined;
  let appNow = Date.now();

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

  it("processes PDF candidates through the Owner operation with real PostgreSQL, private Storage, ClamAV and OCRmyPDF", async () => {
    appNow = Date.now();
    const pdfBytes = new Uint8Array(readFileSync(PDF_FIXTURE!));
    const processedFiles: Uint8Array[] = [];
    let scannerExecutions = 0;
    let processorExecutions = 0;
    const uploadPdf = async (payload: Uint8Array, suffix: string) => {
      const uploadService = createService();
      const issued = await uploadService.create({
        actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
        idempotencyKey: `phase6-pdf-${suffix}-${randomBytes(12).toString("hex")}` as never,
        kind: "document", originalFileName: `candidate-${suffix}.pdf`, declaredMediaType: "application/pdf",
        byteLength: payload.byteLength, sha256: createHash("sha256").update(payload).digest("hex"),
      });
      expect(issued.ok, JSON.stringify({ issued, storage: lastStorageFailure ?? null })).toBe(true);
      if (!issued.ok) throw new Error("PHASE6_PDF_UPLOAD_INTENT_FAILED");
      const uploaded = await fetch(issued.value.uploadTarget, { method: "PUT", headers: { "content-type": "application/pdf", "x-upsert": "false" }, body: Buffer.from(payload) });
      expect([200, 201].includes(uploaded.status)).toBe(true);
      return issued.value;
    };
    const normalProcessingStorage = createSupabaseMediaProcessingStorage({ storageUrl: STORAGE_URL!, serviceRoleKey: SERVICE_ROLE_KEY! });
    const realProcessor = { async process(input: Uint8Array) { processorExecutions += 1; const result = dockerPdfProcessor(input); if (result.ok) processedFiles.push(result.value.bytes); return result; } };
    const makeMediaProcessing = (storage = normalProcessingStorage, processor: PdfProcessorPort = realProcessor) => createMediaProcessingApplicationService({
      scope: { ownerId }, repository: createPostgresMediaProcessingRepository({
        database: appDatabase.database, transactions: appDatabase.transactions, scope: { portfolioId, ownerId },
      }),
      storage,
      scanner: { async scan(input) { scannerExecutions += 1; return dockerScanner(input); } },
      processor,
      digest: { sha256(input) { return createHash("sha256").update(input).digest("hex"); } },
      ids: createSystemIdGenerator(), clock: { now: () => new Date(appNow).toISOString() },
    });
    const mediaProcessing = makeMediaProcessing();

    const safe = await uploadPdf(pdfBytes, "safe");
    const safeHash = createHash("sha256").update(pdfBytes).digest("hex");
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
    expect(scannerExecutions).toBe(2);
    const sameKeyReplay = await mediaProcessing.record({
      actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" }, idempotencyKey: "phase6-pdf-process-safe-key" as never,
      mediaId: safe.mediaId, expectedVersion: 1, result: "passed", detectedMediaType: "application/pdf",
      detectedByteLength: pdfBytes.byteLength, sha256: safeHash,
    });
    expect(sameKeyReplay).toMatchObject({ ok: true, value: { aggregateId: safe.mediaId, aggregateVersion: 2, outcome: "media-processing-recorded" } });
    expect(scannerExecutions).toBe(2);
    expect(processedFiles).toHaveLength(1);
    const freshKeyReplay = await mediaProcessing.record({
      actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" }, idempotencyKey: "phase6-pdf-process-safe-fresh-key" as never,
      mediaId: safe.mediaId, expectedVersion: 2, result: "passed", detectedMediaType: "application/pdf",
      detectedByteLength: pdfBytes.byteLength, sha256: safeHash,
    });
    expect(freshKeyReplay).toMatchObject({ ok: false, error: { code: "MEDIA_INVALID_TRANSITION" } });
    expect(scannerExecutions).toBe(2);
    expect(processedFiles).toHaveLength(1);
    const terminalFacts = await admin.query(
      `select (select count(*)::int from media.processing_attempts where media_id = $1::uuid) as attempts,
              (select count(*)::int from media.processed_objects where media_id = $1::uuid) as outputs,
              (select count(*)::int from media.processing_commands where media_id = $1::uuid) as commands,
              (select count(*)::int from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'media.processing_recorded.v1') as events`,
      [safe.mediaId],
    );
    expect(terminalFacts.rows[0]).toEqual({ attempts: 1, outputs: 1, commands: 1, events: 1 });

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
    const malwareResult = await mediaProcessing.record({ actor: { kind: "owner", ownerId, sessionId: "phase6-pdf-processing-owner" },
      idempotencyKey: "phase6-pdf-process-eicar-key" as never, mediaId: malware.mediaId, expectedVersion: 1, result: "passed",
      detectedMediaType: "application/pdf", detectedByteLength: malwareBytes.byteLength, sha256: createHash("sha256").update(malwareBytes).digest("hex") });
    expect(malwareResult.ok).toBe(true);
    expect(processedFiles).toHaveLength(1);
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
    expect((await unavailableProcessor.record({ ...retryPayload, idempotencyKey: "phase6-pdf-retry-first" as never, expectedVersion: 1 })).ok).toBe(true);
    const successfulRetry = await mediaProcessing.record({ ...retryPayload, idempotencyKey: "phase6-pdf-retry-second" as never, expectedVersion: 2 });
    expect(successfulRetry).toMatchObject({ ok: true, value: { aggregateVersion: 3 } });
    const retainedAttempts = await admin.query("select result, finding_codes from media.processing_attempts where portfolio_id = $1::uuid and owner_id = $2::uuid and media_id = $3::uuid order by finished_at", [portfolioId, ownerId, retry.mediaId]);
    expect(retainedAttempts.rowCount).toBe(2);
    expect(retainedAttempts.rows.map((row) => row.result)).toEqual(["failed", "passed"]);

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
    if (PROCESSING_COUNTS_FILE) writeFileSync(PROCESSING_COUNTS_FILE, JSON.stringify({ scannerExecutions, processorExecutions }));
  }, 300_000);
});
