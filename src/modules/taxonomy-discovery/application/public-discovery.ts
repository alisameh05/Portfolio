import { err, type Rejection, type Result, type StableId } from "../../../shared/domain/index.js";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import type { ProjectDiscoveryCard, ProjectDiscoveryFacet, ProjectDiscoveryPage, PublicDiscoveryCriteria } from "../domain/index.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 512;

export interface PublicDiscoveryReadQuery {
  readonly locale: "en" | "ar";
  readonly taxonomyValueId?: StableId<"TaxonomyValue">;
  readonly limit: number;
  readonly after?: { readonly firstPublishedAt: string; readonly projectId: StableId<"Project"> };
}

export interface PublicDiscoveryReadResult {
  /** The adapter may return one extra row to signal another page. */
  readonly entries: readonly ProjectDiscoveryCard[];
  readonly facets: readonly ProjectDiscoveryFacet[];
}

export interface PublicDiscoveryReader {
  read(query: PublicDiscoveryReadQuery, transaction: TransactionContext): Promise<Result<PublicDiscoveryReadResult, Rejection>>;
}

export interface PublicDiscoveryService {
  getPublicDiscovery(query: PublicDiscoveryCriteria): Promise<Result<ProjectDiscoveryPage, Rejection>>;
}

interface CursorPayload {
  readonly v: 1;
  readonly locale: "en" | "ar";
  readonly taxonomyValueId: string | null;
  readonly firstPublishedAt: string;
  readonly projectId: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, locale: "en" | "ar", taxonomyValueId: string | null): CursorPayload | undefined {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return undefined;
    const value = decoded as Record<string, unknown>;
    if (Object.keys(value).sort().join(",") !== "firstPublishedAt,locale,projectId,taxonomyValueId,v" ||
      value["v"] !== 1 || value["locale"] !== locale || value["taxonomyValueId"] !== taxonomyValueId ||
      typeof value["firstPublishedAt"] !== "string" || !Number.isFinite(Date.parse(value["firstPublishedAt"])) ||
      new Date(value["firstPublishedAt"]).toISOString() !== value["firstPublishedAt"] ||
      typeof value["projectId"] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value["projectId"])) return undefined;
    return value as unknown as CursorPayload;
  } catch {
    return undefined;
  }
}

export function createPublicDiscoveryService(input: {
  readonly reader: PublicDiscoveryReader;
  readonly transactions: TransactionRunner;
}): PublicDiscoveryService {
  return {
    async getPublicDiscovery(query) {
      if (query.locale !== "en" && query.locale !== "ar") return err({ kind: "validation", code: "UNSUPPORTED_DISCOVERY_LOCALE" });
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return err({ kind: "validation", code: "INVALID_DISCOVERY_PAGE_SIZE" });
      const values = query.taxonomyValueIds ?? [];
      if (values.length > 1) return err({ kind: "validation", code: "INVALID_DISCOVERY_FILTER" });
      const taxonomyValueId = values[0];
      const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor, query.locale, taxonomyValueId ?? null);
      if (query.cursor !== undefined && cursor === undefined) return err({ kind: "validation", code: "INVALID_DISCOVERY_CURSOR" });

      return input.transactions.run(async (transaction) => {
        const result = await input.reader.read({
          locale: query.locale,
          limit: limit + 1,
          ...(taxonomyValueId === undefined ? {} : { taxonomyValueId }),
          ...(cursor === undefined ? {} : { after: { firstPublishedAt: cursor.firstPublishedAt, projectId: cursor.projectId as StableId<"Project"> } }),
        }, transaction);
        if (!result.ok) return result;
        const hasNext = result.value.entries.length > limit;
        const entries = result.value.entries.slice(0, limit);
        const last = entries.at(-1);
        const nextCursor = hasNext && last !== undefined ? encodeCursor({
          v: 1,
          locale: query.locale,
          taxonomyValueId: taxonomyValueId ?? null,
          firstPublishedAt: last.firstPublishedAt,
          projectId: last.projectId,
        }) : null;
        return { ok: true, value: { entries, facets: result.value.facets, nextCursor } };
      });
    },
  };
}
