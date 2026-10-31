import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  zProblem,
  zUpdateOwnerContactChannelsResponse,
  zUpdateOwnerGlobalProjectCtaResponse,
  zUpdateOwnerProfileConfigurationResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import type { StableId } from "../../src/shared/domain/index.js";

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
      expect([left.status, right.status]).toEqual([200, 200]);
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
      expect(staleLedger.rows[0]?.count).toBe(0);
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

    const signOut = await fetch(`${apiUrl}/auth/v1/logout?scope=local`, { method: "POST", headers: {
      apikey: anonKey!, authorization: `Bearer ${owner.token}`,
    }, signal: AbortSignal.timeout(10_000) });
    expect(signOut.ok).toBe(true);
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
