import { sql } from "kysely";
import { err, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { ContentKind, CreateDraftPayload, SupportedLocale } from "../domain/index.js";
import type { PublishTestimonialLanguageInput } from "../application/authoring.js";
import type {
  AppendContentRevisionInput,
  ContentAuthoringRecord,
  ContentAuthoringRepository,
  ContentAuthoringReview,
  ContentAuthoringPublication,
  ContentAuthoringRevision,
  ContentAuthoringScope,
  CreateContentPersistenceInput,
  PublishAchievementLanguageInput,
  PublishAchievementLanguageResult,
  PublishProjectLanguageInput,
  PublishProjectLanguageResult,
  PublicAchievementTimelineEntry,
  PublicProjectContentView,
  ContentPublicRouteFacts,
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
  readonly latest_review_id: string | null;
  readonly latest_review_content_type: string | null;
  readonly latest_review_locale: string | null;
  readonly latest_review_sequence: number | null;
  readonly latest_review_snapshot_hash: string | null;
  readonly latest_review_evidence_version: number | null;
  readonly latest_review_reviewer_id: string | null;
  readonly latest_review_decision: string | null;
  readonly latest_review_findings: unknown;
  readonly latest_reviewed_at: Date | string | null;
}

function isKind(value: string): value is ContentKind {
  return value === "project" || value === "achievement" || value === "testimonial";
}

function isLocale(value: string): value is SupportedLocale {
  return value === "en" || value === "ar";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const latestReview = row.latest_review_id === null ? undefined : mapReview(row);
  return {
    revisionId: row.revision_id as StableId<"Revision">,
    contentId: row.content_id as StableId<string>,
    contentType: row.content_type,
    locale: row.locale,
    sequence: row.stream_sequence,
    aggregateVersion: row.aggregate_version,
    evidenceSnapshotVersion: row.aggregate_version,
    title: row.title,
    summary: row.summary,
    body: row.body,
    payload: parsePayload(row.payload, row),
    savedAt,
    reviewed: latestReview !== undefined,
    ...(latestReview === undefined ? {} : { reviewDecision: latestReview.decision, latestReview }),
  };
}

function mapReview(row: RevisionRow): ContentAuthoringReview {
  if (!isKind(row.content_type) || !isLocale(row.locale) || row.latest_review_id === null ||
      row.latest_review_content_type !== row.content_type || row.latest_review_locale !== row.locale ||
      row.latest_review_sequence === null || row.latest_review_snapshot_hash === null ||
      row.latest_review_evidence_version === null || row.latest_review_reviewer_id === null ||
      (row.latest_review_decision !== "accepted" && row.latest_review_decision !== "rejected") || row.latest_reviewed_at === null) {
    throw new PostgresInfrastructureError();
  }
  let findings = row.latest_review_findings;
  if (typeof findings === "string") {
    try { findings = JSON.parse(findings) as unknown; } catch { throw new PostgresInfrastructureError(); }
  }
  if (!Array.isArray(findings) || !findings.every((finding) => typeof finding === "string")) throw new PostgresInfrastructureError();
  const reviewedAt = row.latest_reviewed_at instanceof Date ? row.latest_reviewed_at.toISOString() : new Date(row.latest_reviewed_at).toISOString();
  if (!Number.isFinite(Date.parse(reviewedAt)) || !/^[0-9a-f]{64}$/.test(row.latest_review_snapshot_hash) ||
      !Number.isSafeInteger(row.latest_review_evidence_version) || row.latest_review_evidence_version < 1 ||
      !Number.isSafeInteger(row.latest_review_sequence) || row.latest_review_sequence < 1) throw new PostgresInfrastructureError();
  return {
    reviewId: row.latest_review_id as StableId<"ContentReview">,
    revisionId: row.revision_id as StableId<"Revision">,
    contentId: row.content_id as StableId<string>,
    contentType: row.content_type,
    locale: row.locale,
    snapshotHash: row.latest_review_snapshot_hash,
    evidenceVersion: row.latest_review_evidence_version,
    reviewerId: row.latest_review_reviewer_id as StableId<"Owner">,
    reviewSequence: row.latest_review_sequence,
    decision: row.latest_review_decision,
    findings,
    reviewedAt,
  };
}

async function setTrustedScope(context: TransactionContext, scope: ContentAuthoringScope): Promise<void> {
  const executor = resolvePostgresTransaction(context);
  await sql`
    select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
           set_config('shipwithali.owner_id', ${scope.ownerId}, true)
  `.execute(executor);
}

function latestReviewForRevision() {
  return sql`
    select review_id, content_type, locale, review_sequence, snapshot_hash, evidence_version, reviewer_id,
           decision, findings, reviewed_at
      from content.revision_reviews review
     where review.revision_id = revision.revision_id
       and review.content_id = revision.content_id
       and review.portfolio_id = revision.portfolio_id
     order by review.review_sequence desc
     limit 1
  `;
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
             revision.body, revision.payload, revision.saved_at,
             (latest.review_id is not null) as reviewed,
             latest.review_id::text as latest_review_id,
             latest.content_type as latest_review_content_type,
             latest.locale as latest_review_locale,
             latest.review_sequence as latest_review_sequence,
             latest.snapshot_hash as latest_review_snapshot_hash,
             latest.evidence_version as latest_review_evidence_version,
             latest.reviewer_id::text as latest_review_reviewer_id,
             latest.decision as latest_review_decision,
             latest.findings as latest_review_findings,
             latest.reviewed_at as latest_reviewed_at
        from content.revisions revision
        join content.items item
          on item.content_id = revision.content_id
         and item.portfolio_id = revision.portfolio_id
        left join lateral (${latestReviewForRevision()}) latest on true
       where revision.content_id = ${contentId}::uuid
         and revision.portfolio_id = ${scope.portfolioId}::uuid
       order by revision.locale, revision.stream_sequence
    `.execute(executor);
    const publications = await sql<{ locale: string; revision_id: string; published_at: Date | string }>`
      select locale, revision_id::text, published_at
        from content.language_publications
       where content_id = ${contentId}::uuid
         and portfolio_id = ${scope.portfolioId}::uuid
       order by locale
    `.execute(executor);
    const mappedPublications: ContentAuthoringPublication[] = publications.rows.map((row) => {
      if (!isLocale(row.locale)) throw new PostgresInfrastructureError();
      const publishedAt = row.published_at instanceof Date ? row.published_at.toISOString() : new Date(row.published_at).toISOString();
      if (!Number.isFinite(Date.parse(publishedAt))) throw new PostgresInfrastructureError();
      return { locale: row.locale, revisionId: row.revision_id as StableId<"Revision">, publishedAt };
    });
    const routeResult = root.content_type === "project" && mappedPublications.length > 0 ? await sql<{
      route_identity: string; current_slug: string; normalized_slug: string; is_current: boolean;
    }>`
      select route.route_identity::text, route.current_slug, reservation.normalized_slug, reservation.is_current
        from content.public_routes route
        join content.public_route_reservations reservation
          on reservation.route_identity = route.route_identity
         and reservation.content_id = route.content_id
         and reservation.portfolio_id = route.portfolio_id
       where route.content_id = ${contentId}::uuid and route.portfolio_id = ${scope.portfolioId}::uuid
       order by reservation.normalized_slug
    `.execute(executor) : { rows: [] };
    const routeIdentity = routeResult.rows[0]?.route_identity;
    const routeHistoryResult = routeIdentity !== undefined ? await sql<{
      sequence: number; from_slug: string; to_slug: string; changed_at: Date | string;
    }>`
      select sequence, from_slug, to_slug, changed_at
        from content.public_route_history
       where content_id = ${contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid
       order by sequence
    `.execute(executor) : { rows: [] };
    if (routeIdentity !== undefined && routeResult.rows.some((row) => row.route_identity !== routeIdentity || row.current_slug !== routeResult.rows[0]?.current_slug)) {
      throw new PostgresInfrastructureError();
    }
    const currentSlug = routeResult.rows[0]?.current_slug;
    const publicRoute: ContentPublicRouteFacts | null = routeIdentity === undefined || currentSlug === undefined ? null : {
      identity: routeIdentity as StableId<"PublicRoute">,
      canonicalSlug: currentSlug,
      redirects: routeResult.rows.filter((row) => !row.is_current).map((row) => ({ fromSlug: row.normalized_slug, toSlug: currentSlug })),
      history: routeHistoryResult.rows.map((row) => {
        const changedAt = row.changed_at instanceof Date ? row.changed_at.toISOString() : new Date(row.changed_at).toISOString();
        if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
        return { sequence: row.sequence, fromSlug: row.from_slug, toSlug: row.to_slug, changedAt };
      }),
    };
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
        publications: mappedPublications,
        publicRoute,
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

    async correctCandidateSlug(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selected = await sql<{ content_type: string; lifecycle: string; aggregate_version: number }>`
          select content_type, lifecycle, aggregate_version
            from content.items
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const root = selected.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        if (root.content_type !== "project") return err({ kind: "validation", code: "CONTENT_TYPE_NOT_PROJECT" });
        if (root.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        if (root.lifecycle !== "draft" && root.lifecycle !== "archived") return err({ kind: "validation", code: "PROJECT_CANDIDATE_SLUG_NOT_EDITABLE" });
        const route = await sql<{ route_identity: string }>`
          select route_identity::text from content.public_routes
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        if (route.rows[0] !== undefined) return err({ kind: "validation", code: "PROJECT_CANDIDATE_SLUG_NOT_EDITABLE" });
        const updated = await sql<{ aggregate_version: number }>`
          update content.items
             set candidate_slug = ${input.slug}, aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version
        `.execute(executor);
        const aggregateVersion = updated.rows[0]?.aggregate_version;
        if (aggregateVersion === undefined) throw new PostgresInfrastructureError();
        return { ok: true, value: { aggregateVersion } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async changePublicSlug(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selected = await sql<{ content_type: string; aggregate_version: number }>`
          select content_type, aggregate_version from content.items
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const root = selected.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        if (root.content_type !== "project") return err({ kind: "validation", code: "CONTENT_TYPE_NOT_PROJECT" });
        if (root.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        const route = await sql<{ route_identity: string; current_slug: string }>`
          select route_identity::text, current_slug from content.public_routes
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const current = route.rows[0];
        if (current === undefined) return err({ kind: "validation", code: "PROJECT_PUBLIC_ROUTE_REQUIRED" });
        const claimed = await sql<{ normalized_slug: string }>`
          insert into content.public_route_reservations
            (portfolio_id, content_type, normalized_slug, route_identity, content_id, is_current)
          values (${input.scope.portfolioId}::uuid, 'project', ${input.slug}, ${current.route_identity}::uuid, ${input.contentId}::uuid, true)
          on conflict (portfolio_id, content_type, normalized_slug) do nothing
          returning normalized_slug
        `.execute(executor);
        if (claimed.rows[0] === undefined) {
          const existingReservation = await sql<{ route_identity: string; content_id: string }>`
            select route_identity::text, content_id::text
              from content.public_route_reservations
             where portfolio_id = ${input.scope.portfolioId}::uuid
               and content_type = 'project' and normalized_slug = ${input.slug}
          `.execute(executor);
          const reservation = existingReservation.rows[0];
          if (reservation === undefined || reservation.route_identity !== current.route_identity || reservation.content_id !== input.contentId) {
            return err({ kind: "conflict", code: "PUBLIC_SLUG_CONFLICT" });
          }
          await sql`
            update content.public_route_reservations set is_current = true
             where route_identity = ${current.route_identity}::uuid and normalized_slug = ${input.slug}
          `.execute(executor);
        }
        await sql`
          update content.public_route_reservations set is_current = false
           where route_identity = ${current.route_identity}::uuid and normalized_slug <> ${input.slug}
        `.execute(executor);
        if (current.current_slug !== input.slug) {
          const sequence = await sql<{ value: number }>`
            select coalesce(max(sequence), 0)::integer + 1 as value
              from content.public_route_history where route_identity = ${current.route_identity}::uuid
          `.execute(executor);
          const next = sequence.rows[0]?.value;
          if (next === undefined) throw new PostgresInfrastructureError();
          await sql`
            insert into content.public_route_history
              (route_identity, content_id, portfolio_id, sequence, from_slug, to_slug, changed_at)
            values (${current.route_identity}::uuid, ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid,
              ${next}, ${current.current_slug}, ${input.slug}, transaction_timestamp())
          `.execute(executor);
        }
        await sql`
          update content.public_routes set current_slug = ${input.slug}
           where route_identity = ${current.route_identity}::uuid and content_id = ${input.contentId}::uuid
        `.execute(executor);
        const updated = await sql<{ aggregate_version: number }>`
          update content.items set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version
        `.execute(executor);
        const aggregateVersion = updated.rows[0]?.aggregate_version;
        if (aggregateVersion === undefined) throw new PostgresInfrastructureError();
        return { ok: true, value: { aggregateVersion, previousSlug: current.current_slug, routeIdentity: current.route_identity as StableId<"PublicRoute"> } };
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

    async appendReview(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selectedRevision = await sql<{ content_type: string }>`
          select revision.content_type from content.revisions revision
           where revision.revision_id = ${input.revisionId}::uuid
             and revision.content_id = ${input.contentId}::uuid
             and revision.portfolio_id = ${input.scope.portfolioId}::uuid
             and revision.locale = ${input.locale}
             and revision.aggregate_version = ${input.evidenceVersion}
        `.execute(executor);
        const revisionType = selectedRevision.rows[0]?.content_type;
        if (revisionType === undefined) return err({ kind: "not_found", code: "REVISION_NOT_FOUND" });
        const updated = await sql<{ aggregate_version: number; content_type: string }>`
          update content.items
             set aggregate_version = aggregate_version + 1,
                 updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version, content_type
        `.execute(executor);
        const root = updated.rows[0];
        if (root === undefined) {
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
        if (revisionType !== root.content_type) throw new PostgresInfrastructureError();
        const sequence = await sql<{ next_sequence: number }>`
          select coalesce(max(review_sequence), 0)::integer + 1 as next_sequence
            from content.revision_reviews
           where revision_id = ${input.revisionId}::uuid
        `.execute(executor);
        const reviewSequence = sequence.rows[0]?.next_sequence;
        if (reviewSequence === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.revision_reviews (
            review_id, content_id, portfolio_id, content_type, revision_id, locale,
            review_sequence, snapshot_hash, evidence_version, reviewer_id, decision,
            findings, reviewed_at
          ) values (
            ${input.reviewId}::uuid, ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid,
            ${root.content_type}, ${input.revisionId}::uuid, ${input.locale}, ${reviewSequence},
            ${input.snapshotHash}, ${input.evidenceVersion}, ${input.reviewerId}::uuid,
            ${input.decision}, ${JSON.stringify(input.findings)}::jsonb, ${input.reviewedAt}::timestamptz
          )
        `.execute(executor);
        return { ok: true, value: { aggregateVersion: root.aggregate_version } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async publishProjectLanguage(input: PublishProjectLanguageInput, context: TransactionContext) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selectedRoot = await sql<{
          content_type: string; lifecycle: string; candidate_slug: string | null;
          aggregate_version: number; first_published_at: Date | string | null;
        }>`
          select content_type, lifecycle, candidate_slug, aggregate_version, first_published_at
            from content.items
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const root = selectedRoot.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        if (root.aggregate_version !== input.expectedVersion) {
          return err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        }
        if (root.content_type !== "project") return err({ kind: "validation", code: "CONTENT_TYPE_NOT_PUBLISHABLE" });
        if (root.lifecycle !== "draft" && root.lifecycle !== "published") return err({ kind: "validation", code: "CONTENT_LIFECYCLE_NOT_PUBLISHABLE" });
        if (root.candidate_slug === null) return err({ kind: "validation", code: "PROJECT_CANDIDATE_SLUG_REQUIRED" });

        const selected = await sql<{ review_id: string; snapshot_hash: string; evidence_version: number; decision: string; reviewer_id: string }>`
          select review.review_id::text, review.snapshot_hash, review.evidence_version,
                 review.decision, review.reviewer_id::text
            from content.revisions revision
            join lateral (
              select review_id, snapshot_hash, evidence_version, decision, reviewer_id
                from content.revision_reviews review
               where review.revision_id = revision.revision_id
                 and review.content_id = revision.content_id
                 and review.portfolio_id = revision.portfolio_id
               order by review.review_sequence desc
               limit 1
            ) review on true
           where revision.revision_id = ${input.revisionId}::uuid
             and revision.content_id = ${input.contentId}::uuid
             and revision.portfolio_id = ${input.scope.portfolioId}::uuid
             and revision.content_type = 'project'
             and revision.locale = ${input.locale}
        `.execute(executor);
        const review = selected.rows[0];
        if (review === undefined) return err({ kind: "not_found", code: "REVISION_NOT_FOUND" });
        if (review.review_id !== input.reviewId || review.decision !== "accepted" || review.reviewer_id !== input.scope.ownerId ||
            review.snapshot_hash !== input.snapshotHash) return err({ kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" });

        const existingRoute = await sql<{ route_identity: string; current_slug: string; first_published_at: Date | string }>`
          select route_identity::text, current_slug, first_published_at
            from content.public_routes
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        let routeIdentity: StableId<"PublicRoute">;
        let currentSlug: string;
        let routeFirstPublishedAt: Date | string;
        if (existingRoute.rows[0] !== undefined) {
          routeIdentity = existingRoute.rows[0].route_identity as StableId<"PublicRoute">;
          currentSlug = existingRoute.rows[0].current_slug;
          routeFirstPublishedAt = existingRoute.rows[0].first_published_at;
        } else {
          routeIdentity = input.routeIdentity;
          currentSlug = root.candidate_slug;
          const transactionTime = await sql<{ value: Date | string }>`select transaction_timestamp() as value`.execute(executor);
          const firstTime = root.first_published_at ?? transactionTime.rows[0]?.value;
          if (firstTime === undefined) throw new PostgresInfrastructureError();
          const reservation = await sql<{ normalized_slug: string }>`
            insert into content.public_route_reservations (portfolio_id, content_type, normalized_slug, route_identity, content_id, is_current)
            values (${input.scope.portfolioId}::uuid, 'project', ${currentSlug}, ${routeIdentity}::uuid, ${input.contentId}::uuid, true)
            on conflict (portfolio_id, content_type, normalized_slug) do nothing
            returning normalized_slug
          `.execute(executor);
          if (reservation.rows[0] === undefined) {
            return err({ kind: "conflict", code: "PUBLIC_SLUG_CONFLICT" });
          }
          await sql`
            insert into content.public_routes (route_identity, content_id, portfolio_id, content_type, current_slug, first_published_at)
            values (${routeIdentity}::uuid, ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'project', ${currentSlug}, ${firstTime}::timestamptz)
          `.execute(executor);
          routeFirstPublishedAt = firstTime;
        }
        const firstPublishedAt = root.first_published_at ?? routeFirstPublishedAt;
        const updatedRoot = await sql<{ aggregate_version: number; first_published_at: Date | string }>`
          update content.items
             set lifecycle = 'published',
                 first_published_at = coalesce(first_published_at, transaction_timestamp()),
                 aggregate_version = aggregate_version + 1,
                 updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version, first_published_at
        `.execute(executor);
        const updated = updatedRoot.rows[0];
        if (updated === undefined) throw new PostgresInfrastructureError();
        const pointer = await sql<{ publication_sequence: number }>`
          select coalesce(max(publication_sequence), 0)::integer + 1 as publication_sequence
            from content.publication_history
           where content_id = ${input.contentId}::uuid and locale = ${input.locale}
        `.execute(executor);
        const sequence = pointer.rows[0]?.publication_sequence;
        if (sequence === undefined) throw new PostgresInfrastructureError();

        await sql`
          insert into content.publication_history (
            content_id, portfolio_id, content_type, locale, publication_sequence,
            revision_id, review_id, route_identity, published_at, media_facts_version
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'project', ${input.locale}, ${sequence},
            ${input.revisionId}::uuid, ${input.reviewId}::uuid, ${routeIdentity}::uuid, transaction_timestamp(), ${input.mediaFactsVersion}
          )
        `.execute(executor);
        await sql`
          insert into content.language_publications (
            content_id, portfolio_id, content_type, locale, revision_id, review_id,
            route_identity, publication_sequence, published_at, media_facts_version
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'project', ${input.locale},
            ${input.revisionId}::uuid, ${input.reviewId}::uuid, ${routeIdentity}::uuid, ${sequence}, transaction_timestamp(), ${input.mediaFactsVersion}
          )
          on conflict (content_id, locale) do update set
            revision_id = excluded.revision_id,
            review_id = excluded.review_id,
            route_identity = excluded.route_identity,
            publication_sequence = excluded.publication_sequence,
            published_at = excluded.published_at,
            media_facts_version = excluded.media_facts_version
        `.execute(executor);
        const artifactById = new Map((input.payload.evidence?.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
        const claims = (input.payload.evidence?.claims ?? []).map((claim) => ({
          text: claim.text,
          artifacts: claim.artifactIds.map((id) => {
            const artifact = artifactById.get(id);
            if (artifact === undefined) throw new PostgresInfrastructureError();
            return {
              title: artifact.title,
              ...(artifact.destinationUrl === undefined ? {} : { destinationUrl: artifact.destinationUrl }),
              ...(artifact.mediaAssetId === undefined ? {} : { mediaAssetId: artifact.mediaAssetId }),
            };
          }),
        }));
        const links = (input.payload.externalLinks ?? [])
          .filter((link) => input.locale === "en" || link.isAvailableInArabic)
          .map(({ label, destination }) => ({ label, destination }));
        await sql`
          insert into content.public_project_locales (
            content_id, portfolio_id, content_type, locale, revision_id, route_identity,
            title, summary, body, case_study, claims, external_links,
            first_published_at, published_at, updated_at
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'project', ${input.locale},
            ${input.revisionId}::uuid, ${routeIdentity}::uuid, ${input.payload.title}, ${input.payload.summary},
            ${input.payload.body}, ${JSON.stringify(input.payload.caseStudy)}::jsonb, ${JSON.stringify(claims)}::jsonb,
            ${JSON.stringify(links)}::jsonb, ${firstPublishedAt}::timestamptz, transaction_timestamp(), transaction_timestamp()
          )
          on conflict (content_id, locale) do update set
            revision_id = excluded.revision_id,
            route_identity = excluded.route_identity,
            title = excluded.title,
            summary = excluded.summary,
            body = excluded.body,
            case_study = excluded.case_study,
            claims = excluded.claims,
            external_links = excluded.external_links,
            published_at = excluded.published_at,
            updated_at = transaction_timestamp()
        `.execute(executor);
        const published = await sql<{ published_at: Date | string }>`
          select published_at from content.language_publications
           where content_id = ${input.contentId}::uuid and locale = ${input.locale}
        `.execute(executor);
        const publishedAt = published.rows[0]?.published_at;
        if (publishedAt === undefined) throw new PostgresInfrastructureError();
        return { ok: true, value: {
          aggregateVersion: updated.aggregate_version,
          revisionId: input.revisionId,
          locale: input.locale,
          routeIdentity,
          currentSlug,
          firstPublishedAt: updated.first_published_at instanceof Date ? updated.first_published_at.toISOString() : new Date(updated.first_published_at).toISOString(),
          publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : new Date(publishedAt).toISOString(),
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async publishTestimonialLanguage(input: PublishTestimonialLanguageInput, context: TransactionContext) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selectedRoot = await sql<{
          content_type: string; lifecycle: string; aggregate_version: number; first_published_at: Date | string | null;
        }>`
          select content_type, lifecycle, aggregate_version, first_published_at
            from content.items
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const root = selectedRoot.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        if (root.aggregate_version !== input.expectedVersion) {
          return err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        }
        if (root.content_type !== "testimonial") return err({ kind: "validation", code: "CONTENT_TYPE_NOT_PUBLISHABLE" });
        if (root.lifecycle !== "draft" && root.lifecycle !== "published") return err({ kind: "validation", code: "CONTENT_LIFECYCLE_NOT_PUBLISHABLE" });

        const selected = await sql<{ review_id: string; snapshot_hash: string; decision: string; reviewer_id: string }>`
          select review.review_id::text, review.snapshot_hash, review.decision, review.reviewer_id::text
            from content.revisions revision
            join lateral (
              select review_id, snapshot_hash, decision, reviewer_id
                from content.revision_reviews review
               where review.revision_id = revision.revision_id
                 and review.content_id = revision.content_id
                 and review.portfolio_id = revision.portfolio_id
               order by review.review_sequence desc
               limit 1
            ) review on true
           where revision.revision_id = ${input.revisionId}::uuid
             and revision.content_id = ${input.contentId}::uuid
             and revision.portfolio_id = ${input.scope.portfolioId}::uuid
             and revision.content_type = 'testimonial'
             and revision.locale = ${input.locale}
        `.execute(executor);
        const review = selected.rows[0];
        if (review === undefined) return err({ kind: "not_found", code: "REVISION_NOT_FOUND" });
        if (review.review_id !== input.reviewId || review.decision !== "accepted" || review.reviewer_id !== input.scope.ownerId ||
            review.snapshot_hash !== input.snapshotHash) return err({ kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" });

        const updatedRoot = await sql<{ aggregate_version: number; first_published_at: Date | string }>`
          update content.items
             set lifecycle = 'published',
                 first_published_at = coalesce(first_published_at, transaction_timestamp()),
                 aggregate_version = aggregate_version + 1,
                 updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version, first_published_at
        `.execute(executor);
        const updated = updatedRoot.rows[0];
        if (updated === undefined) throw new PostgresInfrastructureError();
        const pointer = await sql<{ publication_sequence: number }>`
          select coalesce(max(publication_sequence), 0)::integer + 1 as publication_sequence
            from content.testimonial_publication_history
           where content_id = ${input.contentId}::uuid and locale = ${input.locale}
        `.execute(executor);
        const sequence = pointer.rows[0]?.publication_sequence;
        if (sequence === undefined) throw new PostgresInfrastructureError();

        await sql`
          insert into content.testimonial_publication_history (
            content_id, portfolio_id, content_type, locale, publication_sequence,
            revision_id, review_id, published_at
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'testimonial', ${input.locale}, ${sequence},
            ${input.revisionId}::uuid, ${input.reviewId}::uuid, transaction_timestamp()
          )
        `.execute(executor);
        await sql`
          insert into content.testimonial_language_publications (
            content_id, portfolio_id, content_type, locale, revision_id, review_id,
            publication_sequence, published_at
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'testimonial', ${input.locale},
            ${input.revisionId}::uuid, ${input.reviewId}::uuid, ${sequence}, transaction_timestamp()
          )
          on conflict (content_id, locale) do update set
            revision_id = excluded.revision_id,
            review_id = excluded.review_id,
            publication_sequence = excluded.publication_sequence,
            published_at = excluded.published_at
        `.execute(executor);

        const association = input.payload.association ?? (input.payload.relatedProjectId === undefined
          ? { type: "profile" as const }
          : { type: "project" as const, projectId: input.payload.relatedProjectId });
        await sql`
          insert into content.public_testimonial_locales (
            content_id, portfolio_id, content_type, locale, revision_id, author_name, quote,
            association_type, project_id, published_at, updated_at
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'testimonial', ${input.locale},
            ${input.revisionId}::uuid, ${input.payload.authorName}, ${input.payload.quote},
            ${association.type}, ${association.type === "project" ? association.projectId : null}::uuid,
            transaction_timestamp(), transaction_timestamp()
          )
          on conflict (content_id, locale) do update set
            revision_id = excluded.revision_id,
            author_name = excluded.author_name,
            quote = excluded.quote,
            association_type = excluded.association_type,
            project_id = excluded.project_id,
            published_at = excluded.published_at,
            updated_at = transaction_timestamp()
        `.execute(executor);
        const published = await sql<{ published_at: Date | string }>`
          select published_at from content.testimonial_language_publications
           where content_id = ${input.contentId}::uuid and locale = ${input.locale}
        `.execute(executor);
        const publishedAt = published.rows[0]?.published_at;
        if (publishedAt === undefined) throw new PostgresInfrastructureError();
        return { ok: true, value: {
          aggregateVersion: updated.aggregate_version,
          revisionId: input.revisionId,
          locale: input.locale,
          firstPublishedAt: updated.first_published_at instanceof Date ? updated.first_published_at.toISOString() : new Date(updated.first_published_at).toISOString(),
          publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : new Date(publishedAt).toISOString(),
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async publishAchievementLanguage(input: PublishAchievementLanguageInput, context: TransactionContext) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selectedRoot = await sql<{ content_type: string; lifecycle: string; aggregate_version: number; first_published_at: Date | string | null }>`
          select content_type, lifecycle, aggregate_version, first_published_at
            from content.items
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const root = selectedRoot.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        if (root.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        if (root.content_type !== "achievement") return err({ kind: "validation", code: "CONTENT_TYPE_NOT_PUBLISHABLE" });
        if (root.lifecycle !== "draft" && root.lifecycle !== "published") return err({ kind: "validation", code: "CONTENT_LIFECYCLE_NOT_PUBLISHABLE" });

        const selected = await sql<{ review_id: string; snapshot_hash: string; decision: string; reviewer_id: string }>`
          select review.review_id::text, review.snapshot_hash, review.decision, review.reviewer_id::text
            from content.revisions revision
            join lateral (
              select review_id, snapshot_hash, decision, reviewer_id
                from content.revision_reviews review
               where review.revision_id = revision.revision_id
                 and review.content_id = revision.content_id
                 and review.portfolio_id = revision.portfolio_id
               order by review.review_sequence desc limit 1
            ) review on true
           where revision.revision_id = ${input.revisionId}::uuid
             and revision.content_id = ${input.contentId}::uuid
             and revision.portfolio_id = ${input.scope.portfolioId}::uuid
             and revision.content_type = 'achievement' and revision.locale = ${input.locale}
        `.execute(executor);
        const review = selected.rows[0];
        if (review === undefined) return err({ kind: "not_found", code: "REVISION_NOT_FOUND" });
        if (review.review_id !== input.reviewId || review.decision !== "accepted" || review.reviewer_id !== input.scope.ownerId || review.snapshot_hash !== input.snapshotHash) {
          return err({ kind: "validation", code: "ACCEPTED_REVISION_REVIEW_REQUIRED" });
        }

        const time = await sql<{ value: Date | string }>`select transaction_timestamp() as value`.execute(executor);
        const transactionTime = time.rows[0]?.value;
        if (transactionTime === undefined) throw new PostgresInfrastructureError();
        const firstPublishedAt = root.first_published_at ?? transactionTime;
        const updatedRoot = await sql<{ aggregate_version: number; first_published_at: Date | string }>`
          update content.items
             set lifecycle = 'published', first_published_at = coalesce(first_published_at, transaction_timestamp()),
                 aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version, first_published_at
        `.execute(executor);
        const updated = updatedRoot.rows[0];
        if (updated === undefined) throw new PostgresInfrastructureError();
        const sequenceResult = await sql<{ publication_sequence: number }>`
          select coalesce(max(publication_sequence), 0)::integer + 1 as publication_sequence
            from content.publication_history where content_id = ${input.contentId}::uuid and locale = ${input.locale}
        `.execute(executor);
        const sequence = sequenceResult.rows[0]?.publication_sequence;
        if (sequence === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.publication_history (
            content_id, portfolio_id, content_type, locale, publication_sequence,
            revision_id, review_id, route_identity, published_at, media_facts_version
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'achievement', ${input.locale}, ${sequence},
            ${input.revisionId}::uuid, ${input.reviewId}::uuid, null, transaction_timestamp(), ${input.mediaFactsVersion}
          )
        `.execute(executor);
        await sql`
          insert into content.language_publications (
            content_id, portfolio_id, content_type, locale, revision_id, review_id,
            route_identity, publication_sequence, published_at, media_facts_version
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'achievement', ${input.locale},
            ${input.revisionId}::uuid, ${input.reviewId}::uuid, null, ${sequence}, transaction_timestamp(), ${input.mediaFactsVersion}
          )
          on conflict (content_id, locale) do update set
            revision_id = excluded.revision_id, review_id = excluded.review_id,
            route_identity = null, publication_sequence = excluded.publication_sequence,
            published_at = excluded.published_at, media_facts_version = excluded.media_facts_version
        `.execute(executor);
        const artifactsById = new Map((input.payload.evidence?.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
        const publicArtifacts = (input.payload.evidence?.claims ?? []).flatMap((claim) => claim.artifactIds.map((id) => {
          const artifact = artifactsById.get(id);
          if (artifact === undefined) throw new PostgresInfrastructureError();
          return { title: artifact.title, ...(artifact.destinationUrl === undefined ? {} : { destinationUrl: artifact.destinationUrl }),
            ...(artifact.mediaAssetId === undefined ? {} : { mediaAssetId: artifact.mediaAssetId }) };
        }));
        const uniqueArtifacts = [...new Map(publicArtifacts.map((artifact) => [JSON.stringify(artifact), artifact])).values()];
        await sql`
          insert into content.public_achievement_locales (
            content_id, portfolio_id, content_type, locale, revision_id, achieved_on,
            title, summary, body, artifacts, first_published_at, published_at, updated_at
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'achievement', ${input.locale},
            ${input.revisionId}::uuid, ${input.payload.achievedOn}::date, ${input.payload.title}, ${input.payload.summary},
            ${input.payload.body}, ${JSON.stringify(uniqueArtifacts)}::jsonb, ${firstPublishedAt}::timestamptz,
            transaction_timestamp(), transaction_timestamp()
          )
          on conflict (content_id, locale) do update set
            revision_id = excluded.revision_id, achieved_on = excluded.achieved_on,
            title = excluded.title, summary = excluded.summary, body = excluded.body,
            artifacts = excluded.artifacts, published_at = excluded.published_at, updated_at = transaction_timestamp()
        `.execute(executor);
        const published = await sql<{ published_at: Date | string }>`
          select published_at from content.language_publications where content_id = ${input.contentId}::uuid and locale = ${input.locale}
        `.execute(executor);
        const publishedAt = published.rows[0]?.published_at;
        if (publishedAt === undefined) throw new PostgresInfrastructureError();
        return { ok: true, value: {
          aggregateVersion: updated.aggregate_version, revisionId: input.revisionId, locale: input.locale,
          firstPublishedAt: firstPublishedAt instanceof Date ? firstPublishedAt.toISOString() : new Date(firstPublishedAt).toISOString(),
          publishedAt: publishedAt instanceof Date ? publishedAt.toISOString() : new Date(publishedAt).toISOString(),
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async getPublicTestimonials(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const testimonialPublicationJoin = sql`
          from content.testimonial_language_publications publication
          join content.items item
            on item.content_id = publication.content_id and item.portfolio_id = publication.portfolio_id
           and item.content_type = 'testimonial' and item.lifecycle = 'published'
          join content.public_testimonial_locales projection
            on projection.content_id = publication.content_id and projection.portfolio_id = publication.portfolio_id
           and projection.locale = publication.locale and projection.revision_id = publication.revision_id
        `;
        const result = input.association.type === "profile"
          ? await sql<{
              content_id: string; revision_id: string; locale: string; author_name: string; quote: string; project_id: string | null; published_at: Date | string;
            }>`
              select item.content_id::text, publication.revision_id::text, publication.locale,
                     projection.author_name, projection.quote, null::text as project_id, publication.published_at
                ${testimonialPublicationJoin}
               where publication.portfolio_id = ${input.scope.portfolioId}::uuid
                 and publication.locale = ${input.locale}
                 and projection.association_type = 'profile' and projection.project_id is null
               order by publication.published_at desc, item.content_id
            `.execute(executor)
          : await sql<{
              content_id: string; revision_id: string; locale: string; author_name: string; quote: string; project_id: string | null; published_at: Date | string;
            }>`
              select item.content_id::text, publication.revision_id::text, publication.locale,
                     projection.author_name, projection.quote, projection.project_id::text, publication.published_at
                ${testimonialPublicationJoin}
                join content.public_project_locales project_locale
                  on project_locale.content_id = projection.project_id and project_locale.portfolio_id = projection.portfolio_id
                 and project_locale.locale = publication.locale
                join content.items project
                  on project.content_id = project_locale.content_id and project.portfolio_id = project_locale.portfolio_id
                 and project.content_type = 'project' and project.lifecycle = 'published'
                join content.language_publications project_publication
                  on project_publication.content_id = project_locale.content_id and project_publication.portfolio_id = project_locale.portfolio_id
                 and project_publication.locale = project_locale.locale and project_publication.revision_id = project_locale.revision_id
               where publication.portfolio_id = ${input.scope.portfolioId}::uuid
                 and publication.locale = ${input.locale}
                 and projection.association_type = 'project' and projection.project_id = ${input.association.projectId}::uuid
               order by publication.published_at desc, item.content_id
            `.execute(executor);
        const entries = result.rows.map((row) => {
          if (!isLocale(row.locale)) throw new PostgresInfrastructureError();
          const publishedAt = row.published_at instanceof Date ? row.published_at.toISOString() : new Date(row.published_at).toISOString();
          if (!Number.isFinite(Date.parse(publishedAt))) throw new PostgresInfrastructureError();
          const projectId = row.project_id ?? undefined;
          if (input.association.type === "project" && typeof projectId !== "string") throw new PostgresInfrastructureError();
          return {
            contentId: row.content_id as StableId<string>,
            revisionId: row.revision_id as StableId<"Revision">,
            locale: row.locale,
            authorName: row.author_name,
            quote: row.quote,
            association: input.association.type === "profile"
              ? { type: "profile" as const }
              : { type: "project" as const, projectId: projectId as StableId<"Project"> },
            publishedAt,
          };
        });
        return { ok: true, value: entries };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async getPublicProjectBySlug(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const result = await sql<{
          content_id: string; revision_id: string; route_identity: string; current_slug: string;
          title: string; summary: string; body: string; case_study: unknown; claims: unknown; external_links: unknown;
          first_published_at: Date | string; published_at: Date | string;
        }>`
          select item.content_id::text, locale.revision_id::text, route.route_identity::text, route.current_slug,
                 locale.title, locale.summary, locale.body, locale.case_study, locale.claims, locale.external_links,
                 item.first_published_at, locale.published_at
            from content.public_routes route
            join content.public_route_reservations reservation
              on reservation.route_identity = route.route_identity
             and reservation.content_id = route.content_id
             and reservation.portfolio_id = route.portfolio_id
            join content.items item on item.content_id = route.content_id and item.portfolio_id = route.portfolio_id
            join content.language_publications publication
              on publication.content_id = item.content_id and publication.portfolio_id = item.portfolio_id
             and publication.locale = ${input.locale} and publication.route_identity = route.route_identity
            join content.public_project_locales locale
              on locale.content_id = publication.content_id and locale.portfolio_id = publication.portfolio_id
             and locale.locale = publication.locale and locale.revision_id = publication.revision_id
           where route.portfolio_id = ${input.scope.portfolioId}::uuid
             and route.content_type = 'project' and reservation.normalized_slug = ${input.slug}
             and item.lifecycle = 'published' and item.content_type = 'project'
        `.execute(executor);
        const row = result.rows[0];
        if (row === undefined || row.first_published_at === null) return err({ kind: "not_found", code: "PUBLIC_CONTENT_NOT_FOUND" });
        const firstPublishedAt = row.first_published_at instanceof Date ? row.first_published_at.toISOString() : new Date(row.first_published_at).toISOString();
        const publishedAt = row.published_at instanceof Date ? row.published_at.toISOString() : new Date(row.published_at).toISOString();
        const caseStudy = typeof row.case_study === "string" ? JSON.parse(row.case_study) as unknown : row.case_study;
        const claims = typeof row.claims === "string" ? JSON.parse(row.claims) as unknown : row.claims;
        const externalLinks = typeof row.external_links === "string" ? JSON.parse(row.external_links) as unknown : row.external_links;
        if (!Number.isFinite(Date.parse(firstPublishedAt)) || !Number.isFinite(Date.parse(publishedAt)) ||
            !isRecord(caseStudy) || !Array.isArray(claims) || !Array.isArray(externalLinks)) throw new PostgresInfrastructureError();
        return { ok: true, value: {
          contentId: row.content_id as StableId<string>, contentType: "project", locale: input.locale,
          revisionId: row.revision_id as StableId<"Revision">, routeIdentity: row.route_identity as StableId<"PublicRoute">,
          currentSlug: row.current_slug, title: row.title, summary: row.summary, body: row.body,
          firstPublishedAt, publishedAt, caseStudy: caseStudy as PublicProjectContentView["caseStudy"],
          claims: claims as PublicProjectContentView["claims"], externalLinks: externalLinks as PublicProjectContentView["externalLinks"],
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async getPublicAchievementTimeline(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const result = await sql<{
          content_id: string; revision_id: string; achieved_on: string; title: string; summary: string; body: string;
          artifacts: unknown;
        }>`
          select locale.content_id::text, locale.revision_id::text, locale.achieved_on::text,
                 locale.title, locale.summary, locale.body, locale.artifacts
            from content.public_achievement_locales locale
            join content.items item on item.content_id = locale.content_id and item.portfolio_id = locale.portfolio_id
            join content.language_publications publication
              on publication.content_id = locale.content_id and publication.portfolio_id = locale.portfolio_id
             and publication.locale = locale.locale and publication.revision_id = locale.revision_id
           where locale.portfolio_id = ${input.scope.portfolioId}::uuid and locale.locale = ${input.locale}
             and item.content_type = 'achievement' and item.lifecycle = 'published'
           order by locale.achieved_on asc, locale.content_id asc
           limit ${input.limit}
        `.execute(executor);
        return { ok: true, value: result.rows.map((row): PublicAchievementTimelineEntry => {
          let artifacts = row.artifacts;
          if (typeof artifacts === "string") {
            try { artifacts = JSON.parse(artifacts) as unknown; } catch { throw new PostgresInfrastructureError(); }
          }
          if (!Array.isArray(artifacts) || !artifacts.every((artifact) => isRecord(artifact) && typeof artifact["title"] === "string" &&
              (artifact["destinationUrl"] === undefined || typeof artifact["destinationUrl"] === "string") &&
              (artifact["mediaAssetId"] === undefined || typeof artifact["mediaAssetId"] === "string"))) throw new PostgresInfrastructureError();
          return { contentId: row.content_id as StableId<"Achievement">, revisionId: row.revision_id as StableId<"Revision">,
            locale: input.locale, achievedOn: row.achieved_on, title: row.title, summary: row.summary, body: row.body,
            artifacts: artifacts as PublicAchievementTimelineEntry["artifacts"] };
        }) };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async listHistory(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const root = await sql<{ content_id: string }>`
          select content_id::text from content.items
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        if (root.rows[0] === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        const rows = await sql<{
          revision_id: string;
          locale: string;
          stream_sequence: number;
          saved_at: Date | string;
          review_decision: string | null;
        }>`
          select revision.revision_id::text, revision.locale, revision.stream_sequence, revision.saved_at,
                 latest.decision as review_decision
            from content.revisions revision
            left join lateral (${latestReviewForRevision()}) latest on true
           where revision.content_id = ${input.contentId}::uuid
             and revision.portfolio_id = ${input.scope.portfolioId}::uuid
             and (${input.locale ?? null}::text is null or revision.locale = ${input.locale ?? null})
             and (${input.after?.locale ?? null}::text is null or
                  (revision.locale, revision.stream_sequence) > (${input.after?.locale ?? null}::text, ${input.after?.sequence ?? 0}::integer))
           order by revision.locale, revision.stream_sequence
           limit ${input.limit + 1}
        `.execute(executor);
        const hasMore = rows.rows.length > input.limit;
        const entries = rows.rows.slice(0, input.limit).map((row) => {
          if (!isLocale(row.locale) || !Number.isSafeInteger(row.stream_sequence) || row.stream_sequence < 1 ||
              (row.review_decision !== null && row.review_decision !== "accepted" && row.review_decision !== "rejected")) {
            throw new PostgresInfrastructureError();
          }
          const savedAt = row.saved_at instanceof Date ? row.saved_at.toISOString() : new Date(row.saved_at).toISOString();
          if (!Number.isFinite(Date.parse(savedAt))) throw new PostgresInfrastructureError();
          const decision = row.review_decision as "accepted" | "rejected" | null;
          return {
            revisionId: row.revision_id as StableId<"Revision">,
            locale: row.locale,
            sequence: row.stream_sequence,
            savedAt,
            ...(decision === null ? {} : { reviewDecision: decision }),
          };
        });
        return { ok: true, value: { entries, hasMore } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
