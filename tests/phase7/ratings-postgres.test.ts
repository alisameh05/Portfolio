import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresRatingRepository } from "../../src/modules/interaction-moderation/adapters/postgres-ratings.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import { createPostgresProjectDiscoveryProjectionWriter } from "../../src/modules/taxonomy-discovery/adapters/postgres-project-discovery.js";
import { createRatingApplicationService, createFunctionalInteractionContext } from "../../src/modules/interaction-moderation/index.js";
import { createIdentityAccessService } from "../../src/modules/identity-access/application/policy.js";
import { AesGcmPseudonymousTokenAdapter, StubAuthProvider } from "../../src/modules/identity-access/adapters/index.js";
import { createSystemIdGenerator, createTestLogger } from "../../src/runtime/ports.js";
import { handlePutProjectRating } from "../../src/runtime/http/rating.js";
import { initializeDatabaseRuntime, getRatingRuntimeServices, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { createReactionApplicationService } from "../../src/modules/interaction-moderation/index.js";
import { createPostgresReactionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-reactions.js";
import { handlePutProjectReaction } from "../../src/runtime/http/reaction.js";

const url = process.env["PHASE7_RATING_DATABASE_URL"];
describe.runIf(Boolean(url))("real PostgreSQL Rating acceptance", () => {
  const portfolioId = createStableId("Portfolio"), ownerId = createStableId("Owner");
  const scope = { kind: "portfolio" as const, portfolioId };
  // Keep the fixed application clock ahead of PostgreSQL's real transaction_timestamp.
  const now = "2099-10-14T12:00:00.000Z";
  const config = {
    functional: { active: { version: 1, secret: Buffer.alloc(32, 11).toString("base64url") }, previous: [] },
    measurement: { active: { version: 1, secret: Buffer.alloc(32, 22).toString("base64url") }, previous: [] },
  };
  const db = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const second = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const admin = new Client({ connectionString: process.env["PHASE7_RATING_ADMIN_URL"] });
  const operations = createPostgresOperationsPersistence(db.database, { now: () => now });
  const content = createPostgresProjectInteractionFacts({ portfolioId, ownerId });
  const crypto = new AesGcmPseudonymousTokenAdapter({ config, nowSeconds: () => Date.parse(now) / 1000 });
  const identity = createIdentityAccessService({ auth: new StubAuthProvider(), crypto });
  const repository = createPostgresRatingRepository();
  const service = createRatingApplicationService({ portfolioId, content, operations, repository, clock: { now: () => now }, ids: createSystemIdGenerator() });
  const functionalIdentity = createFunctionalInteractionContext({ portfolioId, content, transactions: operations.transactions, identity });
  const deps = { scope, service, functionalIdentity };
  const key = (text = createStableId("Key")) => { const result = parseIdempotencyKey(text); if (!result.ok) throw new Error("key"); return result.value; };
  const prepare = (projectId: StableId<"Project">, tokenString?: string, consent: "unknown" | "denied" = "unknown") => functionalIdentity.prepare({
    scope, correlationId: "rating-test", projectId, interaction: "rating", consent, ...(tokenString === undefined ? {} : { tokenString }) });
  async function actor(projectId: StableId<"Project">) {
    const result = await prepare(projectId); if (!result.ok) throw new Error("identity"); return result.value.actor;
  }
  function http(projectId: StableId<"Project">, choice = 1, cookie?: string, idempotency = key(), dependencies = deps) {
    return handlePutProjectRating(new Request("https://example.com/api/v1/projects/" + projectId + "/rating", {
      method: "PUT", headers: { "Idempotency-Key": idempotency, ...(cookie === undefined ? {} : { cookie }) },
      body: JSON.stringify({ rating: choice }) }), { projectId }, dependencies);
  }
  async function counts(projectId: StableId<"Project">) {
    return (await admin.query("select value, count(*)::int as count from interaction.ratings where project_id=$1 group by value order by value", [projectId])).rows;
  }
  async function events(projectId: StableId<"Project">) {
    return (await admin.query("select payload from operations.outbox_events where aggregate_id=$1 and event_type='interaction.rating_changed.v1' order by event_id", [projectId])).rows;
  }
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
  afterAll(async () => { resetRuntimeForTests(); await admin.end(); await db.resource.close(); await second.resource.close(); });

  it("T04-01 returns strict HTTP 200, secure cookie and one replacement row with reconciled counts", async () => {
    const projectId = await seed();
    const response = await http(projectId); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId, rating: 1 });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("Secure; HttpOnly; SameSite=Lax");
    const replacement = await http(projectId, 5, cookie.split(";")[0]);
    expect(replacement.status).toBe(200); expect(replacement.headers.get("set-cookie")).toBeNull();
    expect(await counts(projectId)).toEqual([{ value: 5, count: 1 }]);
    expect(await events(projectId)).toHaveLength(2);
  });
  it("T04-02 invalid application and transport values have zero persisted effects or cookies", async () => {
    const projectId = await seed(), visitor = await actor(projectId);
    const snapshot = async () => (await admin.query("select (select count(*)::int from interaction.ratings) as ratings, (select count(*)::int from operations.outbox_events) as events, (select count(*)::int from operations.idempotency_records) as ledger")).rows;
    const before = await snapshot();
    for (const value of [0, 1.5, 6, "5", null, {}, [], undefined, NaN, Infinity]) {
      expect(await service.submitRating({ scope, actor: visitor, projectId, value: value as never, idempotencyKey: key(), correlationId: "invalid" }))
        .toMatchObject({ ok: false, error: { kind: "validation" } });
      const response = await handlePutProjectRating(new Request("https://example.com/rating", {
        method: "PUT", headers: { "Idempotency-Key": key() }, body: JSON.stringify({ rating: value }),
      }), { projectId }, deps);
      expect(response.status).toBe(400); expect(response.headers.get("set-cookie")).toBeNull();
    }
    for (const body of ["{", "{}", '{"rating":1,"locale":"ar"}', '{"rating":1,"extra":true}']) {
      const response = await handlePutProjectRating(new Request("https://example.com/rating", {
        method: "PUT", headers: { "Idempotency-Key": key() }, body }), { projectId }, deps);
      expect(response.status).toBe(400); expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await snapshot()).toEqual(before);
    for (const value of [0, 6]) {
      await expect(admin.query("insert into interaction.ratings (portfolio_id,project_id,visitor_id,value,updated_at) values ($1,$2,$3,$4,$5)",
        [portfolioId, projectId, visitor.functionalId, value, now])).rejects.toMatchObject({ code: "23514" });
    }
    expect(await snapshot()).toEqual(before);
  });
  it("T04-03 Rating and Reaction preserve each other across language views and operation-scoped replay", async () => {
    const projectId = await seed(), idempotency = key();
    const reactionService = createReactionApplicationService({ portfolioId, content, operations,
      repository: createPostgresReactionRepository(), clock: { now: () => now }, ids: createSystemIdGenerator() });
    const reaction = (kind: "like" | "dislike", cookie: string) => handlePutProjectReaction(new Request("https://example.com/en/projects/" + projectId + "/reaction", {
      method: "PUT", headers: { cookie, "Idempotency-Key": kind === "like" ? idempotency : key() }, body: JSON.stringify({ reaction: kind }),
    }), { projectId }, { ...deps, service: reactionService });
    // Rating-first issues one recognized subject reusable by the separately authorized Reaction.
    const initial = await http(projectId, 1, undefined, idempotency);
    expect(initial.status).toBe(200);
    const cookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    expect((await reaction("like", cookie)).status).toBe(200);
    expect((await http(projectId, 5, cookie)).status).toBe(200);
    expect((await admin.query("select kind from interaction.reactions where project_id=$1", [projectId])).rows).toEqual([{ kind: "like" }]);
    const arabic = await handlePutProjectRating(new Request("https://example.com/ar/projects/" + projectId + "/rating", {
      method: "PUT", headers: { cookie, "Idempotency-Key": key(), "accept-language": "ar" }, body: '{"rating":5}',
    }), { projectId }, deps);
    expect(arabic.status).toBe(200); expect(arabic.headers.get("set-cookie")).toBeNull();
    expect((await reaction("dislike", cookie)).status).toBe(200);
    expect(await counts(projectId)).toEqual([{ value: 5, count: 1 }]);
    expect(await events(projectId)).toHaveLength(2);
    expect((await admin.query("select kind from interaction.reactions where project_id=$1", [projectId])).rows).toEqual([{ kind: "dislike" }]);
    const stored = (await admin.query("select r.visitor_id = s.visitor_id as same_subject from interaction.ratings r join interaction.reactions s using(portfolio_id,project_id) where r.project_id=$1", [projectId])).rows;
    expect(stored).toEqual([{ same_subject: true }]);
    // Reaction-first recognizes the same subject when the first Rating follows.
    const otherProject = await seed();
    const firstReaction = await handlePutProjectReaction(new Request("https://example.com/reaction", {
      method: "PUT", headers: { "Idempotency-Key": key() }, body: '{"reaction":"like"}',
    }), { projectId: otherProject }, { ...deps, service: reactionService });
    expect(firstReaction.status).toBe(200);
    const following = await http(otherProject, 4, firstReaction.headers.get("set-cookie")!.split(";")[0]);
    expect(following.status).toBe(200); expect(following.headers.get("set-cookie")).toBeNull();
    expect(await counts(otherProject)).toEqual([{ value: 4, count: 1 }]);
  });
  it("T04-06 denies unavailable, wrong-type and foreign references before issuance and again in mutation", async () => {
    const available = await seed(), verified = await actor(available);
    const foreign = createStableId("Portfolio");
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Foreign','Headline','Bio','Contact','https://example.com','Unavailable')", [foreign, createStableId("Owner")]);
    const ids = [createStableId("Project"), await seed("draft"), await seed("hidden"), await seed("archived"),
      await seed("published", "achievement", []), await seed("published", "project", [], portfolioId), await seed("published", "project", ["en"], foreign)];
    let issuance = 0;
    const guarded = createFunctionalInteractionContext({ portfolioId, content, transactions: operations.transactions,
      identity: { ...identity, async issuePseudonymousToken(input) { issuance++; return identity.issuePseudonymousToken(input); } } });
    for (const projectId of ids) {
      const response = await http(projectId, 1, undefined, key(), { ...deps, functionalIdentity: guarded });
      expect(response.status).toBe(404); expect(response.headers.get("set-cookie")).toBeNull();
      expect(await service.submitRating({ scope, actor: verified, projectId, value: 1, idempotencyKey: key(), correlationId: "unavailable" })).toMatchObject({ ok: false, error: { kind: "not_found" } });
      expect(await counts(projectId)).toEqual([]);
    }
    expect(issuance).toBe(0);
  });
  it("T04-07 consent denial/unknown permits functional use and non-interaction issuance rejects", async () => {
    const projectId = await seed();
    for (const consent of ["denied", "unknown"] as const) {
      const prepared = await prepare(projectId, undefined, consent); expect(prepared.ok).toBe(true);
      if (!prepared.ok) throw new Error("prepare");
      expect(await service.submitRating({ scope, actor: prepared.value.actor, projectId, value: 1, idempotencyKey: key(), correlationId: "consent" })).toMatchObject({ ok: true });
    }
    for (const interaction of ["read", "feedback", "event"] as const) {
      expect((await functionalIdentity.prepare({ scope, correlationId: "invalid-operation", projectId, interaction: interaction as never, consent: "unknown" })).ok).toBe(false);
    }
    expect((await admin.query("select count(*)::int as count from measurement.consents")).rows[0].count).toBe(0);
  });
  it("T04-07 actual crypto rejects tampered/expired/wrong-purpose/retired tokens; rotation preserves subject", async () => {
    const projectId = await seed(), issued = await prepare(projectId);
    if (!issued.ok || !issued.value.issued) throw new Error("issuance");
    const token = issued.value.issued.tokenString;
    const make = (adapter: AesGcmPseudonymousTokenAdapter) => createFunctionalInteractionContext({ portfolioId, content, transactions: operations.transactions,
      identity: createIdentityAccessService({ auth: new StubAuthProvider(), crypto: adapter }) });
    const rotated = { ...config, functional: { active: { version: 2, secret: Buffer.alloc(32, 33).toString("base64url") }, previous: [config.functional.active] } };
    const verify = (context = functionalIdentity, tokenString = token) => context.prepare({ scope, projectId, tokenString, interaction: "rating", consent: "unknown", correlationId: "crypto" });
    const restored = await verify(make(new AesGcmPseudonymousTokenAdapter({ config: rotated, nowSeconds: () => Date.parse(now) / 1000 })));
    expect(restored).toEqual({ ok: true, value: { actor: issued.value.actor } });
    expect((await service.submitRating({ scope, actor: issued.value.actor, projectId, value: 1, idempotencyKey: key(), correlationId: "before-rotation" })).ok).toBe(true);
    if (!restored.ok) throw new Error("rotation");
    expect((await service.submitRating({ scope, actor: restored.value.actor, projectId, value: 5, idempotencyKey: key(), correlationId: "after-rotation" })).ok).toBe(true);
    expect((await verify(make(new AesGcmPseudonymousTokenAdapter({ config: { ...rotated, functional: { ...rotated.functional, previous: [] } }, nowSeconds: () => Date.parse(now) / 1000 })))).ok).toBe(false);
    expect((await verify(make(new AesGcmPseudonymousTokenAdapter({ config, nowSeconds: () => Date.parse(issued.value.issued!.expiresAt) / 1000 })))).ok).toBe(false);
    const measurement = await crypto.issuePseudonymousToken({ purpose: "visitor_measurement", consent: "granted", ttlSeconds: 3600 });
    if (!measurement.ok) throw new Error("measurement");
    for (const invalid of [token + "x", measurement.value.tokenString]) {
      const response = await http(projectId, 1, "visitor_functional=" + invalid);
      expect(response.status).toBe(403); expect(response.headers.get("set-cookie")).toBeNull();
    }
    expect(await counts(projectId)).toEqual([{ value: 5, count: 1 }]);
  });
  it("T04-04 new-key same-value is a no-op; exact retry retains original safe result; conflicting reuse changes nothing", async () => {
    const projectId = await seed(), visitor = await actor(projectId), originalKey = key();
    const command = { scope, actor: visitor, projectId, value: 1 as const, idempotencyKey: originalKey, correlationId: "replay" };
    const original = await service.submitRating(command);
    expect(await service.submitRating({ ...command, idempotencyKey: key() })).toEqual(original);
    expect(await events(projectId)).toHaveLength(1);
    expect((await service.submitRating({ ...command, value: 5, idempotencyKey: key() })).ok).toBe(true);
    expect(await service.submitRating(command)).toEqual(original);
    expect(await service.submitRating({ ...command, value: 5 })).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await counts(projectId)).toEqual([{ value: 5, count: 1 }]); expect(await events(projectId)).toHaveLength(2);
  });
  it("T04-05 same-key races across independent pools yield one effect; differing payload yields one conflict", async () => {
    const other = createRatingApplicationService({ portfolioId, content, operations: createPostgresOperationsPersistence(second.database, { now: () => now }), repository, clock: { now: () => now }, ids: createSystemIdGenerator() });
    for (const changed of [false, true]) {
      const projectId = await seed(), visitor = await actor(projectId);
      const command = { scope, actor: visitor, projectId, value: 1 as const, idempotencyKey: key(), correlationId: "same-key-race" };
      const entered = barrier(), release = barrier();
      const first = createRatingApplicationService({ portfolioId, content, operations, clock: { now: () => now }, ids: createSystemIdGenerator(),
        repository: { ...repository, async lockCurrent(input, tx) { const current = await repository.lockCurrent(input, tx); entered.release(); await release.promise; return current; } } });
      const firstWrite = first.submitRating(command); await entered.promise;
      const secondWrite = other.submitRating({ ...command, value: changed ? 5 : 1 });
      try { await waitForLock(); } finally { release.release(); }
      const results = await Promise.all([firstWrite, secondWrite]);
      expect(results.filter(r => r.ok)).toHaveLength(changed ? 1 : 2);
      if (changed) expect(results.filter(r => !r.ok)).toMatchObject([{ error: { kind: "conflict" } }]);
      else expect(results[0]).toEqual(results[1]);
      expect((await counts(projectId)).reduce((sum, r) => sum + r.count, 0)).toBe(1); expect(await events(projectId)).toHaveLength(1);
    }
  });
  function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
  async function waitForLock() {
    const until = Date.now() + 2500;
    while (Date.now() < until) {
      const result = await admin.query("select 1 from pg_stat_activity where usename='rating_runtime' and wait_event_type='Lock'");
      if (result.rowCount) return;
    }
    throw new Error("NO_DATABASE_LOCK_OBSERVED");
  }
  it("T04-05 different-key choices serialize final state across independent connections with a lock barrier", async () => {
    const projectId = await seed(), visitor = await actor(projectId), entered = barrier(), release = barrier();
    const first = createRatingApplicationService({ portfolioId, operations, content, clock: { now: () => now }, ids: createSystemIdGenerator(),
      repository: { ...repository, async lockCurrent(input, tx) { const result = await repository.lockCurrent(input, tx); entered.release(); await release.promise; return result; } } });
    const other = createRatingApplicationService({ portfolioId, content, operations: createPostgresOperationsPersistence(second.database, { now: () => now }), repository, clock: { now: () => now }, ids: createSystemIdGenerator() });
    const command = { scope, actor: visitor, projectId, value: 1 as const, idempotencyKey: key(), correlationId: "different-key" };
    const firstWrite = first.submitRating(command); await entered.promise;
    const secondWrite = other.submitRating({ ...command, value: 5, idempotencyKey: key() });
    try { await waitForLock(); } finally { release.release(); }
    expect((await firstWrite).ok).toBe(true); expect((await secondWrite).ok).toBe(true);
    expect(await counts(projectId)).toEqual([{ value: 5, count: 1 }]); expect(await events(projectId)).toHaveLength(2);
  });
  it("T04-08 row/outbox/ledger/receipt persistence failures roll back every effect and return no cookie", async () => {
    await admin.query("create function public.fail_rating_test() returns trigger language plpgsql as $$ begin raise exception using errcode='P0001', message='INJECTED'; end $$");
    const snapshot = async () => (await admin.query("select (select count(*)::int from interaction.ratings) as votes, (select count(*)::int from operations.outbox_events) as events, (select count(*)::int from operations.idempotency_records) as ledger")).rows;
    for (const [table, action] of [["interaction.ratings", "insert"], ["operations.outbox_events", "insert"], ["operations.idempotency_records", "insert"], ["operations.idempotency_records", "update"]]) {
      const projectId = await seed(), before = await snapshot();
      await admin.query(`create trigger injected before ${action} on ${table} for each row execute function public.fail_rating_test()`);
      try {
        const response = await http(projectId); expect(response.status).toBe(503); expect(response.headers.get("set-cookie")).toBeNull();
        expect(await snapshot()).toEqual(before);
      } finally { await admin.query(`drop trigger injected on ${table}`); }
      expect((await http(projectId)).status).toBe(200);
    }
    await admin.query("drop function public.fail_rating_test()");
  });
  it("T04-03 losing the initial cookie creates independent actors even for the same key", async () => {
    const projectId = await seed(), idempotency = key();
    const a = await http(projectId, 1, undefined, idempotency), b = await http(projectId, 1, undefined, idempotency);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(a.headers.get("set-cookie")).not.toEqual(b.headers.get("set-cookie"));
    expect(await counts(projectId)).toEqual([{ value: 1, count: 2 }]);
    expect((await http(projectId, 1, a.headers.get("set-cookie")!.split(";")[0], idempotency)).status).toBe(200);
    expect(await counts(projectId)).toEqual([{ value: 1, count: 2 }]); expect(await events(projectId)).toHaveLength(2);
  });
  it("T04-03 subjects and Projects remain independent and votes have no locale copy", async () => {
    const a = await seed("published", "project", ["en"]), b = await seed("published", "project", ["ar"]);
    const visitor = await actor(a), other = await actor(a);
    const command = { scope, actor: visitor, projectId: a, value: 1 as const, idempotencyKey: key(), correlationId: "independent" };
    expect((await service.submitRating(command)).ok).toBe(true);
    expect((await service.submitRating({ ...command, projectId: b, value: 5 })).ok).toBe(true);
    expect((await service.submitRating({ ...command, actor: other, value: 5 })).ok).toBe(true);
    expect(await counts(a)).toEqual([{ value: 1, count: 1 }, { value: 5, count: 1 }]);
    expect(await counts(b)).toEqual([{ value: 5, count: 1 }]);
  });
  it("T04-06 withdrawal-first serialization rejects preflight-authorized submission and retained replay", async () => {
    const projectId = await seed(), prepared = await prepare(projectId); if (!prepared.ok) throw new Error("prepare");
    const entered = barrier(), release = barrier(), root = createPostgresContentAuthoringRepository();
    const withdrawing = createContentAuthoringService({ operations, scope: { portfolioId, ownerId }, repository: {
      ...root, async changeLifecycle(input, tx) { const result = await root.changeLifecycle(input, tx); entered.release(); await release.promise; return result; },
    }, discoveryProjection: createPostgresProjectDiscoveryProjectionWriter() });
    const withdrawal = withdrawing.hideContent({ actor: { kind: "owner", ownerId, sessionId: "owner" }, contentId: projectId,
      expectedVersion: 1, idempotencyKey: key(), correlationId: "withdraw-first" });
    await entered.promise;
    const submission = service.submitRating({ scope, actor: prepared.value.actor, projectId, value: 1, idempotencyKey: key(), correlationId: "stale-preflight" });
    try { await waitForLock(); } finally { release.release(); }
    expect((await withdrawal).ok).toBe(true); expect(await submission).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await counts(projectId)).toEqual([]);
    const retained = await seed(), visitor = await actor(retained), command = { scope, actor: visitor, projectId: retained, value: 1 as const, idempotencyKey: key(), correlationId: "withdraw-replay" };
    expect((await service.submitRating(command)).ok).toBe(true); expect((await hide(retained)).ok).toBe(true);
    expect(await service.submitRating(command)).toMatchObject({ ok: false, error: { kind: "not_found" } });
  });
  it("T04-06 submission-first holds real lifecycle withdrawal until commit; later writes reject", async () => {
    const projectId = await seed(), visitor = await actor(projectId), entered = barrier(), release = barrier();
    const first = createRatingApplicationService({ portfolioId, content, operations, clock: { now: () => now }, ids: createSystemIdGenerator(),
      repository: { ...repository, async save(row, tx) { await repository.save(row, tx); entered.release(); await release.promise; } } });
    const command = { scope, actor: visitor, projectId, value: 1 as const, idempotencyKey: key(), correlationId: "submit-first" };
    const submission = first.submitRating(command); await entered.promise;
    const withdrawal = hide(projectId); try { await waitForLock(); } finally { release.release(); }
    expect((await submission).ok).toBe(true); expect((await withdrawal).ok).toBe(true);
    expect(await service.submitRating({ ...command, value: 5, idempotencyKey: key() })).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(await counts(projectId)).toEqual([{ value: 1, count: 1 }]);
  });
  it("restricted principal RLS scopes votes and pooled settings; no anonymous/worker grants or subject leakage", async () => {
    const projectId = await seed(), visitor = await actor(projectId);
    await service.submitRating({ scope, actor: visitor, projectId, value: 1, idempotencyKey: key(), correlationId: "privacy" });
    expect((await admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='interaction.ratings'::regclass")).rows)
      .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    await expect(admin.query("insert into interaction.ratings (portfolio_id,project_id,visitor_id,value,updated_at) values ($1,$2,$3,5,$4)",
      [portfolioId, projectId, visitor.functionalId, now])).rejects.toMatchObject({ code: "23505" });
    for (const role of ["anon", "authenticated", "shipwithali_worker", "shipwithali_backup"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        expect((await admin.query("select has_table_privilege($1,'interaction.ratings',$2) as allowed", [role, privilege])).rows[0].allowed).toBe(false);
      }
    }
    const client = new Client({ connectionString: url }); await client.connect();
    try {
      expect((await client.query("select * from interaction.ratings")).rows).toEqual([]);
      await client.query("begin");
      await client.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.functional_id',$2,true)", [portfolioId, visitor.functionalId]);
      expect((await client.query("select * from interaction.ratings")).rows).toHaveLength(1);
      expect((await client.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows)
        .toEqual([{ rolsuper: false, rolbypassrls: false }]);
      await client.query("set local enable_seqscan=off");
      const plan = await client.query("explain (format json) select value from interaction.ratings where portfolio_id=$1 and project_id=$2 and visitor_id=$3 for update",
        [portfolioId, projectId, visitor.functionalId]);
      expect(JSON.stringify(plan.rows)).toContain("ratings_pkey");
      await client.query("select set_config('shipwithali.functional_id',$1,true)", [createStableId("FunctionalVisitor")]);
      expect((await client.query("select * from interaction.ratings")).rows).toEqual([]);
      await client.query("select set_config('shipwithali.functional_id',$1,true),set_config('shipwithali.portfolio_id',$2,true)", [visitor.functionalId, createStableId("Portfolio")]);
      expect((await client.query("select * from interaction.ratings")).rows).toEqual([]);
      await client.query("savepoint denied");
      await expect(client.query("insert into interaction.ratings (portfolio_id,project_id,visitor_id,value,updated_at) values ($1,$2,$3,1,$4)",
        [portfolioId, createStableId("Project"), visitor.functionalId, now])).rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint denied");
      await client.query("select set_config('shipwithali.portfolio_id',$1,true)", [portfolioId]);
      await client.query("savepoint reassignment");
      await expect(client.query("update interaction.ratings set visitor_id=$1 where project_id=$2", [createStableId("FunctionalVisitor"), projectId]))
        .rejects.toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint reassignment");
      await client.query("rollback"); expect((await client.query("select * from interaction.ratings")).rows).toEqual([]);
    } finally { await client.end(); }
    expect(JSON.stringify(await events(projectId))).not.toContain(visitor.functionalId!);
    const receipts = await admin.query("select result_envelope from operations.idempotency_records where operation_scope=$1", ["interaction.rating:" + portfolioId + ":" + projectId]);
    expect(JSON.stringify(receipts.rows)).not.toContain(visitor.functionalId!);
  });
  it("standard PostgreSQL assembly activates Rating without Measurement and failed required DB returns no cookie", async () => {
    const projectId = await seed();
    const env = { NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL: url!, PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId,
      FUNCTIONAL_ID_HASH_KEY: config.functional.active.secret, FUNCTIONAL_ID_HASH_KEY_VERSION: "1" };
    resetRuntimeForTests();
    await initializeDatabaseRuntime(env, "application");
    const assembled = await getRatingRuntimeServices();
    if (!("functionalIdentity" in assembled)) throw new Error("not assembled");
    const logger = createTestLogger();
    const response = await http(projectId, 1, undefined, key(), { ...assembled, logger } as typeof deps);
    expect(response.status).toBe(200);
    expect(JSON.stringify(logger.records)).not.toContain(response.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!);
    await getLifecycleCoordinator().shutdown();
    const failed = await http(projectId, 1, undefined, key(), assembled);
    expect(failed.status).toBe(503); expect(failed.headers.get("set-cookie")).toBeNull(); resetRuntimeForTests();
    await initializeDatabaseRuntime({ ...env, MEASUREMENT_ID_HASH_KEY: "invalid", MEASUREMENT_ID_HASH_KEY_VERSION: "invalid" }, "application");
    const invalidMeasurement = await getRatingRuntimeServices();
    if (!("functionalIdentity" in invalidMeasurement)) throw new Error("not assembled");
    expect((await http(projectId, 1, undefined, key(), invalidMeasurement)).status).toBe(200);
    await getLifecycleCoordinator().shutdown(); resetRuntimeForTests();
  });
});
