import { createHash, randomBytes } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleCreateOwnerMediaUploadIntent } from "../../src/runtime/http/owner-media.js";
import { withOwnerTestAuth } from "../runtime/owner-test-auth.js";
import { createOwnerSecurityTestStub } from "../../src/runtime/http/owner-security.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresMediaUploadIntentRepository } from "../../src/modules/media/adapters/postgres-upload-intents.js";
import { createUploadCapabilityVault } from "../../src/modules/media/adapters/upload-capability-vault.js";
import { createMediaUploadIntentApplicationService } from "../../src/modules/media/application/upload-intent.js";
import { createSupabaseMediaUploadTargetAdapter } from "../../src/runtime/adapters/supabase-media-upload-target.js";
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
const REQUIRE_REAL = process.env["PHASE6_REQUIRE_UPLOAD_INTENT"] === "1";

if (REQUIRE_REAL && (!DATABASE_URL || !STORAGE_URL || !SERVICE_ROLE_KEY || !ANON_KEY || !REPLAY_KEY)) {
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
});
