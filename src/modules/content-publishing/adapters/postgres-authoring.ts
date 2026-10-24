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
  ContentOwnerExportRecord,
  ContentAuthoringScope,
  ContentProjectOwnerView,
  ContentProjectStatusHistoryEntry,
  ContentProjectStatusTransition,
  ContentProjectStatusValue,
  ContentProjectStatusValueChange,
  ContentProjectMutation,
  CreateContentPersistenceInput,
  PublishAchievementLanguageInput,
  PublishAchievementLanguageResult,
  PublishProjectLanguageInput,
  PublishProjectLanguageResult,
  PublicAchievementTimelineEntry,
  PublicProjectContentView,
  ContentPublicRouteFacts,
  RelateProjectsInput,
  RelateProjectsResult,
  OwnerProjectRelationshipsView,
  PublicRelatedProjectView,
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
  readonly locale_total: number;
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

function statusValue(row: { value_id: string; label: string; state: string; aggregate_version: number }): ContentProjectStatusValue {
  if ((row.state !== "active" && row.state !== "retired") || !Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1 ||
      row.label.length === 0 || row.label.length > 100) throw new PostgresInfrastructureError();
  return { valueId: row.value_id as StableId<"ProjectStatusValue">, label: row.label, state: row.state, aggregateVersion: row.aggregate_version };
}

function databaseTime(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new PostgresInfrastructureError();
  return result;
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
  async function getRecord(contentId: StableId<string>, scope: ContentAuthoringScope, context: TransactionContext, revisionHistoryLimit?: number): Promise<Result<ContentAuthoringRecord, Rejection>> {
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
    const revisionBound = revisionHistoryLimit === undefined ? sql`true` : sql`revision.owner_rank <= ${revisionHistoryLimit}`;
    const revisions = await sql<RevisionRow>`
      select revision.revision_id::text, revision.content_id::text,
             revision.content_type, revision.locale, revision.stream_sequence,
             revision.locale_total,
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
        from (
          select source.*,
                 row_number() over (partition by source.locale order by source.stream_sequence desc) as owner_rank,
                 count(*) over (partition by source.locale)::integer as locale_total
            from content.revisions source
           where source.content_id = ${contentId}::uuid
             and source.portfolio_id = ${scope.portfolioId}::uuid
        ) revision
        join content.items item
          on item.content_id = revision.content_id
         and item.portfolio_id = revision.portfolio_id
        left join lateral (${latestReviewForRevision()}) latest on true
       where ${revisionBound}
       order by revision.locale, revision.stream_sequence
    `.execute(executor);
    const publications = await sql<{
      locale: string; revision_id: string; review_id: string; snapshot_hash: string; evidence_version: number;
      reviewer_id: string; decision: string; media_facts_version: string | null; published_at: Date | string;
    }>`
      select publication.locale, publication.revision_id::text, publication.review_id::text,
             review.snapshot_hash, review.evidence_version, review.reviewer_id::text, review.decision,
             publication.media_facts_version, publication.published_at
        from content.language_publications publication
        join content.revision_reviews review
          on review.review_id = publication.review_id
         and review.content_id = publication.content_id
         and review.portfolio_id = publication.portfolio_id
       where publication.content_id = ${contentId}::uuid
         and publication.portfolio_id = ${scope.portfolioId}::uuid
      union all
      select publication.locale, publication.revision_id::text, publication.review_id::text,
             review.snapshot_hash, review.evidence_version, review.reviewer_id::text, review.decision,
             null::text as media_facts_version, publication.published_at
        from content.testimonial_language_publications publication
        join content.revision_reviews review
          on review.review_id = publication.review_id
         and review.content_id = publication.content_id
         and review.portfolio_id = publication.portfolio_id
       where publication.content_id = ${contentId}::uuid
         and publication.portfolio_id = ${scope.portfolioId}::uuid
       order by locale
    `.execute(executor);
    const mappedPublications: ContentAuthoringPublication[] = publications.rows.map((row) => {
      if (!isLocale(row.locale) || row.decision !== "accepted" && row.decision !== "rejected" ||
          !Number.isSafeInteger(row.evidence_version) || row.evidence_version < 1) throw new PostgresInfrastructureError();
      const publishedAt = row.published_at instanceof Date ? row.published_at.toISOString() : new Date(row.published_at).toISOString();
      if (!Number.isFinite(Date.parse(publishedAt))) throw new PostgresInfrastructureError();
      return {
        locale: row.locale,
        revisionId: row.revision_id as StableId<"Revision">,
        reviewId: row.review_id as StableId<"ContentReview">,
        snapshotHash: row.snapshot_hash,
        evidenceVersion: row.evidence_version,
        reviewerId: row.reviewer_id as StableId<"Owner">,
        decision: row.decision,
        mediaFactsVersion: row.media_facts_version,
        publishedAt,
      };
    });
    const publicationHistoryRows = await sql<{
      locale: string; publication_sequence: number; revision_id: string; review_id: string; published_at: Date | string;
    }>`
      select locale, publication_sequence, revision_id::text, review_id::text, published_at
        from (
          select locale, publication_sequence, revision_id, review_id, published_at
            from content.publication_history
           where content_id = ${contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid
          union all
          select locale, publication_sequence, revision_id, review_id, published_at
            from content.testimonial_publication_history
           where content_id = ${contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid
        ) retained
       order by published_at desc, locale, publication_sequence desc
       limit 100
    `.execute(executor);
    const publicationHistory = publicationHistoryRows.rows.map((entry) => {
      const publishedAt = entry.published_at instanceof Date ? entry.published_at.toISOString() : new Date(entry.published_at).toISOString();
      if (!isLocale(entry.locale) || !Number.isSafeInteger(entry.publication_sequence) || entry.publication_sequence < 1 || !Number.isFinite(Date.parse(publishedAt))) {
        throw new PostgresInfrastructureError();
      }
      return {
        locale: entry.locale,
        sequence: entry.publication_sequence,
        revisionId: entry.revision_id as StableId<"Revision">,
        reviewId: entry.review_id as StableId<"ContentReview">,
        publishedAt,
      };
    });
    const routeResult = root.content_type === "project" ? await sql<{
      route_identity: string; current_slug: string; normalized_slug: string; is_current: boolean;
    }>`
      select route.route_identity::text, route.current_slug, reservation.normalized_slug, reservation.is_current
        from content.public_routes route
        join content.public_route_reservations reservation
          on reservation.route_identity = route.route_identity
         and reservation.content_id = route.content_id
         and reservation.portfolio_id = route.portfolio_id
       where route.content_id = ${contentId}::uuid and route.portfolio_id = ${scope.portfolioId}::uuid
       order by reservation.reserved_at, reservation.normalized_slug
       limit 100
    `.execute(executor) : { rows: [] };
    const routeIdentity = routeResult.rows[0]?.route_identity;
    const routeHistoryResult = routeIdentity !== undefined ? await sql<{
      sequence: number; from_slug: string; to_slug: string; changed_at: Date | string;
    }>`
      select sequence, from_slug, to_slug, changed_at
        from (
          select sequence, from_slug, to_slug, changed_at
            from content.public_route_history
           where content_id = ${contentId}::uuid and portfolio_id = ${scope.portfolioId}::uuid
           order by sequence desc
           limit 100
        ) bounded
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
        ...(revisions.rows.length === 0 ? {} : {
          revisionCounts: Object.fromEntries(revisions.rows.map((entry) => [entry.locale, entry.locale_total])) as NonNullable<ContentAuthoringRecord["revisionCounts"]>,
        }),
        publications: mappedPublications,
        publicationHistory,
        publicRoute,
      },
    };
  }

  return {
    async readOwnerExportSnapshot(scope, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${scope.ownerId}, true),
                         set_config('shipwithali.worker_purpose', 'content.owner-export', true)`.execute(executor);
        const timestamp = await sql<{ captured_at: Date | string }>`select transaction_timestamp() as captured_at`.execute(executor);
        const capturedAtValue = timestamp.rows[0]?.captured_at;
        if (capturedAtValue === undefined) throw new PostgresInfrastructureError();
        const capturedAt = databaseTime(capturedAtValue);
        const roots = await sql<{
          content_id: string; content_type: string; lifecycle: string; aggregate_version: number;
          candidate_slug: string | null; first_published_at: Date | string | null; status_value_id: string | null;
          status_label: string | null; status_state: string | null; featured: boolean;
        }>`
          select item.content_id::text, item.content_type, item.lifecycle, item.aggregate_version,
                 item.candidate_slug, item.first_published_at, item.status_value_id::text,
                 status.label as status_label, status.state as status_state, item.featured
            from content.items item
            left join content.project_status_values status
              on status.value_id = item.status_value_id and status.portfolio_id = item.portfolio_id
           where item.portfolio_id = ${scope.portfolioId}::uuid
           order by item.content_id
        `.execute(executor);
        const ids = roots.rows.map((row) => row.content_id);
        if (ids.length === 0) return { ok: true, value: { capturedAt, records: [] } };

        const revisions = await sql<{
          revision_id: string; content_id: string; content_type: string; locale: string; stream_sequence: number;
          aggregate_version: number; title: string; summary: string; body: string; payload: unknown; saved_at: Date | string;
        }>`
          select revision_id::text, content_id::text, content_type, locale, stream_sequence, aggregate_version,
                 title, summary, body, payload, saved_at
            from content.revisions
           where portfolio_id = ${scope.portfolioId}::uuid
           order by content_id, locale, stream_sequence
        `.execute(executor);
        const reviews = await sql<{
          review_id: string; revision_id: string; content_id: string; content_type: string; locale: string;
          snapshot_hash: string; evidence_version: number; reviewer_id: string; review_sequence: number;
          decision: string; findings: unknown; reviewed_at: Date | string;
        }>`
          select review_id::text, revision_id::text, content_id::text, content_type, locale,
                 snapshot_hash, evidence_version, reviewer_id::text, review_sequence, decision, findings, reviewed_at
            from content.revision_reviews
           where portfolio_id = ${scope.portfolioId}::uuid
           order by content_id, locale, review_sequence
        `.execute(executor);
        const publications = await sql<{
          content_id: string; locale: string; revision_id: string; review_id: string;
          publication_sequence: number; published_at: Date | string;
        }>`
          select content_id::text, locale, revision_id::text, review_id::text, publication_sequence, published_at
            from (
              select content_id, locale, revision_id, review_id, publication_sequence, published_at
                from content.language_publications where portfolio_id = ${scope.portfolioId}::uuid
              union all
              select content_id, locale, revision_id, review_id, publication_sequence, published_at
                from content.testimonial_language_publications where portfolio_id = ${scope.portfolioId}::uuid
            ) current_publications
           order by content_id, locale
        `.execute(executor);
        const publicationHistory = await sql<{
          content_id: string; locale: string; publication_sequence: number; revision_id: string;
          review_id: string; published_at: Date | string;
        }>`
          select content_id::text, locale, publication_sequence, revision_id::text, review_id::text, published_at
            from (
              select content_id, locale, publication_sequence, revision_id, review_id, published_at
                from content.publication_history where portfolio_id = ${scope.portfolioId}::uuid
              union all
              select content_id, locale, publication_sequence, revision_id, review_id, published_at
                from content.testimonial_publication_history where portfolio_id = ${scope.portfolioId}::uuid
            ) retained
           order by content_id, locale, publication_sequence
        `.execute(executor);
        const lifecycle = await sql<{
          content_id: string; transition_sequence: number; previous_lifecycle: string; lifecycle: string;
          aggregate_version: number; reason: string | null; changed_at: Date | string;
        }>`
          select content_id::text, transition_sequence, previous_lifecycle, lifecycle, aggregate_version, reason, changed_at
            from content.lifecycle_history where portfolio_id = ${scope.portfolioId}::uuid
           order by content_id, transition_sequence
        `.execute(executor);
        const routes = await sql<{
          content_id: string; route_identity: string; current_slug: string; first_published_at: Date | string;
          normalized_slug: string; is_current: boolean; reserved_at: Date | string;
        }>`
          select route.content_id::text, route.route_identity::text, route.current_slug, route.first_published_at,
                 reservation.normalized_slug, reservation.is_current, reservation.reserved_at
            from content.public_routes route
            join content.public_route_reservations reservation
              on reservation.route_identity = route.route_identity and reservation.content_id = route.content_id
             and reservation.portfolio_id = route.portfolio_id
           where route.portfolio_id = ${scope.portfolioId}::uuid
           order by route.content_id, reservation.reserved_at, reservation.normalized_slug
        `.execute(executor);
        const routeHistory = await sql<{
          content_id: string; sequence: number; from_slug: string; to_slug: string; changed_at: Date | string;
        }>`
          select content_id::text, sequence, from_slug, to_slug, changed_at
            from content.public_route_history where portfolio_id = ${scope.portfolioId}::uuid
           order by content_id, sequence
        `.execute(executor);
        const related = await sql<{ project_id: string; related_project_id: string }>`
          select project_id::text, related_project_id::text from content.project_relationship_views
           where portfolio_id = ${scope.portfolioId}::uuid order by project_id, related_project_id
        `.execute(executor);
        const relationshipHistory = await sql<{
          left_project_id: string; right_project_id: string; sequence: number; initiating_project_id: string;
          related_project_id: string; occurred_at: Date | string;
        }>`
          select left_project_id::text, right_project_id::text, sequence, initiating_project_id::text,
                 related_project_id::text, occurred_at from content.project_relationship_history
           where portfolio_id = ${scope.portfolioId}::uuid order by left_project_id, right_project_id, sequence
        `.execute(executor);
        const assignments = await sql<{ content_id: string; taxonomy_id: string; kind: string; value_id: string }>`
          select assignment.content_id::text, assignment.taxonomy_id::text, root.kind, assignment.value_id::text
            from content.project_taxonomy_assignments assignment
            join taxonomy.roots root on root.portfolio_id = assignment.portfolio_id
              and root.taxonomy_id = assignment.taxonomy_id
           where assignment.portfolio_id = ${scope.portfolioId}::uuid
           order by assignment.content_id, assignment.taxonomy_id, assignment.value_id
        `.execute(executor);

        const reviewsByRevision = new Map<string, ContentAuthoringReview[]>();
        for (const row of reviews.rows) {
          let findings = row.findings;
          if (typeof findings === "string") { try { findings = JSON.parse(findings) as unknown; } catch { throw new PostgresInfrastructureError(); } }
          if (!isKind(row.content_type) || !isLocale(row.locale) || !Array.isArray(findings) || !findings.every((item) => typeof item === "string") ||
              !Number.isSafeInteger(row.review_sequence) || row.review_sequence < 1 || !Number.isSafeInteger(row.evidence_version) || row.evidence_version < 1 ||
              !/^[a-f0-9]{64}$/.test(row.snapshot_hash) || (row.decision !== "accepted" && row.decision !== "rejected")) throw new PostgresInfrastructureError();
          const list = reviewsByRevision.get(row.revision_id) ?? [];
          list.push({ reviewId: row.review_id as StableId<"ContentReview">, revisionId: row.revision_id as StableId<"Revision">,
            contentId: row.content_id as StableId<string>, contentType: row.content_type, locale: row.locale, snapshotHash: row.snapshot_hash,
            evidenceVersion: row.evidence_version, reviewerId: row.reviewer_id as StableId<"Owner">, reviewSequence: row.review_sequence,
            decision: row.decision, findings, reviewedAt: databaseTime(row.reviewed_at) });
          reviewsByRevision.set(row.revision_id, list);
        }
        const revisionsByContent = new Map<string, ContentOwnerExportRecord["revisions"] extends readonly (infer T)[] ? T[] : never>();
        for (const row of revisions.rows) {
          if (!isKind(row.content_type) || !isLocale(row.locale) || !Number.isSafeInteger(row.stream_sequence) || row.stream_sequence < 1 ||
              !Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1) throw new PostgresInfrastructureError();
          const payload = parsePayload(row.payload, row as RevisionRow);
          const list = revisionsByContent.get(row.content_id) ?? [];
          list.push({ revisionId: row.revision_id as StableId<"Revision">, locale: row.locale, sequence: row.stream_sequence,
            aggregateVersion: row.aggregate_version, savedAt: databaseTime(row.saved_at), payload, reviews: reviewsByRevision.get(row.revision_id) ?? [] });
          revisionsByContent.set(row.content_id, list);
        }
        const group = <T,>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> => {
          const result = new Map<string, T[]>();
          for (const row of rows) { const id = key(row); const list = result.get(id) ?? []; list.push(row); result.set(id, list); }
          return result;
        };
        const publicationsByContent = group(publications.rows, (row) => row.content_id);
        const publicationHistoryByContent = group(publicationHistory.rows, (row) => row.content_id);
        const lifecycleByContent = group(lifecycle.rows, (row) => row.content_id);
        const routesByContent = group(routes.rows, (row) => row.content_id);
        const routeHistoryByContent = group(routeHistory.rows, (row) => row.content_id);
        const relationshipsByProject = group(related.rows, (row) => row.project_id);
        const relationshipHistoryByProject = new Map<string, typeof relationshipHistory.rows[number][]>();
        for (const row of relationshipHistory.rows) {
          for (const projectId of [row.left_project_id, row.right_project_id]) {
            const list = relationshipHistoryByProject.get(projectId) ?? [];
            list.push(row);
            relationshipHistoryByProject.set(projectId, list);
          }
        }
        const assignmentsByContent = group(assignments.rows, (row) => row.content_id);
        const records: ContentOwnerExportRecord[] = roots.rows.map((root) => {
          if (!isKind(root.content_type) || !["draft", "published", "hidden", "archived"].includes(root.lifecycle) ||
              !Number.isSafeInteger(root.aggregate_version) || root.aggregate_version < 1) throw new PostgresInfrastructureError();
          const routeRows = routesByContent.get(root.content_id) ?? [];
          const firstRoute = routeRows[0];
          const routeIdentity = firstRoute?.route_identity;
          if (routeRows.some((row) => row.route_identity !== routeIdentity || row.current_slug !== firstRoute?.current_slug ||
              databaseTime(row.first_published_at) !== databaseTime(firstRoute!.first_published_at))) throw new PostgresInfrastructureError();
          const route = firstRoute === undefined ? null : {
            identity: firstRoute.route_identity as StableId<"PublicRoute">, canonicalSlug: firstRoute.current_slug,
            firstPublishedAt: databaseTime(firstRoute.first_published_at),
            reservations: routeRows.map((row) => ({ slug: row.normalized_slug, isCurrent: row.is_current, reservedAt: databaseTime(row.reserved_at) })),
            history: (routeHistoryByContent.get(root.content_id) ?? []).map((row) => ({ sequence: row.sequence, fromSlug: row.from_slug,
              toSlug: row.to_slug, changedAt: databaseTime(row.changed_at) })),
          };
          return {
            contentId: root.content_id as StableId<string>, contentType: root.content_type,
            lifecycle: root.lifecycle as ContentOwnerExportRecord["lifecycle"], aggregateVersion: root.aggregate_version,
            candidateSlug: root.candidate_slug, firstPublishedAt: root.first_published_at === null ? null : databaseTime(root.first_published_at),
            projectStatus: root.status_value_id === null ? null : root.status_label === null || root.status_state === null ? (() => { throw new PostgresInfrastructureError(); })() :
              { valueId: root.status_value_id as StableId<"ProjectStatusValue">, label: root.status_label, state: root.status_state as "active" | "retired" },
            featured: root.featured, revisions: revisionsByContent.get(root.content_id) ?? [],
            publications: (publicationsByContent.get(root.content_id) ?? []).map((row) => {
              if (!isLocale(row.locale) || !Number.isSafeInteger(row.publication_sequence) || row.publication_sequence < 1) throw new PostgresInfrastructureError();
              return { locale: row.locale, revisionId: row.revision_id as StableId<"Revision">, reviewId: row.review_id as StableId<"ContentReview">,
                publicationSequence: row.publication_sequence, publishedAt: databaseTime(row.published_at) };
            }),
            publicationHistory: (publicationHistoryByContent.get(root.content_id) ?? []).map((row) => {
              if (!isLocale(row.locale) || !Number.isSafeInteger(row.publication_sequence) || row.publication_sequence < 1) throw new PostgresInfrastructureError();
              return { locale: row.locale, sequence: row.publication_sequence, revisionId: row.revision_id as StableId<"Revision">,
                reviewId: row.review_id as StableId<"ContentReview">, publishedAt: databaseTime(row.published_at) };
            }),
            lifecycleHistory: (lifecycleByContent.get(root.content_id) ?? []).map((row) => ({ sequence: row.transition_sequence,
              previousLifecycle: row.previous_lifecycle, lifecycle: row.lifecycle, aggregateVersion: row.aggregate_version,
              reason: row.reason, changedAt: databaseTime(row.changed_at) })),
            publicRoute: route,
            relatedProjectIds: (relationshipsByProject.get(root.content_id) ?? []).map((row) => row.related_project_id as StableId<"Project">),
            relationshipHistory: (relationshipHistoryByProject.get(root.content_id) ?? []).map((row) => ({ leftProjectId: row.left_project_id as StableId<"Project">,
              rightProjectId: row.right_project_id as StableId<"Project">, sequence: row.sequence, initiatingProjectId: row.initiating_project_id as StableId<"Project">,
              relatedProjectId: row.related_project_id as StableId<"Project">, occurredAt: databaseTime(row.occurred_at) })),
            taxonomyAssignments: (assignmentsByContent.get(root.content_id) ?? []).map((row) => ({ taxonomyId: row.taxonomy_id as StableId<"Taxonomy">,
              kind: row.kind, valueId: row.value_id as StableId<"TaxonomyValue"> })),
          };
        });
        return { ok: true, value: { capturedAt, records } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
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

    async getPublicProjectMediaUse(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        await sql`select set_config('statement_timeout', '3s', true)`.execute(executor);
        const result = await sql<{ readonly used: boolean }>`
          select exists (
            select 1
              from content.public_project_locales projection
              join content.language_publications publication
                on publication.content_id = projection.content_id and publication.portfolio_id = projection.portfolio_id
               and publication.locale = projection.locale and publication.revision_id = projection.revision_id
              join content.items item
                on item.content_id = publication.content_id and item.portfolio_id = publication.portfolio_id
               and item.content_type = publication.content_type and item.lifecycle = 'published'
             where projection.portfolio_id = ${input.scope.portfolioId}::uuid
               and projection.locale = ${input.locale}
               and (${input.projectId ?? null}::uuid is null or projection.content_id = ${input.projectId ?? null}::uuid)
               and projection.claims @> jsonb_build_array(jsonb_build_object(
                 'artifacts', jsonb_build_array(jsonb_build_object('mediaAssetId', ${input.mediaAssetId}::text))
               ))
             limit 1
          ) as used
        `.execute(executor);
        if (result.rows.length !== 1 || typeof result.rows[0]?.used !== "boolean") throw new PostgresInfrastructureError();
        return { ok: true, value: result.rows[0].used };
      } catch {
        return { ok: false, error: { kind: "temporarily_unavailable", code: "CONTENT_MEDIA_USE_UNAVAILABLE" } };
      }
    },

    async getVisibleMediaUsage(input, context) {
      const executor = resolvePostgresTransaction(context);
      let savepointActive = false;
      try {
        await sql`savepoint content_visible_media_usage`.execute(executor);
        savepointActive = true;
        await setTrustedScope(context, input.scope);
        await sql`select set_config('lock_timeout', '3s', true), set_config('statement_timeout', '5s', true), set_config('transaction_timeout', '10s', true)`.execute(executor);
        const requested = [...new Set(input.mediaAssetIds)].sort();
        if (requested.length === 0) {
          await sql`release savepoint content_visible_media_usage`.execute(executor);
          savepointActive = false;
          return { ok: true, value: { facts: [] } };
        }
        const rows = await sql<{ media_asset_id: string; in_use: boolean }>`
          with requested(media_asset_id) as (
            select unnest(${requested}::uuid[])
          )
          select requested.media_asset_id::text as media_asset_id,
                 exists (
                   select 1
                     from content.language_publications publication
                     join content.items item
                       on item.content_id = publication.content_id
                      and item.portfolio_id = publication.portfolio_id
                      and item.content_type = publication.content_type
                      and item.lifecycle = 'published'
                     join content.revisions revision
                       on revision.revision_id = publication.revision_id
                      and revision.content_id = publication.content_id
                      and revision.portfolio_id = publication.portfolio_id
                      and revision.locale = publication.locale
                    where publication.portfolio_id = ${input.scope.portfolioId}::uuid
                      and publication.content_type in ('project', 'achievement')
                      and revision.content_type in ('project', 'achievement')
                      and revision.payload #> '{evidence,artifacts}' @>
                        jsonb_build_array(jsonb_build_object('mediaAssetId', requested.media_asset_id::text))
                 ) as in_use
            from requested
           order by requested.media_asset_id
        `.execute(executor);
        if (rows.rows.length !== requested.length) throw new PostgresInfrastructureError();
        await sql`release savepoint content_visible_media_usage`.execute(executor);
        savepointActive = false;
        return { ok: true, value: { facts: rows.rows.map((row) => ({
          mediaAssetId: row.media_asset_id as StableId<"MediaAsset">, inUse: row.in_use,
        })) } };
      } catch {
        if (!savepointActive) throw new PostgresInfrastructureError();
        try {
          await sql`rollback to savepoint content_visible_media_usage`.execute(executor);
          await sql`release savepoint content_visible_media_usage`.execute(executor);
        } catch {
          throw new PostgresInfrastructureError();
        }
        return { ok: false, error: { kind: "temporarily_unavailable", code: "CONTENT_MEDIA_USAGE_UNAVAILABLE" } };
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

    async get(contentId, scope, context, revisionHistoryLimit) {
      try {
        return await getRecord(contentId, scope, context, revisionHistoryLimit);
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

    async relateProjects(input: RelateProjectsInput, context: TransactionContext): Promise<Result<RelateProjectsResult, Rejection>> {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const ids = [input.projectId, input.relatedProjectId].sort();
        const selected = await sql<{
          content_id: string; content_type: string; aggregate_version: number;
        }>`
          select content_id::text, content_type, aggregate_version
            from content.items
           where content_id = any(${ids}::uuid[]) and portfolio_id = ${input.scope.portfolioId}::uuid
           order by content_id
           for update
        `.execute(executor);
        const byId = new Map(selected.rows.map((row) => [row.content_id, row]));
        const initiating = byId.get(input.projectId);
        if (initiating === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        const related = byId.get(input.relatedProjectId);
        if (related === undefined) return err({ kind: "validation", code: "RELATED_PROJECT_UNAVAILABLE" });
        if (initiating.content_type !== "project" || related.content_type !== "project") {
          return err({ kind: "validation", code: "CONTENT_TYPE_NOT_PROJECT" });
        }
        if (initiating.aggregate_version !== input.expectedVersion) {
          return err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: initiating.aggregate_version });
        }
        const [leftId, rightId] = ids as [StableId<"Project">, StableId<"Project">];
        const created = await sql<{ left_project_id: string }>`
          insert into content.project_relationships (
            portfolio_id, left_project_id, right_project_id, content_type, created_by
          ) values (
            ${input.scope.portfolioId}::uuid, ${leftId}::uuid, ${rightId}::uuid, 'project', ${input.scope.ownerId}::uuid
          )
          on conflict (portfolio_id, left_project_id, right_project_id) do nothing
          returning left_project_id::text
        `.execute(executor);
        if (created.rows[0] === undefined) return err({ kind: "conflict", code: "PROJECT_RELATIONSHIP_ALREADY_EXISTS" });

        const updatedVersions = new Map<string, number>();
        for (const id of ids) {
          const root = byId.get(id);
          if (root === undefined) throw new PostgresInfrastructureError();
          const updated = await sql<{ aggregate_version: number }>`
            update content.items
               set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
             where content_id = ${id}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
               and aggregate_version = ${root.aggregate_version}
            returning aggregate_version
          `.execute(executor);
          const version = updated.rows[0]?.aggregate_version;
          if (version === undefined || !Number.isSafeInteger(version) || version < 1) throw new PostgresInfrastructureError();
          updatedVersions.set(id, version);
        }
        const projectAggregateVersion = updatedVersions.get(input.projectId);
        const relatedProjectAggregateVersion = updatedVersions.get(input.relatedProjectId);
        if (projectAggregateVersion === undefined || relatedProjectAggregateVersion === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.project_relationship_views (
            portfolio_id, project_id, related_project_id, left_project_id, right_project_id, content_type
          ) values
            (${input.scope.portfolioId}::uuid, ${input.projectId}::uuid, ${input.relatedProjectId}::uuid, ${leftId}::uuid, ${rightId}::uuid, 'project'),
            (${input.scope.portfolioId}::uuid, ${input.relatedProjectId}::uuid, ${input.projectId}::uuid, ${leftId}::uuid, ${rightId}::uuid, 'project')
        `.execute(executor);
        const historySequence = await sql<{ sequence: number }>`
          select coalesce(max(sequence), 0)::integer + 1 as sequence
            from content.project_relationship_history
           where portfolio_id = ${input.scope.portfolioId}::uuid
             and left_project_id = ${leftId}::uuid and right_project_id = ${rightId}::uuid
        `.execute(executor);
        const sequence = historySequence.rows[0]?.sequence;
        if (sequence !== 1) throw new PostgresInfrastructureError();
        await sql`
          insert into content.project_relationship_history (
            portfolio_id, left_project_id, right_project_id, content_type, sequence, action,
            initiating_project_id, related_project_id, initiating_aggregate_version,
            related_aggregate_version, actor_id, occurred_at
          ) values (
            ${input.scope.portfolioId}::uuid, ${leftId}::uuid, ${rightId}::uuid, 'project', 1, 'related',
            ${input.projectId}::uuid, ${input.relatedProjectId}::uuid, ${projectAggregateVersion},
            ${relatedProjectAggregateVersion}, ${input.scope.ownerId}::uuid, transaction_timestamp()
          )
        `.execute(executor);
        const timestamp = await sql<{ value: Date | string }>`select transaction_timestamp() as value`.execute(executor);
        const relatedAt = timestamp.rows[0]?.value;
        if (relatedAt === undefined) throw new PostgresInfrastructureError();
        const occurredAt = relatedAt instanceof Date ? relatedAt.toISOString() : new Date(relatedAt).toISOString();
        if (!Number.isFinite(Date.parse(occurredAt))) throw new PostgresInfrastructureError();
        return { ok: true, value: { projectAggregateVersion, relatedProjectAggregateVersion, relatedAt: occurredAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async getOwnerProjectRelationships(input, context): Promise<Result<OwnerProjectRelationshipsView, Rejection>> {
      const executor = resolvePostgresTransaction(context);
      try {
        const record = await getRecord(input.projectId, input.scope, context);
        if (!record.ok) return record;
        if (record.value.contentType !== "project") return err({ kind: "validation", code: "CONTENT_TYPE_NOT_PROJECT" });
        const related = await sql<{ project_id: string }>`
          select related_project_id::text as project_id
            from content.project_relationship_views
           where portfolio_id = ${input.scope.portfolioId}::uuid
             and project_id = ${input.projectId}::uuid
           order by project_id
        `.execute(executor);
        return { ok: true, value: {
          projectId: input.projectId,
          aggregateVersion: record.value.aggregateVersion,
          relatedProjectIds: related.rows.map((row) => row.project_id as StableId<"Project">),
          publicRoute: record.value.publicRoute ?? null,
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async getPublicRelatedProjects(input, context): Promise<Result<readonly PublicRelatedProjectView[], Rejection>> {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const rows = await sql<{
          project_id: string; title: string; slug: string; first_published_at: Date | string;
        }>`
          with related_ids as (
            select relationship.related_project_id as project_id
              from content.project_relationship_views relationship
             where relationship.portfolio_id = ${input.scope.portfolioId}::uuid
               and relationship.project_id = ${input.projectId}::uuid
          )
          select related.content_id::text as project_id, discovery.title, discovery.slug,
                 related.first_published_at
            from related_ids relation
            join content.items source
              on source.content_id = ${input.projectId}::uuid
             and source.portfolio_id = ${input.scope.portfolioId}::uuid
             and source.content_type = 'project' and source.lifecycle = 'published'
            join content.language_publications source_publication
              on source_publication.content_id = source.content_id and source_publication.portfolio_id = source.portfolio_id
             and source_publication.locale = ${input.locale}
            join taxonomy.project_discovery_locales source_discovery
              on source_discovery.content_id = source_publication.content_id
             and source_discovery.portfolio_id = source_publication.portfolio_id
             and source_discovery.locale = source_publication.locale
             and source_discovery.revision_id = source_publication.revision_id
            join content.items related
              on related.content_id = relation.project_id
             and related.portfolio_id = ${input.scope.portfolioId}::uuid
             and related.content_type = 'project' and related.lifecycle = 'published'
            join content.language_publications related_publication
              on related_publication.content_id = related.content_id and related_publication.portfolio_id = related.portfolio_id
             and related_publication.locale = ${input.locale}
            join taxonomy.project_discovery_locales discovery
              on discovery.content_id = related_publication.content_id
             and discovery.portfolio_id = related_publication.portfolio_id
             and discovery.locale = related_publication.locale
             and discovery.revision_id = related_publication.revision_id
           where related.first_published_at is not null
           order by related.first_published_at desc, related.content_id desc
           limit ${input.limit}
        `.execute(executor);
        return { ok: true, value: rows.rows.map((row) => {
          const firstPublishedAt = row.first_published_at instanceof Date
            ? row.first_published_at.toISOString()
            : new Date(row.first_published_at).toISOString();
          if (!Number.isFinite(Date.parse(firstPublishedAt))) throw new PostgresInfrastructureError();
          return { projectId: row.project_id as StableId<"Project">, title: row.title, slug: row.slug, firstPublishedAt };
        }) };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async changeLifecycle(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selected = await sql<{
          content_type: string; lifecycle: string; aggregate_version: number;
        }>`
          select content_type, lifecycle, aggregate_version
            from content.items
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const root = selected.rows[0];
        if (root === undefined) return err({ kind: "not_found", code: "CONTENT_NOT_FOUND" });
        if (!isKind(root.content_type) || !["draft", "published", "hidden", "archived"].includes(root.lifecycle) ||
            !Number.isSafeInteger(root.aggregate_version) || root.aggregate_version < 1) throw new PostgresInfrastructureError();
        const previousLifecycle = root.lifecycle as ContentAuthoringRecord["lifecycle"];
        if (root.aggregate_version !== input.expectedVersion) {
          return err({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: root.aggregate_version });
        }
        if (previousLifecycle === input.lifecycle) {
          return { ok: true, value: {
            aggregateVersion: root.aggregate_version,
            lifecycle: input.lifecycle,
            previousLifecycle,
            changed: false,
            changedAt: null,
          } };
        }
        const allowed = input.lifecycle === "hidden"
          ? previousLifecycle === "published"
          : input.lifecycle === "archived"
          ? previousLifecycle === "draft" || previousLifecycle === "published" || previousLifecycle === "hidden"
          : previousLifecycle === "hidden" || previousLifecycle === "archived";
        if (!allowed) return err({ kind: "validation", code: "CONTENT_LIFECYCLE_TRANSITION_NOT_ALLOWED" });
        if (input.lifecycle === "published") {
          const retainedPublication = await sql<{ exists: boolean }>`
            select exists (
              select 1 from content.language_publications
               where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
              union all
              select 1 from content.testimonial_language_publications
               where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
            ) as exists
          `.execute(executor);
          if (retainedPublication.rows[0]?.exists !== true) {
            return err({ kind: "validation", code: "CONTENT_NOT_PREVIOUSLY_PUBLISHED" });
          }
          if (root.content_type === "project") {
            const retainedRoute = await sql<{ exists: boolean }>`
              select exists (
                select 1 from content.public_routes
                 where content_id = ${input.contentId}::uuid
                   and portfolio_id = ${input.scope.portfolioId}::uuid
                   and content_type = 'project'
              ) as exists
            `.execute(executor);
            if (retainedRoute.rows[0]?.exists !== true) {
              return err({ kind: "validation", code: "PUBLIC_ROUTE_IDENTITY_UNAVAILABLE" });
            }
          }
        }
        const updated = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update content.items
             set lifecycle = ${input.lifecycle},
                 aggregate_version = aggregate_version + 1,
                 updated_at = transaction_timestamp()
           where content_id = ${input.contentId}::uuid
             and portfolio_id = ${input.scope.portfolioId}::uuid
             and aggregate_version = ${input.expectedVersion}
          returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const updatedRoot = updated.rows[0];
        if (updatedRoot === undefined) throw new PostgresInfrastructureError();
        const nextSequence = await sql<{ sequence: number }>`
          select coalesce(max(transition_sequence), 0)::integer + 1 as sequence
            from content.lifecycle_history
           where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        const sequence = nextSequence.rows[0]?.sequence;
        if (sequence === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.lifecycle_history (
            content_id, portfolio_id, content_type, transition_sequence,
            previous_lifecycle, lifecycle, aggregate_version, reason, changed_at
          ) values (
            ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, ${root.content_type}, ${sequence},
            ${previousLifecycle}, ${input.lifecycle}, ${updatedRoot.aggregate_version}, ${input.reason ?? null},
            transaction_timestamp()
          )
        `.execute(executor);
        const changedAt = updatedRoot.changed_at instanceof Date
          ? updatedRoot.changed_at.toISOString()
          : new Date(updatedRoot.changed_at).toISOString();
        if (!Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
        return { ok: true, value: {
          aggregateVersion: updatedRoot.aggregate_version,
          lifecycle: input.lifecycle,
          previousLifecycle,
          changed: true,
          changedAt,
        } };
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
        if (root.lifecycle !== "draft" && root.lifecycle !== "published" &&
            !(root.lifecycle === "archived" && root.first_published_at === null)) return err({ kind: "validation", code: "CONTENT_LIFECYCLE_NOT_PUBLISHABLE" });
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
        if (root.lifecycle !== "published") {
          const nextLifecycleSequence = await sql<{ sequence: number }>`
            select coalesce(max(transition_sequence), 0)::integer + 1 as sequence
              from content.lifecycle_history
             where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
          `.execute(executor);
          const lifecycleSequence = nextLifecycleSequence.rows[0]?.sequence;
          if (lifecycleSequence === undefined) throw new PostgresInfrastructureError();
          await sql`
            insert into content.lifecycle_history (
              content_id, portfolio_id, content_type, transition_sequence,
              previous_lifecycle, lifecycle, aggregate_version, reason, changed_at
            ) values (
              ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'project', ${lifecycleSequence},
              ${root.lifecycle}, 'published', ${updated.aggregate_version}, null, transaction_timestamp()
            )
          `.execute(executor);
        }
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
          .map(({ type, label, destination }) => ({ ...(type === undefined ? {} : { type }), label, destination }));
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
        if (root.lifecycle !== "draft" && root.lifecycle !== "published" &&
            !(root.lifecycle === "archived" && root.first_published_at === null)) return err({ kind: "validation", code: "CONTENT_LIFECYCLE_NOT_PUBLISHABLE" });

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
        if (root.lifecycle !== "published") {
          const nextLifecycleSequence = await sql<{ sequence: number }>`
            select coalesce(max(transition_sequence), 0)::integer + 1 as sequence
              from content.lifecycle_history
             where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
          `.execute(executor);
          const lifecycleSequence = nextLifecycleSequence.rows[0]?.sequence;
          if (lifecycleSequence === undefined) throw new PostgresInfrastructureError();
          await sql`
            insert into content.lifecycle_history (
              content_id, portfolio_id, content_type, transition_sequence,
              previous_lifecycle, lifecycle, aggregate_version, reason, changed_at
            ) values (
              ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'testimonial', ${lifecycleSequence},
              ${root.lifecycle}, 'published', ${updated.aggregate_version}, null, transaction_timestamp()
            )
          `.execute(executor);
        }
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
        if (root.lifecycle !== "draft" && root.lifecycle !== "published" &&
            !(root.lifecycle === "archived" && root.first_published_at === null)) return err({ kind: "validation", code: "CONTENT_LIFECYCLE_NOT_PUBLISHABLE" });

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
        if (root.lifecycle !== "published") {
          const nextLifecycleSequence = await sql<{ sequence: number }>`
            select coalesce(max(transition_sequence), 0)::integer + 1 as sequence
              from content.lifecycle_history
             where content_id = ${input.contentId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
          `.execute(executor);
          const lifecycleSequence = nextLifecycleSequence.rows[0]?.sequence;
          if (lifecycleSequence === undefined) throw new PostgresInfrastructureError();
          await sql`
            insert into content.lifecycle_history (
              content_id, portfolio_id, content_type, transition_sequence,
              previous_lifecycle, lifecycle, aggregate_version, reason, changed_at
            ) values (
              ${input.contentId}::uuid, ${input.scope.portfolioId}::uuid, 'achievement', ${lifecycleSequence},
              ${root.lifecycle}, 'published', ${updated.aggregate_version}, null, transaction_timestamp()
            )
          `.execute(executor);
        }
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
            join content.items item on item.content_id = route.content_id and item.portfolio_id = route.portfolio_id
            join content.public_route_reservations reservation
              on reservation.route_identity = route.route_identity
             and reservation.content_id = route.content_id
             and reservation.portfolio_id = route.portfolio_id
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

    async listProjectStatusValues(scope, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const result = await sql<{ value_id: string; label: string; state: string; aggregate_version: number }>`
          select value_id::text, label, state, aggregate_version
            from content.project_status_values
           where portfolio_id = ${scope.portfolioId}::uuid
           order by case when state = 'active' then 0 else 1 end, normalized_label, value_id
        `.execute(executor);
        return { ok: true, value: result.rows.map(statusValue) };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async getProjectOwnerView(projectId, scope, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const result = await sql<{
          content_id: string; aggregate_version: number; status_value_id: string | null; featured: boolean;
          route_identity: string | null; current_slug: string | null;
        }>`
          select item.content_id::text, item.aggregate_version, item.status_value_id::text, item.featured,
                 route.route_identity::text, route.current_slug
            from content.items item
            left join content.public_routes route
              on route.content_id = item.content_id and route.portfolio_id = item.portfolio_id
           where item.content_id = ${projectId}::uuid
             and item.portfolio_id = ${scope.portfolioId}::uuid
             and item.content_type = 'project'
        `.execute(executor);
        const row = result.rows[0];
        if (row === undefined) return err({ kind: "not_found", code: "PROJECT_NOT_FOUND" });
        if (!Number.isSafeInteger(row.aggregate_version) || row.aggregate_version < 1 || typeof row.featured !== "boolean" ||
            (row.route_identity === null) !== (row.current_slug === null)) throw new PostgresInfrastructureError();
        let redirects: { fromSlug: string; toSlug: string }[] = [];
        let routeHistory: { sequence: number; fromSlug: string; toSlug: string; changedAt: string }[] = [];
        if (row.route_identity !== null && row.current_slug !== null) {
          const reservations = await sql<{ normalized_slug: string }>`
            select normalized_slug from content.public_route_reservations
             where route_identity = ${row.route_identity}::uuid and portfolio_id = ${scope.portfolioId}::uuid and not is_current
             order by reserved_at, normalized_slug
             limit 100
          `.execute(executor);
          redirects = reservations.rows.map((reservation) => ({ fromSlug: reservation.normalized_slug, toSlug: row.current_slug! }));
          const history = await sql<{ sequence: number; from_slug: string; to_slug: string; changed_at: Date | string }>`
            select sequence, from_slug, to_slug, changed_at
              from (
                select sequence, from_slug, to_slug, changed_at
                  from content.public_route_history
                 where route_identity = ${row.route_identity}::uuid and content_id = ${projectId}::uuid
                   and portfolio_id = ${scope.portfolioId}::uuid
                 order by sequence desc
                 limit 100
              ) bounded
             order by sequence
          `.execute(executor);
          routeHistory = history.rows.map((entry) => {
            const changedAt = entry.changed_at instanceof Date ? entry.changed_at.toISOString() : new Date(entry.changed_at).toISOString();
            if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
            return { sequence: entry.sequence, fromSlug: entry.from_slug, toSlug: entry.to_slug, changedAt };
          });
        }
        const relatedProjects = await sql<{ project_id: string }>`
          select related_project_id::text as project_id
            from content.project_relationship_views
           where portfolio_id = ${scope.portfolioId}::uuid
             and project_id = ${projectId}::uuid
           order by related_project_id
        `.execute(executor);
        const relationshipHistory = await sql<{
          sequence: number; related_project_id: string; action: "related"; changed_at: Date | string;
        }>`
          select sequence, related_project_id::text, action, occurred_at as changed_at
            from (
              select sequence,
                     case when initiating_project_id = ${projectId}::uuid then related_project_id else initiating_project_id end as related_project_id,
                     action, occurred_at
                from content.project_relationship_history
               where portfolio_id = ${scope.portfolioId}::uuid
                 and (initiating_project_id = ${projectId}::uuid or related_project_id = ${projectId}::uuid)
               order by occurred_at desc, related_project_id
               limit 100
            ) bounded
           order by occurred_at, related_project_id, sequence
        `.execute(executor);
        const statusHistory = await sql<{
          sequence: number; previous_value_id: string | null; current_value_id: string;
          aggregate_version: number; changed_at: Date | string;
        }>`
          select transition_sequence as sequence, previous_value_id::text, current_value_id::text,
                 aggregate_version, changed_at
            from (
              select transition_sequence, previous_value_id, current_value_id, aggregate_version, changed_at
                from content.project_status_history
               where portfolio_id = ${scope.portfolioId}::uuid and content_id = ${projectId}::uuid
               order by transition_sequence desc
               limit 100
            ) bounded
           order by transition_sequence
        `.execute(executor);
        const taxonomyAssignments = await sql<{ taxonomy_id: string; taxonomy_kind: string; value_id: string }>`
          select assignment.taxonomy_id::text, root.kind as taxonomy_kind, assignment.value_id::text
            from content.project_taxonomy_assignments assignment
            join taxonomy.roots root on root.portfolio_id = assignment.portfolio_id and root.taxonomy_id = assignment.taxonomy_id
           where assignment.portfolio_id = ${scope.portfolioId}::uuid and assignment.content_id = ${projectId}::uuid
           order by root.kind, assignment.value_id
        `.execute(executor);
        return { ok: true, value: {
          projectId: row.content_id as StableId<"Project">,
          aggregateVersion: row.aggregate_version,
          statusValueId: row.status_value_id as StableId<"ProjectStatusValue"> | null,
          featured: row.featured,
          publicRoute: row.route_identity === null || row.current_slug === null ? null : {
            identity: row.route_identity as StableId<"PublicRoute">,
            canonicalSlug: row.current_slug,
            redirects: redirects.map((redirect) => ({ fromSlug: redirect.fromSlug, toSlug: redirect.toSlug })),
            history: routeHistory,
          },
          relatedProjectIds: relatedProjects.rows.map((related) => related.project_id as StableId<"Project">),
          relationshipHistory: relationshipHistory.rows.map((entry) => {
            const changedAt = entry.changed_at instanceof Date ? entry.changed_at.toISOString() : new Date(entry.changed_at).toISOString();
            if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
            return { sequence: entry.sequence, relatedProjectId: entry.related_project_id as StableId<"Project">, action: entry.action, changedAt };
          }),
          statusHistory: statusHistory.rows.map((entry) => {
            const changedAt = entry.changed_at instanceof Date ? entry.changed_at.toISOString() : new Date(entry.changed_at).toISOString();
            if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1 || !Number.isSafeInteger(entry.aggregate_version) || entry.aggregate_version < 2 || !Number.isFinite(Date.parse(changedAt))) throw new PostgresInfrastructureError();
            return {
              sequence: entry.sequence,
              previousValueId: entry.previous_value_id as StableId<"ProjectStatusValue"> | null,
              currentValueId: entry.current_value_id as StableId<"ProjectStatusValue">,
              aggregateVersion: entry.aggregate_version,
              changedAt,
            };
          }),
          taxonomyAssignments: taxonomyAssignments.rows.map((assignment) => ({
            taxonomyId: assignment.taxonomy_id as StableId<"Taxonomy">,
            taxonomyKind: assignment.taxonomy_kind,
            valueId: assignment.value_id as StableId<"TaxonomyValue">,
          })),
        } satisfies ContentProjectOwnerView };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async listProjectStatusHistory(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const exists = await sql<{ exists: boolean }>`
          select exists (select 1 from content.project_status_values
            where value_id = ${input.valueId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid) as exists
        `.execute(executor);
        if (exists.rows[0]?.exists !== true) return err({ kind: "not_found", code: "PROJECT_STATUS_VALUE_NOT_FOUND" });
        const result = await sql<{
          operation: string; previous_label: string | null; label: string; state: string;
          aggregate_version: number; changed_at: Date | string;
        }>`
          select operation, previous_label, label, state, aggregate_version, changed_at
            from content.project_status_value_history
           where value_id = ${input.valueId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           order by transition_sequence
        `.execute(executor);
        return { ok: true, value: result.rows.map((row): ContentProjectStatusHistoryEntry => {
          if (!(row.operation === "created" || row.operation === "renamed" || row.operation === "retired") ||
              !(row.state === "active" || row.state === "retired") || !Number.isSafeInteger(row.aggregate_version)) {
            throw new PostgresInfrastructureError();
          }
          return { operation: row.operation, previousLabel: row.previous_label, label: row.label,
            state: row.state, aggregateVersion: row.aggregate_version, changedAt: databaseTime(row.changed_at) };
        }) };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async createProjectStatusValue(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        await sql`select pg_advisory_xact_lock(hashtextextended(${input.scope.portfolioId}::text, 0))`.execute(executor);
        const count = await sql<{ count: number }>`
          select count(*)::integer as count from content.project_status_values
           where portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        if ((count.rows[0]?.count ?? 100) >= 100) return err({ kind: "conflict", code: "PROJECT_STATUS_VALUE_LIMIT_REACHED" });
        const inserted = await sql<{
          value_id: string; label: string; state: string; aggregate_version: number; changed_at: Date | string;
        }>`
          insert into content.project_status_values (value_id, portfolio_id, label)
          values (${input.valueId}::uuid, ${input.scope.portfolioId}::uuid, ${input.label})
          on conflict (portfolio_id, normalized_label) do nothing
          returning value_id::text, label, state, aggregate_version, transaction_timestamp() as changed_at
        `.execute(executor);
        const row = inserted.rows[0];
        if (row === undefined) return err({ kind: "conflict", code: "PROJECT_STATUS_LABEL_ALREADY_EXISTS" });
        const changedAt = databaseTime(row.changed_at);
        await sql`
          insert into content.project_status_value_history (
            value_id, portfolio_id, transition_sequence, operation, previous_label, label, state, aggregate_version, changed_at
          ) values (${input.valueId}::uuid, ${input.scope.portfolioId}::uuid, 1, 'created', null,
            ${row.label}, 'active', 1, ${changedAt}::timestamptz)
        `.execute(executor);
        return { ok: true, value: { value: statusValue(row), changed: true, changedAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async renameProjectStatusValue(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        await sql`select pg_advisory_xact_lock(hashtextextended(${input.scope.portfolioId}::text, 0))`.execute(executor);
        const selected = await sql<{ value_id: string; label: string; state: string; aggregate_version: number }>`
          select value_id::text, label, state, aggregate_version
            from content.project_status_values
           where value_id = ${input.valueId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid for update
        `.execute(executor);
        const current = selected.rows[0];
        if (current === undefined) return err({ kind: "not_found", code: "PROJECT_STATUS_VALUE_NOT_FOUND" });
        const currentValue = statusValue(current);
        if (currentValue.aggregateVersion !== input.expectedVersion) return err({ kind: "precondition_failed", code: "PROJECT_STATUS_VERSION_MISMATCH", currentVersion: currentValue.aggregateVersion });
        if (currentValue.state !== "active") return err({ kind: "validation", code: "PROJECT_STATUS_VALUE_RETIRED" });
        if (currentValue.label === input.label) return { ok: true, value: { value: currentValue, changed: false, changedAt: null } };
        const duplicate = await sql<{ exists: boolean }>`
          select exists (select 1 from content.project_status_values
            where portfolio_id = ${input.scope.portfolioId}::uuid and value_id <> ${input.valueId}::uuid
              and normalized_label = lower(regexp_replace(btrim(${input.label}), '[[:space:]]+', ' ', 'g'))) as exists
        `.execute(executor);
        if (duplicate.rows[0]?.exists === true) return err({ kind: "conflict", code: "PROJECT_STATUS_LABEL_ALREADY_EXISTS" });
        const updated = await sql<{
          value_id: string; label: string; state: string; aggregate_version: number; changed_at: Date | string;
        }>`
          update content.project_status_values
             set label = ${input.label}, aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where value_id = ${input.valueId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           returning value_id::text, label, state, aggregate_version, updated_at as changed_at
        `.execute(executor);
        const row = updated.rows[0];
        if (row === undefined) throw new PostgresInfrastructureError();
        const changedAt = databaseTime(row.changed_at);
        await sql`
          insert into content.project_status_value_history (
            value_id, portfolio_id, transition_sequence, operation, previous_label, label, state, aggregate_version, changed_at
          ) values (${input.valueId}::uuid, ${input.scope.portfolioId}::uuid,
            ${currentValue.aggregateVersion + 1}, 'renamed', ${currentValue.label}, ${row.label}, 'active',
            ${row.aggregate_version}, ${changedAt}::timestamptz)
        `.execute(executor);
        return { ok: true, value: { value: statusValue(row), changed: true, changedAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async retireProjectStatusValue(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selected = await sql<{ value_id: string; label: string; state: string; aggregate_version: number }>`
          select value_id::text, label, state, aggregate_version
            from content.project_status_values
           where value_id = ${input.valueId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid for update
        `.execute(executor);
        const current = selected.rows[0];
        if (current === undefined) return err({ kind: "not_found", code: "PROJECT_STATUS_VALUE_NOT_FOUND" });
        const currentValue = statusValue(current);
        if (currentValue.aggregateVersion !== input.expectedVersion) return err({ kind: "precondition_failed", code: "PROJECT_STATUS_VERSION_MISMATCH", currentVersion: currentValue.aggregateVersion });
        if (currentValue.state === "retired") return { ok: true, value: { value: currentValue, changed: false, changedAt: null } };
        const updated = await sql<{
          value_id: string; label: string; state: string; aggregate_version: number; changed_at: Date | string;
        }>`
          update content.project_status_values
             set state = 'retired', aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where value_id = ${input.valueId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           returning value_id::text, label, state, aggregate_version, updated_at as changed_at
        `.execute(executor);
        const row = updated.rows[0];
        if (row === undefined) throw new PostgresInfrastructureError();
        const changedAt = databaseTime(row.changed_at);
        await sql`
          insert into content.project_status_value_history (
            value_id, portfolio_id, transition_sequence, operation, previous_label, label, state, aggregate_version, changed_at
          ) values (${input.valueId}::uuid, ${input.scope.portfolioId}::uuid,
            ${currentValue.aggregateVersion + 1}, 'retired', ${currentValue.label}, ${row.label}, 'retired',
            ${row.aggregate_version}, ${changedAt}::timestamptz)
        `.execute(executor);
        return { ok: true, value: { value: statusValue(row), changed: true, changedAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async changeProjectStatus(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selectedStatus = await sql<{ state: string }>`
          select state from content.project_status_values
           where value_id = ${input.valueId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid for share
        `.execute(executor);
        if (selectedStatus.rows[0] === undefined) return err({ kind: "validation", code: "PROJECT_STATUS_VALUE_NOT_FOUND" });
        if (selectedStatus.rows[0].state !== "active") return err({ kind: "validation", code: "PROJECT_STATUS_VALUE_NOT_ACTIVE" });
        const selectedProject = await sql<{
          content_id: string; content_type: string; status_value_id: string | null; aggregate_version: number;
        }>`
          select content_id::text, content_type, status_value_id::text, aggregate_version
            from content.items
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const project = selectedProject.rows[0];
        if (project === undefined || project.content_type !== "project") return err({ kind: "not_found", code: "PROJECT_NOT_FOUND" });
        if (!Number.isSafeInteger(project.aggregate_version) || project.aggregate_version < 1) throw new PostgresInfrastructureError();
        if (project.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "PROJECT_VERSION_MISMATCH", currentVersion: project.aggregate_version });
        if (project.status_value_id === input.valueId) return { ok: true, value: {
          previousValueId: project.status_value_id as StableId<"ProjectStatusValue">,
          currentValueId: project.status_value_id as StableId<"ProjectStatusValue">,
          aggregateVersion: project.aggregate_version,
          changedAt: "",
          changed: false,
        } satisfies ContentProjectStatusTransition };
        const updated = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update content.items
             set status_value_id = ${input.valueId}::uuid, aggregate_version = aggregate_version + 1,
                 updated_at = transaction_timestamp()
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const updatedProject = updated.rows[0];
        if (updatedProject === undefined) throw new PostgresInfrastructureError();
        const changedAt = databaseTime(updatedProject.changed_at);
        const sequence = await sql<{ sequence: number }>`
          select coalesce(max(transition_sequence), 0)::integer + 1 as sequence
            from content.project_status_history
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        const nextSequence = sequence.rows[0]?.sequence;
        if (nextSequence === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.project_status_history (
            content_id, portfolio_id, transition_sequence, previous_value_id, current_value_id, aggregate_version, changed_at
          ) values (${input.projectId}::uuid, ${input.scope.portfolioId}::uuid, ${nextSequence},
            ${project.status_value_id}::uuid, ${input.valueId}::uuid, ${updatedProject.aggregate_version}, ${changedAt}::timestamptz)
        `.execute(executor);
        await sql`
          update taxonomy.project_discovery_locales
             set status_value_id = ${input.valueId}::uuid
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        return { ok: true, value: {
          previousValueId: project.status_value_id as StableId<"ProjectStatusValue"> | null,
          currentValueId: input.valueId,
          aggregateVersion: updatedProject.aggregate_version,
          changedAt,
          changed: true,
        } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async setProjectFeatured(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selected = await sql<{ content_type: string; featured: boolean; aggregate_version: number }>`
          select content_type, featured, aggregate_version from content.items
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const project = selected.rows[0];
        if (project === undefined || project.content_type !== "project") return err({ kind: "not_found", code: "PROJECT_NOT_FOUND" });
        if (!Number.isSafeInteger(project.aggregate_version) || project.aggregate_version < 1) throw new PostgresInfrastructureError();
        if (project.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "PROJECT_VERSION_MISMATCH", currentVersion: project.aggregate_version });
        if (project.featured === input.featured) return { ok: true, value: { aggregateVersion: project.aggregate_version, changedAt: null, changed: false } satisfies ContentProjectMutation };
        const updated = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update content.items
             set featured = ${input.featured}, aggregate_version = aggregate_version + 1,
                 updated_at = transaction_timestamp()
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const next = updated.rows[0];
        if (next === undefined) throw new PostgresInfrastructureError();
        const changedAt = databaseTime(next.changed_at);
        await sql`
          update taxonomy.project_discovery_locales
             set featured = ${input.featured}
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
        `.execute(executor);
        return { ok: true, value: { aggregateVersion: next.aggregate_version, changedAt, changed: true } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async assignProjectTaxonomyValue(input, context) {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, input.scope);
        const selected = await sql<{ content_type: string; aggregate_version: number }>`
          select content_type, aggregate_version from content.items
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           for update
        `.execute(executor);
        const project = selected.rows[0];
        if (project === undefined || project.content_type !== "project") return err({ kind: "not_found", code: "PROJECT_NOT_FOUND" });
        if (!Number.isSafeInteger(project.aggregate_version) || project.aggregate_version < 1) throw new PostgresInfrastructureError();
        if (project.aggregate_version !== input.expectedVersion) return err({ kind: "precondition_failed", code: "PROJECT_VERSION_MISMATCH", currentVersion: project.aggregate_version });
        const existing = await sql<{ value_id: string }>`
          select value_id::text from content.project_taxonomy_assignments
           where portfolio_id = ${input.scope.portfolioId}::uuid and content_id = ${input.projectId}::uuid
             and value_id = ${input.valueId}::uuid
        `.execute(executor);
        if (existing.rows.length > 0) return { ok: true, value: { aggregateVersion: project.aggregate_version, changed: false, changedAt: "" } };
        if (!input.eligible) return err({ kind: "validation", code: "TAXONOMY_VALUE_NOT_ACTIVE" });
        const updated = await sql<{ aggregate_version: number; changed_at: Date | string }>`
          update content.items set aggregate_version = aggregate_version + 1, updated_at = transaction_timestamp()
           where content_id = ${input.projectId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
           returning aggregate_version, updated_at as changed_at
        `.execute(executor);
        const next = updated.rows[0];
        if (next === undefined) throw new PostgresInfrastructureError();
        const changedAt = databaseTime(next.changed_at);
        await sql`
          insert into content.project_taxonomy_assignments (portfolio_id, content_id, taxonomy_id, value_id, assigned_at)
          select ${input.scope.portfolioId}::uuid, ${input.projectId}::uuid, value.taxonomy_id, value.value_id, ${changedAt}::timestamptz
            from taxonomy.taxonomy_values value
           where value.portfolio_id = ${input.scope.portfolioId}::uuid and value.value_id = ${input.valueId}::uuid
        `.execute(executor);
        const sequence = await sql<{ sequence: number }>`
          select coalesce(max(sequence), 0)::integer + 1 as sequence
            from content.project_taxonomy_assignment_history
           where portfolio_id = ${input.scope.portfolioId}::uuid and content_id = ${input.projectId}::uuid
        `.execute(executor);
        const nextSequence = sequence.rows[0]?.sequence;
        if (nextSequence === undefined) throw new PostgresInfrastructureError();
        await sql`
          insert into content.project_taxonomy_assignment_history (
            portfolio_id, content_id, sequence, taxonomy_id, value_id, aggregate_version, actor_id, changed_at
          ) select ${input.scope.portfolioId}::uuid, ${input.projectId}::uuid, ${nextSequence}, value.taxonomy_id,
                   value.value_id, ${next.aggregate_version}, ${input.actorId}::uuid, ${changedAt}::timestamptz
              from taxonomy.taxonomy_values value
             where value.portfolio_id = ${input.scope.portfolioId}::uuid and value.value_id = ${input.valueId}::uuid
        `.execute(executor);
        return { ok: true, value: { aggregateVersion: next.aggregate_version, changed: true, changedAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
