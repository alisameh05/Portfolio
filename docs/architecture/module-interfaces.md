# Module interfaces and ownership

The Next.js application contains nine domain modules plus one Provider Adapters module. A module owns its implementation, its write path, and the migrations for its records. Callers and tests use the same interface; Next.js request objects, Supabase rows, provider SDK results, and another module's internal types never cross a domain interface.

## Shared contract

The signatures below are architectural TypeScript, not a generated SDK. Concrete types must preserve these semantics while remaining local to the owning module.

```ts
type StableId = string & { readonly stableId: unique symbol };
type IdempotencyKey = string & { readonly idempotencyKey: unique symbol };

type ActorContext =
  | { kind: "owner"; ownerId: StableId; authenticatedAt: Date }
  | { kind: "visitor"; functionalId?: StableId; analyticsConsent: boolean }
  | { kind: "system"; jobId: StableId };

type Rejection =
  | { kind: "validation"; fields: Record<string, string> }
  | { kind: "unauthorized" }
  | { kind: "forbidden" }
  | { kind: "not-found" }
  | { kind: "conflict"; currentVersion?: string }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "unavailable"; retryable: boolean };

type Result<T> = { ok: true; value: T; events: DomainEvent[] } | { ok: false; error: Rejection };
type DomainEvent = { id: StableId; type: string; version: number; occurredAt: Date; payload: unknown };
```

Owner commands require an Owner `ActorContext`. Retriable public mutations require an `IdempotencyKey`. Successful state changes return domain events; committing those events to the outbox is the transaction adapter's responsibility.

## Module catalog

### Portfolio Configuration

**Owns**: public profile, Contact channels, Global project CTA, and their histories.

```ts
interface PortfolioConfiguration {
  getPublicConfiguration(locale: "en" | "ar"): Promise<PublicPortfolioConfiguration>;
  execute(command: PortfolioConfigurationCommand, actor: ActorContext): Promise<Result<ConfigurationVersion>>;
}
```

Public reads must omit unavailable destinations and produce a safe CTA fallback. Writes never publish Media assets; they may reference only an accepted Media asset identity.

### Content and Publishing

**Owns**: Projects, Achievements, Testimonials, immutable Revisions, Evidence packages, Public lifecycle, language publications, Project relationships, External links, Public route identities, and redirects. Lab entry types remain internal future scaffolding and reject first-release publication.

```ts
interface ContentPublishing {
  resolvePublicRoute(route: string, locale: "en" | "ar"): Promise<PublicRouteResult>;
  queryPublished(query: PublishedContentQuery): Promise<PublishedContentPage>;
  execute(command: PublishingCommand, actor: ActorContext): Promise<Result<PublishingOutcome>>;
}
```

Publication validates the reviewed Revision, Evidence package, accepted Media references, locale, release boundary, and route identity before one atomic commit. Failure preserves the previous current publication and canonical route.

### Taxonomy and Discovery

**Owns**: Taxonomies, Taxonomy values, retirement records, merge mappings, searchable Project projection, and filter semantics.

```ts
interface TaxonomyDiscovery {
  discover(query: DiscoveryQuery): Promise<ProjectDiscoveryPage>;
  execute(command: TaxonomyCommand, actor: ActorContext): Promise<Result<TaxonomyOutcome>>;
}
```

Discovery returns Published Projects only, ordered by publication time descending. Rename preserves identity, retirement blocks new assignments, and merge migrates assignments exactly once while retaining the mapping.

### Media

**Owns**: Media asset identity, upload candidate state, validation evidence, accessibility metadata, acceptance history, storage keys, and variants.

```ts
interface MediaLibrary {
  prepareUpload(request: UploadRequest, actor: ActorContext): Promise<Result<PrivateUploadGrant>>;
  execute(command: MediaCommand, actor: ActorContext): Promise<Result<MediaOutcome>>;
  resolvePublicAsset(id: StableId, variant: MediaVariant): Promise<PublicMediaResult>;
}
```

An upload grant is short-lived, private, size-limited, and bound to one candidate. Resolution succeeds only for accepted assets and never exposes provider credentials or raw private object keys.

### CV Portfolio

**Owns**: CV portfolio identity, CV versions, acceptance state, and the Current CV designation.

```ts
interface CvPortfolio {
  resolveCurrent(locale: "en" | "ar"): Promise<CurrentCvResult>;
  execute(command: CvCommand, actor: ActorContext): Promise<Result<CvOutcome>>;
}
```

Activation accepts only an accepted English CV version in the first release and replaces the prior Current CV atomically. Arabic resolution returns a truthful unavailable result rather than an English-localized claim.

### Interaction and Moderation

**Owns**: Reactions, Ratings, Feedback, current interaction choices, immutable Moderation decisions, and public aggregates.

```ts
interface InteractionModeration {
  submit(command: PublicInteractionCommand, actor: ActorContext, key: IdempotencyKey): Promise<Result<InteractionOutcome>>;
  queryPublic(projectId: StableId, locale: "en" | "ar"): Promise<PublicInteractionSummary>;
  moderate(command: ModerationCommand, actor: ActorContext): Promise<Result<ModerationOutcome>>;
}
```

One functional Visitor identity has at most one current Reaction and Rating per Project. Feedback is private until approval; rejection and later suppression retain decision history. Hidden or Archived Projects reject new submissions and expose no aggregates.

### Measurement

**Owns**: consented Public event data, pseudonymous analytics identity, Analytics goals and immutable versions, Journey context, daily aggregates, and Low-sample policy.

```ts
interface Measurement {
  record(event: PublicMeasurementEvent, actor: ActorContext, key: IdempotencyKey): Promise<Result<RecordedEvent>>;
  execute(command: AnalyticsGoalCommand, actor: ActorContext): Promise<Result<AnalyticsGoalOutcome>>;
  report(query: AnalyticsReportQuery, actor: ActorContext): Promise<Result<AnalyticsReport>>;
}
```

`record` rejects events without analytics consent and fields outside the allowlisted schema. Reports label Engagement estimates as approximate, preserve goal-version identity, and suppress dimensions below the configured sample floor.

### Identity and Access

**Owns**: the allowlisted GitHub provider identity, Owner session policy, short-lived abuse signals, consent state, and purpose-limited functional and analytics identities.

```ts
interface IdentityAccess {
  requireOwner(session: ExternalSession): Promise<Result<ActorContext>>;
  establishVisitorPurpose(request: VisitorPurposeRequest): Promise<Result<VisitorIdentityGrant>>;
  authorizeJob(request: ScheduledJobRequest): Promise<Result<ActorContext>>;
}
```

GitHub email or display name never grants Owner access; the immutable provider subject must match the configured allowlist. Functional interaction identity and analytics identity are separate grants with separate purpose and retention.

### Portability and Operations

**Owns**: export requests, schemas and manifests, integrity results, outbox records, job leases and attempts, recovery evidence, backup records, and Operational alerts.

```ts
interface PortabilityOperations {
  requestExport(scope: ExportScope, actor: ActorContext, key: IdempotencyKey): Promise<Result<ExportRequest>>;
  dispatch(batch: JobBatch, actor: ActorContext): Promise<Result<JobBatchOutcome>>;
  getOperationalState(actor: ActorContext): Promise<Result<OperationalState>>;
}
```

Dispatch uses leases, bounded retries, exponential backoff, and a terminal failed state that raises one actionable alert. Export manifests carry schema version, creation time, included scope, checksums, and stable identity relationships.

### Provider Adapters

**Owns no domain data.** It implements seams for transactions, repositories, object storage, GitHub/Supabase Auth, clocks, cache tags, email, monitoring, scheduled invocation, rate-limit signals, and backup artifacts.

Production adapters translate provider failures to typed `Rejection` or job outcomes. Tests replace an adapter at the existing seam; they do not add a second interface around it.

## Allowed dependency directions

- Public Experience and Owner Workspace call domain module interfaces.
- Content and Publishing may query Media, Taxonomy and Discovery, and Portfolio Configuration interfaces during validation; it cannot write through them.
- CV Portfolio may query Media acceptance.
- Interaction and Moderation and Measurement may request purpose-limited identity grants.
- Every state-changing module writes through transaction/repository adapters and appends events through the same transaction.
- Portability and Operations reads module-owned export projections; it never reconstructs domain meaning from provider rows.
- Provider Adapters depend on provider SDKs and domain interface types. Domain modules do not depend on provider SDKs, Next.js, route handlers, or React.

## HTTP surface

Public pages are server-rendered. The only versioned public mutation routes are:

| Route | Interface call | Notes |
| --- | --- | --- |
| `PUT /api/v1/projects/{projectId}/reaction` | `InteractionModeration.submit` | Idempotency key required; replaces the current choice. |
| `PUT /api/v1/projects/{projectId}/rating` | `InteractionModeration.submit` | Idempotency key required; accepts one through five. |
| `POST /api/v1/projects/{projectId}/feedback` | `InteractionModeration.submit` | Idempotency key required; stores private pending Feedback. |
| `POST /api/v1/events` | `Measurement.record` | Consent and idempotency required; allowlisted schema only. |
| `GET /api/v1/cv/current` | `CvPortfolio.resolveCurrent` | Redirects to a short-lived signed asset and records accounting asynchronously. |

Owner forms use authenticated Server Actions or private route handlers that map one request to one conceptual domain command. They are not a general public CRUD interface.
