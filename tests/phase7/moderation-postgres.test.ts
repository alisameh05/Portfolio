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
import { handleGetOwnerFeedbackModeration, handleApproveOwnerFeedback, handleRejectOwnerFeedback } from "../../src/runtime/http/owner-moderation.js";
import type { OwnerModerationAdapterDeps } from "../../src/runtime/http/owner-moderation.js";
import { initializeDatabaseRuntime, getOwnerModerationRuntimeServices, getApprovedFeedbackApplicationService, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
const url = process.env["PHASE7_MODERATION_DATABASE_URL"];
describe.runIf(Boolean(url))("real PostgreSQL Owner moderation acceptance", () => {
  const portfolioId = createStableId("Portfolio"), ownerId = createStableId("Owner");
  const scope = { kind: "portfolio" as const, portfolioId }, now = "2026-10-15T00:00:00.000Z";
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

  it("T06-01 authorized inspection is private versioned/ordered; missing, non-Owner and foreign scope deny", async () => {
    const id = await submit(await seed());
    expect(await inspect(id)).toMatchObject({ ok: true, value: { aggregateVersion: 1, state: "pending", authorName: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_PARAGRAPH_SENTINEL", decisionHistory: [] } });
    for (const denied of [{ actor: { kind: "visitor", consent: "unknown" } }, { actor: { ...actor, ownerId: createStableId("Owner") } }, { scope: { kind: "portfolio", portfolioId: createStableId("Portfolio") } }, { actor: { ...actor, sessionId: "" } }]) {
      expect(await service.getOwnerFeedbackModeration({ scope,actor,feedbackId:id,correlationId:"denied",...denied } as never)).toMatchObject({ ok:false,error:{kind:"forbidden"} });
    }
    expect(await inspect(createStableId("Feedback"))).toMatchObject({ ok:false,error:{kind:"not_found"} });
    const response = await handleGetOwnerFeedbackModeration(request(), {feedbackId:id}, deps);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
  it("T06-01 actual signed Owner Auth rejects missing/tampered/expired/nonallowlisted/revoked before inspection or replay", async () => {
    const id=await submit(await seed());
    for (const token of ["",sign().slice(0,-3)+"xxx",sign("owner-subject",1792022400),sign("foreign-subject")]) {
      expect([401,403]).toContain((await handleGetOwnerFeedbackModeration(request(undefined,{cookie:token ? "sw_owner_session="+token : ""}),{feedbackId:id},deps)).status);
    }
    const k=key(); expect((await approveHttp(id,{"Idempotency-Key":k})).status).toBe(200);
    const before=await snapshot(id); permitted=false;
    try { expect((await approveHttp(id,{"Idempotency-Key":k})).status).toBe(403); } finally { permitted=true; }
    revoked=true; try { expect((await approveHttp(id,{"Idempotency-Key":k})).status).toBe(401); } finally { revoked=false; }
    expect(await snapshot(id)).toEqual(before);
  });
  it("T06-02 approval appends stable ordered Owner decision, advances once and displays only approved submitted locale",async()=>{
    const project=await seed(),id=await submit(project,"ar");
    expect(await query(project,"ar")).toEqual({ok:true,value:{items:[],nextCursor:null}});
    expect(await service.approveOwnerFeedback(cmd(id))).toMatchObject({ok:true,value:{aggregateId:id,aggregateVersion:2,outcome:"feedback-approved"}});
    expect(await inspect(id)).toMatchObject({ok:true,value:{aggregateVersion:2,state:"approved",decisionHistory:[{decision:"approved",reason:"PRIVATE_REASON_SENTINEL",decidedAt:now}]}});
    expect(await query(project,"en")).toEqual({ok:true,value:{items:[],nextCursor:null}});
    expect(await query(project,"ar")).toEqual({ok:true,value:{items:[{feedbackId:id,projectId:project,locale:"ar",authorName:"PRIVATE_NAME_SENTINEL",paragraph:"PRIVATE_PARAGRAPH_SENTINEL",displayedAt:now}],nextCursor:null}});
    const history=(await admin.query("select * from interaction.moderation_decisions where feedback_id=$1",[id])).rows;
    expect(history).toHaveLength(1);expect(history[0]).toMatchObject({sequence:"1",owner_id:ownerId,decision:"approved"});expect(history[0].decision_id).toMatch(/-7[0-9a-f]{3}-/);
    await admin.query("delete from content.language_publications where content_id=$1 and locale='ar'",[project]);
    expect(await query(project,"ar")).toMatchObject({ok:false,error:{kind:"not_found"}});
  });
  it("T06-03 rejection retains private reason/history and never enters approved query/count",async()=>{
    const project=await seed(),id=await submit(project);expect((await service.rejectOwnerFeedback(cmd(id))).ok).toBe(true);
    expect(await inspect(id)).toMatchObject({ok:true,value:{aggregateVersion:2,state:"rejected",decisionHistory:[{decision:"rejected",reason:"PRIVATE_REASON_SENTINEL"}]}});
    expect(await query(project)).toEqual({ok:true,value:{items:[],nextCursor:null}});
    expect((await admin.query("select count(*)::int n from interaction.feedback where project_id=$1 and moderation_state='approved'",[project])).rows[0].n).toBe(0);
  });
  it("T06-04 Hidden/Archived moderation succeeds privately and changes no Content fact; restored approval remains exact locale",async()=>{
    for(const state of ["hidden","archived"]) {
      const project=await seed(),id=await submit(project);
      await admin.query("update content.items set lifecycle=$2 where content_id=$1",[project,state]);
      const before=(await admin.query("select * from content.items where content_id=$1",[project])).rows;
      expect((await service.approveOwnerFeedback(cmd(id))).ok).toBe(true);expect((await inspect(id)).ok).toBe(true);
      expect(await query(project)).toMatchObject({ok:false,error:{kind:"not_found"}});
      expect((await admin.query("select * from content.items where content_id=$1",[project])).rows).toEqual(before);
      await admin.query("update content.items set lifecycle='published' where content_id=$1",[project]);
      expect(await query(project)).toMatchObject({ok:true,value:{items:[{feedbackId:id}]}});
      expect(await query(project,"ar")).toEqual({ok:true,value:{items:[],nextCursor:null}});
    }
  });
  it("T06-05 exact replay survives later version; changed payload/terminal new key conflict and stale HTTP is 412",async()=>{
    const id=await submit(await seed()),c=cmd(id),r=await service.approveOwnerFeedback(c);expect(r.ok).toBe(true);
    // Seed a retained later decision solely to verify history/replay across future suppression.
    await admin.query("insert into interaction.moderation_decisions (decision_id,portfolio_id,feedback_id,sequence,decision,reason,owner_id,decided_at) values ($1,$2,$3,2,'suppressed','Later private reason',$4,$5)",[createStableId("ModerationDecision"),portfolioId,id,ownerId,now]);
    await admin.query("update interaction.feedback set moderation_state='suppressed',aggregate_version=3 where feedback_id=$1",[id]);
    expect(await inspect(id)).toMatchObject({ok:true,value:{state:"suppressed",aggregateVersion:3,decisionHistory:[{decision:"approved"},{decision:"suppressed"}]}});
    const before=await snapshot(id);expect(await service.approveOwnerFeedback(c)).toEqual(r);
    expect(await service.approveOwnerFeedback({...c,reason:"changed"})).toMatchObject({ok:false,error:{kind:"conflict"}});
    expect(await service.approveOwnerFeedback({...c,expectedVersion:3})).toMatchObject({ok:false,error:{kind:"conflict"}});
    expect(await service.approveOwnerFeedback({...c,idempotencyKey:key(),expectedVersion:3})).toMatchObject({ok:false,error:{kind:"conflict"}});
    expect(await service.rejectOwnerFeedback({...c,idempotencyKey:key(),expectedVersion:3})).toMatchObject({ok:false,error:{kind:"conflict"}});
    expect((await approveHttp(id)).status).toBe(412);expect(await snapshot(id)).toEqual(before);
    const forbidden=createOwnerFeedbackModerationService({...base,authorize:async()=>({ok:false,error:{kind:"forbidden",code:"REVOKED"}})});
    expect(await forbidden.approveOwnerFeedback(c)).toMatchObject({ok:false,error:{kind:"forbidden"}});expect(await snapshot(id)).toEqual(before);
  });
  it("invalid private reasons/version/key reject without partial history or leaked payload",async()=>{
    const id=await submit(await seed()),before=await snapshot(id),c=cmd(id);
    for(const reason of [" ","x".repeat(501),"bad\u0000","bad\u202e"])expect(await service.approveOwnerFeedback({...c,reason})).toMatchObject({ok:false,error:{kind:"validation"}});
    for(const expectedVersion of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])expect(await service.rejectOwnerFeedback({...c,expectedVersion})).toMatchObject({ok:false,error:{kind:"validation"}});
    expect(await snapshot(id)).toEqual(before);
    expect((await service.approveOwnerFeedback({...c,reason:"x".repeat(500)})).ok).toBe(true);
  });
  function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r});return{promise,release};}
  async function waitForLock(){const until=Date.now()+3000;while(Date.now()<until)if((await admin.query("select 1 from pg_stat_activity where usename='moderation_runtime' and wait_event_type='Lock'")).rowCount)return;throw new Error("NO_DATABASE_LOCK_OBSERVED");}
  it("T06-06 independent pools serialize approve/reject and exact-retry races to one decision/state/fact",async()=>{
    const other=createOwnerFeedbackModerationService({...base,operations:createPostgresOperationsPersistence(second.database,{now:()=>now})});
    for(const same of [false,true]){
      const id=await submit(await seed()),c=cmd(id),entered=barrier(),release=barrier();
      const first=createOwnerFeedbackModerationService({...base,repository:{...repository,async decide(f,d,tx){await repository.decide(f,d,tx);entered.release();await release.promise;}}});
      const a=first.approveOwnerFeedback(c);await entered.promise;
      const b=same?other.approveOwnerFeedback(c):other.rejectOwnerFeedback({...c,idempotencyKey:key()});
      try{await waitForLock();}finally{release.release();}
      const results=await Promise.all([a,b]);expect(results.filter(r=>r.ok)).toHaveLength(same?2:1);if(same)expect(results[0]).toEqual(results[1]);else expect(results[1]).toMatchObject({ok:false,error:{kind:"precondition_failed"}});
      expect(await inspect(id)).toMatchObject({ok:true,value:{aggregateVersion:2,state:"approved",decisionHistory:[{decision:"approved"}]}});
      expect((await snapshot(id))[0]).toMatchObject({history:[{decision:"approved"}],events:2});
    }
  });
  it("inspection waits for a concurrent decision and cannot combine old state with new history",async()=>{
    const id=await submit(await seed()),entered=barrier(),release=barrier();
    const first=createOwnerFeedbackModerationService({...base,repository:{...repository,async decide(f,d,tx){await repository.decide(f,d,tx);entered.release();await release.promise;}}});
    const other=createOwnerFeedbackModerationService({...base,operations:createPostgresOperationsPersistence(second.database,{now:()=>now})});
    const decision=first.rejectOwnerFeedback(cmd(id));await entered.promise;
    const inspection=other.getOwnerFeedbackModeration({scope,actor,feedbackId:id,correlationId:"concurrent-inspect"});
    try{await waitForLock();}finally{release.release();}
    expect((await decision).ok).toBe(true);expect(await inspection).toMatchObject({ok:true,value:{state:"rejected",aggregateVersion:2,decisionHistory:[{decision:"rejected"}]}});
  });
  it("T06-07 decision/projection/outbox/ledger/receipt failures fully roll back eligibility, state, history and version",async()=>{
    await admin.query("create function public.fail_moderation_test() returns trigger language plpgsql as $$ begin raise exception using errcode='P0001',message='PRIVATE_REASON_SENTINEL'; end $$");
    for(const [table,action] of [["interaction.moderation_decisions","insert"],["interaction.feedback","update"],["operations.outbox_events","insert"],["operations.idempotency_records","insert"],["operations.idempotency_records","update"]]){
      const project=await seed(),id=await submit(project),before=await snapshot(id),logger=createTestLogger();
      await admin.query(`create trigger injected before ${action} on ${table} for each row execute function public.fail_moderation_test()`);
      try{const response=await approveHttp(id,{}, {...deps,logger});expect(response.status).toBe(503);expect(await response.text()).not.toContain("PRIVATE_REASON_SENTINEL");expect(JSON.stringify(logger.records)).not.toContain("PRIVATE_REASON_SENTINEL");expect(await snapshot(id)).toEqual(before);expect(await query(project)).toEqual({ok:true,value:{items:[],nextCursor:null}});}
      finally{await admin.query(`drop trigger injected on ${table}`);}
      expect((await approveHttp(id)).status).toBe(200);
    }
    await admin.query("drop function public.fail_moderation_test()");
  });
  it("T06-08 logs/outbox/ledger/ordinary receipt exclude private name/text/reason and raw session/subject; public query includes only approved display fields",async()=>{
    const project=await seed(),id=await submit(project),logger=createTestLogger();
    const response=await approveHttp(id,{}, {...deps,logger});expect(response.status).toBe(200);
    const safe=JSON.stringify([await response.json(),logger.records,(await admin.query("select * from operations.outbox_events")).rows,(await admin.query("select * from operations.idempotency_records")).rows]);
    for(const sentinel of ["PRIVATE_NAME_SENTINEL","PRIVATE_PARAGRAPH_SENTINEL","PRIVATE_REASON_SENTINEL","owner-subject",actor.sessionId,secret])expect(safe).not.toContain(sentinel);
    const publicView=await query(project);expect(publicView.ok).toBe(true);expect(JSON.stringify(publicView)).not.toContain("PRIVATE_REASON_SENTINEL");expect(JSON.stringify(publicView)).not.toContain("decisionHistory");expect(JSON.stringify(publicView)).not.toContain("ownerId");
  });
  it("existing HTTP enforces origin/CSRF/abuse/quoted positive precondition and sanitized error responses",async()=>{
    const id=await submit(await seed()),before=await snapshot(id);
    for(const headers of [{origin:"https://evil.example"},{"x-csrf-token":""},{"If-Match":"1"},{"If-Match":'"0"'},{"Idempotency-Key":""}])expect([400,403]).toContain((await approveHttp(id,headers)).status);
    const blocked=await approveHttp(id,{}, {...deps,security:{...deps.security,rateLimit:{check:async()=>({allowed:false,retryAfterSeconds:19})}}});expect(blocked.status).toBe(429);expect(blocked.headers.get("retry-after")).toBe("19");expect(await snapshot(id)).toEqual(before);
    expect((await handleRejectOwnerFeedback(request({reason:"PRIVATE_REASON_SENTINEL"}),{feedbackId:id},deps)).status).toBe(200);
  });
  it("restricted RLS denies anonymous/worker/non-Owner/foreign scope and public pending/history; history cannot be edited; pool scope resets",async()=>{
    const id=await submit(await seed());const c=new Client({connectionString:url});await c.connect();
    try{
      expect((await c.query("select rolsuper,rolbypassrls from pg_roles where rolname=current_user")).rows).toEqual([{rolsuper:false,rolbypassrls:false}]);
      expect((await c.query("select * from interaction.feedback")).rows).toEqual([]);
      await c.query("begin");await c.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true),set_config('shipwithali.feedback_access','owner',true)",[portfolioId,createStableId("Owner")]);
      expect((await c.query("select * from interaction.feedback where feedback_id=$1",[id])).rows).toEqual([]);
      expect((await c.query("update interaction.feedback set moderation_state='approved' where feedback_id=$1",[id])).rowCount).toBe(0);
      await c.query("select set_config('shipwithali.owner_id',$1,true)",[ownerId]);expect((await c.query("select feedback_id from interaction.feedback where feedback_id=$1",[id])).rowCount).toBe(1);
      await c.query("select set_config('shipwithali.portfolio_id',$1,true)",[createStableId("Portfolio")]);expect((await c.query("select * from interaction.feedback")).rows).toEqual([]);
      await c.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.feedback_access','public',true)",[portfolioId]);expect((await c.query("select * from interaction.feedback where feedback_id=$1",[id])).rows).toEqual([]);expect((await c.query("select * from interaction.moderation_decisions")).rows).toEqual([]);
      await c.query("rollback");expect((await c.query("select * from interaction.feedback")).rows).toEqual([]);
      for(const table of ["interaction.feedback","interaction.moderation_decisions"]){
        for(const role of ["anon","authenticated","shipwithali_worker","shipwithali_backup"])for(const privilege of ["SELECT","INSERT","UPDATE","DELETE"])expect((await admin.query("select has_table_privilege($1,$2,$3) allowed",[role,table,privilege])).rows[0].allowed).toBe(false);
        expect((await admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass",[table])).rows).toEqual([{relrowsecurity:true,relforcerowsecurity:true}]);
      }
      for(const column of ["moderation_state","aggregate_version","approved_at"])expect((await admin.query("select has_column_privilege('moderation_runtime','interaction.feedback',$1,'UPDATE') allowed",[column])).rows[0].allowed).toBe(true);
      for(const column of ["paragraph","author_name","portfolio_id","project_id"])expect((await admin.query("select has_column_privilege('moderation_runtime','interaction.feedback',$1,'UPDATE') allowed",[column])).rows[0].allowed).toBe(false);
      await expect(c.query("update interaction.moderation_decisions set reason='bad'")).rejects.toMatchObject({code:"42501"});await expect(c.query("delete from interaction.feedback")).rejects.toMatchObject({code:"42501"});await expect(c.query("update interaction.feedback set paragraph='bad'")).rejects.toMatchObject({code:"42501"});
    }finally{await c.end();}
  });
  it("standard runtime assembles real moderation and approved query; closed DB fails safely without optional Measurement",async()=>{
    const project=await seed(),id=await submit(project);resetRuntimeForTests();
    await initializeDatabaseRuntime({NODE_ENV:"test",APP_BASE_URL:"https://example.com",DATABASE_URL:url!,PORTFOLIO_ID:portfolioId,OWNER_ID:ownerId},"application");
    const assembled=await getOwnerModerationRuntimeServices();expect("scope" in assembled).toBe(true);
    expect((await approveHttp(id,{}, {...assembled,security:deps.security})).status).toBe(200);
    expect(await getApprovedFeedbackApplicationService().getApprovedFeedback({scope,portfolioId,projectId:project,locale:"en",limit:25,correlationId:"assembled"})).toMatchObject({ok:true,value:{items:[{feedbackId:id}]}});
    await getLifecycleCoordinator().shutdown();expect(await assembled.service.getOwnerFeedbackModeration({scope,actor,feedbackId:id,correlationId:"closed"})).toMatchObject({ok:false,error:{kind:"temporarily_unavailable"}});resetRuntimeForTests();
  });
});
