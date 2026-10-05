import { sql } from "kysely";
import { err, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { ContentKind, CreateDraftPayload, SupportedLocale } from "../domain/index.js";
import type {
  AppendContentRevisionInput,
  ContentAuthoringRecord,
  ContentAuthoringRepository,
  ContentAuthoringRevision,
  ContentAuthoringScope,
  CreateContentPersistenceInput,
} from "../application/authoring.js";

interface RootRow {
  readonly content_id: string;
  readonly portfolio_id: string;
  readonly content_type: string;
  readonly lifecycle: string;
  readonly candidate_slug: string | null;
  readonly aggregate_version: number;
}

interface RevisionRow {
  readonly revision_id: string;
  readonly content_id: string;
  readonly content_type: string;
  readonly locale: string;
  readonly stream_sequence: number;
  readonly aggregate_version: number;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly payload: unknown;
  readonly saved_at: Date | string;
  readonly reviewed: boolean;
}

function isKind(value: string): value is ContentKind {
  return value === "project" || value === "achievement" || value === "testimonial";
}

function isLocale(value: string): value is SupportedLocale {
  return value === "en" || value === "ar";
}

function parsePayload(value: unknown, row: RevisionRow): CreateDraftPayload {
  let candidate = value;
  if (typeof candidate === "string") {
    try { candidate = JSON.parse(candidate) as unknown; } catch { throw new PostgresInfrastructureError(); }
  }
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw new PostgresInfrastructureError();
  const payload = candidate as Record<string, unknown>;
  if (!isKind(row.content_type) || payload["contentType"] !== row.content_type || payload["locale"] !== row.locale ||
      payload["title"] !== row.title || payload["summary"] !== row.summary || payload["body"] !== row.body) {
    throw new PostgresInfrastructureError();
  }
  if (row.content_type === "project" && payload["candidateSlug"] !== undefined && typeof payload["candidateSlug"] !== "string") throw new PostgresInfrastructureError();
  if (row.content_type === "achievement" && payload["achievedOn"] !== undefined && typeof payload["achievedOn"] !== "string") throw new PostgresInfrastructureError();
  if (row.content_type === "testimonial" && payload["authorName"] !== undefined && typeof payload["authorName"] !== "string") throw new PostgresInfrastructureError();
  if (!isLocale(row.locale)) throw new PostgresInfrastructureError();
  return payload as unknown as CreateDraftPayload;
}

function mapRevision(row: RevisionRow): ContentAuthoringRevision {
  if (!isKind(row.content_type) || !isLocale(row.locale)) throw new PostgresInfrastructureError();
  const savedAt = row.saved_at instanceof Date ? row.saved_at.toISOString() : new Date(row.saved_at).toISOString();
  if (!Number.isFinite(Date.parse(savedAt)) || !Number.isSafeInteger(row.stream_sequence) || row.stream_sequence < 1 ||
      !Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1) throw new PostgresInfrastructureError();
  return {
    revisionId: row.revision_id as StableId<"Revision">,
    contentId: row.content_id as StableId<string>,
    contentType: row.content_type,
    locale: row.locale,
    sequence: row.stream_sequence,
    aggregateVersion: row.aggregate_version,
    title: row.title,
    summary: row.summary,
    body: row.body,
    payload: parsePayload(row.payload, row),
    savedAt,
    reviewed: row.reviewed,
  };
}

async function setTrustedScope(context: TransactionContext, scope: ContentAuthoringScope): Promise<void> {
  const executor = resolvePostgresTransaction(context);
  await sql`
    select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
           set_config('shipwithali.owner_id', ${scope.ownerId}, true)
  `.execute(executor);
}

export function createPostgresContentAuthoringRepository(): ContentAuthoringRepository {
  async function getRecord(contentId: StableId<string>, scope: ContentAuthoringScope, context: TransactionContext): Promise<Result<ContentAuthoringRecord, Rejection>> {
    const executor = resolvePostgresTransaction(context);
    await setTrustedScope(context, scope);
    const selected = await sql<RootRow>`
      select content_id::text, portfolio_id::text, content_type, lifecycle, candidate_slug, aggregate_version
        from content.items
       where content_id = ${contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid
    `.execute(executor);
    const root = selected.rows[0];
    if (root === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
    if (!isKind(root.content_type) || !["draft", "published", "hidden", "archived"].includes(root.lifecycle) ||
        !Number.isSafeInteger(root.aggregate_version) || root.aggregate_version < 1) throw new PostgresInfrastructureError();
    const revisions = await sql<RevisionRow>`
      select revision.revision_id::text, revision.content_id::text,
             revision.content_type, revision.locale, revision.stream_sequence,
             revision.aggregate_version, revision.title, revision.summary,
             revision.body, revision.payload, revision.saved_at, revision.reviewed
        from content.revisions revision
        join content.items item
          on item.content_id = revision.content_id
         and item.portfolio_id = revision.portfolio_id
       where revision.content_id = ${contentId}::uuid
         and revision.portfolio_id = ${scope.portfolioId}::uuid
       order by revision.saved_at, revision.locale, revision.stream_sequence
    `.execute(executor);
    return {
      ok: true,
      value: {
        contentId: root.content_id as StableId<string>,
        portfolioId: root.portfolio_id as StableId<"Portfolio">,
        ownerId: scope.ownerId,
        contentType: root.content_type,
        lifecycle: root.lifecycle as ContentAuthoringRecord["lifecycle"],
        candidateSlug: root.candidate_slug,
        aggregateVersion: root.aggregate_version,
        revisions: revisions.rows.map(mapRevision),
      },
    };
  }

  return {
    async projectExists(projectId, scope, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const result = await sql<{ exists: boolean }>`
          select exists (
            select 1 from content.items
             where content_id = ${projectId}::uuid
               and portfolio_id = ${scope.portfolioId}::uuid
               and content_type = 'project'
          ) as exists
        `.execute(executor);
        return result.rows[0]?.exists === true;
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async create(input: CreateContentPersistenceInput, context: TransactionContext) {
      const executor = resolvePostgresTransaction(context);
      const scope = { portfolioId: input.portfolioId, ownerId: input.ownerId };
      try {
        await setTrustedScope(context, scope);
        const root = await sql<{ content_id: string }>`
          insert into content.items (content_id, portfolio_id, content_type, lifecycle, candidate_slug, aggregate_version)
          values (
            ${input.contentId}::uuid, ${input.portfolioId}::uuid,
            ${input.payload.contentType}, 'draft', ${input.candidateSlug}, 1
          )
          on conflict (content_id) do nothing
          returning content_id::text
        `.execute(executor);
        if (root.rows.length === 0) return err({ kind: "conflict", code: "CONTENT_ALREADY_EXISTS" });
        await sql`
          insert into content.revisions (
            revision_id, content_id, portfolio_id, content_type, locale, stream_sequence,
            aggregate_version, title, summary, body, payload, reviewed, saved_at
          ) values (
            ${input.revisionId}::uuid, ${input.contentId}::uuid, ${input.portfolioId}::uuid,
            ${input.payload.contentType}, ${input.payload.locale}, 1, 1, ${input.payload.title}, ${input.payload.summary},
            ${input.payload.body}, ${JSON.stringify(input.payload)}::jsonb, false, ${input.savedAt}::timestamptz
          )
        `.execute(executor);
        return await getRecord(input.contentId, scope, context);
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async get(contentId, scope, context) {
      try {
        return await getRecord(contentId, scope, context);
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async appendRevision(input: AppendContentRevisionInput, context: TransactionContext) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const updated = await sql<{ aggregate_version: number }>`
          update content.items
             set aggregate_version = aggregate_version + 1,
                 updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version
        `.execute(executor);
        const rootVersion = updated.rows[0]?.aggregate_version;
        if (rootVersion === undefined) {
          const current = await sql<{ aggregate_version: number }>`
            select aggregate_version from content.items
             where content_id = ${input.contentId}::uuid
               and portfolio_id = ${input.scope.portfolioId}::uuid
          `.execute(executor);
          const currentVersion = current.rows[0]?.aggregate_version;
          return currentVersion === undefined
            ? err({ kind: "not_found", code: "CONTENT_NOT_FOUND" })
            : err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion });
        }
        const maxSequence = await sql<{ next_sequence: number }>`
          select coalesce(max(stream_sequence), 0)::integer + 1 as next_sequence
            from content.revisions
           where content_id = ${input.contentId}::uuid and locale = ${input.payload.locale}
        `.execute(executor);
        const sequence = maxSequence.rows[0]?.next_sequence;
        if (sequence === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.revisions (
            revision_id, content_id, portfolio_id, content_type, locale, stream_sequence,
            aggregate_version, title, summary, body, payload, reviewed, saved_at
          ) values (
            ${input.revisionId}::uuid, ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid,
            ${input.payload.contentType}, ${input.payload.locale}, ${sequence}, ${rootVersion}, ${input.payload.title},
            ${input.payload.summary}, ${input.payload.body}, ${JSON.stringify(input.payload)}::jsonb,
            false, ${input.savedAt}::timestamptz
          )
        `.execute(executor);
        const record = await getRecord(input.contentId, input.scope, context);
        if (!record.ok) return record;
        const revision = record.value.revisions.find((entry) => entry.revisionId === input.revisionId);
        if (revision === undefined) throw new PostgresInfrastructureError();
        return { ok: true, value: { record: record.value, revision } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
