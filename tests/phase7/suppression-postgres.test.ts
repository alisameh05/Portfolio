import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHmac } from "node:crypto";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresFeedbackSubmissionRepository } from "../../src/modules/interaction-moderation/adapters/postgres-feedback.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createFeedbackApplicationService, createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/index.js";
import { createIdentityAccessService, decideAuthorization } from "../../src/modules/identity-access/index.js";
import { SupabaseOwnerSessionAdapter, StubCryptoAdapter } from "../../src/modules/identity-access/adapters/index.js";
import { createSystemIdGenerator, createTestLogger } from "../../src/runtime/ports.js";
import { handleGetOwnerFeedbackModeration, handleApproveOwnerFeedback, handleRejectOwnerFeedback, handleSuppressOwnerFeedback } from "../../src/runtime/http/owner-moderation.js";
import type { OwnerModerationAdapterDeps } from "../../src/runtime/http/owner-moderation.js";
import { initializeDatabaseRuntime, getOwnerModerationRuntimeServices, getApprovedFeedbackApplicationService, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
const url = process.env["PHASE7_MODERATION_DATABASE_URL"];
describe.runIf(Boolean(url))("real PostgreSQL suppression and keyset page acceptance", () => {
  const portfolioId = createStableId("Portfolio"), ownerId = createStableId("Owner");
  const scope = { kind: "portfolio" as const, portfolioId }, now = "2099-10-15T00:00:00.000Z";
  const db = createPostgresRuntimeDatabase(url ?? "postgres://invalid"), second = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const admin = new Client({ connectionString: process.env["PHASE7_MODERATION_ADMIN_URL"] });
  const operations = createPostgresOperationsPersistence(db.database, { now: () => now });
  const content = createPostgresProjectInteractionFacts({ portfolioId, ownerId }), repository = createPostgresModerationRepository();
  const base = { scope: { portfolioId, ownerId }, operations, content, repository, clock: { now: () => now }, ids: createSystemIdGenerator(), authorize: async (q: Parameters<typeof decideAuthorization>[0]) => decideAuthorization(q) };
  const service = createOwnerFeedbackModerationService(base);
  const submission = createFeedbackApplicationService({ portfolioId, operations, content, repository: createPostgresFeedbackSubmissionRepository(), clock: base.clock, ids: base.ids });
  const key = () => { const r = parseIdempotencyKey(createStableId("Key")); if (!r.ok) throw new Error("key"); return r.value; };
  const actor = { kind: "owner" as const, ownerId, sessionId: "verified-session" };
  let permitted = true, revoked = false;
  const secret = "local-nonproduction-moderation-signing-material";
  const sign = (subject = "owner-subject", expiry = 1792026000) => {
    const h = Buffer.from(JSON.stringify({ alg: "HS256", kid: "local" })).toString("base64url");
    const b = Buffer.from(JSON.stringify({ sub: subject, session_id: actor.sessionId, iss: "http://127.0.0.1/auth/v1", aud: "authenticated", exp: expiry })).toString("base64url");
    return h + "." + b + "." + createHmac("sha256", secret).update(h + "." + b).digest("base64url");
  };
  const identity = createIdentityAccessService({ auth: new SupabaseOwnerSessionAdapter({ issuer: "http://127.0.0.1/auth/v1", audience: "authenticated", allowedAlgorithms: ["HS256"], signingKeys: new Map([["local", secret]]),
    get ownerAllowlist() { return permitted ? ["owner-subject"] : []; }, stableOwnerId: ownerId, nowSeconds: () => 1792022400,
    resolveProviderIdentity: async subject => ({ provider: "github", subject }), isSessionRevoked: async () => revoked }), crypto: new StubCryptoAdapter() });
  const deps: OwnerModerationAdapterDeps = { scope, service, security: { appOrigin: "https://example.com", identity, rateLimit: { check: async () => ({ allowed: true }) } } };
  const cmd = (feedbackId: StableId<"Feedback">) => ({ scope, actor, feedbackId, expectedVersion: 1, idempotencyKey: key(), reason: "PRIVATE_REASON_SENTINEL", correlationId: "moderation-test" });
  const inspect = (id: StableId<"Feedback">) => service.getOwnerFeedbackModeration({ scope, actor, feedbackId: id, correlationId: "inspect" });
  const query = (projectId: StableId<"Project">, locale: "en" | "ar" = "en") => service.getApprovedFeedback({ scope, portfolioId, projectId, locale, limit: 25, correlationId: "public" });
  const request = (body?: unknown, headers: Record<string,string> = {}) => new Request("https://example.com/moderation", { method: body === undefined ? "GET" : "POST", headers: { cookie: "sw_owner_session=" + sign(), origin: "https://example.com", "x-csrf-token": "csrf-proof-193", "Idempotency-Key": key(), "If-Match": '\"1\"', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const approveHttp = (id: StableId<"Feedback">, headers: Record<string,string> = {}, dependencies = deps) => handleApproveOwnerFeedback(request({ reason: "PRIVATE_REASON_SENTINEL" }, headers), { feedbackId: id }, dependencies);
  const snapshot = async (id: StableId<"Feedback">) => (await admin.query("select row_to_json(f) as feedback, (select coalesce(json_agg(d order by sequence),'[]') from interaction.moderation_decisions d where d.feedback_id=f.feedback_id) as history, (select count(*)::int from operations.outbox_events where aggregate_id=f.feedback_id) as events, (select count(*)::int from operations.idempotency_records) as ledger from interaction.feedback f where feedback_id=$1", [id])).rows;
  async function submit(projectId: StableId<"Project">, locale: "en" | "ar" = "en") {
    const r = await submission.submitFeedback({ scope, actor: { kind: "visitor", consent: "unknown" }, projectId, locale, authorName: "PRIVATE_NAME_SENTINEL", comment: "PRIVATE_PARAGRAPH_SENTINEL", correlationId: "submit", idempotencyKey: key() });
    expect(r.ok).toBe(true); if (!r.ok) throw new Error("SUBMISSION_FAILED"); return r.value.id;
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
  beforeAll(async () => {
    await admin.connect();
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable')", [portfolioId,ownerId]);
  });
  afterAll(async () => { resetRuntimeForTests(); await admin.end(); await db.resource.close(); await second.resource.close(); });


  const suppressionTime = "2026-10-31T12:30:00.123Z";
  const suppressor = createOwnerFeedbackModerationService({ ...base, clock: { now: () => suppressionTime } });
  const suppress = (id: StableId<"Feedback">) => ({ ...cmd(id), expectedVersion: 2 });
  const suppressHttp = (id: StableId<"Feedback">, headers: Record<string,string> = {}, dependencies = deps) =>
    handleSuppressOwnerFeedback(request({ reason: "PRIVATE_REASON_SENTINEL" }, { "If-Match": '"2"', ...headers }), { feedbackId: id }, dependencies);
  async function approved(project: StableId<"Project">, locale: "en" | "ar" = "en") {
    const id = await submit(project, locale);
    expect((await service.approveOwnerFeedback(cmd(id))).ok).toBe(true);
    return id;
  }
  async function publicCount(projectId: StableId<"Project">) {
    const c = new Client({ connectionString: url }); await c.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true),set_config('shipwithali.feedback_access','public',true)", [portfolioId,ownerId]);
      return (await c.query("select count(*)::int n from interaction.feedback where project_id=$1", [projectId])).rows[0].n;
    } finally { await c.query("rollback"); await c.end(); }
  }
  it("T07-01/T07-08 suppression removes public eligibility/count immediately without workers and retains private history/cleanup anchor", async () => {
    const project = await seed(), id = await approved(project);
    expect(await publicCount(project)).toBe(1);
    expect(await suppressor.suppressOwnerFeedback(suppress(id))).toMatchObject({ ok: true, value: { aggregateVersion: 3, outcome: "feedback-suppressed" } });
    expect(await query(project)).toEqual({ ok: true, value: { items: [], nextCursor: null } });
    expect(await publicCount(project)).toBe(0);
    expect(await inspect(id)).toMatchObject({ ok: true, value: { state: "suppressed", authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_PARAGRAPH_SENTINEL",
      decisionHistory: [{ decision: "approved", decidedAt: now }, { decision: "suppressed", decidedAt: suppressionTime }] } });
    const decisions = (await admin.query("select sequence,decision,owner_id,decided_at from interaction.moderation_decisions where feedback_id=$1 order by sequence", [id])).rows;
    expect(decisions).toMatchObject([{ sequence: "1", decision: "approved" }, { sequence: "2", decision: "suppressed", owner_id: ownerId, decided_at: new Date(suppressionTime) }]);
    expect((await admin.query("select approved_at from interaction.feedback where feedback_id=$1", [id])).rows[0].approved_at).toEqual(new Date(now));
  });
  it("T07-02 exact retry appends no decision/fact, changed payload and terminal new keys conflict, stale HTTP is 412", async () => {
    const id = await approved(await seed()), c = suppress(id), result = await service.suppressOwnerFeedback(c), before = await snapshot(id);
    expect(result.ok).toBe(true); expect(await service.suppressOwnerFeedback(c)).toEqual(result);
    expect(await service.suppressOwnerFeedback({ ...c, reason: "changed" })).toMatchObject({ ok: false, error: { kind: "conflict" } });
    for (const operation of [service.approveOwnerFeedback, service.rejectOwnerFeedback, service.suppressOwnerFeedback])
      expect(await operation({ ...c, expectedVersion: 3, idempotencyKey: key() })).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect((await suppressHttp(id)).status).toBe(412); expect(await snapshot(id)).toEqual(before);
    const pending = await submit(await seed());
    expect(await service.suppressOwnerFeedback({ ...cmd(pending) })).toMatchObject({ ok: false, error: { kind: "conflict" } });
    const rejected = await submit(await seed()); expect((await service.rejectOwnerFeedback(cmd(rejected))).ok).toBe(true);
    expect(await service.suppressOwnerFeedback(suppress(rejected))).toMatchObject({ ok: false, error: { kind: "conflict" } });
  });
  it("T07-07 real signed Owner auth, application scope and current replay authorization deny without effects", async () => {
    const id = await approved(await seed()), c = suppress(id);
    for (const denied of [{ actor: { kind: "visitor", consent: "unknown" } }, { actor: { ...actor, ownerId: createStableId("Owner") } },
      { scope: { kind: "portfolio", portfolioId: createStableId("Portfolio") } }, { actor: { ...actor, sessionId: "" } }])
      expect(await service.suppressOwnerFeedback({ ...c, ...denied } as never)).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    for (const token of ["", sign().slice(0,-3)+"xxx", sign("foreign-subject"), sign("owner-subject",1792022400)])
      expect([401,403]).toContain((await suppressHttp(id, { cookie: token ? "sw_owner_session="+token : "" })).status);
    const k = key(); expect((await suppressHttp(id, { "Idempotency-Key": k })).status).toBe(200);
    const before = await snapshot(id); permitted = false;
    try { expect((await suppressHttp(id, { "Idempotency-Key": k })).status).toBe(403); } finally { permitted = true; }
    revoked = true; try { expect((await suppressHttp(id, { "Idempotency-Key": k })).status).toBe(401); } finally { revoked = false; }
    const denied = createOwnerFeedbackModerationService({ ...base, authorize: async () => ({ ok: true, value: false }) });
    expect(await denied.suppressOwnerFeedback(c)).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await snapshot(id)).toEqual(before);
  });
  it("T07-07 suppression preserves origin/CSRF/abuse controls and private reason validation", async () => {
    const id = await approved(await seed()), before = await snapshot(id);
    for (const headers of [{ origin: "https://evil.example" }, { "x-csrf-token": "" }, { "If-Match": "2" }, { "Idempotency-Key": "" }])
      expect([400,403]).toContain((await suppressHttp(id, headers)).status);
    for (const reason of [" ", "x".repeat(501), "bad\u0000", "bad\u202e"])
      expect(await service.suppressOwnerFeedback({ ...suppress(id), reason })).toMatchObject({ ok: false, error: { kind: "validation" } });
    const response = await suppressHttp(id, {}, { ...deps, security: { ...deps.security, rateLimit: { check: async () => ({ allowed: false, retryAfterSeconds: 19 }) } } });
    expect(response.status).toBe(429); expect(response.headers.get("retry-after")).toBe("19"); expect(await snapshot(id)).toEqual(before);
  });
  function barrier() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
  async function waitForLock() { const until = Date.now()+3000; while (Date.now()<until)
    if ((await admin.query("select 1 from pg_stat_activity where usename='moderation_runtime' and wait_event_type='Lock'")).rowCount) return;
    throw new Error("NO_DATABASE_LOCK_OBSERVED"); }
  it("T07-03 independent connections observe committed public read during suppression and empty read/count after commit", async () => {
    const project = await seed(), id = await approved(project), entered = barrier(), release = barrier();
    const first = createOwnerFeedbackModerationService({ ...base, repository: { ...repository, async decide(f,d,tx) {
      await repository.decide(f,d,tx); entered.release(); await release.promise;
    } } });
    const other = createOwnerFeedbackModerationService({ ...base, operations: createPostgresOperationsPersistence(second.database, base.clock) });
    const decision = first.suppressOwnerFeedback(suppress(id)); await entered.promise;
    try {
      expect(await other.getApprovedFeedback({ scope, portfolioId, projectId: project, locale: "en", correlationId: "during" })).toMatchObject({ ok: true, value: { items: [{ feedbackId: id }] } });
      expect(await publicCount(project)).toBe(1);
    } finally { release.release(); }
    expect((await decision).ok).toBe(true); expect(await query(project)).toEqual({ ok: true, value: { items: [], nextCursor: null } }); expect(await publicCount(project)).toBe(0);
  });
  it("T07-03 concurrent suppress/retry serializes to one state, two ordered decisions and one suppression fact", async () => {
    const id = await approved(await seed()), c = suppress(id), entered = barrier(), release = barrier();
    const first = createOwnerFeedbackModerationService({ ...base, repository: { ...repository, async decide(f,d,tx) {
      await repository.decide(f,d,tx); entered.release(); await release.promise;
    } } });
    const other = createOwnerFeedbackModerationService({ ...base, operations: createPostgresOperationsPersistence(second.database, base.clock) });
    const a = first.suppressOwnerFeedback(c); await entered.promise; const b = other.suppressOwnerFeedback(c);
    try { await waitForLock(); } finally { release.release(); }
    const results = await Promise.all([a,b]); expect(results[0].ok).toBe(true); expect(results[1]).toEqual(results[0]);
    expect((await snapshot(id))[0]).toMatchObject({ history: [{ decision: "approved" }, { decision: "suppressed" }], events: 3 });
  });
  it("T07-03 state/history/outbox/ledger/receipt injected failures roll back suppression and public eligibility completely", async () => {
    await admin.query("create function public.fail_suppression_test() returns trigger language plpgsql as $$ begin raise exception using errcode='P0001',message='PRIVATE_REASON_SENTINEL'; end $$");
    try {
      for (const [table, action] of [["interaction.moderation_decisions","insert"],["interaction.feedback","update"],["operations.outbox_events","insert"],["operations.idempotency_records","insert"],["operations.idempotency_records","update"]]) {
        const project = await seed(), id = await approved(project), before = await snapshot(id), logger = createTestLogger();
        await admin.query(`create trigger injected before ${action} on ${table} for each row execute function public.fail_suppression_test()`);
        try { const response = await suppressHttp(id, {}, { ...deps, logger }); expect(response.status).toBe(503);
          expect(await response.text()).not.toContain("PRIVATE_REASON_SENTINEL"); expect(JSON.stringify(logger.records)).not.toContain("PRIVATE_REASON_SENTINEL");
          expect(await snapshot(id)).toEqual(before); expect(await publicCount(project)).toBe(1); expect(await query(project)).toMatchObject({ ok: true, value: { items: [{ feedbackId: id }] } });
        } finally { await admin.query(`drop trigger injected on ${table}`); }
        expect((await suppressHttp(id)).status).toBe(200);
      }
    } finally { await admin.query("drop function public.fail_suppression_test()"); }
  });
  it("T07-04/T07-05 exact-locale pages expose only approved safe DTOs; private states and withdrawn locales are absent", async () => {
    const project = await seed(), en = await approved(project), ar = await approved(project,"ar"), pending = await submit(project), rejected = await submit(project), suppressed = await approved(project);
    expect((await service.rejectOwnerFeedback(cmd(rejected))).ok).toBe(true); expect((await service.suppressOwnerFeedback(suppress(suppressed))).ok).toBe(true);
    expect(await query(project)).toEqual({ ok: true, value: { items: [{ feedbackId: en, projectId: project, locale: "en", authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_PARAGRAPH_SENTINEL", displayedAt: now }], nextCursor: null } });
    expect(await query(project,"ar")).toMatchObject({ ok: true, value: { items: [{ feedbackId: ar, locale: "ar" }] } });
    const visible = JSON.stringify(await query(project)); for (const hidden of [pending,rejected,suppressed,"reason","state","history","ownerId","subject","provider"] ) expect(visible).not.toContain(hidden);
    await admin.query("delete from content.language_publications where content_id=$1 and locale='ar'",[project]); expect(await query(project,"ar")).toMatchObject({ ok: false, error: { kind: "not_found" } });
    for (const state of ["hidden","archived"]) { await admin.query("update content.items set lifecycle=$2 where content_id=$1",[project,state]); expect(await query(project)).toMatchObject({ ok:false,error:{kind:"not_found"} }); }
    expect(await query(await seed())).toEqual({ ok:true,value:{items:[],nextCursor:null} });
  });
  it("T07-06 default/max pages and tied times paginate by stable descending IDs without duplicates", async () => {
    const project = await seed(), ids: StableId<"Feedback">[] = [];
    for (let i=0;i<103;i++) ids.push(await approved(project));
    const page = (extra: object = {}) => service.getApprovedFeedback({ scope, portfolioId, projectId: project, locale: "en", correlationId: "pages", ...extra });
    const first = await page(); expect(first.ok).toBe(true); if (!first.ok) throw new Error("PAGE_FAILED"); expect(first.value.items).toHaveLength(25);
    const all: string[] = [], sorted = [...ids].sort().reverse(); let cursor = first.value.nextCursor;
    all.push(...first.value.items.map(i=>i.feedbackId));
    while (cursor) { const next = await page({ cursor }); expect(next.ok).toBe(true); if (!next.ok) throw new Error("PAGE_FAILED"); all.push(...next.value.items.map(i=>i.feedbackId)); cursor=next.value.nextCursor; }
    expect(all).toEqual(sorted); expect(new Set(all).size).toBe(103);
    const max=await page({limit:100}); expect(max.ok).toBe(true); if(!max.ok)throw new Error("PAGE_FAILED"); expect(max.value.items).toHaveLength(100);
    expect(await page({limit:100,cursor:max.value.nextCursor})).toMatchObject({ok:true,value:{items:sorted.slice(100).map(feedbackId=>({feedbackId})),nextCursor:null}});
    for (const limit of [0,-1,1.5,101,NaN]) expect(await page({limit})).toMatchObject({ok:false,error:{kind:"validation"}});
  });
  it("T07-06 invalid cursor rejects and timestamp ordering preserves database microseconds", async () => {
    const project=await seed(), a=await approved(project), b=await approved(project), c=await approved(project);
    await admin.query("update interaction.feedback set approved_at=$2 where feedback_id=$1",[a,"2099-10-15T00:00:00.123456Z"]);
    await admin.query("update interaction.feedback set approved_at=$2 where feedback_id=$1",[b,"2099-10-15T00:00:00.123455Z"]);
    const page=(extra:object={})=>service.getApprovedFeedback({scope,portfolioId,projectId:project,locale:"en",correlationId:"cursor",limit:1,...extra});
    const first=await page();expect(first).toMatchObject({ok:true,value:{items:[{feedbackId:a,displayedAt:"2099-10-15T00:00:00.123456Z"}]}});if(!first.ok)throw new Error("PAGE_FAILED");
    const next=await page({cursor:first.value.nextCursor});expect(next).toMatchObject({ok:true,value:{items:[{feedbackId:b}]}});if(!next.ok)throw new Error("PAGE_FAILED");
    expect(await page({cursor:next.value.nextCursor})).toMatchObject({ok:true,value:{items:[{feedbackId:c}],nextCursor:null}});
    for(const cursor of [null,{}, {displayedAt:now,feedbackId:"bad"},{displayedAt:"2026-02-30T00:00:00.000Z",feedbackId:a},{displayedAt:"not-a-time",feedbackId:a},{displayedAt:now,feedbackId:a,extra:"secret"}])
      expect(await page({cursor})).toMatchObject({ok:false,error:{kind:"validation"}});
  });
  it("T07-05 safe suppression receipts/logs/facts omit all text/reasons/subjects and public RLS denies suppressed history", async () => {
    const project=await seed(),id=await approved(project),logger=createTestLogger();const response=await suppressHttp(id,{}, {...deps,logger});expect(response.status).toBe(200);
    const safe=JSON.stringify([await response.json(),logger.records,(await admin.query("select * from operations.outbox_events")).rows,(await admin.query("select * from operations.idempotency_records")).rows]);
    for(const sentinel of ["PRIVATE_NAME_SENTINEL","PRIVATE_PARAGRAPH_SENTINEL","PRIVATE_REASON_SENTINEL","owner-subject",actor.sessionId,secret])expect(safe).not.toContain(sentinel);
    expect(await publicCount(project)).toBe(0);expect((await inspect(id)).ok).toBe(true);
    const client=new Client({connectionString:url});await client.connect();try{await client.query("begin");await client.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.feedback_access','public',true)",[portfolioId]);
      expect((await client.query("select * from interaction.moderation_decisions where feedback_id=$1",[id])).rows).toEqual([]);
    }finally{await client.query("rollback");await client.end();}
  });
  it("T07-06 representative restricted keyset plan uses bounded partial index", async () => {
    const project=await seed();
    // Auxiliary plan fixtures model a mature approved stream without running workers.
    const ids=Array.from({length:5000},()=>createStableId("Feedback"));
    await admin.query("insert into interaction.feedback(feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at,approved_at) select id,$2,$3,'en','Plan','Plan','approved',2,$4,$4 from unnest($1::uuid[]) id",[ids,portfolioId,project,now]);
    await admin.query("analyze interaction.feedback");const client=new Client({connectionString:url});await client.connect();
    try {await client.query("begin");await client.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true),set_config('shipwithali.feedback_access','public',true)",[portfolioId,ownerId]);
      const plan=(await client.query("explain (analyze,buffers,format json) select feedback_id,project_id,locale,author_name,paragraph,approved_at from interaction.feedback where portfolio_id=$1 and project_id=$2 and locale='en' and moderation_state='approved' and (approved_at,feedback_id)<($3::timestamptz,$4::uuid) order by approved_at desc,feedback_id desc limit 26",[portfolioId,project,now,"ffffffff-ffff-7fff-bfff-ffffffffffff"])).rows[0]["QUERY PLAN"][0];
      expect(JSON.stringify(plan)).toContain("feedback_approved_locale");expect(plan.Plan["Node Type"]).toBe("Limit");expect(plan.Plan["Actual Rows"]).toBe(26);
      function safePlan(node: Record<string,unknown>): object {
        return Object.fromEntries(Object.entries(node).filter(([field])=>[
          "Node Type","Index Name","Actual Rows","Actual Loops","Plan Rows","Startup Cost","Total Cost",
          "Shared Hit Blocks","Shared Read Blocks","Rows Removed by Filter",
        ].includes(field)).concat([["children", (Array.isArray(node["Plans"]) ? node["Plans"] : []).map(safePlan)]]));
      }
      const {writeFileSync}=await import("node:fs");writeFileSync("artifacts/suppression-query-plan.json",JSON.stringify({boundedRows:plan.Plan["Actual Rows"],partialIndex:"feedback_approved_locale",restrictedRls:true,approvedPlanFixtures:5000,naturalPlanner:true,plan:safePlan(plan.Plan)},null,2));
    }finally{await client.query("rollback");await client.end();}
  });
  it("standard runtime existing HTTP suppression and in-process pages use real persistence with Measurement/worker absent", async () => {
    const project=await seed(),id=await submit(project);resetRuntimeForTests();await initializeDatabaseRuntime({NODE_ENV:"test",APP_BASE_URL:"https://example.com",DATABASE_URL:url!,PORTFOLIO_ID:portfolioId,OWNER_ID:ownerId},"application");
    const assembled=await getOwnerModerationRuntimeServices();expect((await approveHttp(id,{}, {...assembled,security:deps.security})).status).toBe(200);
    expect((await suppressHttp(id,{}, {...assembled,security:deps.security})).status).toBe(200);
    expect(await getApprovedFeedbackApplicationService().getApprovedFeedback({scope,portfolioId,projectId:project,locale:"en",correlationId:"assembled"})).toEqual({ok:true,value:{items:[],nextCursor:null}});
    await getLifecycleCoordinator().shutdown();expect(await assembled.service.suppressOwnerFeedback(suppress(id))).toMatchObject({ok:false,error:{kind:"temporarily_unavailable"}});resetRuntimeForTests();
  });
});
