# ShipWithAli architecture

This directory is the implementation architecture for ShipWithAli. Domain meaning remains authoritative in [`CONTEXT.md`](../../CONTEXT.md) and behavior remains authoritative in [`docs/domain-model.md`](../domain-model.md); accepted ADRs override older proposals. The architecture is expressed as code in [`workspace.dsl`](./workspace.dsl).

## Decision summary

ShipWithAli is a domain-oriented modular monolith: one Next.js deployment, one PostgreSQL database, and one primary object store. Nine deep modules expose narrow interfaces while provider adapters isolate Next.js, Vercel, Supabase, GitHub OAuth, Resend, and Sentry. Correctness-critical changes are synchronous and transactional; asynchronous effects use an outbox and an idempotent PostgreSQL-backed job queue.

The first release intentionally has no microservices, external message broker, Redis cache, search cluster, GraphQL gateway, separate CMS, Visitor accounts, or Lab entry surface. Quantitative extraction triggers are documented in [`quality-attributes.md`](./quality-attributes.md).

## Document map

- [`requirements.md`](./requirements.md): stable functional and quality requirement identifiers plus capacity estimates.
- [`module-interfaces.md`](./module-interfaces.md): module ownership, interfaces, error contract, and allowed dependency directions.
- [`quality-attributes.md`](./quality-attributes.md): security, privacy, consistency, caching, operations, recovery, deployment, and extraction policy.
- [`traceability.md`](./traceability.md): requirements, ADRs, domain scenarios, views, and test evidence.
- [`validation.md`](./validation.md): reproducible MCP validation result, view manifest, inspection disposition, and source hash.
- `exports/`: MCP-generated Mermaid and C4-PlantUML snapshots keyed by Structurizr view identifier.

## C4 view catalog

| View key | Purpose |
| --- | --- |
| `SystemLandscape` | Shows the people, ShipWithAli, runtime providers, operational integrations, and public destinations. |
| `SystemContext` | Shows the people and external systems that directly interact with ShipWithAli. |
| `Containers` | Shows the Next.js application, PostgreSQL database, and object storage. |
| `Modules` | Shows the nine domain modules and the Provider Adapters module inside the Next.js application. |
| `ProductionDeployment` | Maps container and external-system instances to Vercel, Supabase, GitHub, Resend, and Sentry deployment nodes. |
| `PublishLanguageVersion` | Shows reviewed publication, media validation, transaction commit, outbox, and cache invalidation. |
| `PublicRead` | Shows route resolution, published-language projection, filtering, and cached rendering. |
| `ModerateFeedback` | Shows private Feedback submission and retained Moderation decisions. |
| `AnalyticsPipeline` | Shows consent checking, minimized intake, durable aggregation work, and reports. |
| `AcceptMedia` | Shows private upload preparation, object validation, metadata acceptance, and outbox work. |
| `ActivateCurrentCv` | Shows accepted-media validation and atomic Current CV replacement. |
| `ProduceOwnerExport` | Shows portable export construction, integrity metadata, storage, and recovery jobs. |
| `FutureExtraction` | Shows the only four measured extraction candidates and their versioned-event seams. |

## Validation gate

Architecture work is complete only when all four checks pass:

1. Structurizr MCP `validate` returns `OK` for the complete DSL.
2. MCP `parse` returns a workspace containing every stable view key above.
3. MCP `inspect` returns no errors; warnings are either corrected or recorded in this file.
4. Every view exports through both Mermaid and C4-PlantUML, and the returned text is stored under `exports/`.

The remote MCP is used only for DSL validation, parsing, inspection, and export. The registry record was unpublished at implementation time, so DSL must contain no secrets, credentials, private CV content, production data, or identifying Visitor data. Server create, update, and delete tools are outside this workflow.

The remote MCP accepts a DSL string and cannot resolve repository-relative `!docs` or `!adrs` paths. The workspace therefore ignores only the `model.softwaresystem.documentation` and `model.softwaresystem.decisions` inspection types for ShipWithAli. The Markdown files in this directory and `docs/adr/` remain the versioned sources of truth and can be attached by a filesystem-aware Structurizr Local/CLI workflow later; all other inspections remain enabled.

## System-design diagnostic

| Diagnostic | Evidence | Result |
| --- | --- | --- |
| Functional and quality requirements | `requirements.md` and `traceability.md` | Pass |
| QPS and storage estimates | `requirements.md` capacity model | Pass |
| Redundancy and recovery | CDN degradation, backups, RPO/RTO, restore test | Pass |
| Database scaling | Pooling, indexes, vertical-first policy, replica trigger | Pass |
| Read-heavy cache | Vercel CDN and tag-addressed Next.js cache | Pass |
| Durable asynchronous work | Transactional outbox and PostgreSQL job queue | Pass |
| Monitoring and alerts | Sentry, structured logs, metrics, alert thresholds | Pass |
| Deployment strategy | Isolated environments, preview gate, expand-contract migrations, rollback | Pass |

Implemented architecture score: **10/10**. Runtime conformance still depends on the future application implementation and the acceptance evidence listed in `traceability.md`.
