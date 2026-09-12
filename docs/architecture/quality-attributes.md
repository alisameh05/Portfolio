# Quality attributes and operations

## Consistency and asynchronous work

Strongly consistent operations are publication and route changes, Taxonomy merges, Current CV activation, Moderation decisions, Owner authorization, and acceptance of Media assets. Each executes in one PostgreSQL transaction with the relevant optimistic version check, uniqueness constraints, and outbox insert.

Analytics aggregation, cache invalidation, email, error forwarding, exports, backup orchestration, and link checks are eventually consistent. Their outbox handlers use this lifecycle:

`pending -> leased -> succeeded`

Failed work returns to `pending` with exponential backoff until the configured attempt limit, then becomes `failed` and raises one Operational alert. A lease expiry makes abandoned work eligible for a later worker. The idempotency key is unique per handler and event version; success is recorded before acknowledgement.

Vercel Cron invokes one authenticated job endpoint. Identity and Access validates the schedule secret and constructs a System actor. One invocation claims a bounded batch with `FOR UPDATE SKIP LOCKED`, stops before its execution deadline, and leaves remaining work for the next invocation.

## Caching and public degradation

- Landing, gallery, Timeline, Case study, and public configuration reads use tag-addressed Next.js caching behind Vercel CDN.
- Tags are derived from stable identities and locale, never from display titles or slugs.
- A successful publication writes its outbox event; cache invalidation is retried asynchronously. Until invalidation succeeds, the previous valid publication may remain visible but no Draft can become visible.
- Dynamic interaction summaries load independently of core case-study content and may show an unavailable state without breaking navigation.
- Media has text alternatives or a functional fallback. Analytics, Resend, Sentry, and External link failures never replace the Core public journey.
- No Redis is introduced while CDN/application caching and PostgreSQL indexes meet the documented targets.

## Security model

### Trust zones

1. **Untrusted browser**: all Visitor and Owner browser input, files, URLs, rich text, locale, cookies, and headers.
2. **Vercel application**: validates requests, authorizes actors, executes module interfaces, and holds server-only provider credentials.
3. **Supabase data plane**: PostgreSQL and private object buckets protected by TLS, RLS, least-privilege roles, and signed access.
4. **Operational providers**: GitHub OAuth, Resend, Sentry, and GitHub Actions receive only the minimum data required for their purpose.

### Controls

- Supabase Auth delegates Owner sign-in to GitHub OAuth. Public signup is disabled and the immutable GitHub provider subject is matched against `OWNER_GITHUB_SUBJECTS`; email and display-name matches are insufficient.
- Owner sessions use secure, HTTP-only, same-site cookies. State-changing requests require same-origin checks and CSRF protection; destructive operations can require recent reauthentication.
- PostgreSQL RLS denies direct public table writes. Public reads use explicit published-language projections; privileged writes run through server-side module commands.
- Rich text is sanitized to an allowlist, rendered with output encoding, and covered by a restrictive Content Security Policy. External links accept `https`, with explicitly modeled `mailto`, `tel`, or platform schemes only where the Contact channel type allows them.
- Upload grants are private, short-lived, size-limited, and bound to one candidate. Acceptance verifies declared MIME type, extension, content signature, malware/safety result, ownership, and Media accessibility metadata.
- Rate limits key on action, stable Project identity, and a short-lived keyed network signal. Raw IP addresses are neither persisted nor emitted to logs or analytics.
- Sentry scrubbing removes cookies, authorization headers, names, Feedback, event payloads, and CV/media contents before transmission.
- Secrets live in Vercel, Supabase, and GitHub encrypted configuration, are scoped by environment, and never enter the DSL, repository, browser bundles, exports, or logs.

## Privacy and retention

- Passive browsing creates no analytics identity. Consent creates a purpose-limited analytics identity; withdrawal prevents new non-essential events and schedules eligible detail for deletion or anonymization.
- Reacting or rating may create a separate signed functional identity at the moment of interaction. It is used only to enforce one current choice per Visitor and Project.
- Event intake allows at most three events per page view and accepts only enumerated action, stable content identity, coarse referrer class, coarse geography/device/language, consent version, event time, and bounded Journey context.
- Raw Public event data expires after 14 days; daily aggregates expire after 13 months.
- Rejected or unresolved Feedback expires after 90 days. Suppressed Feedback and its Moderation history expire after 12 months unless an Owner or legal deletion rule requires earlier removal.
- Analytics reports expose a Low-sample state and suppress dimensions below the implementation's documented sample floor. They describe Journey context, never causal attribution.

## Capacity and scaling

The workload target is 100,000 page views/month, 25 peak requests/second, 5 peak mutations/second, and at most 300,000 pre-consent events/month. Cached public reads absorb bursts; pooled serverless connections protect PostgreSQL.

Scaling order:

1. Inspect query plans, remove N+1 access, add or adjust indexes, and bound result sizes.
2. Increase PostgreSQL and application capacity while preserving connection-pool limits.
3. Add read replicas only if measured read load remains the bottleneck and replica lag is acceptable for the selected read path.
4. Partition expired high-volume event data if retention deletion or aggregation becomes the bottleneck.
5. Extract a module only at a measured trigger below; do not shard this portfolio database.

| Candidate | Sustained extraction trigger | Extracted ownership |
| --- | --- | --- |
| Measurement | More than 1,000,000 events/day or aggregation repeatedly delays operational transactions | Event intake, analytics identities, goal versions, aggregates, and its own database |
| Media | Provider processing limits are exceeded or backlog remains above five minutes | Validation/variants, object metadata, job workers, and its own database |
| Interaction and Moderation | More than 250 sustained writes/second | Reactions, Ratings, Feedback, Moderation history, aggregates, and its own database |
| Taxonomy and Discovery search | More than 100,000 public documents and search stays above 300 ms p95 after PostgreSQL tuning | Search projection/index only; Taxonomy authority remains in the monolith |

Organizational extraction additionally requires a separately accountable team and independent release cadence. Extraction uses versioned outbox events, starts with a backfilled read model, cuts reads before writes, and ends with removal of shared-table access.

## Availability, recovery, and backup

- Public availability objective: 99.9% measured at the Core public journey, excluding truthful failure of an External destination outside ShipWithAli's control.
- Cached response objective: below 500 ms p95. User-experience gates at p75 are LCP no more than 2.5 seconds, INP no more than 200 ms, and CLS no more than 0.1.
- Relational RPO: 24 hours. Media RPO: 7 days. RTO: 8 hours.
- A nightly GitHub Actions job creates a PostgreSQL logical dump, manifest, checksum, and encrypted private artifact with seven-day retention. A weekly job creates an encrypted storage/Owner-export artifact. Encryption keys remain separate from artifacts.
- A monthly rehearsal restores into an isolated local Supabase environment, verifies checksums, applies migrations, and runs portable-meaning and route-identity tests. Production is never the restore target of a rehearsal.
- Provider backup features may supplement these artifacts but do not replace the tested Owner-controlled path.

## Observability and alerting

Structured application logs carry request ID, actor kind, module, operation, stable entity ID when non-sensitive, result class, latency, and outbox/job correlation ID. They exclude content bodies and raw identifiers. Sentry supplies scrubbed exceptions and sampled traces; provider metrics supply runtime, database, and storage health.

Actionable alerts cover:

- publication or restoration failures above their normal validation baseline;
- unauthorized Owner attempts or OAuth allowlist mismatch anomalies;
- public error rate, latency, or availability objective breaches;
- outbox age above five minutes, repeated job failure, or Analytics aggregation lag above 24 hours;
- failed or missing backup and failed monthly restoration;
- database, storage, or egress above 70% of the configured allowance;
- sustained CSP violations or upload-safety failures.

Routine successful jobs and healthy traffic produce dashboards, not alerts.

## Environments and rollout

- Local development and CI use local Supabase migrations and deterministic seed data.
- Vercel previews receive non-production configuration and seeded data; they never receive production service-role, OAuth, Resend, Sentry, storage, or backup credentials.
- Production migrations pass unit, integration, RLS, static-dependency, and restore checks. Schema changes use expand-contract steps so the previous application deployment remains compatible.
- A verified preview is promoted to production. Application rollback uses the prior Vercel deployment; database rollback uses a forward corrective migration rather than destructive reversal.
- Storage or egress at 70% opens an R2 assessment. Migration copies objects, verifies checksums, switches the storage adapter, and preserves every Media asset identity and public reference.
