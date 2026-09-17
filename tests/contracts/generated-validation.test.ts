import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  zEventReceipt,
  zFeedbackReceipt,
  zFeedbackSubmission,
  zGetCurrentCvQuery,
  zPostPublicEventBody,
  zPostPublicEventHeaders,
  zProblem,
  zPostProjectFeedbackHeaders,
  zPutProjectRatingBody,
  zPutProjectRatingHeaders,
  zPutProjectReactionBody,
  zPutProjectReactionHeaders,
  zPutProjectReactionPath,
  zRatingState,
  zReactionState,
} from "../../src/contracts/http/v1/generated/zod.gen.js";
import type { PostPublicEventData } from "../../src/contracts/http/v1/generated/types.gen.js";

const ids = {
  event: "01890f3e-7b2f-7cc0-98cf-5a2890378ef4",
  feedback: "01890f3e-7b2f-7cc0-98cf-5a2890378ef2",
  mediaAsset: "01890f3e-7b2f-7cc0-98cf-5a2890378ef5",
  page: "01890f3e-7b2f-7cc0-98cf-5a2890378ef3",
  project: "01890f3e-7b2f-7cc0-98cf-5a2890378ef1",
  relatedProject: "01890f3e-7b2f-7cc0-98cf-5a2890378ef6",
  testimonial: "01890f3e-7b2f-7cc0-98cf-5a2890378ef7",
};
const eventContext = {
  occurredAt: "2026-09-17T12:00:00Z",
  locale: "en",
  consentVersion: "2026-09",
  pageRouteIdentity: ids.page,
} as const;
const typedEvents: ReadonlyArray<PostPublicEventData["body"]> = [
  { action: "page-viewed", context: eventContext },
  { action: "project-viewed", context: eventContext, projectId: ids.project },
  { action: "active-engagement-sampled", context: eventContext, activeMilliseconds: 5_000 },
  { action: "media-engaged", context: eventContext, mediaAssetId: ids.mediaAsset, engagement: "opened" },
  {
    action: "related-project-opened",
    context: eventContext,
    sourceProjectId: ids.project,
    targetProjectId: ids.relatedProject,
  },
  { action: "contact-channel-opened", context: eventContext, channel: "linkedin" },
  {
    action: "external-project-link-opened",
    context: eventContext,
    projectId: ids.project,
    destination: "github-repository",
  },
  { action: "testimonial-engaged", context: eventContext, testimonialId: ids.testimonial },
  { action: "global-project-cta-opened", context: eventContext, projectId: ids.project },
];

type Example = { value: unknown };
type ExampleContent = { examples: Record<string, Example> };
type BundledOperation = {
  requestBody?: { content: Record<string, ExampleContent> };
  responses: Record<string, { content?: Record<string, ExampleContent> }>;
};
const bundle = JSON.parse(
  readFileSync("openapi/generated/public-v1.json", "utf8"),
) as { paths: Record<string, Record<string, BundledOperation>> };

const requestExample = (path: string, method: string, name: string) =>
  bundle.paths[path]![method]!.requestBody!.content["application/json"]!.examples[name]!.value;

const responseExample = (path: string, method: string, status: string, name: string) =>
  bundle.paths[path]![method]!.responses[status]!.content!["application/json"]!.examples[name]!.value;

describe("generated public v1 validators", () => {
  it("accepts every declared success example", () => {
    expect(zPutProjectReactionBody.parse(requestExample(
      "/api/v1/projects/{projectId}/reaction", "put", "like",
    ))).toEqual({ reaction: "like" });
    expect(zReactionState.parse(responseExample(
      "/api/v1/projects/{projectId}/reaction", "put", "200", "current",
    ))).toEqual({
      projectId: ids.project,
      reaction: "like",
    });
    expect(zPutProjectRatingBody.parse(requestExample(
      "/api/v1/projects/{projectId}/rating", "put", "five-stars",
    ))).toEqual({ rating: 5 });
    expect(zRatingState.parse(responseExample(
      "/api/v1/projects/{projectId}/rating", "put", "200", "current",
    ))).toEqual({
      projectId: ids.project,
      rating: 5,
    });
    expect(zFeedbackSubmission.safeParse(requestExample(
      "/api/v1/projects/{projectId}/feedback", "post", "english",
    )).success).toBe(true);
    expect(zFeedbackReceipt.safeParse(responseExample(
      "/api/v1/projects/{projectId}/feedback", "post", "201", "pending",
    )).success).toBe(true);
    expect(zPostPublicEventBody.safeParse(requestExample(
      "/api/v1/events", "post", "project-viewed",
    )).success).toBe(true);
    expect(zEventReceipt.safeParse(responseExample(
      "/api/v1/events", "post", "202", "accepted",
    )).success).toBe(true);
  });

  it("rejects unknown properties and invalid interaction values", () => {
    expect(zPutProjectReactionBody.safeParse({ reaction: "love" }).success).toBe(false);
    expect(zPutProjectReactionBody.safeParse({ reaction: "like", providerId: "x" }).success).toBe(false);
    expect(zPutProjectRatingBody.safeParse({ rating: 0 }).success).toBe(false);
    expect(zPutProjectRatingBody.safeParse({ rating: 6 }).success).toBe(false);
    expect(zFeedbackSubmission.safeParse({
      name: "Ada",
      paragraph: "Useful",
      locale: "en",
      approved: true,
    }).success).toBe(false);
  });

  it("requires valid idempotency and stable identity inputs", () => {
    const headers = [
      zPutProjectReactionHeaders,
      zPutProjectRatingHeaders,
      zPostProjectFeedbackHeaders,
      zPostPublicEventHeaders,
    ];

    for (const schema of headers) {
      expect(schema.safeParse({ "Idempotency-Key": "request-123" }).success).toBe(true);
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ "Idempotency-Key": "contains space" }).success).toBe(false);
      expect(schema.safeParse({ "Idempotency-Key": "x".repeat(129) }).success).toBe(false);
    }

    expect(zPutProjectReactionPath.safeParse({ projectId: ids.project }).success).toBe(true);
    expect(zPutProjectReactionPath.safeParse({ projectId: "project-slug" }).success).toBe(false);
  });

  it("accepts an allowlisted event and rejects unsupported or sensitive shapes", () => {
    const valid = {
      action: "project-viewed",
      projectId: ids.project,
      context: {
        occurredAt: "2026-09-17T12:00:00Z",
        locale: "en",
        consentVersion: "2026-09",
        pageRouteIdentity: ids.page,
      },
    };

    expect(zPostPublicEventBody.safeParse(valid).success).toBe(true);
    expect(zPostPublicEventBody.safeParse({ ...valid, action: "feedback-submitted" }).success).toBe(false);
    expect(zPostPublicEventBody.safeParse({ ...valid, feedbackText: "private" }).success).toBe(false);
    expect(zPostPublicEventBody.safeParse({
      ...valid,
      context: { ...valid.context, ipAddress: "203.0.113.1" },
    }).success).toBe(false);

    for (const event of typedEvents) {
      expect(zPostPublicEventBody.safeParse(event).success).toBe(true);
    }
  });

  it("accepts only the explicit English Current CV query", () => {
    expect(zGetCurrentCvQuery.parse({ locale: "en" })).toEqual({
      locale: "en",
      disposition: "inline",
    });
    expect(zGetCurrentCvQuery.safeParse({ locale: "ar" }).success).toBe(false);
    expect(zGetCurrentCvQuery.safeParse({}).success).toBe(false);
  });

  it("keeps Problem Details closed and leak-free", () => {
    const problem = {
      type: "urn:shipwithali:problem:internal-error",
      title: "Unexpected failure",
      status: 500,
      detail: "The request could not be completed.",
      instance: "/api/v1/events",
      code: "internal_error",
      traceId: "trace-123",
    };

    expect(zProblem.safeParse(problem).success).toBe(true);
    expect(zProblem.safeParse({ ...problem, stack: "secret" }).success).toBe(false);
    expect(JSON.stringify(problem)).not.toMatch(/supabase|postgres|stack|token/i);
  });
});
