import { afterEach, describe, expect, it } from "vitest";
import {
  getFeedbackRuntimeServices,
  getOwnerAnalyticsRuntimeServices,
  getOwnerModerationRuntimeServices,
  getRatingRuntimeServices,
  getReactionRuntimeServices,
  resetRuntimeForTests,
} from "../../src/bootstrap/composition-root.js";
import { handlePostProjectFeedback } from "../../src/runtime/http/feedback.js";
import { handlePostPublicEvent } from "../../src/runtime/http/public-event.js";
import { handlePutProjectRating } from "../../src/runtime/http/rating.js";
import { handlePutProjectReaction } from "../../src/runtime/http/reaction.js";
import {
  handleApproveOwnerFeedback,
  handleGetOwnerFeedbackModeration,
  handleRejectOwnerFeedback,
  handleSuppressOwnerFeedback,
} from "../../src/runtime/http/owner-moderation.js";
import {
  handleActivateOwnerAnalyticsGoalVersion,
  handleCreateOwnerAnalyticsGoalVersion,
  handleGetOwnerAnalyticsGoal,
} from "../../src/runtime/http/owner-analytics.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

afterEach(() => resetRuntimeForTests());

const unavailable = {
  ok: false,
  error: { kind: "temporarily_unavailable", code: "PHASE7_RUNTIME_NOT_CONFIGURED" },
};
const projectId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e93";
const feedbackId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e94";
const goalId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e95";
const versionId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e96";
const idempotency = "phase7-http-unconfigured-001";
const ownerMutationHeaders = withOwnerTestAuth({
  "content-type": "application/json",
  "idempotency-key": idempotency,
  "if-match": '"1"',
});
const ownerSecurity = ownerTestSecurity();
const unavailableStatus = async (response: Response) => {
  expect(response.status).toBe(503);
  expect((await response.json()).code).toBe("temporarily_unavailable");
};

describe("Phase 7 runtime without database composition", () => {
  it("does not return successful in-memory results for public Reaction, Rating, or Feedback", async () => {
    const reaction = await getReactionRuntimeServices();
    const rating = await getRatingRuntimeServices();
    const feedback = await getFeedbackRuntimeServices();

    expect(await reaction.service.submitReaction({} as never)).toMatchObject(unavailable);
    expect(await rating.service.submitRating({} as never)).toMatchObject(unavailable);
    expect(await feedback.service.submitFeedback({} as never)).toMatchObject(unavailable);
  });

  it("does not return successful in-memory results for any Owner moderation or goal operation", async () => {
    const moderation = await getOwnerModerationRuntimeServices();
    const analytics = await getOwnerAnalyticsRuntimeServices();

    expect(await moderation.service.getOwnerFeedbackModeration({} as never)).toMatchObject(unavailable);
    expect(await moderation.service.approveOwnerFeedback({} as never)).toMatchObject(unavailable);
    expect(await moderation.service.rejectOwnerFeedback({} as never)).toMatchObject(unavailable);
    expect(await moderation.service.suppressOwnerFeedback({} as never)).toMatchObject(unavailable);

    expect(await analytics.service.getOwnerAnalyticsGoal({} as never)).toMatchObject(unavailable);
    expect(await analytics.service.createOwnerAnalyticsGoalVersion({} as never)).toMatchObject(unavailable);
    expect(await analytics.service.activateOwnerAnalyticsGoalVersion({} as never)).toMatchObject(unavailable);
  });

  it("maps every unconfigured public and Owner HTTP operation to 503", async () => {
    const [reaction, rating, feedback, moderation, analytics] = await Promise.all([
      getReactionRuntimeServices(),
      getRatingRuntimeServices(),
      getFeedbackRuntimeServices(),
      getOwnerModerationRuntimeServices(),
      getOwnerAnalyticsRuntimeServices(),
    ]);
    const request = (url: string, method: string, headers: HeadersInit, body?: string) =>
      new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
    const moderationDeps = { ...moderation, security: ownerSecurity };
    const analyticsDeps = { ...analytics, security: ownerSecurity };
    const responses = await Promise.all([
      handlePutProjectReaction(request(`https://example.com/api/v1/projects/${projectId}/reaction`, "PUT",
        { "idempotency-key": idempotency, "content-type": "application/json" }, JSON.stringify({ reaction: "like" })), { projectId }, reaction),
      handlePutProjectRating(request(`https://example.com/api/v1/projects/${projectId}/rating`, "PUT",
        { "idempotency-key": idempotency, "content-type": "application/json" }, JSON.stringify({ rating: 5 })), { projectId }, rating),
      handlePostProjectFeedback(request(`https://example.com/api/v1/projects/${projectId}/feedback`, "POST",
        { "idempotency-key": idempotency, "content-type": "application/json" },
        JSON.stringify({ name: "Visitor", paragraph: "Private feedback body", locale: "en" })), { projectId }, feedback),
      handlePostPublicEvent(request("https://example.com/api/v1/events", "POST", {
        "idempotency-key": idempotency,
        cookie: "sw_analytics_consent=signed-test-token",
        "content-type": "application/json",
      }, JSON.stringify({ action: "page-viewed", context: {
        pageRouteIdentity: projectId,
        locale: "en",
        occurredAt: "2026-10-16T00:00:00.000Z",
        consentVersion: "notice-v1",
        journeyContext: [projectId],
        deviceClass: "unknown",
        referrerClass: "professional",
        countryCode: "EG",
      } })), { consent: { async verifyEvidence() { return { ok: true, value: {} } as never; } } }),
      handleGetOwnerFeedbackModeration(request(`https://example.com/api/owner/v1/feedback/${feedbackId}`, "GET", withOwnerTestAuth({})), { feedbackId }, moderationDeps),
      handleApproveOwnerFeedback(request(`https://example.com/api/owner/v1/feedback/${feedbackId}/commands/approve`, "POST", ownerMutationHeaders,
        JSON.stringify({ reason: "Reviewed" })), { feedbackId }, moderationDeps),
      handleRejectOwnerFeedback(request(`https://example.com/api/owner/v1/feedback/${feedbackId}/commands/reject`, "POST", ownerMutationHeaders,
        JSON.stringify({ reason: "Reviewed" })), { feedbackId }, moderationDeps),
      handleSuppressOwnerFeedback(request(`https://example.com/api/owner/v1/feedback/${feedbackId}/commands/suppress`, "POST", ownerMutationHeaders,
        JSON.stringify({ reason: "Reviewed" })), { feedbackId }, moderationDeps),
      handleGetOwnerAnalyticsGoal(request(`https://example.com/api/owner/v1/analytics-goals/${goalId}`, "GET", withOwnerTestAuth({})), { goalId }, analyticsDeps),
      handleCreateOwnerAnalyticsGoalVersion(request(`https://example.com/api/owner/v1/analytics-goals/${goalId}/versions`, "POST", ownerMutationHeaders,
        JSON.stringify({ definition: { name: "Project journey", steps: [{ action: "page-viewed" }] } })), { goalId }, analyticsDeps),
      handleActivateOwnerAnalyticsGoalVersion(request(`https://example.com/api/owner/v1/analytics-goals/${goalId}/commands/activate-version`, "POST", ownerMutationHeaders,
        JSON.stringify({ versionId })), { goalId }, analyticsDeps),
    ]);

    for (const response of responses) await unavailableStatus(response);
    expect(responses[0]?.headers.get("set-cookie")).toBeNull();
    expect(responses[1]?.headers.get("set-cookie")).toBeNull();
  });
});
