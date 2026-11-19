import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import {
  zApproveOwnerFeedbackResponse,
  zGetOwnerFeedbackModerationResponse,
  zProblem,
  zRejectOwnerFeedbackResponse,
  zSuppressOwnerFeedbackResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { zPostProjectFeedbackResponse } from "../../src/contracts/http/v1/generated/zod.gen.js";
import { createPostgresProjectInteractionFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createOwnerFeedbackModerationService } from "../../src/modules/interaction-moderation/index.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createSystemClock, createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, type StableId } from "../../src/shared/domain/index.js";

const enabled = process.env["PHASE9_REQUIRE_OWNER_HTTP"] === "1";
const suite = enabled ? describe : describe.skip;
const adminUrl = process.env["PHASE9_MODERATION_HTTP_ADMIN_DATABASE_URL"];
const appUrl = process.env["PHASE9_OWNER_HTTP_DATABASE_URL"];
const apiUrl = process.env["PHASE9_OWNER_HTTP_SUPABASE_URL"];
const anonKey = process.env["PHASE9_OWNER_HTTP_ANON_KEY"];
const serviceKey = process.env["PHASE9_OWNER_HTTP_SERVICE_KEY"];
const ownerId = process.env["OWNER_ID"];
const portfolioId = process.env["PORTFOLIO_ID"];
const urls = JSON.parse(process.env["PHASE9_MODERATION_HTTP_URLS"] ?? "[]") as string[];
const githubSubject = "910306";
const privateName = "PRIVATE_MODERATION_NAME_SENTINEL_306";
const privateParagraph = "PRIVATE_MODERATION_PARAGRAPH_SENTINEL_306";
const privateReason = "PRIVATE_MODERATION_REASON_SENTINEL_306";
const admin = new Client({ connectionString: adminUrl });
const projectionDatabase = createPostgresRuntimeDatabase(appUrl ?? "postgres://invalid");
const projectionScope = { portfolioId: portfolioId as StableId<"Portfolio">, ownerId: ownerId as StableId<"Owner"> };
const moderation = createOwnerFeedbackModerationService({
  scope: projectionScope,
  authorize: async (query) => decideAuthorization(query),
  operations: createPostgresOperationsPersistence(projectionDatabase.database),
  content: createPostgresProjectInteractionFacts(projectionScope),
  repository: createPostgresModerationRepository(),
  clock: createSystemClock(),
  ids: createSystemIdGenerator(),
});

type Login = { readonly userId: string; readonly token: string; readonly sessionId: string };
let owner: Login;
let nonOwner: Login;
let csrf = `phase9-moderation-csrf-${randomUUID()}`;
let adminConnected = false;

function fetchBuilt(input: string, init?: RequestInit): Promise<Response> {
  if (!urls.some((url) => input.startsWith(`${url}/`))) return globalThis.fetch(input, init);
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", new URL(urls[0]!).host);
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

function privateHeaders(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
}

async function createOwnerLogin(email: string, subject = githubSubject): Promise<Login> {
  const createdResponse = await fetch(`${apiUrl}/auth/v1/admin/users`, { method: "POST", headers: {
    apikey: serviceKey!, authorization: `Bearer ${serviceKey!}`, "content-type": "application/json",
  }, body: JSON.stringify({ email, email_confirm: true }), signal: AbortSignal.timeout(10_000) });
  if (!createdResponse.ok) throw new Error("PHASE9_MODERATION_OWNER_CREATE_FAILED");
  const created = await createdResponse.json() as { id?: string };
  if (!created.id) throw new Error("PHASE9_MODERATION_OWNER_ID_MISSING");
  const linkResponse = await fetch(`${apiUrl}/auth/v1/admin/generate_link`, { method: "POST", headers: {
    apikey: serviceKey!, authorization: `Bearer ${serviceKey!}`, "content-type": "application/json",
  }, body: JSON.stringify({ type: "magiclink", email }), signal: AbortSignal.timeout(10_000) });
  if (!linkResponse.ok) throw new Error("PHASE9_MODERATION_LINK_CREATE_FAILED");
  const link = await linkResponse.json() as { hashed_token?: string };
  if (!link.hashed_token) throw new Error("PHASE9_MODERATION_LINK_TOKEN_MISSING");
  const sessionResponse = await fetch(`${apiUrl}/auth/v1/verify`, { method: "POST", headers: {
    apikey: anonKey!, "content-type": "application/json",
  }, body: JSON.stringify({ type: "magiclink", token_hash: link.hashed_token }), signal: AbortSignal.timeout(10_000) });
  if (!sessionResponse.ok) throw new Error("PHASE9_MODERATION_SESSION_CREATE_FAILED");
  const session = await sessionResponse.json() as { access_token?: string; user?: { id?: string } };
  if (!session.access_token || session.user?.id !== created.id) throw new Error("PHASE9_MODERATION_SESSION_INVALID");
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1]!, "base64url").toString("utf8")) as { session_id?: string };
  if (!claims.session_id) throw new Error("PHASE9_MODERATION_SESSION_ID_MISSING");
  await admin.query("insert into auth.identities (user_id, identity_data, provider, provider_id) values ($1::uuid, $2::jsonb, 'github', $3)",
    [created.id, JSON.stringify({ sub: subject, provider_id: subject }), subject]);
  await admin.query("insert into identity_access.owner_links (github_subject, owner_id) values ($1, $2::uuid)", [subject, ownerId]);
  return { userId: created.id, token: session.access_token, sessionId: claims.session_id };
}

async function seedPublishedProject(): Promise<StableId<"Project">> {
  const projectId = createStableId("Project");
  const routeId = createStableId("PublicRoute");
  const revisionId = createStableId("Revision");
  const reviewId = createStableId("ContentReview");
  const now = new Date().toISOString();
  const payload = { contentType: "project", locale: "en", title: "Moderation fixture", summary: "Safe summary", body: "Safe body" };
  await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project','published')", [projectId, portfolioId]);
  await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)",
    [routeId, projectId, portfolioId, `moderation-${projectId}`, now]);
  await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project','en',1,1,'Moderation fixture','Safe summary','Safe body',$4,$5)",
    [revisionId, projectId, portfolioId, payload, now]);
  await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,'en',1,$5,1,$6,'accepted',$7)",
    [reviewId, projectId, portfolioId, revisionId, "a".repeat(64), ownerId, now]);
  await admin.query("insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project','en',$3,$4,$5,1,$6)",
    [projectId, portfolioId, revisionId, reviewId, routeId, now]);
  return projectId;
}

async function seedForeignFeedback(): Promise<StableId<"Feedback">> {
  const foreignPortfolioId = createStableId("Portfolio");
  const foreignProjectId = createStableId("Project");
  const feedbackId = createStableId("Feedback");
  await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Foreign','Headline','Bio','Contact','https://example.com','Unavailable')", [foreignPortfolioId, createStableId("Owner")]);
  await admin.query("insert into interaction.feedback (feedback_id,portfolio_id,project_id,locale,author_name,paragraph,moderation_state,aggregate_version,submitted_at) values ($1,$2,$3,'en','Foreign name','Foreign private paragraph','pending',1,clock_timestamp())", [feedbackId, foreignPortfolioId, foreignProjectId]);
  return feedbackId;
}

async function submit(projectId: StableId<"Project">): Promise<StableId<"Feedback">> {
  const response = await fetchBuilt(`${urls[0]}/api/v1/projects/${projectId}/feedback`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": createStableId("Key") },
    body: JSON.stringify({ name: privateName, paragraph: privateParagraph, locale: "en" }),
  });
  expect(response.status).toBe(201);
  const body: unknown = await response.json();
  expect(zPostProjectFeedbackResponse.safeParse(body).success).toBe(true);
  return (body as { feedbackId: StableId<"Feedback"> }).feedbackId;
}

function ownerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { host: new URL(urls[0]!).host, cookie: `sw_owner_session=${owner.token}`, origin: new URL(urls[0]!).origin,
    "x-csrf-token": csrf, ...extra };
}

async function command(operation: "approve" | "reject" | "suppress", feedbackId: StableId<"Feedback">, version: number, key = createStableId("Key"), server = 0, reason = privateReason): Promise<Response> {
  return fetchBuilt(`${urls[server]}/api/owner/v1/feedback/${feedbackId}/commands/${operation}`, {
    method: "POST", headers: ownerHeaders({ "content-type": "application/json", "idempotency-key": key, "if-match": `"${version}"` }),
    body: JSON.stringify({ reason }), signal: AbortSignal.timeout(15_000),
  });
}

async function inspect(feedbackId: StableId<"Feedback">, server = 0): Promise<Response> {
  return fetchBuilt(`${urls[server]}/api/owner/v1/feedback/${feedbackId}`, {
    headers: ownerHeaders(), signal: AbortSignal.timeout(15_000),
  });
}

async function publicItems(projectId: StableId<"Project">) {
  const result = await moderation.getApprovedFeedback({
    scope: { kind: "portfolio", portfolioId: projectionScope.portfolioId },
    portfolioId: projectionScope.portfolioId, projectId, locale: "en", correlationId: "moderation-http-projection",
  });
  if (!result.ok) throw new Error("PHASE9_MODERATION_PUBLIC_PROJECTION_FAILED");
  return result.value;
}

suite("Phase 9 #306 production-built Owner Feedback Moderation HTTP acceptance", () => {
  beforeAll(async () => {
    if (!adminUrl || !appUrl || !apiUrl || !anonKey || !serviceKey || !ownerId || !portfolioId || urls.length !== 2) {
      throw new Error("PHASE9_MODERATION_HTTP_ENV_REQUIRED");
    }
    await admin.connect();
    adminConnected = true;
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable') on conflict (portfolio_id) do nothing", [portfolioId, ownerId]);
    owner = await createOwnerLogin(`phase9-moderation-${randomUUID()}@example.test`);
    nonOwner = await createOwnerLogin(`phase9-moderation-unlisted-${randomUUID()}@example.test`, "910307");
  }, 60_000);

  afterAll(async () => {
    if (adminConnected) await admin.end();
    await projectionDatabase.resource.close();
  });

  it("AC01-04 exposes private moderation, public eligibility, exact replay and suppression through built HTTP", async () => {
    const projectId = await seedPublishedProject();
    const approvedId = await submit(projectId);
    const pendingView = await inspect(approvedId);
    expect(pendingView.status).toBe(200);
    privateHeaders(pendingView);
    const pending = await pendingView.json();
    expect(zGetOwnerFeedbackModerationResponse.safeParse(pending).success).toBe(true);
    expect(pending).toMatchObject({ feedbackId: approvedId, aggregateVersion: 1, state: "pending", authorName: privateName, paragraph: privateParagraph, decisionHistory: [] });
    expect((await publicItems(projectId)).items).toEqual([]);

    const approveKey = createStableId("Key");
    const [approved, approvedConcurrent] = await Promise.all([
      command("approve", approvedId, 1, approveKey, 0),
      command("approve", approvedId, 1, approveKey, 1),
    ]);
    expect(approved.status).toBe(200);
    expect(approvedConcurrent.status).toBe(200);
    privateHeaders(approved);
    privateHeaders(approvedConcurrent);
    const approvedReceipt = await approved.json();
    const concurrentReceipt = await approvedConcurrent.json();
    expect(zApproveOwnerFeedbackResponse.safeParse(approvedReceipt).success).toBe(true);
    expect(zApproveOwnerFeedbackResponse.safeParse(concurrentReceipt).success).toBe(true);
    expect(concurrentReceipt).toEqual(approvedReceipt);
    expect(approvedReceipt).toMatchObject({ aggregateId: approvedId, aggregateVersion: 2, outcome: "feedback-approved" });
    const approvalReplay = await command("approve", approvedId, 1, approveKey, 1);
    expect(approvalReplay.status).toBe(200);
    privateHeaders(approvalReplay);
    expect(await approvalReplay.json()).toEqual(approvedReceipt);
    const changedReplay = await command("approve", approvedId, 1, approveKey, 1, "Changed reason");
    expect(changedReplay.status).toBe(409);
    privateHeaders(changedReplay);
    expect(zProblem.safeParse(await changedReplay.json()).success).toBe(true);
    const approvedPublic = await publicItems(projectId);
    expect(approvedPublic.items).toHaveLength(1);
    expect(approvedPublic.items[0]).toMatchObject({ feedbackId: approvedId, locale: "en", authorName: privateName, paragraph: privateParagraph });

    const rejectedId = await submit(projectId);
    const rejected = await command("reject", rejectedId, 1);
    expect(rejected.status).toBe(200);
    privateHeaders(rejected);
    expect(zRejectOwnerFeedbackResponse.safeParse(await rejected.json()).success).toBe(true);
    expect(await publicItems(projectId)).toMatchObject({ items: [{ feedbackId: approvedId }] });
    const rejectedView = await inspect(rejectedId);
    privateHeaders(rejectedView);
    expect(await rejectedView.json()).toMatchObject({ state: "rejected", aggregateVersion: 2, decisionHistory: [{ decision: "rejected", reason: privateReason }] });

    const suppressKey = createStableId("Key");
    const suppressed = await command("suppress", approvedId, 2, suppressKey, 1);
    expect(suppressed.status).toBe(200);
    privateHeaders(suppressed);
    const suppressedReceipt = await suppressed.json();
    expect(zSuppressOwnerFeedbackResponse.safeParse(suppressedReceipt).success).toBe(true);
    expect(suppressedReceipt).toMatchObject({ aggregateId: approvedId, aggregateVersion: 3, outcome: "feedback-suppressed" });
    const suppressionReplay = await command("suppress", approvedId, 2, suppressKey);
    expect(suppressionReplay.status).toBe(200);
    privateHeaders(suppressionReplay);
    expect(await suppressionReplay.json()).toEqual(suppressedReceipt);
    const invalidTransition = await command("suppress", approvedId, 3);
    expect(invalidTransition.status).toBe(409);
    privateHeaders(invalidTransition);
    expect(zProblem.safeParse(await invalidTransition.json()).success).toBe(true);
    expect((await publicItems(projectId)).items).toEqual([]);
    const suppressedView = await inspect(approvedId, 1);
    expect(suppressedView.status).toBe(200);
    privateHeaders(suppressedView);
    expect(await suppressedView.json()).toMatchObject({ state: "suppressed", aggregateVersion: 3, decisionHistory: [
      { decision: "approved", reason: privateReason }, { decision: "suppressed", reason: privateReason },
    ] });
    const privateFacts = await admin.query("select count(*)::int as rows, max(aggregate_version)::text as version from interaction.feedback where feedback_id=$1", [approvedId]);
    expect(privateFacts.rows[0]).toMatchObject({ rows: 1, version: "3" });
    const decisions = await admin.query("select decision from interaction.moderation_decisions where feedback_id=$1 order by sequence", [approvedId]);
    expect(decisions.rows.map((row) => row.decision)).toEqual(["approved", "suppressed"]);
    const durableEvents = await admin.query("select payload::text as payload from operations.outbox_events where aggregate_id=$1", [approvedId]);
    expect(durableEvents.rows).toHaveLength(3);
    for (const row of durableEvents.rows) {
      expect(row.payload).not.toContain(privateName);
      expect(row.payload).not.toContain(privateParagraph);
      expect(row.payload).not.toContain(privateReason);
    }
  }, 60_000);

  it("AC05 denies unauthenticated, missing, and stale access before changing private state", async () => {
    const feedbackId = await submit(await seedPublishedProject());
    const before = await admin.query("select aggregate_version::text, moderation_state from interaction.feedback where feedback_id=$1", [feedbackId]);
    const anonymous = await fetchBuilt(`${urls[0]}/api/owner/v1/feedback/${feedbackId}`, { signal: AbortSignal.timeout(15_000) });
    expect(anonymous.status).toBe(401);
    privateHeaders(anonymous);
    expect(zProblem.safeParse(await anonymous.json()).success).toBe(true);
    const missing = await inspect(createStableId("Feedback"));
    expect(missing.status).toBe(404);
    privateHeaders(missing);
    expect(zProblem.safeParse(await missing.json()).success).toBe(true);
    const nonOwnerRead = await fetchBuilt(`${urls[0]}/api/owner/v1/feedback/${feedbackId}`, {
      headers: { host: new URL(urls[0]!).host, cookie: `sw_owner_session=${nonOwner.token}` },
      signal: AbortSignal.timeout(15_000),
    });
    expect(nonOwnerRead.status).toBe(403);
    privateHeaders(nonOwnerRead);
    expect(zProblem.safeParse(await nonOwnerRead.json()).success).toBe(true);
    const nonOwnerDecision = await fetchBuilt(`${urls[0]}/api/owner/v1/feedback/${feedbackId}/commands/approve`, {
      method: "POST", headers: { host: new URL(urls[0]!).host, cookie: `sw_owner_session=${nonOwner.token}`,
        origin: new URL(urls[0]!).origin, "x-csrf-token": csrf, "content-type": "application/json",
        "idempotency-key": createStableId("Key"), "if-match": '"1"' },
      body: JSON.stringify({ reason: privateReason }), signal: AbortSignal.timeout(15_000),
    });
    expect(nonOwnerDecision.status).toBe(403);
    privateHeaders(nonOwnerDecision);
    expect(zProblem.safeParse(await nonOwnerDecision.json()).success).toBe(true);
    const foreignId = await seedForeignFeedback();
    const foreignBefore = await admin.query("select aggregate_version::text, moderation_state from interaction.feedback where feedback_id=$1", [foreignId]);
    const foreignRead = await inspect(foreignId);
    expect(foreignRead.status).toBe(404);
    privateHeaders(foreignRead);
    expect(zProblem.safeParse(await foreignRead.json()).success).toBe(true);
    const foreignDecision = await command("approve", foreignId, 1);
    expect(foreignDecision.status).toBe(404);
    privateHeaders(foreignDecision);
    expect(zProblem.safeParse(await foreignDecision.json()).success).toBe(true);
    const foreignAfter = await admin.query("select aggregate_version::text, moderation_state from interaction.feedback where feedback_id=$1", [foreignId]);
    expect(foreignAfter.rows).toEqual(foreignBefore.rows);
    expect((await admin.query("select count(*)::int as count from interaction.moderation_decisions where feedback_id=$1", [foreignId])).rows[0].count).toBe(0);
    expect((await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id=$1", [foreignId])).rows[0].count).toBe(0);
    const stale = await command("approve", feedbackId, 2);
    expect(stale.status).toBe(412);
    privateHeaders(stale);
    expect(zProblem.safeParse(await stale.json()).success).toBe(true);
    const after = await admin.query("select aggregate_version::text, moderation_state from interaction.feedback where feedback_id=$1", [feedbackId]);
    expect(after.rows).toEqual(before.rows);
  }, 60_000);
});
