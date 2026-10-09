import { describe, expect, it } from "vitest";
import { unsafeStableId } from "../../src/shared/domain/index.js";
import type { ContentAuthoringService, ContentProjectOwnerView, ContentProjectStatusValue } from "../../src/modules/content-publishing/application/authoring.js";
import { createProductionContentAuthoringService } from "../../src/runtime/fakes/content-authoring.js";
import { createContentOwnerProjectService } from "../../src/runtime/content-owner-project.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  handleCreateOwnerProjectStatusValue,
  handleListOwnerProjectStatusValues,
  handleRenameOwnerProjectStatusValue,
  handleRetireOwnerProjectStatusValue,
} from "../../src/runtime/http/owner-project-status.js";
import { ownerTestSecurity, withOwnerTestAuth } from "./owner-test-auth.js";

const VALUE_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2";
const active: ContentProjectStatusValue = {
  valueId: unsafeStableId<"ProjectStatusValue">(VALUE_ID), label: "Shipped", state: "active", aggregateVersion: 1,
};

it("uses the Content Owner view as the source for the composed Project aggregate", async () => {
  const projectId = unsafeStableId<"Project">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e8f");
  const relatedProjectId = unsafeStableId<"Project">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e90");
  const ownerView: ContentProjectOwnerView = {
    projectId,
    aggregateVersion: 8,
    statusValueId: unsafeStableId<"ProjectStatusValue">(VALUE_ID),
    featured: true,
    publicRoute: {
      identity: unsafeStableId<"PublicRoute">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e93"),
      canonicalSlug: "project-route",
      redirects: [{ fromSlug: "old-route", toSlug: "project-route" }],
      history: [{ sequence: 1, fromSlug: "old-route", toSlug: "project-route", changedAt: "2026-10-08T10:00:00.000Z" }],
    },
    relatedProjectIds: [relatedProjectId],
    relationshipHistory: [],
    statusHistory: [],
    taxonomyAssignments: [{
      taxonomyId: unsafeStableId<"Taxonomy">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e94"),
      taxonomyKind: "industry",
      valueId: unsafeStableId<"TaxonomyValue">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e95"),
    }],
  };
  const content: ContentAuthoringService = {
    ...createProductionContentAuthoringService(),
    async getProjectOwnerView() { return { ok: true, value: ownerView }; },
  };
  const service = createContentOwnerProjectService(content);
  const result = await service.getOwnerProjectAggregate({
    actor: { kind: "owner", ownerId: unsafeStableId<"Owner">("0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e96"), sessionId: "test-session" },
    projectId,
  });
  expect(result).toEqual({ ok: true, value: ownerView });
});

function makeService() {
  const calls: string[] = [];
  const base = createProductionContentAuthoringService();
  const service: ContentAuthoringService = {
    ...base,
    async listProjectStatusValues(query) {
      calls.push(`list:${query.actor.kind}`);
      return { ok: true, value: [active] };
    },
    async createProjectStatusValue(command) {
      calls.push(`create:${command.label}:${command.idempotencyKey}:${command.correlationId}`);
      return { ok: true, value: active };
    },
    async renameProjectStatusValue(command) {
      calls.push(`rename:${command.valueId}:${command.expectedVersion}:${command.label}`);
      return { ok: true, value: { ...active, label: command.label, aggregateVersion: 2 } };
    },
    async retireProjectStatusValue(command) {
      calls.push(`retire:${command.valueId}:${command.expectedVersion}`);
      return { ok: true, value: { ...active, state: "retired", aggregateVersion: 2 } };
    },
  };
  return { calls, service };
}

function request(path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://example.com${path}`, {
    method,
    headers: withOwnerTestAuth({ "content-type": "application/json", ...headers }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function deps(service: ContentAuthoringService) {
  return { service, security: ownerTestSecurity(), logger: createTestLogger() };
}

describe("Owner Project status HTTP adapters", () => {
  it("lists private active and retired status identities through the authenticated Owner boundary", async () => {
    const fake = makeService();
    const response = await handleListOwnerProjectStatusValues(
      request("/api/owner/v1/project-status-values", "GET"), deps(fake.service),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.json()).toEqual({ values: [{ valueId: VALUE_ID, label: "Shipped", state: "active" }] });
    expect(fake.calls).toHaveLength(1);
  });

  it("creates a normalized status with the idempotency key and returns its versioned receipt", async () => {
    const fake = makeService();
    const response = await handleCreateOwnerProjectStatusValue(
      request("/api/owner/v1/project-status-values", "POST", { label: "Shipped" }, { "idempotency-key": "status-create-1" }),
      deps(fake.service),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ valueId: VALUE_ID, label: "Shipped", state: "active", aggregateVersion: 1, outcome: "project-status-value-created" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatch(/^create:Shipped:status-create-1:/u);
  });

  it("rejects unknown body properties before dispatch and applies If-Match to retirement", async () => {
    const fake = makeService();
    const invalid = await handleCreateOwnerProjectStatusValue(
      request("/api/owner/v1/project-status-values", "POST", { label: "Shipped", visibility: "public" }, { "idempotency-key": "status-create-2" }),
      deps(fake.service),
    );
    expect(invalid.status).toBe(400);
    expect(fake.calls).toHaveLength(0);

    const retired = await handleRetireOwnerProjectStatusValue(
      request(`/api/owner/v1/project-status-values/${VALUE_ID}/commands/retire`, "POST", {}, { "idempotency-key": "status-retire-1", "if-match": '"1"' }),
      { valueId: VALUE_ID }, deps(fake.service),
    );
    expect(retired.status).toBe(200);
    expect(await retired.json()).toMatchObject({ valueId: VALUE_ID, state: "retired", aggregateVersion: 2, outcome: "project-status-value-retired" });
    expect(fake.calls).toContain(`retire:${VALUE_ID}:1`);
  });

  it("preserves stable status identity across rename and rejects missing concurrency headers", async () => {
    const fake = makeService();
    const response = await handleRenameOwnerProjectStatusValue(
      request(`/api/owner/v1/project-status-values/${VALUE_ID}/commands/rename`, "POST", { label: "In Progress" }, { "idempotency-key": "status-rename-1", "if-match": '"1"' }),
      { valueId: VALUE_ID }, deps(fake.service),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ valueId: VALUE_ID, label: "In Progress", aggregateVersion: 2, outcome: "project-status-value-renamed" });
    const missing = await handleRenameOwnerProjectStatusValue(
      request(`/api/owner/v1/project-status-values/${VALUE_ID}/commands/rename`, "POST", { label: "In Progress" }, { "idempotency-key": "status-rename-2" }),
      { valueId: VALUE_ID }, deps(fake.service),
    );
    expect(missing.status).toBe(400);
    expect(fake.calls.filter((call) => call.startsWith("rename:")).length).toBe(1);
  });
});
