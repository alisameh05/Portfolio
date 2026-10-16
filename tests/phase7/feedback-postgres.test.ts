import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresFeedbackSubmissionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-feedback.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/postgres-project-discovery.js";
import { createFeedbackApplicationService } from "../../src/modules/interaction-moderation/index.js";
import { createSystemIdGenerator, createTestLogger } from "../../src/runtime/ports.js";
import { handlePostProjectFeedback, type FeedbackAdapterDeps } from "../../src/runtime/http/feedback.js";
import { initializeDatabaseRuntime, getFeedbackRuntimeServices, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
const url = process.env["PHASE7_FEEDBACK_DATABASE_URL"];
describe.runIf(Boolean(url))("real PostgreSQL private Feedback acceptance", () => {
  const portfolioId = createStableId("Portfolio"), ownerId = createStableId("Owner");
  // Keep fixed test time ahead of the disposable database clock. Content lifecycle
  // idempotency expires after 24 hours, so a historical fixture makes its
  // reservation expired at insertion and masks the lock-order assertions below.
  const scope = { kind: "portfolio" as const, portfolioId }, now = "2099-10-15T00:00:00.000Z";
  const db = createPostgresRuntimeDatabase(url ?? "postgres://invalid"), second = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const worker = createPostgresRuntimeDatabase(process.env["PHASE7_FEEDBACK_WORKER_URL"] ?? "postgres://invalid");
  const admin = new Client({ connectionString: process.env["PHASE7_FEEDBACK_ADMIN_URL"] });
  const operations = createPostgresOperationsPersistence(db.database, { now: () => now }), content = createPostgresProjectInteractionFacts({ portfolioId, ownerId });
  const repository = createPostgresFeedbackSubmissionRepository();
  const service = createFeedbackApplicationService({ portfolioId, content, operations, repository, clock: { now: () => now }, ids: createSystemIdGenerator() });
  const deps: FeedbackAdapterDeps = { scope, service, rateLimit: { check: async () => ({ allowed: true }) } };
  const key = (text = createStableId("Key")) => { const result = parseIdempotencyKey(text); if (!result.ok) throw new Error("key"); return result.value; };
  const command = (projectId: StableId<"Project">) => ({ scope, actor: { kind: "visitor" as const, consent: "unknown" as const }, projectId,
    authorName: "PRIVATE_NAME_SENTINEL", comment: "PRIVATE_PARAGRAPH_SENTINEL", locale: "en" as const, idempotencyKey: key(), correlationId: "feedback-test" });
  function http(projectId: StableId<"Project">, body: unknown = { name: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_PARAGRAPH_SENTINEL", locale: "en" }, idempotency = key(), dependencies = deps) {
    return handlePostProjectFeedback(new Request("https://example.com/feedback", { method: "POST", headers: { "Idempotency-Key": idempotency }, body: JSON.stringify(body) }), { projectId }, dependencies);
  }
  const rows = async (projectId: StableId<"Project">) => (await admin.query("select * from interaction.feedback where project_id=$1", [projectId])).rows;
  const events = async () => (await admin.query("select payload from operations.outbox_events where event_type='interaction.feedback_submitted.v1'")).rows;
  const snapshot = async () => (await admin.query("select (select count(*)::int from interaction.feedback) as feedback, (select count(*)::int from operations.outbox_events) as events, (select count(*)::int from operations.idempotency_records) as ledger")).rows;
  async function seed(lifecycle = "published", contentType = "project", locales: readonly string[] = ["en", "ar"], portfolio = portfolioId) {
    const projectId = createStableId("Project"), route = createStableId("PublicRoute");
    await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,$3,$4)", [projectId, portfolio, contentType, lifecycle]);
    if (contentType === "project" && locales.length) {
      await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)", [route, projectId, portfolio, "project-" + projectId, now]);
      for (const locale of locales) {
        const revision = createStableId("Revision"), review = createStableId("ContentReview");
        const payload = { contentType: "project", locale, title: "Project", summary: "Summary", body: "Body" };
        await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project',$4,1,1,'Project','Summary','Body',$5,$6)", [revision, projectId, portfolio, locale, payload, now]);
        await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,$5,1,$6,1,$7,'accepted',$8)", [review, projectId, portfolio, revision, locale, "a".repeat(64), ownerId, now]);
        await admin.query("insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project',$3,$4,$5,$6,1,$7)", [projectId, portfolio, locale, revision, review, route, now]);
      }
    }
    return projectId;
  }
  const lifecycle = createContentAuthoringService({ repository: createPostgresContentAuthoringRepository(), operations,
    discoveryProjection: createPostgresProjectDiscoveryProjectionWriter(),
    scope: { portfolioId, ownerId }, clock: { now: () => now } });
  const hide = (contentId: StableId<"Project">) => lifecycle.hideContent({ actor: { kind: "owner", ownerId, sessionId: "verified-owner" },
    contentId, expectedVersion: 1, correlationId: "hide-test", idempotencyKey: key() });
  beforeAll(async () => {
    await admin.connect();
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable')", [portfolioId, ownerId]);
  });
  afterAll(async () => { resetRuntimeForTests(); await admin.end(); await db.resource.close(); await second.resource.close(); await worker.resource.close(); });

  it("T05-01/T05-02 en/ar returns minimal 201; stores private version 1/server time with no identities under every consent state", async () => {
    const projectId = await seed();
    for (const locale of ["en", "ar"] as const) {
      for (const consent of ["unknown", "denied", "granted"] as const) {
        const cmd = { ...command(projectId), locale, actor: { kind: "visitor" as const, consent } };
        expect((await service.submitFeedback(cmd)).ok).toBe(true);
        const response = await http(projectId, { name: cmd.authorName, paragraph: cmd.comment, locale }, cmd.idempotencyKey);
        expect(response.status).toBe(201); expect(response.headers.get("set-cookie")).toBeNull();
        expect(await response.json()).toEqual({ feedbackId: expect.any(String), projectId, status: "pending" });
      }
    }
    const stored = await rows(projectId); expect(stored).toHaveLength(6);
    for (const row of stored) {
      expect(row).toMatchObject({ portfolio_id: portfolioId, project_id: projectId, author_name: "PRIVATE_NAME_SENTINEL",
        paragraph: "PRIVATE_PARAGRAPH_SENTINEL", moderation_state: "pending", aggregate_version: "1" });
      expect(new Date(row.submitted_at).toISOString()).toBe(now);
    }
    for (const table of ["measurement.consents", "interaction.reactions", "interaction.ratings"]) expect((await admin.query(`select count(*)::int as count from ${table}`)).rows[0].count).toBe(0);
    const plain = await service.submitFeedback({ ...command(projectId), locale: "ar", authorName: "  علي  ", comment: "  <script>plain data</script> مرحبا  " });
    expect(plain.ok).toBe(true);
    expect(await rows(projectId)).toContainEqual(expect.objectContaining({ author_name: "علي", paragraph: "<script>plain data</script> مرحبا" }));
  });
  it("T05-03 invalid text/locale/type/unknown fields reject at both seams with zero persistence; boundary lengths survive", async () => {
    const projectId = await seed(), before = await snapshot();
    for (const body of [{ name: " " }, { paragraph: "\t\n" }, { name: "x".repeat(101) }, { paragraph: "x".repeat(2001) },
      { locale: "fr" }, { name: 42 }, { paragraph: null }, { name: "bad\u0000" }, { paragraph: "bad\u0001" }, { paragraph: "bad\u202e" }, { extra: "PRIVATE_SENTINEL" }]) {
      const response = await http(projectId, { name: "Ada", paragraph: "Helpful", locale: "en", ...body });
      expect([400, 422]).toContain(response.status); expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).not.toContain("PRIVATE_SENTINEL");
      expect(await service.submitFeedback({ ...command(projectId),
        ...("name" in body ? { authorName: body.name } : {}), ...("paragraph" in body ? { comment: body.paragraph } : {}),
        ...("locale" in body ? { locale: body.locale } : {}), ...("extra" in body ? { extra: body.extra } : {}) } as never)).toMatchObject({ ok: false });
    }
    expect(await snapshot()).toEqual(before);
    expect((await http(projectId, { name: "x".repeat(100), paragraph: "x".repeat(2000), locale: "en" })).status).toBe(201);
    expect((await rows(projectId))[0].paragraph).toHaveLength(2000);
  });
  it("T05-04 authoritative Project/type/Portfolio/exact locale rejection has zero effects", async () => {
    const foreign = createStableId("Portfolio");
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Foreign','Headline','Bio','Contact','https://example.com','Unavailable')", [foreign, createStableId("Owner")]);
    const unavailable = [createStableId("Project"), await seed("draft"), await seed("hidden"), await seed("archived"),
      await seed("published", "achievement"), await seed("published", "project", []), await seed("published", "project", ["ar"]),
      await seed("published", "project", ["en"], foreign)];
    const before = await snapshot();
    for (const projectId of unavailable) {
      expect(await service.submitFeedback(command(projectId))).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect((await http(projectId)).status).toBe(404);
    }
    expect(await service.submitFeedback({ ...command(await seed()), scope: { kind: "portfolio", portfolioId: createStableId("Portfolio") } })).toMatchObject({ ok: false });
    expect(await snapshot()).toEqual(before);
  });
  it("T05-05 canonical retry has original minimal receipt; changed payload conflicts; key is Project scoped", async () => {
    const projectId = await seed(), cmd = command(projectId), result = await service.submitFeedback(cmd);
    expect(result.ok).toBe(true); expect(await service.submitFeedback({ ...cmd, authorName: "  " + cmd.authorName + "  " })).toEqual(result);
    for (const change of [{ comment: "Changed" }, { authorName: "Changed" }, { locale: "ar" as const }]) expect(await service.submitFeedback({ ...cmd, ...change })).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await rows(projectId)).toHaveLength(1);
    expect((await service.submitFeedback({ ...cmd, projectId: await seed() })).ok).toBe(true);
  });
  function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
  async function waitForLock() {
    const until = Date.now() + 2500;
    while (Date.now() < until) if ((await admin.query("select 1 from pg_stat_activity where usename='feedback_runtime' and wait_event_type='Lock'")).rowCount) return;
    throw new Error("NO_DATABASE_LOCK_OBSERVED");
  }
  it("T05-05 independent-pool same-key races produce one row/fact; changed payload conflicts", async () => {
    const other = createFeedbackApplicationService({ portfolioId, content, operations: createPostgresOperationsPersistence(second.database, { now: () => now }), repository, clock: { now: () => now }, ids: createSystemIdGenerator() });
    for (const changed of [false, true]) {
      const projectId = await seed(), cmd = command(projectId), entered = barrier(), release = barrier(), before = (await events()).length;
      const first = createFeedbackApplicationService({ portfolioId, content, operations, clock: { now: () => now }, ids: createSystemIdGenerator(),
        repository: { async insert(row, tx) { await repository.insert(row, tx); entered.release(); await release.promise; } } });
      const a = first.submitFeedback(cmd); await entered.promise;
      const b = other.submitFeedback({ ...cmd, comment: changed ? "Changed" : cmd.comment });
      try { await waitForLock(); } finally { release.release(); }
      const results = await Promise.all([a, b]); expect(results.filter(r => r.ok)).toHaveLength(changed ? 1 : 2);
      if (changed) expect(results.filter(r => !r.ok)).toMatchObject([{ error: { kind: "conflict" } }]); else expect(results[0]).toEqual(results[1]);
      expect(await rows(projectId)).toHaveLength(1); expect(await events()).toHaveLength(before + 1);
    }
  });
  it("T05-06 abuse/body controls reject before PostgreSQL and fail closed if unavailable", async () => {
    const projectId = await seed(), before = await snapshot();
    const blocked = await http(projectId, undefined, key(), { ...deps, rateLimit: { check: async () => ({ allowed: false, retryAfterSeconds: 23 }) } });
    expect(blocked.status).toBe(429); expect(blocked.headers.get("retry-after")).toBe("23");
    expect((await http(projectId, { name: "PRIVATE_NAME_SENTINEL", paragraph: "x".repeat(17000), locale: "en" })).status).toBe(400);
    expect((await http(projectId, undefined, key(), { ...deps, rateLimit: { check: async () => { throw new Error("PRIVATE_PARAGRAPH_SENTINEL"); } } })).status).toBe(503);
    expect(await snapshot()).toEqual(before);
  });
  it("T05-07 row/outbox/ledger/receipt failures roll back all effects without private errors", async () => {
    await admin.query("create function public.fail_feedback_test() returns trigger language plpgsql as $$ begin raise exception using errcode='P0001', message='PRIVATE_PARAGRAPH_SENTINEL'; end $$");
    for (const [table, action] of [["interaction.feedback", "insert"], ["operations.outbox_events", "insert"], ["operations.idempotency_records", "insert"], ["operations.idempotency_records", "update"]]) {
      const projectId = await seed(), before = await snapshot(), logger = createTestLogger();
      await admin.query(`create trigger injected before ${action} on ${table} for each row execute function public.fail_feedback_test()`);
      try {
        const response = await http(projectId, undefined, key(), { ...deps, logger }); expect(response.status).toBe(503);
        expect(await response.text()).not.toContain("PRIVATE_PARAGRAPH_SENTINEL"); expect(JSON.stringify(logger.records)).not.toContain("PRIVATE_PARAGRAPH_SENTINEL");
        expect(await snapshot()).toEqual(before);
      } finally { await admin.query(`drop trigger injected on ${table}`); }
      expect((await http(projectId)).status).toBe(201);
    }
    await admin.query("drop function public.fail_feedback_test()");
  });
  it("T05-07 hide-first blocks/rejects submission and previously accepted replay", async () => {
    const projectId = await seed(), entered = barrier(), release = barrier(), root = createPostgresContentAuthoringRepository();
    const withdrawing = createContentAuthoringService({ operations, scope: { portfolioId, ownerId }, repository: {
      ...root, async changeLifecycle(input, tx) { const result = await root.changeLifecycle(input, tx); entered.release(); await release.promise; return result; },
    }, discoveryProjection: createPostgresProjectDiscoveryProjectionWriter() });
    const withdrawal = withdrawing.hideContent({ actor: { kind: "owner", ownerId, sessionId: "owner" }, contentId: projectId,
      expectedVersion: 1, idempotencyKey: key(), correlationId: "hide-first" }); await entered.promise;
    const submission = service.submitFeedback(command(projectId)); try { await waitForLock(); } finally { release.release(); }
    expect((await withdrawal).ok).toBe(true); expect(await submission).toMatchObject({ ok: false, error: { kind: "not_found" } }); expect(await rows(projectId)).toEqual([]);
    const retained = await seed(), cmd = command(retained); expect((await service.submitFeedback(cmd)).ok).toBe(true);
    expect((await hide(retained)).ok).toBe(true); expect(await service.submitFeedback(cmd)).toMatchObject({ ok: false, error: { kind: "not_found" } }); expect(await rows(retained)).toHaveLength(1);
  });
  it("T05-07 submit-first blocks real hide until commit; subsequent submissions reject", async () => {
    const projectId = await seed(), entered = barrier(), release = barrier();
    const first = createFeedbackApplicationService({ portfolioId, content, operations, clock: { now: () => now }, ids: createSystemIdGenerator(),
      repository: { async insert(row, tx) { await repository.insert(row, tx); entered.release(); await release.promise; } } });
    const submission = first.submitFeedback(command(projectId)); await entered.promise;
    const withdrawal = hide(projectId); try { await waitForLock(); } finally { release.release(); }
    expect((await submission).ok).toBe(true); expect((await withdrawal).ok).toBe(true);
    expect(await service.submitFeedback(command(projectId))).toMatchObject({ ok: false, error: { kind: "not_found" } }); expect(await rows(projectId)).toHaveLength(1);
  });
  it("T05-08 sentinels exist only in private Feedback; logs/facts/ledger/Measurement have no text", async () => {
    const projectId = await seed(), logger = createTestLogger(), response = await http(projectId, undefined, key(), { ...deps, logger }); expect(response.status).toBe(201);
    const alternate = JSON.stringify([await response.json(), logger.records, await events(),
      (await admin.query("select * from operations.idempotency_records")).rows, (await admin.query("select * from measurement.consents")).rows]);
    expect(alternate).not.toContain("PRIVATE_NAME_SENTINEL"); expect(alternate).not.toContain("PRIVATE_PARAGRAPH_SENTINEL");
    expect(await rows(projectId)).toMatchObject([{ author_name: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_PARAGRAPH_SENTINEL" }]);
  });
  it("restricted submission scope has pending-only INSERT; Worker deletion is purpose- and retention-scoped", async () => {
    expect((await admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='interaction.feedback'::regclass")).rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    for (const role of ["anon", "authenticated", "shipwithali_backup", "feedback_runtime"]) {
      for (const privilege of (role === "feedback_runtime" ? ["DELETE"] : ["SELECT", "UPDATE", "DELETE"])) expect((await admin.query("select has_table_privilege($1,'interaction.feedback',$2) as allowed", [role, privilege])).rows[0].allowed, `${role} must not have ${privilege} on interaction.feedback`).toBe(false);
      if (role !== "feedback_runtime") expect((await admin.query("select has_table_privilege($1,'interaction.feedback','INSERT') as allowed", [role])).rows[0].allowed).toBe(false);
    }
    expect((await admin.query("select has_table_privilege('shipwithali_worker','interaction.feedback','DELETE') as allowed")).rows[0].allowed).toBe(true);
    const client = new Client({ connectionString: url }); await client.connect(); const projectId = await seed();
    try {
      expect((await client.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      expect((await client.query("select * from interaction.feedback")).rows).toEqual([]);
      const insert = (portfolio = portfolioId, state = "pending", version = 1) => client.query("insert into interaction.feedback (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at) values ($1,$2,$3,'en','Ada','Helpful',$4,$5,$6)", [createStableId("Feedback"), portfolio, projectId, state, version, now]);
      await expect(insert()).rejects.toMatchObject({ code: "42501" }); await client.query("begin"); await client.query("select set_config('shipwithali.portfolio_id',$1,true)", [portfolioId]); await insert();
      for (const [portfolio, state, version] of [[createStableId("Portfolio"), "pending", 1], [portfolioId, "approved", 1], [portfolioId, "pending", 2]] as const) {
        await client.query("savepoint denied"); await expect(insert(portfolio, state, version)).rejects.toMatchObject({ code: "42501" }); await client.query("rollback to savepoint denied");
      }
      await client.query("rollback"); await expect(insert()).rejects.toMatchObject({ code: "42501" });
    } finally { await client.end(); }
  });
  it("standard Feedback assembly needs no functional/Measurement crypto and enforces configured rate controls", async () => {
    const projectId = await seed(), env = { NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL: url!, PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId,
      FEEDBACK_RATE_LIMIT_MAX_REQUESTS: "1", FEEDBACK_RATE_LIMIT_WINDOW_SECONDS: "60", MEASUREMENT_ID_HASH_KEY: "invalid" };
    resetRuntimeForTests(); await initializeDatabaseRuntime(env, "application"); const assembled = await getFeedbackRuntimeServices();
    expect((await http(projectId, undefined, key(), assembled)).status).toBe(201);
    const blocked = await http(projectId, undefined, key(), assembled); expect(blocked.status).toBe(429); expect(blocked.headers.get("retry-after")).toBeTruthy();
    await getLifecycleCoordinator().shutdown(); resetRuntimeForTests(); await initializeDatabaseRuntime({ ...env, FEEDBACK_RATE_LIMIT_MAX_REQUESTS: "30" }, "application");
    const failedDb = await getFeedbackRuntimeServices(); await getLifecycleCoordinator().shutdown(); expect((await http(projectId, undefined, key(), failedDb)).status).toBe(503); resetRuntimeForTests();
  });
  it("restricted worker claims a mixed Feedback and preexisting Media rejection batch without privacy regression", async () => {
    const projectId = await seed(), submitted = await service.submitFeedback(command(projectId)); expect(submitted.ok).toBe(true);
    if (!submitted.ok) throw new Error("submission");
    const mediaId = createStableId("MediaAsset"), eventId = createStableId("Event");
    // Same persisted shape as the established Media rejection producer.
    await admin.query("insert into operations.outbox_events (event_id,event_type,schema_version,aggregate_id,aggregate_version,payload,correlation_id,occurred_at,available_at) values ($1,'media.asset_rejected.v1',1,$2,1,$3,'media-regression',$4,$4)",
      [eventId, mediaId, { mediaAssetId: mediaId, reason: "OWNER_REJECTED" }, now]);
    const claimed = await createPostgresOperationsPersistence(worker.database).outbox.claimDue({ workerId: "feedback-regression", now, leaseDurationSeconds: 30, limit: 100 });
    expect(claimed).toContainEqual(expect.objectContaining({ eventId, payload: { type: "media.asset_rejected.v1", version: 1, value: { mediaAssetId: mediaId, reason: "OWNER_REJECTED" } } }));
    expect(claimed).toContainEqual(expect.objectContaining({ payload: { type: "interaction.feedback_submitted.v1", version: 1, value: { feedbackId: submitted.value.id, projectId } } }));
    expect(JSON.stringify(claimed)).not.toContain("PRIVATE_PARAGRAPH_SENTINEL");
  });
});

