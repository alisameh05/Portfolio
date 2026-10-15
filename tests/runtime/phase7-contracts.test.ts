import { describe, expect, it } from "vitest";
import { handlePostPublicEvent as rawHandlePostPublicEvent } from "../../src/runtime/http/public-event.js";
import { handlePostProjectFeedback } from "../../src/runtime/http/feedback.js";
import { createPublicEventTestFake, createProductionPublicEventService } from "../../src/runtime/fakes/public-event.js";
import { createFeedbackTestFake } from "../../src/runtime/fakes/feedback.js";
import { createReactionTestFake } from "../../src/runtime/fakes/reaction.js";
import { createRatingTestFake } from "../../src/runtime/fakes/rating.js";
import { createTestLogger } from "../../src/runtime/ports.js";
const handlePostPublicEvent: typeof rawHandlePostPublicEvent = (request, deps) => rawHandlePostPublicEvent(request, {
  ...deps, consent: { async verifyEvidence(query) { return { ok: true, value: { purpose: "measurement",
    subject: id as never, portfolioId: id as never, consentId: id as never, noticeVersion: query.noticeVersion,
    revision: 1, issuedAt: "2026-10-14T12:00:00.000Z", expiresAt: "2026-11-13T12:00:00.000Z" } }; } },
});
const id = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e93";
const context = { pageRouteIdentity: id, locale: "ar", occurredAt: "2026-10-14T12:00:00Z", consentVersion: "v1", journeyContext: [id], deviceClass: "unknown", referrerClass: "professional", countryCode: "EG" };
const actions = [
 { action: "page-viewed" },
 { action: "project-viewed", projectId: id },
 { action: "active-engagement-sampled", projectId: id, activeMilliseconds: 60000 },
 { action: "media-engaged", projectId: id, mediaAssetId: id, engagement: "completed" },
 { action: "related-project-opened", sourceProjectId: id, targetProjectId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e94" },
 { action: "testimonial-engaged", projectId: id, testimonialId: id },
];
function request(body: unknown) { return new Request("https://example.com/api/v1/events", { method: "POST", headers: { "Idempotency-Key": "contracts-188", cookie: "sw_analytics_consent=PRIVATE_TOKEN_SENTINEL" }, body: JSON.stringify(body) }); }
describe("Phase 7 contracts #188", () => {
 it.each(actions)("T09/T10 preserves $action with complete context, scope, and idempotency", async action => {
  const fake = createPublicEventTestFake({ type: "success" });
  const event = { ...action, context };
  const response = await handlePostPublicEvent(request(event), { service: fake, scope: { kind: "portfolio", portfolioId: id as never } });
  expect(response.status, await response.clone().text()).toBe(202);
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]).toMatchObject({ event, idempotencyKey: "contracts-188", scope: { kind: "portfolio", portfolioId: id }, correlationId: expect.any(String) });
  expect(fake.calls[0]).toHaveProperty("measurement.purpose", "measurement");
  expect(await response.json()).toEqual({ eventId: expect.any(String), acceptedAt: expect.any(String) });
 });
 it.each([
  { action: "contact-channel-opened", projectId: id, channel: "phone" },
  { action: "external-project-link-opened", projectId: id, destination: "live-demo" },
  { action: "global-project-cta-opened", projectId: id },
 ])("keeps later optional action fail-closed until its fact capability is implemented: %j", async action => {
  const fake = createPublicEventTestFake({ type: "success" });
  expect((await handlePostPublicEvent(request({ context, ...action }), { service: fake })).status).toBe(400);
  expect(fake.calls).toHaveLength(0);
 });
 it.each([
  { action: "project-viewed" },
  { action: "page-viewed", projectId: id },
  { action: "media-engaged", mediaAssetId: id, engagement: "liked" },
  { action: "contact-channel-opened", channel: "email" },
  { action: "cv_download" },
  { action: "feedback-submitted", paragraph: "PRIVATE_TEXT_SENTINEL" },
  { action: "page-viewed", context: { ...context, functionalId: "PRIVATE_SUBJECT_SENTINEL" } },
 ])("T01-02 rejects excluded/wrong action fields before dispatch: %j", async action => {
  const fake = createPublicEventTestFake({ type: "success" });
  expect((await handlePostPublicEvent(request({ context, ...action }), { service: fake })).status).toBe(400);
  expect(fake.calls).toHaveLength(0);
 });
 it("T01-01 keeps the production event shell fail closed for all nine actions", async () => {
  for (const action of actions) expect((await handlePostPublicEvent(request({ ...action, context }), { service: createProductionPublicEventService() })).status).toBe(503);
 });
 it("T01-04/05 Feedback receipt and logs omit private text and identities, retaining submitted locale in the command", async () => {
  const fake = createFeedbackTestFake({ type: "success" }); const logger = createTestLogger();
  const response = await handlePostProjectFeedback(new Request("https://example.com", { method: "POST", headers: { "Idempotency-Key": "contracts-188" }, body: JSON.stringify({ name: "PRIVATE_NAME_SENTINEL", paragraph: "PRIVATE_TEXT_SENTINEL", locale: "ar" }) }), { projectId: id }, { rateLimit: { check: async () => ({ allowed: true }) }, service: fake, logger });
  expect(response.status).toBe(201);
  expect(fake.calls[0]).toMatchObject({ locale: "ar" });
  const command = fake.calls[0]; if (!command) throw new Error("missing command");
  const result = await fake.submitFeedback(command);
  expect(result.ok).toBe(true);
  if (result.ok) expect(Object.keys(result.value).sort()).toEqual(["id", "projectId", "status"]);
  const external = JSON.stringify({ receipt: await response.json(), logs: logger.records });
  expect(external).not.toContain("PRIVATE_");
 });
 it("T01-05 ordinary vote receipts omit functional subjects", async () => {
  const command = { actor: { kind: "visitor", consent: "denied", functionalId: id }, scope: { kind: "unconfigured" }, correlationId: "trace", idempotencyKey: "contracts-188", projectId: id } as const;
  const reaction = await createReactionTestFake({ type: "success" }).submitReaction({ ...command, idempotencyKey: command.idempotencyKey as never, projectId: id as never, actor: { ...command.actor, functionalId: id as never }, kind: "like" });
  const rating = await createRatingTestFake({ type: "success" }).submitRating({ ...command, idempotencyKey: command.idempotencyKey as never, projectId: id as never, actor: { ...command.actor, functionalId: id as never }, value: 5 });
  if (!reaction.ok || !rating.ok) throw new Error("expected safe receipts");
  expect(Object.keys(reaction.value).sort()).toEqual(["kind", "projectId"]);
  expect(Object.keys(rating.value).sort()).toEqual(["projectId", "value"]);
 });
});
