# Phase 1: Architecture Alignment and Contracts

Status: ready-for-agent

## Problem Statement

ShipWithAli has an approved backend architecture and behavioral model, but this checkout does not yet contain the executable repository foundation that keeps implementation aligned with those decisions. Without pinned tooling, explicit module interfaces, shared provider-neutral domain contracts, enforceable dependency rules, and stable public and Owner HTTP contracts, later implementation could accidentally couple the domain to Next.js, Supabase, Kysely, Vercel, or generated transport code; expand the public surface; expose deferred Lab entry behavior; or introduce incompatible API changes before runtime work begins.

Phase 1 must convert the accepted architecture into a reproducible, reviewable contract foundation. It must define what later phases are allowed to build without implementing the runtime, persistence, authentication, UI, delivery, or operational behavior assigned to those phases.

## Solution

Create a backend-only Phase 1 foundation for the approved domain-oriented modular monolith. Pin the runtime and development toolchain; establish the nine module interfaces and their allowed dependency directions; define the shared domain contracts used across modules; define the exact five-operation public v1 HTTP surface and the authenticated, command-oriented Owner v1 surface in OpenAPI 3.1; and add deterministic linting, bundling, type and runtime-validator generation, strictification, drift detection, and backward-compatibility checks.

Make architecture and contract conformance executable through one repository-level Phase 1 verification seam. That seam must prove the source contracts are valid, generated artifacts are reproducible, compatibility has a baseline, illegal module dependencies are rejected, provider types do not leak into domain or application interfaces, and neither frontend nor Lab entry surfaces have been introduced. It must also establish the Codex pull-request review policy and produce an explicit CodeRabbit inventory and removal result or named removal plan.

## User Stories

1. As a maintainer, I want Phase 1 limited to architecture alignment and contracts, so that later runtime and infrastructure work cannot be mistaken for part of this effort.
2. As a maintainer, I want accepted ADRs to outrank all implementation artifacts, so that Phase 1 preserves decisions already made.
3. As a maintainer, I want the shared glossary used throughout the contracts, so that Project, Publication, Public lifecycle, Current CV, Feedback, and other domain terms keep one meaning.
4. As a maintainer, I want the domain model to remain authoritative for behavior, so that OpenAPI does not redefine business invariants.
5. As an implementer, I want one pinned Node.js 24 LTS version, so that local, CI, and future container environments do not silently diverge.
6. As an implementer, I want the package manager and dependency versions reproducibly pinned, so that the contract workflow behaves the same on every machine.
7. As an implementer, I want strict TypeScript settings established at the foundation, so that later modules inherit the intended safety rules.
8. As an implementer, I want a skeleton for each of the nine approved modules, so that new behavior has an unambiguous owner.
9. As an implementer, I want each module to expose one public interface, so that callers do not deep-import its implementation.
10. As an implementer, I want domain code restricted to its own domain and shared domain contracts, so that provider and transport concerns cannot enter the domain model.
11. As an implementer, I want application code to depend only on its domain, shared contracts, and other modules' public interfaces, so that cross-module collaboration remains explicit.
12. As an implementer, I want adapter-only access to provider SDKs, so that Supabase, Kysely, Next.js, and Vercel can be replaced without changing stable domain interfaces.
13. As an implementer, I want cycles and deep imports rejected automatically, so that the modular monolith does not decay into shared implementation code.
14. As an implementer, I want an intentionally invalid import fixture, so that the architecture checker proves it can detect a real violation.
15. As a domain implementer, I want opaque stable identities defined independently of slugs, URLs, emails, provider keys, and storage paths, so that identities survive presentation and provider changes.
16. As a domain implementer, I want a shared idempotency-key contract, so that later mutation handlers can replay identical requests and reject conflicting reuse consistently.
17. As a domain implementer, I want Owner, Visitor, and system actors represented by one provider-neutral actor contract, so that modules never parse sessions, cookies, JWTs, IP addresses, or provider claims.
18. As a domain implementer, I want expected business rejections represented as typed results, so that later adapters can map them exhaustively without treating them as infrastructure failures.
19. As a domain implementer, I want stable machine-readable rejection codes, so that callers never branch on human-readable detail.
20. As a domain implementer, I want versioned immutable Domain events with correlation and causation metadata, so that later outbox consumers have a durable contract.
21. As a domain implementer, I want aggregate updates to carry an expected version, so that later persistence can reject stale commands without partial state changes.
22. As a public API consumer, I want the public v1 contract to contain exactly Reaction, Rating, Feedback, consented Public event data, and Current CV operations, so that the transport surface stays intentionally narrow.
23. As a Visitor, I want Reaction and Rating contracts to express one current value per permitted Visitor and Project, so that clients understand replacement rather than vote accumulation semantics.
24. As a Visitor, I want Feedback submission to be described as private and pending, so that the contract does not imply immediate public display.
25. As a privacy-conscious Visitor, I want Public event data restricted to the accepted consent-gated, privacy-minimized allowlist, so that arbitrary analytics payloads cannot be sent.
26. As a privacy-conscious Visitor, I want Reaction, Rating, Feedback, and CV actions excluded from the Public event allowlist, so that the same behavior is not double-counted through analytics intake.
27. As a Visitor, I want the Current CV contract to represent only the single accepted English Current CV, so that the API does not promise unavailable localization.
28. As a public API client, I want all four mutations to require an idempotency key, so that retries are safe and conflicting reuse is explicit.
29. As a public API client, I want public v1 changes to be additive and backward compatible, so that an existing client is not broken within the major version.
30. As a maintainer, I want public owner CRUD, broad content reads, internal module calls, provider endpoints, and Lab entry behavior excluded from the public contract, so that transport scope remains aligned with the accepted ADR.
31. As the Owner, I want a separate authenticated Owner v1 contract, so that management intent is not mixed into the public surface.
32. As the Owner, I want command-oriented operations instead of table-shaped CRUD, so that the contract expresses domain intent and invariants.
33. As the Owner, I want contract operations for public profile, Contact channels, and the Global project CTA, so that Portfolio Configuration intent is represented.
34. As the Owner, I want contract operations for saving Revisions and publishing, hiding, archiving, or restoring content, so that the Public lifecycle and Language version intent are explicit.
35. As the Owner, I want contract operations for Project status, Featured, public slug changes, and curated Project relationships, so that these concepts are not collapsed into generic updates.
36. As the Owner, I want contract operations for creating, assigning, renaming, retiring, and merging Taxonomy values, so that controlled vocabulary evolution is explicit.
37. As the Owner, I want contract operations for Media upload intent, processing results, acceptance, and rejection, so that upload is not confused with public acceptance.
38. As the Owner, I want contract operations for registering, accepting, and activating CV versions, so that activation of Current CV is a distinct intent.
39. As the Owner, I want contract operations for approving, rejecting, and suppressing Feedback, so that Moderation history is preserved rather than represented as deletion.
40. As the Owner, I want contract operations for creating and activating immutable Analytics goal versions, so that reporting rules remain historically identifiable.
41. As the Owner, I want contract operations to request, inspect, and download an Owner export, so that portability is represented without exposing provider backups.
42. As the Owner, I want narrow aggregate and history queries, so that outcomes can be inspected without raw table-shaped endpoints or a generic patch operation.
43. As an Owner API client, I want every mutation of an existing aggregate to require both optimistic concurrency and idempotency headers, so that stale and repeated commands have distinct semantics.
44. As an Owner API client, I want the security scheme and the difference between unauthenticated and unauthorized responses documented, so that authentication is not mistaken for authorization.
45. As any HTTP client, I want every error response described using RFC 9457 Problem Details, so that failures have one safe, machine-readable shape.
46. As any HTTP client, I want validation, authentication, authorization, absence, conflict, concurrency, domain validation, rate limiting, temporary unavailability, and unexpected failure semantics mapped consistently, so that clients can respond correctly.
47. As a contract maintainer, I want source contracts linted and bundled deterministically, so that review and compatibility checks operate on canonical artifacts.
48. As a contract maintainer, I want generated TypeScript transport types and runtime validators committed but never hand-edited, so that consumers have reproducible artifacts.
49. As a contract maintainer, I want generated object validators to reject unknown properties, so that declared closed transport shapes are actually enforced at runtime.
50. As a contract maintainer, I want generation repeated in a clean temporary location and compared byte-for-byte, so that stale or nondeterministic artifacts fail the gate.
51. As a contract maintainer, I want both public and Owner contracts compared with a baseline, so that breaking request, response, security, and status changes are detected before merge.
52. As a contract maintainer, I want server-stub generation prohibited, so that transport tooling cannot dictate domain or application implementation.
53. As a reviewer, I want generated transport artifacts prevented from becoming domain types, so that the HTTP seam remains an adapter concern.
54. As a reviewer, I want a route inventory compared with the two contracts, so that Phase 1 cannot introduce undeclared, frontend, or Lab entry surfaces.
55. As a reviewer, I want the repository's Codex instructions to cover domain invariants, module dependencies, provider leakage, security, privacy, migration safety, contract compatibility, generated drift, negative tests, rollback, and backend-only scope, so that automated review targets the accepted risks.
56. As a maintainer, I want CodeRabbit configuration, workflows, secrets, app requirements, and branch-protection checks inventoried, so that Codex remains the only AI reviewer.
57. As a maintainer, I want discovered CodeRabbit integration removed when repository access permits it, so that duplicate AI review policy is not left active.
58. As a maintainer, I want any administrative CodeRabbit removal blocker recorded with a named owner and action, so that Phase 1 does not claim completion while the policy is unresolved.
59. As a maintainer, I want one Phase 1 conformance command and CI gate to aggregate all architecture and contract checks, so that readiness is visible through a single high-level seam.
60. As a maintainer, I want the gate to produce durable evidence artifacts, so that Phase 1 completion is demonstrable rather than inferred from source files.

## Implementation Decisions

### Authority and scope

- Decision authority is, in order: accepted ADRs, the shared glossary, the domain model, the approved implementation guide, then OpenAPI and generated transport artifacts.
- This specification covers Phase 1 only. It creates compile-time/module skeletons and transport contracts, not working domain behavior or HTTP handlers.
- The architecture remains one domain-oriented modular monolith with one future Next.js deployment and one PostgreSQL database. No service extraction is part of Phase 1.
- The work is backend-only. Repository scans and the route inventory must show no React presentation, browser state, Lab entry route or operation, or other frontend surface.

### Toolchain foundation

- Use Node.js 24 LTS and pin one exact patch consistently for developers and CI. Declare compatible runtime constraints without allowing a different major version.
- Use npm with a committed lockfile and an exact package-manager version. Dependency installation in verification uses the lockfile without mutation.
- Enable TypeScript strict mode, unchecked indexed-access checks, and exact optional-property semantics from the start.
- Pin contract tools to exact reviewed versions. Preserve the known-compatible TypeScript 6.0.3 and OpenAPI generator 0.99.0 pairing unless a replacement is deliberately proven by the same deterministic generation and validator suite before adoption.
- Record the effective Node.js, npm, TypeScript, OpenAPI generator, Redocly, validator library, architecture-checker, and contract-compatibility versions in the Phase 1 dependency/version evidence.

### Module architecture

- Establish these nine modules: Portfolio Configuration; Content and Publishing; Taxonomy and Discovery; Media; CV Portfolio; Interaction and Moderation; Measurement; Identity and Access; Portability and Operations.
- Every module has domain, application, ports, and adapters areas plus one public module interface. Other modules may import only that public interface.
- A module skeleton contains contracts and compile-time placeholders only. It must not implement persistence, provider calls, business workflows, Route Handlers, or UI.
- Domain areas may import only their own domain and shared domain contracts.
- Application areas may import their own domain, shared domain contracts, and the public interfaces of other modules. They may not import another module's repositories or adapters.
- Adapters implement provider-neutral ports. Only adapters and future composition roots may import Next.js, Supabase, Kysely, Vercel, generated OpenAPI artifacts, or other provider-specific types.
- Cross-module commands and queries use exported application interfaces. Durable cross-module reactions use versioned Domain events.
- The architecture checker fails on dependency cycles, deep imports, disallowed cross-module imports, and provider or generated-transport leakage into domain and application areas.
- An intentionally invalid fixture must exercise at least one illegal provider import and one illegal deep cross-module import. The fixture is successful only when the checker rejects it for the expected rule.

### Shared domain contracts

- Define opaque `StableId` semantics using immutable UUIDv7 values created before persistence. Presentation labels, slugs, routes, provider keys, email addresses, and storage paths never serve as domain identity.
- Define `IdempotencyKey` as an opaque client value of 1 through 128 visible ASCII characters. Later persistence will scope it by operation and actor, replay an identical canonical request, and reject different-content reuse as a conflict.
- Define a provider-neutral actor union for the Owner, Visitor, and system job. Only identity adapters may construct it; domain and application code never parse transport or provider authentication data.
- Define an explicit result contract for expected business rejection and a closed rejection union covering validation, unauthenticated, forbidden, not found, conflict, failed precondition, rate limited, and temporarily unavailable outcomes.
- Rejection codes are stable machine values. Human detail is localized at the transport seam and cannot be used as control flow.
- Define immutable Domain events with stable event identity, event type, schema version, aggregate identity and version, RFC 3339 UTC occurrence time, correlation identity, optional causation identity, and a read-only payload.
- Event type and schema version evolve independently. Consumers must be able to reject unknown major semantics, tolerate additive fields, and deduplicate by event identity.
- Commands that update an existing aggregate carry an expected version. A mismatch is a failed-precondition result and cannot partially change state.
- Shared contracts must not import framework, database, authentication-provider, OpenAPI, generator, or validator types.

### Public v1 HTTP contract

- The public OpenAPI 3.1 contract contains exactly five operations: upsert Project Reaction; upsert Project Rating; submit Project Feedback; submit consented Public event data; and access the Current CV.
- The corresponding methods and routes remain `PUT /api/v1/projects/{projectId}/reaction`, `PUT /api/v1/projects/{projectId}/rating`, `POST /api/v1/projects/{projectId}/feedback`, `POST /api/v1/events`, and `GET /api/v1/cv/current`.
- All four public mutations require `Idempotency-Key`. Exact replay returns the original safe result; reuse with a different canonical request is a conflict.
- Reaction accepts only like or dislike; Rating accepts only integer values from one through five; both describe replacement of the current value for the permitted functional Visitor identity and Published Project.
- Feedback is stored as private pending Feedback after validation and abuse checks. The response must not imply public eligibility or display.
- Public event intake is a discriminated union of the accepted nine privacy-minimized event variants, requires consent, and rejects unknown event names and properties. Reaction, Rating, Feedback, and CV actions are excluded to prevent double-counting.
- Current CV represents the single accepted English CV version and may describe stream or redirect success. Intentional redirect responses must be fully declared.
- Public owner CRUD, broad content reads, in-process module queries, provider operations, and all Lab entry behavior are forbidden from this contract.
- Changes within public v1 are additive and backward compatible. Breaking request, response, security, status, or semantic changes require a new major route.
- Sol remains the named design role for proposing the public HTTP interface; reviewed OpenAPI source is the durable transport source of truth after acceptance.

### Owner v1 HTTP contract

- Define a separate OpenAPI 3.1 surface under the owner major route. It is authenticated globally and command-oriented rather than table-shaped CRUD.
- Owner authentication is described as a verified Supabase session originating from GitHub OAuth plus an explicit Owner allowlist. The contract distinguishes missing or invalid authentication from an authenticated actor lacking Owner authorization.
- Mutations of existing aggregates require both `If-Match` and `Idempotency-Key`. Creation commands require idempotency; optimistic concurrency applies wherever an existing aggregate version is changed.
- Configuration operations cover the public profile, Contact channels, and Global project CTA.
- Content operations cover saving a Revision and commands to publish a Language version, hide, archive, and restore Publishable content.
- Project operations cover changing Project status, setting Featured, changing the public slug while preserving Public route identity, and creating an owner-curated Project relationship.
- Taxonomy operations cover creating a Taxonomy value, renaming, retiring, and merging a value, and assigning a value to a Project.
- Media operations cover creating an upload intent, recording processing, and accepting or rejecting a Media asset.
- CV Portfolio operations cover registering, accepting, and activating a CV version.
- Interaction and Moderation operations cover approving, rejecting, and suppressing Feedback.
- Measurement operations cover creating and activating immutable Analytics goal versions.
- Portability operations cover requesting, inspecting, and downloading an Owner export.
- Narrow authenticated queries expose aggregate or history views for content, Projects, Taxonomies, Media, the CV portfolio, Feedback, and Analytics goals. They are not raw table mirrors.
- The owner contract must not include a generic patch endpoint, public content-read replacement, runtime-only health endpoint, or Lab entry operation.
- Changes within owner v1 are additive and backward compatible under the same compatibility policy as public v1.

### Common HTTP semantics and generated artifacts

- Every non-success response uses `application/problem+json` and the RFC 9457 fields `type`, `title`, `status`, `detail`, and `instance`, plus safe `code`, `traceId`, and field-error extensions where applicable.
- Contract status semantics are: malformed transport input 400; missing or invalid authentication 401; authenticated but unauthorized 403; unknown resource 404; idempotency, identity, slug, or invalid-transition conflict 409; optimistic concurrency or `If-Match` failure 412; valid transport shape rejected by publication, evidence, or domain validation 422; rate limiting 429 with `Retry-After`; temporary dependency/readiness failure 503; and unexpected failure 500 without internal details.
- The declared rejection-to-Problem-Details mapping is exhaustive. Adding a rejection kind without an HTTP mapping must fail contract verification.
- Redocly lints and bundles public and Owner source contracts independently into canonical committed bundles.
- A pinned generator produces committed TypeScript transport types and runtime validators for both surfaces. It never generates server stubs.
- A deterministic post-generation strictification step converts generated object validators to closed shapes so unknown properties are rejected in practice, not only declared in OpenAPI.
- Generated artifacts carry a clear generated-file notice, are never manually edited, and may be imported only by transport adapters and contract tests.
- Drift verification regenerates into a clean temporary location and compares all generated and bundled artifacts byte-for-byte with committed output.
- Compatibility verification compares both canonical bundles with a committed or fetched `master` baseline and rejects removed or renamed fields, narrower accepted inputs, newly required inputs, changed security, changed status semantics, and other breaking behavior.
- Reference documentation may be produced as a local or CI artifact; hosting a public documentation site is not part of Phase 1.

### Review policy and CodeRabbit inventory

- Add a dedicated pull-request review policy for Codex covering domain invariants, illegal module dependencies, provider leakage, authorization and RLS implications, secrets and privacy, future SQL and migration safety, OpenAPI compatibility, generated drift, negative tests, operational rollback, and backend-only scope.
- Codex is the only AI reviewer. Human approval and deterministic CI remain separate concerns and cannot be replaced by a Codex result.
- Inventory CodeRabbit repository configuration, workflow jobs, secrets, GitHub App installation or requirement, and branch-protection checks.
- Remove discovered CodeRabbit integration when current permissions allow. When an external administrative setting cannot be changed, record the exact remaining item, responsible owner, and required action; that item blocks Phase 1 completion.

### Completion evidence

- The single Phase 1 conformance gate aggregates toolchain/version verification, both contract lint and bundle checks, deterministic generation and drift checks, compatibility checks, architecture checks, shared-contract tests, route/surface inventory, and frontend/Lab exclusion scans.
- The gate emits or retains: both canonical contract bundles; a generation-diff result; a contract compatibility result and baseline identity; an architecture report including the rejected invalid fixture; a route inventory; a dependency/version manifest; a CodeRabbit removal checklist; and the reviewed Codex instructions.
- Phase 1 is complete only when both contracts lint and bundle, generation reproduces byte-for-byte, a usable compatibility baseline exists, invalid dependency fixtures fail for the intended reasons, valid skeletons pass, provider imports are absent outside allowed areas, and no Lab or frontend surface exists.

## Testing Decisions

- The primary test seam is one repository-level Phase 1 conformance command used locally and in CI. It reports each constituent check clearly but returns one failing status if any architecture, contract, generation, compatibility, review-policy, or scope rule fails.
- Tests assert externally observable repository behavior: accepted source contracts produce valid canonical bundles and strict generated validators; forbidden dependency graphs are rejected; valid module interfaces compile; and the inventory reports contain the required evidence. Tests do not inspect incidental helper function structure.
- Contract tests cover both public and Owner surfaces through their bundled OpenAPI documents and generated runtime validators. Source fragments are not treated as separate behavioral seams.
- Public contract tests prove exactly five operations exist; all four mutations require idempotency; the Current CV operation is English-only; the event schema is a closed discriminated allowlist; forbidden public surfaces are absent; and every declared example validates.
- Owner contract tests prove global authentication is declared; 401 and 403 are distinct; command groups and narrow queries are present; existing-aggregate mutations declare concurrency and idempotency headers; generic patch and Lab entry operations are absent; and every declared example validates.
- Problem Details tests prove every non-success response uses the correct media type and safe required fields, each typed rejection has a status mapping, rate limits declare `Retry-After`, and unexpected failures expose no provider or internal detail.
- Generated-validator tests exercise representative valid values and negative cases for unknown properties, invalid enums, invalid Rating ranges, malformed identities, missing required headers, unsupported event types, and provider-specific extra fields.
- Determinism tests run bundle and generation twice in isolated temporary locations and require identical bytes. A diff is a failure even when both outputs typecheck.
- Drift tests compare clean regeneration with committed artifacts. Hand edits, stale output, omitted files, or nondeterministic ordering must fail.
- Compatibility tests use the `master` contract baseline when it exists. The initial Phase 1 implementation commits an explicit baseline so subsequent changes cannot silently redefine compatibility history.
- Architecture tests use the module public interfaces as the highest code seam. One valid dependency graph must pass, while fixtures for provider leakage, generated-transport leakage, a deep cross-module import, and a cycle must fail with specific rule identifiers.
- Shared-contract tests validate UUIDv7 identity parsing or construction, idempotency-key length and character rules, actor-union exhaustiveness, rejection-union exhaustiveness, event metadata rules, immutable/read-only type expectations, and expected-version requirements without importing any provider.
- Route and source scans fail on any Lab entry operation or route, JSX/TSX, React presentation dependency, broad public content API, generated server stub, or undeclared HTTP operation introduced by Phase 1.
- Review-policy tests or deterministic text checks prove the Codex instructions include every required review concern and do not designate a second AI reviewer.
- The CodeRabbit checklist is tested as evidence: every inventory category has a recorded result, and any unresolved external removal item prevents a passing completion verdict.
- Existing prior art for public contract verification is the previously validated Redocly lint/bundle, generated TypeScript and strict-validator tests, committed-artifact drift check, and one-worker Vitest configuration used successfully on Windows. That prior result guides the new two-contract suite but is not treated as current checkout evidence.
- On Windows, Vitest uses the threads pool with one worker if process spawning is restricted. This is a deterministic execution setting, not a reduction in coverage.
- Tests must not require production credentials, production data, the public internet, a running database, a deployed application, or a working Next.js runtime in Phase 1.

## Out of Scope

- Every task, gate, and evidence item assigned to Phases 2 through 10.
- Initializing the working Next.js App Router runtime, composition root, configuration loader, logging, correlation, error boundary, health endpoints, readiness behavior, or graceful shutdown.
- Implementing Route Handlers, even empty or fake-backed handlers; Phase 1 defines transport contracts and generated artifacts only.
- PostgreSQL schemas, SQL migrations, Supabase local configuration, RLS, Kysely adapters, transactions, idempotency persistence, outbox tables, leased jobs, seeds, or projections.
- Runtime Supabase Auth, GitHub OAuth, Owner authorization, session verification, CSRF, cookies, pseudonymous identity issuance, or rate limiting.
- Business implementation for Portfolio Configuration, publishing, Taxonomy and Discovery, Media, CV Portfolio, Interaction and Moderation, Measurement, Identity and Access, or Portability and Operations.
- Public pages, Owner workspace UI, React, JSX, CSS, accessibility presentation, RTL rendering, frontend state, SEO, or browser performance work.
- Public broad read APIs created for the future same-origin frontend; those reads remain future in-process module queries.
- Lab entry routes, commands, queries, navigation, publishing, interaction, or Owner operations.
- Database, HTTP-adapter, container, security-scan, load, resilience, backup/restore, TestSprite, staging, production, Vercel, Supabase, GHCR, and deployment implementation.
- Dockerfiles, OCI images, SBOMs, attestations, backup scripts, restore rehearsals, monitoring, dashboards, alerts, or scheduled workflows.
- Microservices, GraphQL, Redis, Kafka, Kubernetes, external search, automatic recommendations, or automatic translation publication.
- Publishing hosted API reference documentation; only local or CI documentation artifacts are allowed.
- Changing accepted ADRs, the shared glossary, or domain behavior. Any discovered conflict must stop the conflicting change and identify the ADR that would need separate reconsideration.

## Further Notes

- Dependencies for this spec are the accepted ADRs, the shared glossary, and the domain model. The implementation guide supplies the approved Phase 1 blueprint but does not outrank those sources.
- The repository currently contains documentation but not the Phase 1 runtime/tooling foundation, so acceptance evidence must come from the implementation produced from this spec rather than from document claims.
- The prior public-contract work is useful precedent for compatible generator versions, strictification, Windows test execution, and the five-operation boundary. Because those artifacts are not present in the current checkout, they must be restored or recreated and revalidated rather than assumed current.
- No architecture decision in this spec authorizes a later phase to merge past an unmet Phase 1 gate.
