import { describe, expect, it, vi } from "vitest";
import { createPublicDiscoveryService, type PublicDiscoveryReader } from "../../../src/modules/taxonomy-discovery/application/public-discovery.js";
import type { ProjectDiscoveryCard, ProjectDiscoveryFacet } from "../../../src/modules/taxonomy-discovery/domain/index.js";
import type { TransactionContext, TransactionRunner } from "../../../src/runtime/ports.js";
import type { StableId } from "../../../src/shared/domain/index.js";

const cardIds = [
  "01890f3e-7b2f-7cc0-98cf-5a2890378ef1",
  "01890f3e-7b2f-7cc0-98cf-5a2890378ef2",
  "01890f3e-7b2f-7cc0-98cf-5a2890378ef3",
];
const timestamp = "2026-10-09T08:00:00.000Z";
const project = (id: string): ProjectDiscoveryCard => ({
  projectId: id as StableId<"Project">, locale: "en", title: `Project ${id.slice(-1)}`,
  summary: "Approved summary", slug: `project-${id.slice(-1)}`, firstPublishedAt: timestamp,
  taxonomyValues: [], isFeatured: true,
});
const facet: ProjectDiscoveryFacet = {
  taxonomyId: "01890f3e-7b2f-7cc0-98cf-5a2890378ef6" as StableId<"Taxonomy">,
  valueId: "01890f3e-7b2f-7cc0-98cf-5a2890378ef4" as StableId<"TaxonomyValue">,
  kind: "category", label: "Systems", projectCount: 3,
};

function harness(reader: PublicDiscoveryReader) {
  const transactions = { async run<T>(callback: (context: TransactionContext) => Promise<T> | T) {
    return callback({ kind: "transaction" } as unknown as TransactionContext);
  } } as TransactionRunner;
  return createPublicDiscoveryService({ reader, transactions });
}

describe("Public Discovery query policy", () => {
  it("uses newest-publication keysets and returns a scoped opaque continuation", async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: { entries: cardIds.map(project), facets: [facet] } }));
    const first = await harness({ read }).getPublicDiscovery({ locale: "en", limit: 2 });
    expect(first).toMatchObject({ ok: true, value: { entries: [{ projectId: cardIds[0] }, { projectId: cardIds[1] }], facets: [facet] } });
    if (!first.ok || first.value.nextCursor === null) throw new Error("expected next page");
    expect(read).toHaveBeenCalledWith({ locale: "en", limit: 3 }, expect.anything());

    const nextRead = vi.fn(async (query: { readonly after?: unknown }) => {
      expect(query.after).toEqual({ firstPublishedAt: timestamp, projectId: cardIds[1] });
      return { ok: true as const, value: { entries: [project(cardIds[2]!)], facets: [facet] } };
    });
    const next = await harness({ read: nextRead }).getPublicDiscovery({ locale: "en", limit: 2, cursor: first.value.nextCursor! });
    expect(next).toMatchObject({ ok: true, value: { entries: [{ projectId: cardIds[2]! }], nextCursor: null } });
  });

  it("defaults to 20 and rejects unsupported sizes, locales, and multiple filters before reading", async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: { entries: [], facets: [] } }));
    const service = harness({ read });
    expect(await service.getPublicDiscovery({ locale: "en" })).toMatchObject({ ok: true, value: { entries: [], nextCursor: null } });
    expect(read).toHaveBeenCalledWith({ locale: "en", limit: 21 }, expect.anything());
    expect(await service.getPublicDiscovery({ locale: "en", limit: 0 })).toMatchObject({ ok: false, error: { code: "INVALID_DISCOVERY_PAGE_SIZE" } });
    expect(await service.getPublicDiscovery({ locale: "en", limit: 101 })).toMatchObject({ ok: false, error: { code: "INVALID_DISCOVERY_PAGE_SIZE" } });
    expect(await service.getPublicDiscovery({ locale: "xx" as "en", limit: 20 })).toMatchObject({ ok: false, error: { code: "UNSUPPORTED_DISCOVERY_LOCALE" } });
    expect(await service.getPublicDiscovery({ locale: "en", taxonomyValueIds: [facet.valueId, facet.valueId] })).toMatchObject({ ok: false, error: { code: "INVALID_DISCOVERY_FILTER" } });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed and cross-locale or cross-filter cursors", async () => {
    const read = vi.fn(async () => ({ ok: true as const, value: { entries: cardIds.map(project), facets: [] } }));
    const page = await harness({ read }).getPublicDiscovery({ locale: "en", taxonomyValueIds: [facet.valueId], limit: 1 });
    if (!page.ok || page.value.nextCursor === null) throw new Error("expected next page");
    const service = harness({ read });
    expect(await service.getPublicDiscovery({ locale: "ar", taxonomyValueIds: [facet.valueId], limit: 1, cursor: page.value.nextCursor }))
      .toMatchObject({ ok: false, error: { code: "INVALID_DISCOVERY_CURSOR" } });
    expect(await service.getPublicDiscovery({ locale: "en", limit: 1, cursor: page.value.nextCursor }))
      .toMatchObject({ ok: false, error: { code: "INVALID_DISCOVERY_CURSOR" } });
    expect(await service.getPublicDiscovery({ locale: "en", limit: 1, cursor: "eyJ2Ijo5fQ" }))
      .toMatchObject({ ok: false, error: { code: "INVALID_DISCOVERY_CURSOR" } });
  });

  it("uses a safe typed rejection for unknown or foreign controlled values", async () => {
    const read = vi.fn(async () => ({ ok: false as const, error: { kind: "validation" as const, code: "INVALID_DISCOVERY_FILTER" } }));
    const result = await harness({ read }).getPublicDiscovery({ locale: "en", taxonomyValueIds: [facet.valueId] });
    expect(result).toMatchObject({ ok: false, error: { kind: "validation", code: "INVALID_DISCOVERY_FILTER" } });
  });
});
