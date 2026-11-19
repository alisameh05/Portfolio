import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createConsentApplicationService } from "../../src/modules/measurement/application/consent.js";
import { createPostgresConsentRepository } from "../../src/modules/measurement/adapters/postgres-consent.js";
import { AesGcmConsentEvidenceAdapter } from "../../src/modules/identity-access/adapters/consent-evidence.js";
import { createPseudonymousIdentityConfig } from "../../src/modules/identity-access/adapters/pseudonymous-config.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresPublicRateLimit } from "../../src/modules/identity-access/adapters/postgres-reaction-rate-limit.js";
import { createStableId } from "../../src/shared/domain/index.js";
import { zPostPublicEventResponse, zProblem } from "../../src/contracts/http/v1/generated/zod.gen.js";

const enabled = process.env["PHASE9_REQUIRE_PUBLIC_EVENT_HTTP"] === "1";
const suite = enabled ? describe : describe.skip;
const adminUrl = process.env["PHASE9_EVENT_HTTP_ADMIN_DATABASE_URL"];
const appUrl = process.env["PHASE9_EVENT_HTTP_DATABASE_URL"];
const portfolioId = process.env["PORTFOLIO_ID"];
const ownerId = process.env["OWNER_ID"];
const urls = JSON.parse(process.env["PHASE9_EVENT_HTTP_URLS"] ?? "[]") as string[];
const noticeVersion = (process.env["MEASUREMENT_CONSENT_NOTICE_VERSIONS"] ?? "").split(",").map(value => value.trim()).find(Boolean);

let admin: Client;
let database: ReturnType<typeof createPostgresRuntimeDatabase>;
let routeId: string;
let consent: ReturnType<typeof createConsentApplicationService>;
let consentId: string;
let consentToken: string;
let foreignConsentToken: string;

function validEvent(overrides: Record<string, unknown> = {}) {
  const { context: contextOverride, ...eventOverrides } = overrides;
  return {
    action: "page-viewed",
    context: {
      occurredAt: new Date().toISOString(), locale: "en", consentVersion: noticeVersion,
      pageRouteIdentity: routeId, referrerClass: "professional", deviceClass: "desktop", countryCode: "EG",
      ...((contextOverride as Record<string, unknown> | undefined) ?? {}),
    },
    ...eventOverrides,
  };
}

function send(urlIndex: number, event: unknown, key: string, cookie?: string, clientAddress = "198.51.100.1") {
  return fetch(`${urls[urlIndex]}/api/v1/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "idempotency-key": key,
      "x-vercel-forwarded-for": clientAddress,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(15_000),
  });
}

suite("Phase 9 #307 production-built public Measurement HTTP acceptance", () => {
  beforeAll(async () => {
    if (!adminUrl || !appUrl || !portfolioId || !ownerId || urls.length !== 2 || !noticeVersion) {
      throw new Error("PHASE9_EVENT_HTTP_ENV_REQUIRED");
    }
    admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    database = createPostgresRuntimeDatabase(appUrl, { max: 4 });
    const clock = { now: () => new Date().toISOString() };
    consent = createConsentApplicationService({
      transactions: database.transactions, repository: createPostgresConsentRepository(),
      crypto: new AesGcmConsentEvidenceAdapter(createPseudonymousIdentityConfig(process.env), clock.now),
      clock, ids: createSystemIdGenerator(),
      supportedNoticeVersions: (process.env["MEASUREMENT_CONSENT_NOTICE_VERSIONS"] ?? "").split(",").map(value => value.trim()).filter(Boolean),
      ttlSeconds: 2_592_000,
    });
    const scope = { kind: "portfolio" as const, portfolioId: portfolioId as never };
    const granted = await consent.recordConsent({ scope, correlationId: "phase9-event-grant", consent: "granted", noticeVersion, expectedRevision: 0 });
    if (!granted.ok || !granted.value.evidence) throw new Error("PHASE9_EVENT_CONSENT_FIXTURE_FAILED");
    consentId = granted.value.consentId;
    consentToken = granted.value.evidence;
    const foreignPortfolioId = createStableId("Portfolio");
    const foreignGrant = await consent.recordConsent({ scope: { kind: "portfolio", portfolioId: foreignPortfolioId as never },
      correlationId: "phase9-event-foreign-grant", consent: "granted", noticeVersion, expectedRevision: 0 });
    if (!foreignGrant.ok || !foreignGrant.value.evidence) throw new Error("PHASE9_EVENT_FOREIGN_CONSENT_FIXTURE_FAILED");
    foreignConsentToken = foreignGrant.value.evidence;
    const projectId = createStableId("Project");
    routeId = createStableId("PublicRoute");
    const publishedAt = new Date().toISOString();
    await admin.query(
      "insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable') on conflict (portfolio_id) do nothing",
      [portfolioId, ownerId],
    );
    await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project','published')", [projectId, portfolioId]);
    await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)", [routeId, projectId, portfolioId, `event-${projectId}`, publishedAt]);
    const revisionId = createStableId("Revision");
    const reviewId = createStableId("ContentReview");
    const payload = { contentType: "project", locale: "en", title: "Synthetic event project", summary: "Synthetic summary", body: "Synthetic body" };
    await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project','en',1,1,'Synthetic event project','Synthetic summary','Synthetic body',$4,$5)", [revisionId, projectId, portfolioId, payload, publishedAt]);
    await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,'en',1,$5,1,$6,'accepted',$7)", [reviewId, projectId, portfolioId, revisionId, "a".repeat(64), ownerId, publishedAt]);
    await admin.query("insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project','en',$3,$4,$5,1,$6)", [projectId, portfolioId, revisionId, reviewId, routeId, publishedAt]);
  }, 30_000);

  afterAll(async () => {
    // The runner destroys the isolated database, including immutable review fixtures.
    await Promise.all([database?.resource.close(), admin?.end()]);
  });

  it("AC01 accepts only a currently consented minimized observation and persists one event/job", async () => {
    const before = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1", [portfolioId]);
    const response = await send(0, validEvent(), "phase9-event-valid-001", `sw_analytics_consent=${consentToken}`);
    expect(response.status).toBe(202);
    const receipt = await response.json() as unknown;
    expect(zPostPublicEventResponse.safeParse(receipt).success).toBe(true);
    expect(Object.keys(receipt as object).sort()).toEqual(["acceptedAt", "eventId"]);
    const row = await admin.query("select action, measurement_subject::text, page_route_identity::text, project_id::text, consent_version from measurement.public_events where event_id=$1", [(receipt as { eventId: string }).eventId]);
    expect(row.rows).toEqual([{ action: "page-viewed", measurement_subject: expect.any(String), page_route_identity: routeId, project_id: null, consent_version: noticeVersion }]);
    expect(JSON.stringify(receipt)).not.toContain(row.rows[0]?.measurement_subject);
    const after = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1", [portfolioId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count + 1);
    const jobs = await admin.query("select count(*)::int as count from operations.jobs where job_type='measurement.public-event-received.v1' and payload->>'eventId'=$1", [(receipt as { eventId: string }).eventId]);
    expect(jobs.rows[0]?.count).toBe(1);
  });

  it("AC04 applies the shared PostgreSQL public budget with a bounded Retry-After", async () => {
    const limit = createPostgresPublicRateLimit({ database: database.database, portfolioId: portfolioId!,
      hashKey: process.env["FUNCTIONAL_ID_HASH_KEY"] ?? "", operation: "postPublicEvent" });
    for (let request = 0; request < 30; request += 1) {
      expect(await limit.check("198.51.100.77")).toMatchObject({ allowed: true });
    }
    const before = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1 and page_route_identity=$2", [portfolioId, routeId]);
    const response = await send(0, validEvent(), "phase9-event-rate-limited-001", `sw_analytics_consent=${consentToken}`, "198.51.100.77");
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    const after = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1 and page_route_identity=$2", [portfolioId, routeId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("AC02-AC04 deny missing, tampered, withdrawn, wrong-purpose, unknown and out-of-bounds evidence without writes", async () => {
    const before = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1", [portfolioId]);
    const consentBefore = await admin.query("select count(*)::int as count from measurement.consents where portfolio_id=$1", [portfolioId]);
    const subjectsBefore = await admin.query("select count(*)::int as count from measurement.consents where subject is not null");
    const denied = await send(0, validEvent(), "phase9-event-no-consent", "visitor_functional=anything");
    expect(denied.status).toBe(403);
    const tampered = await send(1, validEvent(), "phase9-event-tampered", `sw_analytics_consent=${consentToken}x`);
    expect(tampered.status).toBe(403);
    const foreign = await send(1, validEvent(), "phase9-event-foreign", `sw_analytics_consent=${foreignConsentToken}`);
    expect(foreign.status).toBe(403);
    const unknown = await send(0, { ...validEvent(), feedbackText: "must not be collected" }, "phase9-event-unknown", `sw_analytics_consent=${consentToken}`);
    expect(unknown.status).toBe(400);
    const forbiddenAction = await send(1, { ...validEvent(), action: "feedback-submitted" }, "phase9-event-forbidden-action", `sw_analytics_consent=${consentToken}`);
    expect(forbiddenAction.status).toBe(400);
    const invalidJourney = await send(0, validEvent({ context: { journeyContext: Array.from({ length: 11 }, () => routeId) } }), "phase9-event-bad-journey", `sw_analytics_consent=${consentToken}`);
    expect(invalidJourney.status).toBe(400);
    const wrongNotice = await send(1, validEvent({ context: { consentVersion: "unsupported" } }), "phase9-event-wrong-notice", `sw_analytics_consent=${consentToken}`);
    expect(wrongNotice.status).toBe(403);
    const oversized = await send(0, { ...validEvent(), extra: "x".repeat(70_000) }, "phase9-event-oversized", `sw_analytics_consent=${consentToken}`);
    expect(oversized.status).toBe(400);
    const after = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1", [portfolioId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    const consentAfter = await admin.query("select count(*)::int as count from measurement.consents where portfolio_id=$1", [portfolioId]);
    expect(consentAfter.rows[0]?.count).toBe(consentBefore.rows[0]?.count);
    const subjectsAfter = await admin.query("select count(*)::int as count from measurement.consents where subject is not null");
    expect(subjectsAfter.rows[0]?.count).toBe(subjectsBefore.rows[0]?.count);
  });

  it("AC05 replays the original receipt across replicas, conflicts on changed payload, and revokes withdrawn consent", async () => {
    const event = validEvent();
    const key = "phase9-event-replay-001";
    const before = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1 and page_route_identity=$2", [portfolioId, routeId]);
    const [first, replay] = await Promise.all([
      send(0, event, key, `sw_analytics_consent=${consentToken}`),
      send(1, event, key, `sw_analytics_consent=${consentToken}`),
    ]);
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    const original = await first.json();
    expect(await replay.json()).toEqual(original);
    const conflict = await send(1, { ...event, context: { ...(event as { context: object }).context, deviceClass: "mobile" } }, key, `sw_analytics_consent=${consentToken}`);
    expect(conflict.status).toBe(409);
    const denied = await consent.recordConsent({ scope: { kind: "portfolio", portfolioId: portfolioId as never }, correlationId: "phase9-event-withdraw", consent: "denied", consentId: consentId as never, noticeVersion: noticeVersion!, expectedRevision: 1 });
    expect(denied.ok).toBe(true);
    const afterWithdrawal = await send(0, event, "phase9-event-withdrawn-001", `sw_analytics_consent=${consentToken}`);
    expect(afterWithdrawal.status).toBe(403);
    const after = await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1 and page_route_identity=$2", [portfolioId, routeId]);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count + 1);
  });
});
