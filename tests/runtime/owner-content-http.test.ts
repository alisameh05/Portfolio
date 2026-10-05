import { describe, expect, it } from "vitest";
import { unsafeStableId } from "../../src/shared/domain/index.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import { createOwnerPublicationTestFake } from "../../src/runtime/fakes/owner-publication.js";
import type { ContentAuthoringService } from "../../src/modules/content-publishing/application/authoring.js";
import {
  handleCreateOwnerContent,
} from "../../src/runtime/http/owner-content-authoring.js";
import {
  handleGetOwnerContentAggregate,
  handleSaveOwnerContentRevision,
} from "../../src/runtime/http/owner-publication.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const CONTENT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1";
const REVISION_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2";
const CONTENT = {
  contentId: CONTENT_ID,
  aggregateVersion: 1,
  contentType: "project",
  lifecycle: "draft",
  localizedStreams: { en: { revisionCount: 1, currentPublishedRevisionId: null } },
  revisions: [{ revisionId: REVISION_ID, locale: "en", sequence: 1, reviewed: false }],
};

function createService() {
  const calls: { create: unknown[]; get: unknown[]; save: unknown[] } = { create: [], get: [], save: [] };
  const service: ContentAuthoringService = {
    async createContent(command) {
      calls.create.push(command);
      return { ok: true, value: { contentId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 1, revisionId: unsafeStableId<"Revision">(REVISION_ID), outcome: "content-created" } };
    },
    async getOwnerContentAggregate(query) {
      calls.get.push(query);
      return { ok: true, value: CONTENT as never };
    },
    async saveRevision(command) {
      calls.save.push(command);
      return { ok: true, value: { aggregateId: unsafeStableId<string>(CONTENT_ID), aggregateVersion: 2, revisionId: unsafeStableId<"Revision">(REVISION_ID), outcome: "revision-saved" } };
    },
  };
  return { calls, service };
}

function request(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/owner/v1/content", {
    method,
    headers: withOwnerTestAuth({ "content-type": "application/json", ...headers }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("Owner content authoring HTTP adapters", () => {
  it("creates Draft content without an If-Match header and dispatches one validated command", async () => {
    const fake = createService();
    const response = await handleCreateOwnerContent(
      request("POST", { contentType: "project", locale: "en", title: "Atlas Search", summary: "A draft.", body: "Draft only.", candidateSlug: "atlas-search" }, { "idempotency-key": "create-project-1" }),
      { service: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(201);
    expect(fake.calls.create).toHaveLength(1);
    expect(await response.json()).toEqual({ contentId: CONTENT_ID, aggregateVersion: 1, revisionId: REVISION_ID, outcome: "content-created" });
  });

  it("rejects unknown draft fields before dispatch", async () => {
    const fake = createService();
    const response = await handleCreateOwnerContent(
      request("POST", { contentType: "project", locale: "en", title: "Atlas Search", summary: "A draft.", body: "Draft.", candidateSlug: "atlas-search", private: true }),
      { service: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.create).toHaveLength(0);
  });

  it("inspects a scoped aggregate and saves a Revision using the declared precondition headers", async () => {
    const fake = createService();
    const publicationFake = createOwnerPublicationTestFake({ type: "success" });
    const get = await handleGetOwnerContentAggregate(
      request("GET"),
      { contentId: CONTENT_ID },
      { service: publicationFake, contentAuthoring: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(get.status).toBe(200);
    expect(fake.calls.get).toHaveLength(1);
    const save = await handleSaveOwnerContentRevision(
      request("POST", { locale: "ar", title: "بحث", summary: "مسودة", body: "نص أولي", draftData: { contentType: "project", caseStudy: { outcomes: ["مخرجات"] } } }, { "idempotency-key": "save-1", "if-match": '"1"' }),
      { contentId: CONTENT_ID },
      { service: publicationFake, contentAuthoring: fake.service, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(save.status).toBe(201);
    expect(fake.calls.save).toHaveLength(1);
    expect(fake.calls.save[0]).toMatchObject({ expectedVersion: 1, locale: "ar", body: "نص أولي", draftData: { contentType: "project", caseStudy: { outcomes: ["مخرجات"] } } });
  });
});
