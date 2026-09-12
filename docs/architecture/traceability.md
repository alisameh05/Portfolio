# Architecture traceability

This matrix connects product intent to model elements, Structurizr view keys, and checkable implementation evidence. `Verified` means the architecture artifact was exercised in this repository; `Planned` identifies the exact future application test that must exist before release.

## Test evidence catalog

| Test ID | Evidence | Status |
| --- | --- | --- |
| A-01 | Structurizr MCP validates `workspace.dsl` with `OK`. | Verified |
| A-02 | Structurizr MCP parses all 13 stable view keys. | Verified |
| A-03 | Structurizr MCP inspection returns zero errors; two documented repository-path checks are ignored. | Verified |
| A-04 | Every view exports to Mermaid and C4-PlantUML under `exports/`. | Verified |
| Q-01 | Static dependency tests reject imports from domain modules to Next.js, provider SDKs, or another module's implementation. | Planned |
| Q-02 | Load tests sustain 25 requests/second and 5 mutations/second while meeting the latency objective and throttling excess writes. | Planned |
| Q-03 | Automated axe, keyboard, reduced-motion, RTL, and real-device Core Web Vitals gates pass for core journeys. | Planned |
| Q-04 | Security tests cover OAuth allowlist mismatch, RLS, CSRF, XSS, malicious URLs, upload spoofing, secret exposure, and rate limits. | Planned |
| Q-05 | Failure injection disables analytics, Resend, Sentry, media delivery, and External links independently without breaking the Core public journey. | Planned |
| Q-06 | An isolated monthly restore verifies backup checksums, stable identities, routes, publications, Moderation history, and RPO/RTO evidence. | Planned |
| Q-07 | Operational tests verify outbox age, job failure, analytics lag, backup, OAuth anomaly, error-rate, and quota alerts without healthy-run notifications. | Planned |
| I-01 | PostgreSQL integration tests prove atomic domain state plus outbox commit and rollback. | Planned |
| I-02 | RLS integration tests prove public published reads, private drafts/uploads/Feedback, and Owner-only writes. | Planned |
| I-03 | Retry tests prove idempotency and uniqueness for public mutations, event intake, job handlers, and exports. | Planned |
| I-04 | Cache tests prove stable identity/locale tags, targeted invalidation, and no Draft leakage before invalidation. | Planned |
| I-05 | Retention tests expire raw events, aggregates, rejected/unresolved Feedback, and suppressed history at the accepted limits. | Planned |
| I-06 | Portability tests verify schema version, manifest, checksums, stable relationships, privacy filtering, and compatible import meaning. | Planned |
| E-01 | Browser tests cover the landing-to-discovery-to-Case-study-to-CV-to-contact Core public journey. | Planned |
| E-02 | Browser tests prove independent English/Arabic publication, no text fallback, full RTL behavior, and truthful English-only destinations. | Planned |
| E-03 | Browser tests prove GitHub OAuth Owner access uses immutable allowlist identity and public signup grants no workspace access. | Planned |
| E-04 | Browser tests cover Reaction/Rating replacement, private Feedback submission, approval, rejection, suppression, and hidden-Project behavior. | Planned |
| E-05 | Browser tests cover private upload, Media acceptance, accessibility metadata, CV activation, and signed Current CV access. | Planned |

`D-01` through `D-16` refer one-to-one to the 16 acceptance scenarios in [`docs/domain-model.md`](../domain-model.md); each must be implemented as a domain-interface test.

## Functional requirements

| Requirement | Owning model elements | Primary views | Evidence |
| --- | --- | --- | --- |
| FR-01 Core public journey | Public Experience, Content and Publishing, CV Portfolio, Portfolio Configuration | `SystemContext`, `PublicRead`, `ActivateCurrentCv` | D-15, E-01, Q-05 |
| FR-02 Project discovery | Content and Publishing, Taxonomy and Discovery | `Modules`, `PublicRead` | D-07, D-08, E-01 |
| FR-03 Bilingual publication | Public Experience, Content and Publishing | `PublicRead`, `PublishLanguageVersion` | D-01, D-02, D-13, E-02 |
| FR-04 Evidence-led publishing | Owner Workspace, Content and Publishing, Media, Portability and Operations | `PublishLanguageVersion` | D-03, D-12, I-01, I-04 |
| FR-05 Safe media | Owner Workspace, Media, Object Storage | `AcceptMedia` | D-12, E-05, Q-04 |
| FR-06 Controlled taxonomy | Taxonomy and Discovery | `Modules`, `PublishLanguageVersion` | D-08, I-01 |
| FR-07 Visitor interaction and Moderation | Interaction and Moderation, Identity and Access | `ModerateFeedback` | D-05, D-10, D-11, E-04, I-03 |
| FR-08 CV portfolio | CV Portfolio, Media, Object Storage | `ActivateCurrentCv` | D-09, E-05, I-01 |
| FR-09 Privacy-preserving measurement | Measurement, Identity and Access, Portability and Operations | `AnalyticsPipeline` | I-03, I-05, Q-04 |
| FR-10 Owner portability | Portability and Operations, Database, Object Storage | `ProduceOwnerExport` | D-16, I-06, Q-06 |
| FR-11 Owner workspace | Owner Workspace, Identity and Access, Supabase Auth, GitHub OAuth | `SystemContext`, `Modules` | E-03, I-02, Q-04 |
| FR-12 Portfolio configuration | Portfolio Configuration, Public Experience | `PublicRead` | E-01, Q-05 |
| FR-13 Durable routes | Content and Publishing, Database | `PublicRead`, `PublishLanguageVersion` | D-04, I-01, I-04 |
| FR-14 Deferred Lab | Content and Publishing | `Modules` | D-14, Q-01 |

## Quality requirements

| Requirement | Architecture mechanism | Primary views | Evidence |
| --- | --- | --- | --- |
| NFR-01 Capacity | CDN caching, pooled connections, bounded writes, vertical-first scaling | `Containers`, `ProductionDeployment` | Q-02 |
| NFR-02 Performance | Cached public projections, PostgreSQL full-text/trigram indexes, progressive media | `PublicRead`, `ProductionDeployment` | Q-02, Q-03 |
| NFR-03 Availability and degradation | Last valid publication, independent optional integrations, retry-safe jobs | `SystemContext`, `PublicRead`, `ProductionDeployment` | D-03, D-15, Q-05 |
| NFR-04 Accessibility | Public Experience fallback and accepted Media accessibility metadata | `Modules`, `AcceptMedia` | D-12, Q-03 |
| NFR-05 Security | Identity and Access, Provider Adapters, RLS, signed operations, upload validation | `Modules`, `AcceptMedia`, `ProductionDeployment` | I-02, E-03, Q-04 |
| NFR-06 Privacy and retention | Consent separation, allowlisted events, Low-sample policy, scheduled deletion | `AnalyticsPipeline`, `ModerateFeedback` | I-05, Q-04 |
| NFR-07 Recovery | Encrypted nightly database and weekly storage artifacts plus isolated restore | `ProduceOwnerExport`, `ProductionDeployment` | I-06, Q-06 |
| NFR-08 Observability | Structured logs, scrubbed Sentry traces, provider metrics, actionable alerts | `Containers`, `ProductionDeployment` | Q-07 |
| NFR-09 Evolvability | Deep module interfaces, provider adapters, outbox events, measured extraction triggers | `Modules`, `FutureExtraction` | Q-01, A-02 |

## ADR traceability

| ADR | Architecture consequence | Views | Evidence |
| --- | --- | --- | --- |
| 0001 Evidence-led public publication | Content and Publishing performs atomic publication validation. | `PublishLanguageVersion` | D-03, D-12, I-01 |
| 0002 Accessible immersive hero | Public Experience preserves a static and reduced-motion Core public journey. | `PublicRead` | Q-03, Q-05 |
| 0003 Newest published projects first | Taxonomy and Discovery owns publication-time ordering; Featured remains orthogonal. | `PublicRead` | D-06, D-07 |
| 0004 Privacy-preserving analytics | Measurement is consented, purpose-limited, aggregate-first, and separate from functional identity. | `AnalyticsPipeline` | I-05, Q-04 |
| 0005 Controlled taxonomy evolution | Taxonomy and Discovery owns rename, retirement, merge, and historical mapping. | `Modules` | D-08, I-01 |
| 0006 Minimal testimonial publication | Content and Publishing applies the restrained Testimonial evidence rule and retained suppression history. | `Modules` | Domain-interface testimonial tests |
| 0007 Defer Lab launch | Lab entry has no first-release route, Owner command, or public projection. | `Modules` | D-14, Q-01 |
| 0008 Measurable public quality gates | Public fallbacks, SLOs, alerts, accessibility, and release gates are architectural constraints. | `ProductionDeployment`, `PublicRead` | Q-02, Q-03, Q-05, Q-07 |
| 0009 Bilingual launch boundary | Publication and routing operate independently for English and Arabic. | `PublishLanguageVersion`, `PublicRead` | D-01, D-02, D-13, E-02 |
| 0010 Durable public identity and safe media | Routes use stable identities and Media crosses to public state only after acceptance. | `PublicRead`, `AcceptMedia` | D-04, D-12, E-05 |
| 0011 Owner data portability | Portability and Operations creates versioned, integrity-checked provider-independent packages. | `ProduceOwnerExport` | D-16, I-06 |
| 0012 Domain-oriented modular monolith | Nine modules share one deployment and database behind explicit interfaces and extraction triggers. | `Modules`, `FutureExtraction` | Q-01, Q-02 |
| 0013 Vercel and Supabase with provider seams | Provider Adapters isolate hosting, auth, persistence, storage, cache, and integrations. | `Containers`, `ProductionDeployment` | Q-01, E-03, Q-05 |
| 0014 Transactional outbox and consistency | Strong state and outbox commit together; eventual handlers are idempotent and leased. | All dynamic views | I-01, I-03, Q-07 |
| 0015 Consent-first measurement retention | Consent and functional identities are separate and conservative retention is scheduled. | `AnalyticsPipeline`, `ModerateFeedback` | I-05, Q-04 |

## Domain acceptance scenarios

| Scenario | Modules | Views | Evidence |
| --- | --- | --- | --- |
| D-01 Independent languages | Content and Publishing | `PublishLanguageVersion` | Domain test plus E-02 |
| D-02 No text fallback | Content and Publishing, Public Experience | `PublicRead` | Domain test plus E-02 |
| D-03 Last valid publication | Content and Publishing, Portability and Operations | `PublishLanguageVersion` | Domain test plus I-01/I-04 |
| D-04 Durable identity | Content and Publishing | `PublicRead` | Domain test plus route integration test |
| D-05 Lifecycle retention | Content and Publishing, Interaction and Moderation | `ModerateFeedback`, `PublicRead` | Domain test plus E-04 |
| D-06 Orthogonal featuring | Content and Publishing, Taxonomy and Discovery | `PublicRead` | Domain test |
| D-07 Newest-first discovery | Taxonomy and Discovery | `PublicRead` | Domain test plus indexed-query integration test |
| D-08 Controlled taxonomy | Taxonomy and Discovery | `Modules` | Domain test plus I-01 |
| D-09 Atomic CV replacement | CV Portfolio, Media | `ActivateCurrentCv` | Domain test plus I-01/E-05 |
| D-10 Interaction deduplication | Interaction and Moderation, Identity and Access | `ModerateFeedback` | Domain test plus I-03/E-04 |
| D-11 Moderation privacy | Interaction and Moderation | `ModerateFeedback` | Domain test plus I-02/E-04 |
| D-12 Publication gates | Content and Publishing, Media | `PublishLanguageVersion`, `AcceptMedia` | Domain test plus Q-04/E-05 |
| D-13 Arabic boundary | Content and Publishing, Media, CV Portfolio | `PublicRead`, `ActivateCurrentCv` | Domain test plus E-02 |
| D-14 Deferred Lab | Content and Publishing | `Modules` | Domain test plus Q-01 |
| D-15 Degraded dependencies | Public Experience, Provider Adapters | `SystemContext`, `PublicRead` | Domain test plus Q-05 |
| D-16 Portable meaning | Portability and Operations | `ProduceOwnerExport` | Domain test plus I-06/Q-06 |
