import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createSystemIdGenerator, createTestLogger, type TransactionContext } from "../../src/runtime/ports.js";
import { createPostgresRuntimeDatabase, resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresConsentRepository } from "../../src/modules/measurement/adapters/postgres-consent.js";
import { createPostgresMeasurementEventRepository } from "../../src/modules/measurement/adapters/postgres-events.js";
import { createPostgresContentMeasurementPublicFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createConsentApplicationService, createMeasurementEventService, type PublicMeasurementEvent, type VerifiedMeasurementEvidence } from "../../src/modules/measurement/index.js";
import type { MeasurementEventRepositoryPort } from "../../src/modules/measurement/application/ingest-event.js";
import type { ConsentApplicationService, ConsentRepositoryPort } from "../../src/modules/measurement/application/consent.js";
import { AesGcmConsentEvidenceAdapter } from "../../src/modules/identity-access/adapters/consent-evidence.js";
import { handlePostPublicEvent } from "../../src/runtime/http/public-event.js";
import { initializeDatabaseRuntime, getMeasurementEventIngestionService, getConsentApplicationService, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";

const url = process.env["PHASE7_EVENT_DATABASE_URL"];
describe.runIf(Boolean(url))("durable consented public-event ingestion", () => {
  const portfolioId = createStableId("Portfolio"), ownerId = createStableId("Owner");
  const scope = { kind: "portfolio" as const, portfolioId };
  let now = "2026-10-15T12:00:00.000Z";
  const config = {
    functional: { active: { version: 1, secret: Buffer.alloc(32, 11).toString("base64url") }, previous: [] },
    measurement: { active: { version: 1, secret: Buffer.alloc(32, 22).toString("base64url") }, previous: [] },
  };
  const database = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const otherDatabase = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const admin = new Client({ connectionString: process.env["PHASE7_EVENT_ADMIN_URL"] });
  const operations = createPostgresOperationsPersistence(database.database, { now: () => now });
  const otherOperations = createPostgresOperationsPersistence(otherDatabase.database, { now: () => now });
  const consentRepository = createPostgresConsentRepository();
  const consent = createConsentApplicationService({ transactions: database.transactions, repository: consentRepository,
    crypto: new AesGcmConsentEvidenceAdapter(config, () => now), clock: { now: () => now }, ids: createSystemIdGenerator(),
    supportedNoticeVersions: ["2026-10"], ttlSeconds: 2_592_000 });
  const content = createPostgresContentMeasurementPublicFacts({ portfolioId, ownerId });
  const repository = createPostgresMeasurementEventRepository();
  const makeService = (options: { operations?: typeof operations; repository?: MeasurementEventRepositoryPort; facts?: typeof content; consentService?: ConsentApplicationService } = {}) => createMeasurementEventService({
    portfolioId, transactions: (options.operations ?? operations).transactions, operations: options.operations ?? operations,
    consent: options.consentService ?? consent, content: options.facts ?? content, repository: options.repository ?? repository,
    clock: { now: () => now }, ids: createSystemIdGenerator(),
  });
  const service = makeService();
  const key = (value: string = createStableId("Key")) => { const parsed = parseIdempotencyKey(value); if (!parsed.ok) throw new Error("KEY"); return parsed.value; };
  const context = (routeId: StableId<"PublicRoute">, overrides: Record<string, unknown> = {}) => ({
    occurredAt: now, locale: "en" as const, consentVersion: "2026-10", pageRouteIdentity: routeId,
    referrerClass: "professional" as const, deviceClass: "desktop" as const, countryCode: "EG", ...overrides,
  });
  const pageEvent = (routeId: StableId<"PublicRoute">, overrides: Record<string, unknown> = {}): PublicMeasurementEvent => ({ action: "page-viewed", context: context(routeId, overrides) as never });
  const command = (event: PublicMeasurementEvent, evidence: VerifiedMeasurementEvidence, keyValue = key()) => ({
    scope, correlationId: "event-integration", actor: { kind: "visitor" as const, consent: "granted" as const },
    measurement: evidence, idempotencyKey: keyValue, event,
  });
  async function issueEvidence() {
    const granted = await consent.recordConsent({ scope, correlationId: "event-consent", consent: "granted", noticeVersion: "2026-10", expectedRevision: 0 });
    expect(granted.ok).toBe(true); if (!granted.ok || !granted.value.evidence) throw new Error("CONSENT_GRANT_FAILED");
    const verified = await consent.verifyEvidence({ scope, correlationId: "event-consent", noticeVersion: "2026-10", token: granted.value.evidence });
    expect(verified.ok).toBe(true); if (!verified.ok) throw new Error("CONSENT_VERIFY_FAILED");
    return { ...granted.value, token: granted.value.evidence, verified: verified.value };
  }
  async function seedProject(options: { lifecycle?: string; locales?: readonly ("en" | "ar")[]; portfolio?: StableId<"Portfolio"> } = {}) {
    const projectId = createStableId("Project"), routeId = createStableId("PublicRoute"), targetPortfolio = options.portfolio ?? portfolioId;
    const lifecycle = options.lifecycle ?? "published", locales = options.locales ?? ["en"];
    await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project',$3)", [projectId, targetPortfolio, lifecycle]);
    await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)", [routeId, projectId, targetPortfolio, "project-" + projectId, now]);
    for (const locale of locales) {
      const revision = createStableId("Revision"), review = createStableId("ContentReview");
      const payload = { contentType: "project", locale, title: "Private fixture title", summary: "Fixture summary", body: "Fixture body" };
      await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project',$4,1,1,'Private fixture title','Fixture summary','Fixture body',$5,$6)", [revision, projectId, targetPortfolio, locale, payload, now]);
      await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,$5,1,$6,1,$7,'accepted',$8)", [review, projectId, targetPortfolio, revision, locale, "a".repeat(64), ownerId, now]);
      await admin.query("insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project',$3,$4,$5,$6,1,$7)", [projectId, targetPortfolio, locale, revision, review, routeId, now]);
    }
    return { projectId, routeId };
  }
  async function countEvents() { return Number((await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1", [portfolioId])).rows[0].count); }
  async function countJobs() { return Number((await admin.query("select count(*)::int as count from operations.jobs where job_type='measurement.public-event-received.v1'")).rows[0].count); }
  function request(token: string | undefined, event: unknown, keyValue = "http-event-key-01") {
    return new Request("https://example.com/api/v1/events", { method: "POST", headers: {
      "Idempotency-Key": keyValue, "content-type": "application/json", ...(token === undefined ? {} : { cookie: `sw_analytics_consent=${token}` }),
    }, body: JSON.stringify(event) });
  }
  beforeAll(async () => {
    await admin.connect();
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable')", [portfolioId, ownerId]);
  });
  afterAll(async () => { await admin.end(); await database.resource.close(); await otherDatabase.resource.close(); resetRuntimeForTests(); });

  it("T09-01/T09-03 persists each first-slice action and round-trips the full safe context", async () => {
    const { projectId, routeId } = await seedProject();
    const evidence = await issueEvidence();
    const events: PublicMeasurementEvent[] = [
      { action: "page-viewed", context: context(routeId, { journeyContext: [routeId] }) },
      { action: "project-viewed", projectId, context: context(routeId, { journeyContext: [routeId], referrerClass: "search", deviceClass: "tablet" }) },
      { action: "active-engagement-sampled", projectId, activeMilliseconds: 12_500, context: context(routeId, { journeyContext: [routeId], countryCode: "EG" }) },
    ];
    const receipts = [];
    for (const event of events) {
      const response = await handlePostPublicEvent(request(evidence.token, event, "http-" + event.action), { scope, service, consent, logger: createTestLogger() });
      expect(response.status, await response.clone().text()).toBe(202);
      const body = await response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["acceptedAt", "eventId"]);
      receipts.push(body);
    }
    expect(await countEvents()).toBe(3);
    expect(await countJobs()).toBe(3);
    const rows = await admin.query(`select event_id::text, measurement_subject::text, action, page_route_identity::text, project_id::text,
      locale, consent_version, journey_context::text[], referrer_class, device_class, country_code, active_milliseconds,
      to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
      to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as accepted_at,
      to_char(effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_at
      from measurement.public_events where portfolio_id=$1 order by action`, [portfolioId]);
    const engagement = rows.rows.find(row => row.action === "active-engagement-sampled");
    expect(engagement).toMatchObject({ page_route_identity: routeId, project_id: projectId, locale: "en", consent_version: "2026-10",
      journey_context: [routeId], referrer_class: "professional", device_class: "desktop", country_code: "EG", active_milliseconds: 12_500 });
    expect(JSON.stringify({ receipts, jobs: await admin.query("select payload from operations.jobs where job_type='measurement.public-event-received.v1'") })).not.toContain(evidence.verified.subject);
    expect(JSON.stringify(receipts)).not.toContain(evidence.verified.subject);
  });

  it("T09-02 rejects missing, forged, expired, unsupported, withdrawn and mismatched consent without writes", async () => {
    const { routeId } = await seedProject();
    const event = pageEvent(routeId);
    const evidence = await issueEvidence();
    const start = await countEvents();
    for (const token of [undefined, "granted", "forged-cookie-value"]) {
      expect((await handlePostPublicEvent(request(token, event), { scope, service, consent })).status).toBe(403);
    }
    const mismatch = pageEvent(routeId, { consentVersion: "other-version" });
    expect((await handlePostPublicEvent(request(evidence.token, mismatch), { scope, service, consent })).status).toBe(403);
    const unsupported = await consent.recordConsent({ scope, correlationId: "unsupported", consent: "granted", noticeVersion: "unsupported", expectedRevision: 0 });
    expect(unsupported.ok).toBe(false);
    const row = await admin.query("select consent_id from measurement.consents where consent_id=$1", [evidence.consentId]);
    expect(row.rowCount).toBe(1);
    now = evidence.evidenceExpiresAt;
    expect((await handlePostPublicEvent(request(evidence.token, event, "expired-consent-key"), { scope, service, consent })).status).toBe(403);
    now = "2026-10-15T12:00:00.000Z";
    const withdrawn = await consent.recordConsent({ scope, correlationId: "withdraw-consent", consent: "denied", noticeVersion: "2026-10", consentId: evidence.consentId, expectedRevision: 1 });
    expect(withdrawn.ok).toBe(true);
    expect((await handlePostPublicEvent(request(evidence.token, event, "withdrawn-consent-key"), { scope, service, consent })).status).toBe(403);
    expect(await countEvents()).toBe(start);
    expect(await countJobs()).toBe(3);
  });

  it("T09-04 binds current routes, Project, locale, type and Portfolio while allowing retained journey identities", async () => {
    const current = await seedProject();
    const hidden = await seedProject({ lifecycle: "hidden", locales: ["en"] });
    const foreignPortfolio = createStableId("Portfolio");
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Foreign','Headline','Bio','Contact','https://example.com','Unavailable')", [foreignPortfolio, createStableId("Owner")]);
    const foreign = await seedProject({ portfolio: foreignPortfolio });
    const evidence = await issueEvidence();
    const before = await countEvents();
    expect((await service.ingestEvent(command({ action: "project-viewed", projectId: createStableId("Project"), context: context(current.routeId) }, evidence.verified))).ok).toBe(false);
    expect((await service.ingestEvent(command(pageEvent(current.routeId, { locale: "ar" }), evidence.verified))).ok).toBe(false);
    expect((await service.ingestEvent(command(pageEvent(foreign.routeId), evidence.verified))).ok).toBe(false);
    expect((await service.ingestEvent(command(pageEvent(createStableId("PublicRoute")), evidence.verified))).ok).toBe(false);
    const priorJourney = pageEvent(current.routeId, { journeyContext: [hidden.routeId] });
    const accepted = await service.ingestEvent(command(priorJourney, evidence.verified, key("retained-journey-key-001")));
    expect(accepted.ok, accepted.ok ? "" : accepted.error.code).toBe(true);
    expect(JSON.stringify(accepted)).not.toContain("Private fixture title");
    expect(await countEvents()).toBe(before + 1);
  });

  it("T09-05/T09-06 enforces microsecond time cutoffs, future clamping and bounded coarse dimensions", async () => {
    const { routeId } = await seedProject();
    const evidence = await issueEvidence();
    const acceptedAt = now;
    const atOldLimit = pageEvent(routeId, { occurredAt: "2026-10-14T12:00:00.000000Z" });
    const atFutureLimit = pageEvent(routeId, { occurredAt: "2026-10-15T12:01:00.000000Z", referrerClass: "unknown", deviceClass: "other" });
    const oneMicrosOld = pageEvent(routeId, { occurredAt: "2026-10-14T11:59:59.999999Z" });
    const oneMicrosFuture = pageEvent(routeId, { occurredAt: "2026-10-15T12:01:00.000001Z" });
    expect((await service.ingestEvent(command(atOldLimit, evidence.verified, key("old-limit-event-key-01")))).ok).toBe(true);
    const futureReceipt = await service.ingestEvent(command(atFutureLimit, evidence.verified, key("future-limit-event-key-01")));
    expect(futureReceipt.ok).toBe(true);
    expect((await service.ingestEvent(command(oneMicrosOld, evidence.verified, key("old-outside-event-key-01")))).ok).toBe(false);
    expect((await service.ingestEvent(command(oneMicrosFuture, evidence.verified, key("future-outside-event-key-01")))).ok).toBe(false);
    if (futureReceipt.ok) {
      const row = await admin.query("select to_char(accepted_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') accepted, to_char(effective_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') effective from measurement.public_events where event_id=$1", [futureReceipt.value.eventId]);
      expect(row.rows[0]).toEqual({ accepted: "2026-10-15T12:00:00.000000Z", effective: "2026-10-15T12:00:00.000000Z" });
    }
    expect(acceptedAt).toBe("2026-10-15T12:00:00.000Z");
  });

  it("T09-07 commits event, safe receipt and private job once; exact races replay and failures roll back", async () => {
    const { projectId, routeId } = await seedProject();
    const changedRoute = await seedProject();
    const evidence = await issueEvidence();
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const inserted = new Promise<void>(resolve => { entered = resolve; });
    let held = false;
    const blockingRepository: MeasurementEventRepositoryPort = { async insert(event, tx) {
      await repository.insert(event, tx);
      if (!held) { held = true; entered(); await barrier; }
    } };
    const firstService = makeService({ repository: blockingRepository });
    const event: PublicMeasurementEvent = { action: "project-viewed", projectId, context: context(routeId) };
    const raceKey = key("concurrent-event-key-001");
    const beforeEvents = await countEvents(), beforeJobs = await countJobs();
    const first = firstService.ingestEvent(command(event, evidence.verified, raceKey));
    await inserted;
    const replay = service.ingestEvent(command(event, evidence.verified, raceKey));
    let waiting = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !waiting) {
      waiting = ((await admin.query("select 1 from pg_stat_activity where usename='event_runtime' and wait_event_type='Lock'")).rowCount ?? 0) > 0;
    }
    expect(waiting).toBe(true);
    release();
    const [original, repeated] = await Promise.all([first, replay]);
    expect(original).toEqual(repeated);
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);
    const payload = await admin.query("select payload from operations.jobs where payload->>'eventId'=$1", [original.ok ? original.value.eventId : ""]);
    expect(payload.rows).toHaveLength(1);
    expect(JSON.stringify(payload.rows[0])).not.toContain(evidence.verified.subject);
    expect(await service.ingestEvent(command(
      { ...event, context: context(routeId, { referrerClass: "search" }) }, evidence.verified, raceKey,
    ))).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await service.ingestEvent(command({ action: "project-viewed", projectId: changedRoute.projectId, context: context(changedRoute.routeId) }, evidence.verified, raceKey)))
      .toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);

    const failingRepository: MeasurementEventRepositoryPort = { async insert() { throw new Error("injected persistence failure"); } };
    const failed = await makeService({ repository: failingRepository }).ingestEvent(command(event, evidence.verified, key("rollback-event-key-001")));
    expect(failed.ok).toBe(false);
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);
    const failingJobs = { ...operations, jobs: { ...operations.jobs, async enqueue() { throw new Error("injected job failure"); } } } as typeof operations;
    expect((await makeService({ operations: failingJobs }).ingestEvent(command(event, evidence.verified, key("rollback-job-key-001")))).ok).toBe(false);
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);
  });

  it("T09-08 serializes intake against withdrawal in both lock orders and rejects post-withdrawal replay", async () => {
    const { routeId } = await seedProject();
    const evidence = await issueEvidence();
    const event = pageEvent(routeId), replayKey = key("withdrawn-replay-key-001");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const routeLocked = new Promise<void>(resolve => { entered = resolve; });
    let held = false;
    const blockingFacts = { ...content, async getRouteFacts(input: Parameters<typeof content.getRouteFacts>[0], tx: TransactionContext) {
      const facts = await content.getRouteFacts(input, tx);
      if (!held) { held = true; entered(); await gate; }
      return facts;
    } };
    const intakeService = makeService({ facts: blockingFacts });
    const intake = intakeService.ingestEvent(command(event, evidence.verified, replayKey));
    await routeLocked;
    const withdrawal = consent.recordConsent({ scope, correlationId: "withdraw-after-intake", consent: "denied", noticeVersion: "2026-10", consentId: evidence.consentId, expectedRevision: 1 });
    let waiting = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !waiting) waiting = ((await admin.query("select 1 from pg_stat_activity where usename='event_runtime' and wait_event_type='Lock'")).rowCount ?? 0) > 0;
    expect(waiting).toBe(true);
    release();
    expect((await intake).ok).toBe(true);
    expect((await withdrawal).ok).toBe(true);
    const after = await countEvents();
    expect(await service.ingestEvent(command(event, evidence.verified, replayKey))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await countEvents()).toBe(after);

    const secondEvidence = await issueEvidence();
    let unlock!: () => void, lockEntered!: () => void;
    const lockGate = new Promise<void>(resolve => { unlock = resolve; });
    const withdrawalLocked = new Promise<void>(resolve => { lockEntered = resolve; });
    let holdLock = true;
    const heldRepository: ConsentRepositoryPort = {
      async lock(portfolio, consentId, tx) {
        const row = await consentRepository.lock(portfolio, consentId, tx);
        if (holdLock) { holdLock = false; lockEntered(); await lockGate; }
        return row;
      },
      save: (row, tx) => consentRepository.save(row, tx),
    };
    const withdrawalFirst = createConsentApplicationService({ transactions: database.transactions, repository: heldRepository,
      crypto: new AesGcmConsentEvidenceAdapter(config, () => now), clock: { now: () => now }, ids: createSystemIdGenerator(),
      supportedNoticeVersions: ["2026-10"], ttlSeconds: 2_592_000 });
    const firstWithdraw = withdrawalFirst.recordConsent({ scope, correlationId: "withdraw-before-intake", consent: "denied", noticeVersion: "2026-10", consentId: secondEvidence.consentId, expectedRevision: 1 });
    await withdrawalLocked;
    const blockedIntake = service.ingestEvent(command(event, secondEvidence.verified, key("withdraw-before-intake-key-01")));
    waiting = false;
    const until = Date.now() + 3_000;
    while (Date.now() < until && !waiting) waiting = ((await admin.query("select 1 from pg_stat_activity where usename='event_runtime' and wait_event_type='Lock'")).rowCount ?? 0) > 0;
    expect(waiting).toBe(true);
    unlock();
    expect((await firstWithdraw).ok).toBe(true);
    expect(await blockedIntake).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("T09-09 enforces module RLS and keeps optional event assembly out of core readiness", async () => {
    const { routeId } = await seedProject();
    const evidence = await issueEvidence();
    const grants = await admin.query(`select has_table_privilege('event_runtime','measurement.public_events','INSERT') as insert,
      has_table_privilege('event_runtime','measurement.public_events','SELECT') as read,
      has_table_privilege('shipwithali_worker','measurement.public_events','SELECT') as worker_read,
      has_schema_privilege('anon','measurement','USAGE') as anon_schema,
      has_table_privilege('anon','measurement.public_events','SELECT') as anon_read`);
    expect(grants.rows[0]).toEqual({ insert: true, read: false, worker_read: true, anon_schema: false, anon_read: false });
    const roles = await admin.query("select rolbypassrls, rolsuper from pg_roles where rolname in ('event_runtime','shipwithali_application','shipwithali_worker')");
    expect(roles.rows.every(row => !row.rolbypassrls && !row.rolsuper)).toBe(true);
    await admin.query("begin");
    try {
      await admin.query("set local role shipwithali_worker");
      await admin.query("select set_config('shipwithali.portfolio_id',$1,true)", [portfolioId]);
      const worker = await admin.query("select count(*)::int as count from measurement.public_events");
      expect(worker.rows[0].count).toBeGreaterThan(0);
    } finally { await admin.query("rollback"); }
    expect((await service.ingestEvent(command(pageEvent(routeId), evidence.verified))).ok).toBe(true);

    const runtime = createPostgresRuntimeDatabase(url!);
    const runtimeOps = createPostgresOperationsPersistence(runtime.database, { now: () => now });
    const env = { NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL: url!, PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId };
    try {
      resetRuntimeForTests();
      const state = await initializeDatabaseRuntime(env, "application", () => ({ operations: runtimeOps, resource: runtime.resource, readiness: runtime.readiness, consent }));
      expect(state.runtimeKind).toBe("application");
      expect(getConsentApplicationService()).toBe(consent);
      expect(getMeasurementEventIngestionService()).toBeUndefined();
      const unavailable = await handlePostPublicEvent(request(evidence.token, pageEvent(routeId), "missing-event-service"), { scope, logger: createTestLogger() });
      expect(unavailable.status).toBe(503);
      resetRuntimeForTests();
      await initializeDatabaseRuntime(env, "application", () => ({ operations: runtimeOps, resource: runtime.resource, readiness: runtime.readiness,
        consent, eventIngestion: { scope, service } }));
      expect(getMeasurementEventIngestionService()?.service).toBe(service);
      const response = await handlePostPublicEvent(request(evidence.token, pageEvent(routeId), "assembled-event-service"), { logger: createTestLogger() });
      expect(response.status).toBe(202);
    } finally { resetRuntimeForTests(); await runtime.resource.close(); }
  });
});
