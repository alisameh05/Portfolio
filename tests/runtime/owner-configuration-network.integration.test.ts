import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  zCreateOwnerContentResponse,
  zGetOwnerContentAggregateResponse,
  zGetOwnerContentHistoryResponse,
  zArchiveOwnerContentResponse,
  zHideOwnerContentResponse,
  zPublishOwnerContentLanguageResponse,
  zPreviewOwnerContentRevisionResponse,
  zReviewOwnerContentRevisionResponse,
  zRestoreOwnerContentResponse,
  zSaveOwnerContentRevisionResponse,
  zProblem,
  zUpdateOwnerContactChannelsResponse,
  zUpdateOwnerGlobalProjectCtaResponse,
  zUpdateOwnerProfileConfigurationResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import type { StableId } from "../../src/shared/domain/index.js";
import { createStableId } from "../../src/shared/domain/index.js";
import { createSupabaseOwnerSessionProvider } from "../../src/modules/identity-access/adapters/supabase-owner-session-provider.js";
import { createPostgresOwnerConfigurationRateLimit } from "../../src/modules/identity-access/adapters/postgres-owner-configuration-rate-limit.js";

const enabled = process.env["PHASE9_REQUIRE_OWNER_HTTP"] === "1";
const suite = enabled ? describe : describe.skip;
const adminUrl = process.env["PHASE9_OWNER_HTTP_ADMIN_DATABASE_URL"];
const appUrl = process.env["PHASE9_OWNER_HTTP_DATABASE_URL"];
const apiUrl = process.env["PHASE9_OWNER_HTTP_SUPABASE_URL"];
const anonKey = process.env["PHASE9_OWNER_HTTP_ANON_KEY"];
const serviceKey = process.env["PHASE9_OWNER_HTTP_SERVICE_KEY"];
const ownerId = process.env["OWNER_ID"];
const portfolioId = process.env["PORTFOLIO_ID"];
const githubSubject = "910294";
const secondGithubSubject = "910296";
const foreignGithubSubject = "910295";
const sentinel = "SHOULD_NEVER_APPEAR_PHASE9_SECRET_7d0b0a";
const urls = JSON.parse(process.env["PHASE9_OWNER_HTTP_URLS"] ?? "[]") as string[];
const unavailableUrl = process.env["PHASE9_OWNER_HTTP_UNREADY_URL"];

// Both listeners model replicas behind one ingress and receive its canonical Host.
function fetch(input: string, init?: RequestInit): Promise<Response> {
  if (!urls.some((url) => input.startsWith(`${url}/`))) return globalThis.fetch(input, init);
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) {
    headers.set("host", new URL(urls[0]!).host);
  }
  // Node fetch replaces Host; use a real HTTP request to model ingress routing.
  return new Promise((resolve, reject) => {
    const request = httpRequest(input, { method: init?.method ?? "GET", headers: Object.fromEntries(headers),
      ...(init?.signal ? { signal: init.signal } : {}) }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        resolve(new Response(Buffer.concat(chunks), { status: response.statusCode ?? 500, headers: responseHeaders }));
      });
    });
    request.on("error", reject);
    request.end(init?.body);
  });
}

async function expectPrivateProblem(response: Response, status: number): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  const body: unknown = await response.json();
  expect(zProblem.safeParse(body).success).toBe(true);
  expect(JSON.stringify(body)).not.toContain(sentinel);
}

type Login = { userId: string; token: string; sessionId: string };
let admin: Client;
let appDatabase: ReturnType<typeof createPostgresRuntimeDatabase>;
let owner: Login;
let ownerSecondSession: Login;
let foreignOwner: Login;
let csrf = "phase9-csrf-proof-910294";
const secondCsrf = "phase9-csrf-proof-910296";

suite("Phase 9 #294 production-built Owner configuration network acceptance", () => {
  beforeAll(async () => {
    if (!adminUrl || !appUrl || !apiUrl || !anonKey || !serviceKey || !ownerId || !portfolioId || urls.length !== 2 || !unavailableUrl) {
      throw new Error("PHASE9_OWNER_HTTP_ENV_REQUIRED");
    }
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    const runtimeRole = new URL(appUrl).username;
    const permissions = await admin.query<{ superuser: boolean; bypass_rls: boolean; can_read_limiter_table: boolean; can_execute_limiter: boolean; forced_rls: boolean }>(
      `select role.rolsuper as superuser, role.rolbypassrls as bypass_rls,
        has_table_privilege(role.rolname, 'identity_access.owner_configuration_limit_windows', 'select') as can_read_limiter_table,
        has_function_privilege(role.rolname, 'identity_access.check_owner_configuration_rate_limit(text,text)', 'execute') as can_execute_limiter,
        relation.relforcerowsecurity as forced_rls
       from pg_roles as role cross join pg_class as relation
       where role.rolname = $1 and relation.oid = 'identity_access.owner_configuration_limit_windows'::regclass`,
      [runtimeRole],
    );
    expect(permissions.rows).toEqual([{ superuser: false, bypass_rls: false, can_read_limiter_table: false, can_execute_limiter: true, forced_rls: true }]);
    appDatabase = createPostgresRuntimeDatabase(appUrl, { max: 4 });
    const settings = createPortfolioSettingsService({
      repository: createPostgresPortfolioSettingsRepository(),
      transactions: appDatabase.transactions,
      scope: { portfolioId: portfolioId as StableId<"Portfolio">, ownerId: ownerId as StableId<"Owner"> },
    });
    const provisioned = await settings.provision({
      profile: { displayName: "Phase Nine Owner", headline: "Secure configuration", bio: "Initial profile." },
      contactChannels: [{ channel: "email", label: "Email", destination: "mailto:owner@example.test", availableLocales: ["en"] }],
      globalCta: { label: "Discuss a project", destination: "https://example.test/contact", unavailableFallback: "Contact by email." },
    });
    if (!provisioned.ok) throw new Error("PHASE9_OWNER_HTTP_SETTINGS_PROVISION_FAILED");
    owner = await createLogin("phase9-owner@example.test", githubSubject, ownerId);
    ownerSecondSession = await createLogin("phase9-owner-second-session@example.test", secondGithubSubject, ownerId);
    foreignOwner = await createLogin("phase9-foreign@example.test", foreignGithubSubject,
      "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1");
    const verified = await createSupabaseOwnerSessionProvider({
      config: { supabaseUrl: apiUrl, issuer: `${apiUrl}/auth/v1`, audience: "authenticated", ownerAllowlist: [githubSubject, secondGithubSubject] },
      stableOwnerId: ownerId, database: appDatabase.database,
    }).verifyOwnerSession({ sessionToken: owner.token, expectedPurpose: "owner_session" });
    if (!verified.ok) {
      console.error(`PHASE9_AUTH_DIAGNOSTIC:${verified.error.code}`);
      throw new Error(`PHASE9_AUTH_DIAGNOSTIC:${verified.error.code}`);
    }
    const limit = await createPostgresOwnerConfigurationRateLimit(appDatabase.database)
      .check(`owner_session:${ownerId}:updateOwnerProfileConfiguration`);
    expect(limit.allowed).toBe(true);
    try {
      const contentLimit = await createPostgresOwnerConfigurationRateLimit(appDatabase.database)
        .check(`owner_session:${ownerId}:createOwnerContent`);
      expect(contentLimit.allowed).toBe(true);
      const publicationLimit = createPostgresOwnerConfigurationRateLimit(appDatabase.database);
      for (const operation of ["publishOwnerContentLanguage", "hideOwnerContent", "archiveOwnerContent", "restoreOwnerContent"]) {
        expect(await publicationLimit.check(`owner_session:${ownerId}:${operation}`)).toMatchObject({ allowed: true });
      }
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code.match(/^[A-Z0-9_]{5,10}$/u)?.[0] ?? "UNCLASSIFIED"
        : "UNCLASSIFIED";
      console.error(`PHASE9_CONTENT_RATE_LIMIT_PREFLIGHT:${code}`);
      throw error;
    }
  }, 60_000);

  afterAll(async () => {
    if (appDatabase !== undefined) await appDatabase.resource.close();
    if (admin !== undefined) await admin.end();
  });

  it("executes all three operations over two built server instances with exact replay, version and scope protections", async () => {
    const cases = [
      {
        path: "/api/owner/v1/configuration/profile", operation: "updateOwnerProfileConfiguration",
        responseSchema: zUpdateOwnerProfileConfigurationResponse,
        body: { displayName: "Phase Nine Owner Updated", headline: "Built HTTP", bio: "A private owner change." },
        changed: { displayName: "Changed replay", headline: "Built HTTP", bio: "A private owner change." },
      },
      {
        path: "/api/owner/v1/configuration/contact-channels", operation: "updateOwnerContactChannels",
        responseSchema: zUpdateOwnerContactChannelsResponse,
        body: { channels: [{ channel: "email", label: "Work email", destination: "mailto:work@example.test", availableLocales: ["en"] }] },
        changed: { channels: [{ channel: "email", label: "Changed replay", destination: "mailto:work@example.test", availableLocales: ["en"] }] },
      },
      {
        path: "/api/owner/v1/configuration/project-cta", operation: "updateOwnerGlobalProjectCta",
        responseSchema: zUpdateOwnerGlobalProjectCtaResponse,
        body: { label: "Start a conversation", destination: "https://example.test/start", unavailableFallback: "Use email." },
        changed: { label: "Changed replay", destination: "https://example.test/start", unavailableFallback: "Use email." },
      },
    ] as const;

    let currentVersion = 1;
    for (const [index, entry] of cases.entries()) {
      const key = `phase9-real-http-${entry.operation}-${randomUUID()}`;
      const operationVersion = currentVersion;
      const make = (urlIndex: number, body: unknown, version = operationVersion, session: Login = owner) => fetch(`${urls[urlIndex]}${entry.path}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json", origin: new URL(urls[0]!).origin,
          cookie: `sw_owner_session=${session.token}`, "x-csrf-token": session === owner ? csrf : secondCsrf,
          "idempotency-key": key, "if-match": `"${version}"`,
        },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
      const eventType = entry.operation === "updateOwnerProfileConfiguration"
        ? "portfolio_configuration.profile_updated.v1"
        : entry.operation === "updateOwnerContactChannels"
          ? "portfolio_configuration.channels_updated.v1"
          : "portfolio_configuration.cta_updated.v1";
      const beforeEvents = await admin.query<{ count: number }>(
        "select count(*)::int as count from operations.outbox_events where aggregate_id = $1 and event_type = $2",
        [portfolioId, eventType],
      );
      const [left, right] = await Promise.all([make(0, entry.body, operationVersion, owner), make(1, entry.body, operationVersion, ownerSecondSession)]);
      const leftBody: unknown = await left.json();
      const rightBody: unknown = await right.json();
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);
      expect(leftBody).toEqual(rightBody);
      expect(entry.responseSchema.safeParse(leftBody).success).toBe(true);
      currentVersion += 1;
      for (const response of [left, right]) {
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
      expect(JSON.stringify(leftBody)).not.toContain(owner.token);
      expect(JSON.stringify(leftBody)).not.toContain(sentinel);

      const changed = await make(index % 2, entry.changed, operationVersion);
      await expectPrivateProblem(changed, 409);
      const staleKey = `${key}-stale`;
      const stale = await fetch(`${urls[index % 2]}${entry.path}`, {
        method: "PUT", headers: {
          "content-type": "application/json", origin: new URL(urls[0]!).origin,
          cookie: `sw_owner_session=${owner.token}`, "x-csrf-token": csrf,
          "idempotency-key": staleKey, "if-match": `"${currentVersion - 1}"`,
        }, body: JSON.stringify(entry.body), signal: AbortSignal.timeout(15_000),
      });
      await expectPrivateProblem(stale, 412);
      const storedKeyHash = createHash("sha256").update(key, "utf8").digest("hex");
      const ledger = await admin.query<{ count: number }>(
        "select count(*)::int as count from operations.idempotency_records where key_hash = $1", [storedKeyHash],
      );
      expect(ledger.rows[0]?.count).toBe(1);
      const staleLedger = await admin.query<{ count: number }>(
        "select count(*)::int as count from operations.idempotency_records where key_hash = $1",
        [createHash("sha256").update(staleKey, "utf8").digest("hex")],
      );
      // Authorized domain rejections retain a safe result for exact replay;
      // the stale command must not add configuration or outbox effects.
      expect(staleLedger.rows[0]?.count).toBe(1);
      const afterEvents = await admin.query<{ count: number }>(
        "select count(*)::int as count from operations.outbox_events where aggregate_id = $1 and event_type = $2",
        [portfolioId, eventType],
      );
      expect(afterEvents.rows[0]?.count).toBe((beforeEvents.rows[0]?.count ?? 0) + 1);
    }

    const configured = await admin.query<{ version: number; display_name: string; headline: string; bio: string; global_cta_label: string; global_cta_destination: string; global_cta_unavailable_fallback: string }>(
      "select version, display_name, headline, bio, global_cta_label, global_cta_destination, global_cta_unavailable_fallback from portfolio_config.settings where portfolio_id = $1::uuid",
      [portfolioId],
    );
    expect(configured.rows).toEqual([{
      version: 4, display_name: "Phase Nine Owner Updated", headline: "Built HTTP",
      bio: "A private owner change.", global_cta_label: "Start a conversation",
      global_cta_destination: "https://example.test/start", global_cta_unavailable_fallback: "Use email.",
    }]);
    const channels = await admin.query<{ channel: string; label: string; destination: string; available_locales: string[] }>(
      "select channel, label, destination, available_locales from portfolio_config.contact_channels where portfolio_id = $1::uuid order by position",
      [portfolioId],
    );
    expect(channels.rows).toEqual([{ channel: "email", label: "Work email", destination: "mailto:work@example.test", available_locales: ["en"] }]);

    const endpoint = `${urls[0]}${cases[0].path}`;
    const deniedKeys: string[] = [];
    const denied = async (headers: Record<string, string>, token = owner.token, body: unknown = cases[0].body) => {
      const idempotencyKey = `phase9-denied-${randomUUID()}`;
      deniedKeys.push(idempotencyKey);
      return fetch(endpoint, {
        method: "PUT", headers: { "content-type": "application/json", origin: new URL(urls[0]!).origin,
          cookie: `sw_owner_session=${token}`, "x-csrf-token": csrf,
          "idempotency-key": idempotencyKey, "if-match": '"2"', ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    };
    await expectPrivateProblem(await denied({}, ""), 401);
    await expectPrivateProblem(await denied({ "x-forwarded-host": "forged.example.test" }), 403);
    await expectPrivateProblem(await denied({ origin: "https://forged.example.test" }), 403);
    await expectPrivateProblem(await denied({ "x-csrf-token": owner.token }), 403);
    await expectPrivateProblem(await denied({}, foreignOwner.token), 403);
    await expectPrivateProblem(await denied({}, owner.token, { ...cases[0].body, portfolioId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec1", secret: sentinel }), 400);
    const tampered = `${owner.token.split(".")[0]}.${Buffer.from(JSON.stringify({ sub: owner.userId, session_id: owner.sessionId,
      iss: `${apiUrl}/auth/v1`, aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 300 }), "utf8").toString("base64url")}.invalid`;
    await expectPrivateProblem(await denied({}, tampered), 401);

    const before = await admin.query<{ count: number }>("select count(*)::int as count from operations.outbox_events where aggregate_id = $1", [portfolioId]);
    expect((await denied({ "x-forwarded-host": "forged.example.test" })).headers.get("cache-control")).toBe("private, no-store");
    const after = await admin.query<{ count: number }>("select count(*)::int as count from operations.outbox_events where aggregate_id = $1", [portfolioId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const deniedHashes = deniedKeys.map((key) => createHash("sha256").update(key, "utf8").digest("hex"));
    const deniedLedger = await admin.query<{ count: number }>(
      "select count(*)::int as count from operations.idempotency_records where key_hash = any($1::text[])", [deniedHashes],
    );
    expect(deniedLedger.rows[0]?.count).toBe(0);
  }, 120_000);

  it("serves all six private Content authoring, review, preview and history operations over built HTTP", async () => {
    const origin = new URL(urls[0]!).origin;
    const request = (url: string, method: string, body?: unknown, key?: string, version?: number) => fetch(url, {
      method,
      headers: {
        "content-type": "application/json", origin,
        cookie: `sw_owner_session=${owner.token}`, "x-csrf-token": csrf,
        ...(key === undefined ? {} : { "idempotency-key": key }),
        ...(version === undefined ? {} : { "if-match": `"${version}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const contentPath = `${urls[0]}/api/owner/v1/content`;
    const createKey = `phase9-content-create-${randomUUID()}`;
    const createBody = {
      contentType: "project", locale: "en", title: "Private HTTP draft",
      summary: "Synthetic authoring acceptance fixture.", body: "A private draft body.", candidateSlug: "private-http-draft",
    };
    const createdResponse = await request(contentPath, "POST", createBody, createKey);
    if (createdResponse.status !== 201) {
      const problem = zProblem.safeParse(await createdResponse.clone().json().catch(() => null));
      console.error(`PHASE9_CONTENT_CREATE_HTTP:${createdResponse.status}:${problem.success ? problem.data.code : "non_problem"}`);
    }
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(createdResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const created = zCreateOwnerContentResponse.safeParse(await createdResponse.json() as unknown);
    expect(created.success).toBe(true);
    if (!created.success) throw new Error("PHASE9_CONTENT_CREATE_RESPONSE_INVALID");
    const createReplay = await request(`${urls[1]}/api/owner/v1/content`, "POST", createBody, createKey);
    expect(createReplay.status).toBe(201);
    expect(await createReplay.json()).toEqual(created.data);
    const contentId = created.data.contentId;

    const contentUrl = `${contentPath}/${contentId}`;
    const aggregateResponse = await request(contentUrl, "GET");
    expect(aggregateResponse.status).toBe(200);
    expect(aggregateResponse.headers.get("cache-control")).toBe("private, no-store");
    const aggregate = zGetOwnerContentAggregateResponse.safeParse(await aggregateResponse.json() as unknown);
    expect(aggregate.success).toBe(true);
    if (!aggregate.success) throw new Error("PHASE9_CONTENT_AGGREGATE_INVALID");
    const initialRevision = aggregate.data.revisions[0]?.revisionId;
    if (!initialRevision) throw new Error("PHASE9_CONTENT_INITIAL_REVISION_MISSING");

    const saveKey = `phase9-content-save-${randomUUID()}`;
    const saveBody = {
      locale: "en", title: "Private HTTP draft, revised", summary: "Saved immutable version.", body: "Updated private draft body.",
    };
    const savedResponse = await request(`${contentUrl}/revisions`, "POST", saveBody, saveKey, created.data.aggregateVersion);
    expect(savedResponse.status).toBe(201);
    expect(savedResponse.headers.get("cache-control")).toBe("private, no-store");
    const saved = zSaveOwnerContentRevisionResponse.safeParse(await savedResponse.json() as unknown);
    expect(saved.success).toBe(true);
    if (!saved.success) throw new Error("PHASE9_CONTENT_SAVE_RESPONSE_INVALID");
    const saveReplay = await request(`${urls[1]}/api/owner/v1/content/${contentId}/revisions`, "POST", saveBody, saveKey, created.data.aggregateVersion);
    expect(saveReplay.status).toBe(201);
    expect(await saveReplay.json()).toEqual(saved.data);
    await expectPrivateProblem(await request(`${urls[1]}/api/owner/v1/content/${contentId}/revisions`, "POST",
      { ...saveBody, title: "Changed idempotency input" }, saveKey, created.data.aggregateVersion), 409);
    await expectPrivateProblem(await request(`${urls[1]}/api/owner/v1/content/${contentId}/revisions`, "POST",
      { ...saveBody, title: "Stale update" }, `phase9-content-stale-${randomUUID()}`, created.data.aggregateVersion), 412);
    const revisionId = saved.data.revisionId;

    const previewResponse = await request(`${contentUrl}/revisions/${revisionId}/preview`, "GET");
    expect(previewResponse.status).toBe(200);
    expect(previewResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(previewResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const preview = zPreviewOwnerContentRevisionResponse.safeParse(await previewResponse.json() as unknown);
    expect(preview.success).toBe(true);
    if (!preview.success) throw new Error("PHASE9_CONTENT_PREVIEW_INVALID");

    const reviewKey = `phase9-content-review-${randomUUID()}`;
    const reviewBody = {
      locale: "en", snapshotHash: preview.data.snapshotHash, evidenceVersion: preview.data.evidenceVersion,
      decision: "accepted", findings: [],
    };
    const reviewResponse = await request(`${contentUrl}/revisions/${revisionId}/review`, "POST", reviewBody, reviewKey, saved.data.aggregateVersion);
    expect(reviewResponse.status).toBe(200);
    expect(reviewResponse.headers.get("cache-control")).toBe("private, no-store");
    const reviewed = zReviewOwnerContentRevisionResponse.safeParse(await reviewResponse.json() as unknown);
    expect(reviewed.success).toBe(true);
    const reviewReplay = await request(`${urls[1]}/api/owner/v1/content/${contentId}/revisions/${revisionId}/review`, "POST",
      reviewBody, reviewKey, saved.data.aggregateVersion);
    expect(reviewReplay.status).toBe(200);

    const historyResponse = await request(`${contentUrl}/history?locale=en&limit=25`, "GET");
    expect(historyResponse.status).toBe(200);
    expect(historyResponse.headers.get("cache-control")).toBe("private, no-store");
    const history = zGetOwnerContentHistoryResponse.safeParse(await historyResponse.json() as unknown);
    expect(history.success).toBe(true);
    if (!history.success) throw new Error("PHASE9_CONTENT_HISTORY_INVALID");
    expect(history.data.entries.map((entry) => entry.revisionId)).toEqual([initialRevision, revisionId]);
    expect(JSON.stringify([created.data, aggregate.data, saved.data, preview.data, reviewed.data, history.data])).not.toContain(owner.token);
    const privateReadUrls = [
      `${urls[1]}/api/owner/v1/content/${contentId}`,
      `${urls[1]}/api/owner/v1/content/${contentId}/revisions/${revisionId}/preview`,
      `${urls[1]}/api/owner/v1/content/${contentId}/history`,
    ];
    for (const url of privateReadUrls) {
      const denied = await fetch(url, { method: "GET", headers: {
        host: new URL(urls[0]!).host, cookie: `sw_owner_session=${foreignOwner.token}`,
      }, signal: AbortSignal.timeout(15_000) });
      await expectPrivateProblem(denied, 403);
    }
    const createReplayByForeignOwner = await fetch(`${urls[1]}/api/owner/v1/content`, { method: "POST", headers: {
      host: new URL(urls[0]!).host, "content-type": "application/json", origin,
      cookie: `sw_owner_session=${foreignOwner.token}`, "idempotency-key": createKey,
    }, body: JSON.stringify(createBody), signal: AbortSignal.timeout(15_000) });
    await expectPrivateProblem(createReplayByForeignOwner, 403);
    await admin.query("delete from auth.sessions where id = $1::uuid", [ownerSecondSession.sessionId]);
    for (const url of privateReadUrls) {
      const revoked = await fetch(url, { method: "GET", headers: {
        host: new URL(urls[0]!).host, cookie: `sw_owner_session=${ownerSecondSession.token}`,
      }, signal: AbortSignal.timeout(15_000) });
      await expectPrivateProblem(revoked, 401);
    }
    const replayAfterRevocation = await fetch(`${urls[1]}/api/owner/v1/content`, { method: "POST", headers: {
      host: new URL(urls[0]!).host, "content-type": "application/json", origin,
      cookie: `sw_owner_session=${ownerSecondSession.token}`, "x-csrf-token": secondCsrf,
      "idempotency-key": createKey,
    }, body: JSON.stringify(createBody), signal: AbortSignal.timeout(15_000) });
    await expectPrivateProblem(replayAfterRevocation, 401);
    const saveReplayAfterRevocation = await fetch(`${urls[1]}/api/owner/v1/content/${contentId}/revisions`, { method: "POST", headers: {
      host: new URL(urls[0]!).host, "content-type": "application/json", origin,
      cookie: `sw_owner_session=${ownerSecondSession.token}`, "x-csrf-token": secondCsrf,
      "idempotency-key": saveKey, "if-match": `\"${created.data.aggregateVersion}\"`,
    }, body: JSON.stringify(saveBody), signal: AbortSignal.timeout(15_000) });
    await expectPrivateProblem(saveReplayAfterRevocation, 401);
    const reviewReplayAfterRevocation = await fetch(`${urls[1]}/api/owner/v1/content/${contentId}/revisions/${revisionId}/review`, { method: "POST", headers: {
      host: new URL(urls[0]!).host, "content-type": "application/json", origin,
      cookie: `sw_owner_session=${ownerSecondSession.token}`, "x-csrf-token": secondCsrf,
      "idempotency-key": reviewKey, "if-match": `\"${saved.data.aggregateVersion}\"`,
    }, body: JSON.stringify(reviewBody), signal: AbortSignal.timeout(15_000) });
    await expectPrivateProblem(reviewReplayAfterRevocation, 401);
    const foreignSaveReplay = await fetch(`${urls[1]}/api/owner/v1/content/${contentId}/revisions`, { method: "POST", headers: {
      host: new URL(urls[0]!).host, "content-type": "application/json", origin,
      cookie: `sw_owner_session=${foreignOwner.token}`, "idempotency-key": saveKey,
      "if-match": `\"${created.data.aggregateVersion}\"`,
    }, body: JSON.stringify(saveBody), signal: AbortSignal.timeout(15_000) });
    await expectPrivateProblem(foreignSaveReplay, 403);
    const foreignReviewReplay = await fetch(`${urls[1]}/api/owner/v1/content/${contentId}/revisions/${revisionId}/review`, { method: "POST", headers: {
      host: new URL(urls[0]!).host, "content-type": "application/json", origin,
      cookie: `sw_owner_session=${foreignOwner.token}`, "idempotency-key": reviewKey,
    }, body: JSON.stringify(reviewBody), signal: AbortSignal.timeout(15_000) });
    await expectPrivateProblem(foreignReviewReplay, 403);

  }, 90_000);

  it("serves language publication and lifecycle commands over built HTTP", async () => {
    const origin = new URL(urls[0]!).origin;
    const request = (url: string, method: string, body?: unknown, key?: string, version?: number) => fetch(url, {
      method,
      headers: {
        "content-type": "application/json", origin,
        cookie: `sw_owner_session=${owner.token}`, "x-csrf-token": csrf,
        ...(key === undefined ? {} : { "idempotency-key": key }),
        ...(version === undefined ? {} : { "if-match": `"${version}"` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const contentPath = `${urls[0]}/api/owner/v1/content`;
    const suffix = randomUUID();
    const artifactId = createStableId("SupportingArtifact");
    const caseStudy = { problem: "Keep publication explicit.", ownerRole: "Reviewed the language workflow.",
      contributions: ["Connected lifecycle commands."], outcomes: ["The last valid public state remains recoverable."], lessons: "Save does not publish." };
    const evidence = {
      claims: [{ claimId: createStableId("EvidenceClaim"), text: "The transport preserves reviewed content.", artifactIds: [artifactId] }],
      artifacts: [{ id: artifactId, title: "Publication workflow evidence", destinationUrl: "https://example.test/publication-evidence" }],
    };
    const languageCreate = await request(contentPath, "POST", {
      contentType: "project", locale: "en", title: "Language publication fixture", summary: "English first.",
      body: "The English revision is the initial public language.", candidateSlug: `language-http-${suffix.slice(0, 12)}`,
      caseStudy, evidence, externalLinks: [],
    }, `phase9-language-create-${suffix}`);
    expect(languageCreate.status).toBe(201);
    expect(languageCreate.headers.get("cache-control")).toBe("private, no-store");
    const languageCreated = zCreateOwnerContentResponse.safeParse(await languageCreate.json() as unknown);
    expect(languageCreated.success).toBe(true);
    if (!languageCreated.success) throw new Error("PHASE9_LANGUAGE_CREATE_RESPONSE_INVALID");
    const languageUrl = `${contentPath}/${languageCreated.data.contentId}`;
    const languageRevisionId = languageCreated.data.revisionId;
    const englishPreviewResponse = await request(`${languageUrl}/revisions/${languageRevisionId}/preview`, "GET");
    const englishPreview = zPreviewOwnerContentRevisionResponse.safeParse(await englishPreviewResponse.json() as unknown);
    expect(englishPreviewResponse.status).toBe(200);
    expect(englishPreview.success).toBe(true);
    if (!englishPreview.success) throw new Error("PHASE9_LANGUAGE_ENGLISH_PREVIEW_INVALID");
    const englishReviewResponse = await request(`${languageUrl}/revisions/${languageRevisionId}/review`, "POST", {
      locale: "en", snapshotHash: englishPreview.data.snapshotHash, evidenceVersion: englishPreview.data.evidenceVersion,
      decision: "accepted", findings: [],
    }, `phase9-language-review-en-${suffix}`, languageCreated.data.aggregateVersion);
    const englishReview = zReviewOwnerContentRevisionResponse.safeParse(await englishReviewResponse.json() as unknown);
    expect(englishReviewResponse.status).toBe(200);
    expect(englishReview.success).toBe(true);
    if (!englishReview.success) throw new Error("PHASE9_LANGUAGE_ENGLISH_REVIEW_INVALID");
    const englishPublishResponse = await request(`${languageUrl}/commands/publish-language`, "POST",
      { locale: "en", revisionId: languageRevisionId }, `phase9-language-publish-en-${suffix}`, englishReview.data.aggregateVersion);
    const englishPublish = zPublishOwnerContentLanguageResponse.safeParse(await englishPublishResponse.json() as unknown);
    expect(englishPublishResponse.status).toBe(200);
    expect(englishPublishResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(englishPublishResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(englishPublish.success).toBe(true);
    if (!englishPublish.success) throw new Error("PHASE9_LANGUAGE_ENGLISH_PUBLISH_INVALID");
    expect(englishPublishResponse.headers.get("etag")).toBe(`"${englishPublish.data.aggregateVersion}"`);

    const arabicBody = { locale: "ar", title: "\u0646\u0633\u062e\u0629 \u0639\u0631\u0628\u064a\u0629",
      summary: "\u0645\u0644\u062e\u0635 \u0639\u0631\u0628\u064a", body: "\u0645\u062d\u062a\u0648\u0649 \u0639\u0631\u0628\u064a",
      draftData: { contentType: "project", caseStudy, evidence, externalLinks: [] } };
    const arabicSaveResponse = await request(`${languageUrl}/revisions`, "POST", arabicBody,
      `phase9-language-save-ar-${suffix}`, englishPublish.data.aggregateVersion);
    expect(arabicSaveResponse.status).toBe(201);
    const arabicSave = zSaveOwnerContentRevisionResponse.safeParse(await arabicSaveResponse.json() as unknown);
    expect(arabicSave.success).toBe(true);
    if (!arabicSave.success) throw new Error("PHASE9_LANGUAGE_ARABIC_SAVE_INVALID");
    const languageAggregateResponse = await request(languageUrl, "GET");
    const languageAggregate = zGetOwnerContentAggregateResponse.safeParse(await languageAggregateResponse.json() as unknown);
    expect(languageAggregate.success).toBe(true);
    if (!languageAggregate.success) throw new Error("PHASE9_LANGUAGE_AGGREGATE_INVALID");
    expect(languageAggregate.data.localizedStreams).toMatchObject({
      en: { currentPublishedRevisionId: languageRevisionId },
      ar: { revisionCount: 1, currentPublishedRevisionId: null },
    });
    const arabicBeforePublish = await admin.query(
      "select count(*)::int as count from content.public_project_locales where content_id = $1::uuid and locale = 'ar'",
      [languageCreated.data.contentId],
    );
    expect(arabicBeforePublish.rows[0]?.count).toBe(0);

    const arabicPreviewResponse = await request(`${languageUrl}/revisions/${arabicSave.data.revisionId}/preview`, "GET");
    const arabicPreview = zPreviewOwnerContentRevisionResponse.safeParse(await arabicPreviewResponse.json() as unknown);
    expect(arabicPreviewResponse.status).toBe(200);
    expect(arabicPreview.success).toBe(true);
    if (!arabicPreview.success) throw new Error("PHASE9_LANGUAGE_ARABIC_PREVIEW_INVALID");
    const arabicReviewResponse = await request(`${languageUrl}/revisions/${arabicSave.data.revisionId}/review`, "POST", {
      locale: "ar", snapshotHash: arabicPreview.data.snapshotHash, evidenceVersion: arabicPreview.data.evidenceVersion,
      decision: "accepted", findings: [],
    }, `phase9-language-review-ar-${suffix}`, arabicSave.data.aggregateVersion);
    const arabicReview = zReviewOwnerContentRevisionResponse.safeParse(await arabicReviewResponse.json() as unknown);
    expect(arabicReviewResponse.status).toBe(200);
    expect(arabicReview.success).toBe(true);
    if (!arabicReview.success) throw new Error("PHASE9_LANGUAGE_ARABIC_REVIEW_INVALID");
    const arabicPublishResponse = await request(`${languageUrl}/commands/publish-language`, "POST",
      { locale: "ar", revisionId: arabicSave.data.revisionId }, `phase9-language-publish-ar-${suffix}`, arabicReview.data.aggregateVersion);
    const arabicPublish = zPublishOwnerContentLanguageResponse.safeParse(await arabicPublishResponse.json() as unknown);
    expect(arabicPublishResponse.status).toBe(200);
    expect(arabicPublishResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(arabicPublishResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(arabicPublish.success).toBe(true);
    if (!arabicPublish.success) throw new Error("PHASE9_LANGUAGE_ARABIC_PUBLISH_INVALID");
    const arabicProjection = await admin.query(
      "select title from content.public_project_locales where content_id = $1::uuid and locale = 'ar'",
      [languageCreated.data.contentId],
    );
    expect(arabicProjection.rows[0]?.title).toBe(arabicBody.title);

    const englishDraftResponse = await request(`${languageUrl}/revisions`, "POST", {
      locale: "en", title: "Unreviewed English edit", summary: "A new Draft.", body: "This edit must remain private.",
      draftData: { contentType: "project", caseStudy, evidence, externalLinks: [] },
    }, `phase9-language-save-en-unreviewed-${suffix}`, arabicPublish.data.aggregateVersion);
    expect(englishDraftResponse.status).toBe(201);
    const englishDraft = zSaveOwnerContentRevisionResponse.safeParse(await englishDraftResponse.json() as unknown);
    expect(englishDraft.success).toBe(true);
    if (!englishDraft.success) throw new Error("PHASE9_LANGUAGE_ENGLISH_DRAFT_INVALID");
    const invalidPublish = await request(`${languageUrl}/commands/publish-language`, "POST",
      { locale: "en", revisionId: englishDraft.data.revisionId }, `phase9-language-invalid-publish-${suffix}`, englishDraft.data.aggregateVersion);
    await expectPrivateProblem(invalidPublish, 422);
    const englishProjection = await admin.query(
      "select title from content.public_project_locales where content_id = $1::uuid and locale = 'en'",
      [languageCreated.data.contentId],
    );
    expect(englishProjection.rows[0]?.title).toBe("Language publication fixture");

    const hideKey = `phase9-language-hide-${suffix}`;
    const hideResponse = await request(`${languageUrl}/commands/hide`, "POST", {}, hideKey, englishDraft.data.aggregateVersion);
    const hidden = zHideOwnerContentResponse.safeParse(await hideResponse.json() as unknown);
    expect(hideResponse.status).toBe(200);
    expect(hideResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(hideResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(hidden.success).toBe(true);
    if (!hidden.success) throw new Error("PHASE9_LANGUAGE_HIDE_INVALID");
    const hiddenState = await admin.query(
      "select item.lifecycle, array_agg(locale.locale order by locale.locale) as retained_locales " +
      "from content.items item left join content.public_project_locales locale using (content_id, portfolio_id) " +
      "where item.content_id = $1::uuid group by item.lifecycle",
      [languageCreated.data.contentId],
    );
    expect(hiddenState.rows[0]).toEqual({ lifecycle: "hidden", retained_locales: ["ar", "en"] });

    const archiveKey = `phase9-language-archive-${suffix}`;
    const archive = () => request(`${languageUrl}/commands/archive`, "POST", {}, archiveKey, hidden.data.aggregateVersion);
    const archiveResponse = await archive();
    const archived = zArchiveOwnerContentResponse.safeParse(await archiveResponse.json() as unknown);
    expect(archiveResponse.status).toBe(200);
    expect(archiveResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(archiveResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(archived.success).toBe(true);
    if (!archived.success) throw new Error("PHASE9_LANGUAGE_ARCHIVE_INVALID");
    const archiveReplay = await archive();
    expect(archiveReplay.status).toBe(200);
    expect(await archiveReplay.json()).toEqual(archived.data);
    const archivedEvents = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'content.content_archived.v1'",
      [languageCreated.data.contentId],
    );
    expect(archivedEvents.rows[0]?.count).toBe(1);

    const restoreResponse = await request(`${languageUrl}/commands/restore`, "POST", {},
      `phase9-language-restore-${suffix}`, archived.data.aggregateVersion);
    const restored = zRestoreOwnerContentResponse.safeParse(await restoreResponse.json() as unknown);
    expect(restoreResponse.status).toBe(200);
    expect(restoreResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(restoreResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(restored.success).toBe(true);
    if (!restored.success) throw new Error("PHASE9_LANGUAGE_RESTORE_INVALID");
    const retainedHistory = await request(`${languageUrl}/history?locale=en&limit=25`, "GET");
    const retained = zGetOwnerContentHistoryResponse.safeParse(await retainedHistory.json() as unknown);
    expect(retainedHistory.status).toBe(200);
    expect(retained.success).toBe(true);
    if (!retained.success) throw new Error("PHASE9_LANGUAGE_HISTORY_INVALID");
    expect(retained.data.entries.map((entry) => entry.revisionId)).toContain(languageRevisionId);

    const neverPublishedResponse = await request(contentPath, "POST", {
      contentType: "project", locale: "en", title: "Never published fixture", summary: "Restore must fail.",
      body: "No public Revision has ever existed.", candidateSlug: `never-published-${suffix.slice(0, 12)}`,
    }, `phase9-never-published-create-${suffix}`);
    const neverPublished = zCreateOwnerContentResponse.safeParse(await neverPublishedResponse.json() as unknown);
    expect(neverPublishedResponse.status).toBe(201);
    expect(neverPublished.success).toBe(true);
    if (!neverPublished.success) throw new Error("PHASE9_NEVER_PUBLISHED_CREATE_INVALID");
    const neverPublishedUrl = `${contentPath}/${neverPublished.data.contentId}`;
    const archiveUnpublishedResponse = await request(`${neverPublishedUrl}/commands/archive`, "POST", {},
      `phase9-never-published-archive-${suffix}`, neverPublished.data.aggregateVersion);
    const unpublishedArchive = zArchiveOwnerContentResponse.safeParse(await archiveUnpublishedResponse.json() as unknown);
    expect(archiveUnpublishedResponse.status).toBe(200);
    expect(unpublishedArchive.success).toBe(true);
    if (!unpublishedArchive.success) throw new Error("PHASE9_NEVER_PUBLISHED_ARCHIVE_INVALID");
    const invalidRestore = await request(`${neverPublishedUrl}/commands/restore`, "POST", {},
      `phase9-never-published-restore-${suffix}`, unpublishedArchive.data.aggregateVersion);
    await expectPrivateProblem(invalidRestore, 422);
    const neverPublishedStateResponse = await request(neverPublishedUrl, "GET");
    const neverPublishedState = zGetOwnerContentAggregateResponse.safeParse(await neverPublishedStateResponse.json() as unknown);
    expect(neverPublishedState.success).toBe(true);
    if (!neverPublishedState.success) throw new Error("PHASE9_NEVER_PUBLISHED_STATE_INVALID");
    expect(neverPublishedState.data.lifecycle).toBe("archived");
    expect(neverPublishedState.data.publicationHistory).toHaveLength(0);
    const noPartialProjection = await admin.query(
      "select count(*)::int as count from content.public_project_locales where content_id = $1::uuid",
      [neverPublished.data.contentId],
    );
    expect(noPartialProjection.rows[0]?.count).toBe(0);
  }, 90_000);

  it("enforces the shared database limit across independent built instances and fails closed on limiter outage", async () => {
    const path = "/api/owner/v1/configuration/contact-channels";
    const originalWindow = (await admin.query<{ window: Date }>(
      "select date_trunc('minute', clock_timestamp()) as window",
    )).rows[0]?.window;
    if (!originalWindow) throw new Error("PHASE9_OWNER_HTTP_DATABASE_CLOCK_UNAVAILABLE");
    const windowDeadline = Date.now() + 65_000;
    let newWindow = false;
    while (Date.now() < windowDeadline) {
      const currentWindow = (await admin.query<{ window: Date }>(
        "select date_trunc('minute', clock_timestamp()) as window",
      )).rows[0]?.window;
      if (currentWindow && currentWindow.getTime() !== originalWindow.getTime()) { newWindow = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!newWindow) throw new Error("PHASE9_OWNER_HTTP_DATABASE_WINDOW_DID_NOT_ADVANCE");
    let limited: Response | undefined;
    let limitedKey: string | undefined;
    let allowedInvalid = 0;
    for (let index = 0; index < 31; index += 1) {
      const requestKey = `phase9-limit-${randomUUID()}`;
      const response = await fetch(`${urls[index % 2]}${path}`, { method: "PUT", headers: {
        "content-type": "application/json", origin: new URL(urls[0]!).origin,
        cookie: `sw_owner_session=${owner.token}`, "x-csrf-token": csrf,
        "idempotency-key": requestKey, "if-match": '"1"',
      }, body: "{}", signal: AbortSignal.timeout(15_000) });
      if (response.status === 429) { limited = response; limitedKey = requestKey; break; }
      expect(response.status).toBe(400);
      allowedInvalid += 1;
    }
    if (!limited) throw new Error("PHASE9_OWNER_HTTP_LIMIT_NOT_REACHED");
    await expectPrivateProblem(limited, 429);
    expect(Number(limited?.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(allowedInvalid).toBeGreaterThan(0);
    const limitedLedger = await admin.query<{ count: number }>(
      "select count(*)::int as count from operations.idempotency_records where key_hash = $1",
      [createHash("sha256").update(limitedKey!, "utf8").digest("hex")],
    );
    expect(limitedLedger.rows[0]?.count).toBe(0);

    const before = await admin.query<{ count: number }>("select count(*)::int as count from operations.outbox_events where aggregate_id = $1", [portfolioId]);
    const outageKey = `phase9-limit-outage-${randomUUID()}`;
    await admin.query("revoke execute on function identity_access.check_owner_configuration_rate_limit(text,text) from shipwithali_application");
    try {
      const outage = await fetch(`${urls[0]}/api/owner/v1/configuration/profile`, { method: "PUT", headers: {
        "content-type": "application/json", origin: new URL(urls[0]!).origin,
        cookie: `sw_owner_session=${owner.token}`, "x-csrf-token": csrf,
        "idempotency-key": outageKey, "if-match": '"1"',
      }, body: JSON.stringify({ displayName: "Should not write", headline: "No limiter", bio: "Denied" }), signal: AbortSignal.timeout(15_000) });
      await expectPrivateProblem(outage, 503);
    } finally {
      await admin.query("grant execute on function identity_access.check_owner_configuration_rate_limit(text,text) to shipwithali_application");
    }
    const after = await admin.query<{ count: number }>("select count(*)::int as count from operations.outbox_events where aggregate_id = $1", [portfolioId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const outageLedger = await admin.query<{ count: number }>(
      "select count(*)::int as count from operations.idempotency_records where key_hash = $1",
      [createHash("sha256").update(outageKey, "utf8").digest("hex")],
    );
    expect(outageLedger.rows[0]?.count).toBe(0);

    // Revoke the real fixture session in Auth's authoritative session store.
    // The unchanged, still-signed JWT must cease authorizing HTTP requests.
    const revocation = await admin.query("delete from auth.sessions where id = $1::uuid", [owner.sessionId]);
    expect(revocation.rowCount).toBe(1);
    const revoked = await fetch(`${urls[0]}/api/owner/v1/configuration/profile`, { method: "PUT", headers: {
      "content-type": "application/json", origin: new URL(urls[0]!).origin,
      cookie: `sw_owner_session=${owner.token}`, "x-csrf-token": csrf,
      "idempotency-key": `phase9-revoked-${randomUUID()}`, "if-match": '"2"',
    }, body: JSON.stringify({ displayName: "No", headline: "No", bio: "No" }), signal: AbortSignal.timeout(15_000) });
    await expectPrivateProblem(revoked, 401);
  }, 180_000);

  it("fails closed with private schema-valid Problems when required Owner configuration is missing at bootstrap", async () => {
    const readiness = await fetch(`${unavailableUrl}/readyz`, { signal: AbortSignal.timeout(15_000) });
    expect(readiness.status).toBe(503);
    const response = await fetch(`${unavailableUrl}/api/owner/v1/configuration/profile`, {
      method: "PUT", headers: { "content-type": "application/json", origin: new URL(urls[0]!).origin,
        "idempotency-key": `phase9-unready-${randomUUID()}`, "if-match": '"1"', "x-csrf-token": csrf },
      body: JSON.stringify({ displayName: "not dispatched", headline: "not dispatched", bio: "not dispatched" }),
      signal: AbortSignal.timeout(15_000),
    });
    await expectPrivateProblem(response, 503);
  }, 30_000);

  async function createLogin(email: string, providerId: string, linkedOwner: string): Promise<Login> {
    const createResponse = await fetch(`${apiUrl}/auth/v1/admin/users`, { method: "POST", headers: {
      apikey: serviceKey!, authorization: `Bearer ${serviceKey!}`, "content-type": "application/json",
    }, body: JSON.stringify({ email, email_confirm: true }), signal: AbortSignal.timeout(10_000) });
    if (!createResponse.ok) throw new Error("PHASE9_OWNER_HTTP_USER_CREATE_FAILED");
    const created = await createResponse.json() as { id?: string };
    if (!created.id) throw new Error("PHASE9_OWNER_HTTP_USER_ID_MISSING");
    const linkResponse = await fetch(`${apiUrl}/auth/v1/admin/generate_link`, { method: "POST", headers: {
      apikey: serviceKey!, authorization: `Bearer ${serviceKey!}`, "content-type": "application/json",
    }, body: JSON.stringify({ type: "magiclink", email }), signal: AbortSignal.timeout(10_000) });
    if (!linkResponse.ok) throw new Error("PHASE9_OWNER_HTTP_LINK_CREATE_FAILED");
    const link = await linkResponse.json() as { hashed_token?: string };
    if (!link.hashed_token) throw new Error("PHASE9_OWNER_HTTP_LINK_TOKEN_MISSING");
    const sessionResponse = await fetch(`${apiUrl}/auth/v1/verify`, { method: "POST", headers: {
      apikey: anonKey!, "content-type": "application/json",
    }, body: JSON.stringify({ type: "magiclink", token_hash: link.hashed_token }), signal: AbortSignal.timeout(10_000) });
    if (!sessionResponse.ok) throw new Error("PHASE9_OWNER_HTTP_SESSION_CREATE_FAILED");
    const session = await sessionResponse.json() as { access_token?: string; user?: { id?: string } };
    const token = session.access_token;
    if (!token || session.user?.id !== created.id) throw new Error("PHASE9_OWNER_HTTP_SESSION_INVALID");
    const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { session_id?: string };
    if (!claims.session_id) throw new Error("PHASE9_OWNER_HTTP_SESSION_ID_MISSING");
    await admin.query("insert into auth.identities (user_id, identity_data, provider, provider_id) values ($1::uuid, $2::jsonb, 'github', $3)",
      [created.id, JSON.stringify({ sub: providerId, provider_id: providerId }), providerId]);
    await admin.query("insert into identity_access.owner_links (github_subject, owner_id) values ($1, $2::uuid)", [providerId, linkedOwner]);
    return { userId: created.id, token, sessionId: claims.session_id };
  }
});
