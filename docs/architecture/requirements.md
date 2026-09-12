# Architecture requirements

This catalog gives stable identifiers to the first-release requirements in [`project-brief.md`](../../project-brief.md), [`CONTEXT.md`](../../CONTEXT.md), [`docs/domain-model.md`](../domain-model.md), and the accepted ADRs. The identifiers are used by the Structurizr model, traceability matrix, module interfaces, and implementation tickets.

## Functional requirements

| ID | Requirement | Completion criterion |
| --- | --- | --- |
| FR-01 | Core public journey | A Visitor can reach the landing page, discover a Project, read a published Case study, access the Current CV when available, and use a Contact channel when non-critical dependencies fail. |
| FR-02 | Project discovery | Published Projects are searchable and filterable through controlled Taxonomies, ordered newest-published first, with independent Featured presentation and owner-curated Project relationships. |
| FR-03 | Bilingual publication | English and Arabic have independent reviewed Revisions and publications; Arabic is RTL and never falls back to English text. |
| FR-04 | Evidence-led publishing | Owner commands save immutable Revisions and publish, hide, archive, or restore content only after evidence, media, locale, and route validation. |
| FR-05 | Safe media | Uploaded files remain private candidates until type, signature, ownership, suitability, safety, and Media accessibility metadata are accepted. |
| FR-06 | Controlled taxonomy | Taxonomy values can be assigned, renamed, retired, and merged while preserving identity, assignments, and audit history. |
| FR-07 | Visitor interaction and Moderation | Visitors can react, rate, and submit Feedback without accounts; current choices are deduplicated and Feedback remains private until approved. |
| FR-08 | CV portfolio | The Owner can accept CV versions and atomically designate exactly one English Current CV while retaining prior versions. |
| FR-09 | Privacy-preserving measurement | Consented Public event data, immutable Analytics goal versions, Journey context, aggregates, and Low-sample states support portfolio decisions without identity-heavy tracking. |
| FR-10 | Owner portability | A versioned Owner export preserves stable identities, locales, histories, relationships, integrity information, and provider-independent meaning. |
| FR-11 | Owner workspace | One allowlisted Owner authenticates with GitHub OAuth and manages content, settings, Taxonomies, media, CV versions, Moderation, Analytics goals, and exports. |
| FR-12 | Portfolio configuration | The Owner manages the public profile, Contact channels, and one Global project CTA whose unavailable destination degrades safely. |
| FR-13 | Durable routes | First publication establishes a Public route identity; later slug changes preserve prior routes as redirects and canonical metadata. |
| FR-14 | Deferred Lab | Lab entry remains modeled as future scope and is absent from every first-release public and Owner workflow. |

## Quality requirements

| ID | Requirement | Target |
| --- | --- | --- |
| NFR-01 | Capacity | 100,000 page views/month, 25 peak requests/second, and 5 peak mutation requests/second. |
| NFR-02 | Performance | Cached public responses below 500 ms p95; LCP at or below 2.5 s, INP at or below 200 ms, and CLS at or below 0.1 at p75. |
| NFR-03 | Availability and degradation | 99.9% internal public-availability objective; last valid Published content survives failure of analytics, alerts, email, rich media, and External links. |
| NFR-04 | Accessibility | Core public and Owner journeys meet WCAG 2.2 AA and retain a static, reduced-motion-compatible hero fallback. |
| NFR-05 | Security | Server-enforced Owner authorization, RLS, secure sessions, CSRF and XSS defenses, safe URLs, validated uploads, rate limits, and server-only secrets. |
| NFR-06 | Privacy and retention | Consent precedes non-essential measurement; raw analytics lasts 14 days, aggregates 13 months, rejected/unresolved Feedback 90 days, and suppressed history 12 months. |
| NFR-07 | Recovery | Relational RPO 24 hours, media RPO 7 days, RTO 8 hours, with encrypted off-provider backups and tested restoration. |
| NFR-08 | Observability | Metrics, structured logs, scrubbed traces, and actionable-only alerts cover publication, auth, jobs, analytics lag, backups, errors, and quota pressure. |
| NFR-09 | Evolvability | Domain modules do not import Next.js, Supabase, Vercel, or another module's implementation; provider and job adapters remain replaceable. |

## Capacity model

- `100,000 / 30 / 86,400` is approximately `0.04` average page views/second. The 25 requests/second design peak therefore covers short recruiter/social bursts by more than two orders of magnitude.
- At no more than three events per page view, the pre-consent upper bound is 300,000 raw events/month. With an implementation budget of 350 bytes/event plus 100% index overhead, 14-day raw retention consumes approximately 98 MB; consent should reduce the observed total.
- Content, revision, taxonomy, Moderation, and operational records receive a 100 MB first-year planning budget excluding analytics indexes.
- Media capacity is provider-quota driven. Storage or egress at 70% of the configured Supabase allowance opens the R2 assessment before uploads are blocked.
- PostgreSQL is scaled by query tuning, indexes, pooling, and vertical capacity before read replicas. Sharding is outside the expected lifetime of this workload.
