# Owner Feedback moderation — #193

Only [#193](https://github.com/alisameh05/Portfolio/issues/193) is implemented against parent [#187](https://github.com/alisameh05/Portfolio/issues/187). Blocker #192 was closed as completed and PR #214 merged at base `7a7ae176a9cadd73de7334582bd357dad870411c`. Phase 4 gate #90/PR #105 and Phase 5 gate #125/PR #144 are completed merged prerequisites with their earlier durable gate evidence; current shared boundaries are checked below.

## Exact tested source

Implementation commit: `4191ffb1858067e4176739cd1308c808b24d9088`; Git tree `6b2b78696328c9c5877515ceeb6cc52364b8b553`.
Source fingerprint: `486e74270ee5fc96ac2050f701c42555c1253f91db902ed223a9876844f656bb`.
Required run: `1c72ca60-09b8-4d67-ad0e-345f4a268f5e`.
[Machine report](phase7-moderation-193.json) records exact assertions, source, migration checksums/ledger/schema fingerprint, tools, roles and cleanup. Subsequent delivery changes contain evidence only and must retain this same source fingerprint.

Required acceptance: **80 passed / 0 failed / 0 skipped**, `success: true`, zero failed suites, cleanup passed. PostgreSQL 18.3; Node 24.21.0/npm 11.19.0; Supabase CLI 2.117.0; committed Kysely codegen and Vitest pins.

## Criterion-to-test evidence

The principal tests are [real PostgreSQL application/HTTP acceptance](../tests/phase7/moderation-postgres.test.ts), [application authorization](../tests/phase7/moderation.test.ts), [existing Owner transport contract](../tests/runtime/owner-moderation.test.ts), [Owner request security](../tests/phase4/owner-request-security.test.ts), and [actual signed session adapter](../tests/phase4/owner-session-auth.test.ts).

| Criterion | Executed proof |
| --- | --- |
| T06-01 / P7-21 | `authorized inspection is private versioned/ordered`; Visitor/foreign Owner/Portfolio/missing actor-session deny; unknown ID is not_found. Signed Owner sessions reject missing/tampered/expired/nonallowlisted/revoked evidence before inspection/replay. `inspection waits for a concurrent decision` proves one consistent version/state/history. A retained later suppression fixture proves history sequence ordering. Private HTTP responses are private/no-store/noindex. |
| T06-02 / P7-22 | `approval appends stable ordered Owner decision` verifies UUIDv7 identity, sequence 1, scoped Owner reference, server timestamp, one version advance, original submitted locale only. Pending is absent, Arabic approval is absent in English, and withdrawing Arabic publication returns unavailable. No pending/rejected count enters the query. |
| T06-03 / P7-23 | `rejection retains private reason/history` verifies one rejected decision/version 2 and zero approved public results/count. |
| T06-04 | `Hidden/Archived moderation succeeds privately` compares Content lifecycle rows before/after unchanged, preserves Owner inspection, gates public queries and demonstrates exact-locale restoration. Approval does not publish Content. |
| T06-05 / P7-25 | `exact replay survives later version` verifies original safe receipt without another decision/event/ledger mutation, payload-key conflict, current-version terminal/new-key conflicts and stale If-Match HTTP 412. Both current app authorization denial and actual signed-session allowlist removal/revocation deny replay. Header/domain reason boundaries and CSRF/origin/abuse tests pass. |
| T06-06 / relevant P7-26 | `independent pools serialize approve/reject and exact-retry races` holds the first decision transaction, observes PostgreSQL Lock wait from another pool, then proves one decision/state/fact or identical replay receipts. No sleeps establish race ordering. |
| T06-07 / relevant P7-26 | `decision/projection/outbox/ledger/receipt failures fully roll back` injects real triggers before decision INSERT, eligibility/state/version UPDATE, outbox INSERT, ledger reservation INSERT and receipt UPDATE. Entire history/state/version/eligibility/ledger/fact snapshot remains unchanged; subsequent retry succeeds. |
| T06-08 / relevant P7-29 | `logs/outbox/ledger/ordinary receipt exclude private...` checks private name/paragraph/reason and raw authenticated subject/session/signing material sentinels. Public DTOs contain only explicitly approved name/paragraph plus Feedback/Project/locale/display time; no private reason, history, Owner reference or unapproved text. |

## Persistence, access and migration qualification

Migration [20261015010000_retain_feedback_moderation.sql](../supabase/migrations/20261015010000_retain_feedback_moderation.sql) expands Feedback with approved time and adds owned append-only Moderation decisions. Its timestamp follows the committed submission migration: the CLI-generated timestamp needed moving after that already committed prerequisite. Rollback is disabling assembly while preserving retained private rows, followed by a reviewed forward-fix migration.

The focused runner uses a disposable loopback-only native PostgreSQL cluster, Supabase CLI migration-up and actual migration ledger. Clean and prior-release upgrade schema match for columns, constraints, indexes, table/column grants, policies and forced RLS of both owned tables. Existing pending Feedback and Rating survive; replay adds no migration ledger row. Generated Interaction types match the real schema. Full Phase 3–6 integrated qualification remains #208.

Runtime roles are non-superuser/non-bypassrls. Anonymous/authenticated/worker/backup roles have no Feedback/history grants; unconfigured/non-Owner/foreign scopes read no private row and cannot moderate. Public-purpose scope reads approved currently published locale rows only and no decision history. Column grants prohibit rewriting name/paragraph/association; history has no UPDATE/DELETE grant. Transaction-local scope resets across pool use. There is no SECURITY DEFINER/view bypass, visitor tracking identity or cross-module write.

The state/version/approved timestamp are the synchronous eligibility projection. They commit in the same transaction as the private history, safe outbox fact and safe receipt/ledger; there is no worker dependency for approval eligibility. Content root precedes Feedback and ledger locks. Inspection takes only a Feedback lock, never a reverse Content lock.

## Reproduction and cleanup

```text
npm run setup:validation
npm run validation:ready
npm run phase7:focus:moderation
npm run phase7:focus:feedback
npm run phase7:focus:ratings
npm run typecheck
npm run lint
npm run test:arch
npm run runtime:architecture
npm run route:inventory
npm run phase5:context
npm run contract:verify
npm test -- --no-file-parallelism --reporter=json --outputFile=artifacts/moderation-full-vitest.json
npm run build
```

`PHASE7_POSTGRES_BIN` selects installed PostgreSQL binaries (`pg_config --bindir` on Linux or the configured PostgreSQL 18 directory on Windows). The gate chooses an ephemeral port and disposable cluster/project, creates restricted login roles, closes all pools/clients and verifies removal of only its own temporary directory. Developer/production databases and normal Supabase stack are untouched. Run contract regeneration before the source-fingerprinted focused gates; they correctly reject overlapping source regeneration. `--refresh-types` is schema setup, followed by a normal source-bound run; the committed final run used type verification.

The gate rejects missing tools/services, wrong/stale runtime/install, missing/incomplete test reports, any failed/pending/todo assertion or suite, source drift and failed cleanup. It writes evidence only after acceptance and cleanup succeed; private SQL errors/connection details/test payloads are not published.

## Standards

No actionable Standards findings in `7a7ae176...4191ffb`. The independent read-only review verified five public HTTP operations/backend-only scope, provider boundaries, authorization before replay, scoped RLS/privacy, atomicity, negative tests and migration rollback. No baseline smell warranted a finding.

## Spec

No actionable Spec findings in `7a7ae17...4191ffb`. The independent read-only review verified T06-01–T06-08, actual signed Auth, reauthorization, independent PostgreSQL lock barriers, atomic rollback, restricted RLS and fail-closed migration/type/test evidence. No scope creep was identified.

Standards: 0 actionable findings. Spec: 0 actionable findings.

Suppression and full keyset paging remain #194; public summary composition remains #195. The narrow bounded exact-locale query demonstrates this slice without introducing a sixth public operation. No production deployment, migration, schedule, merge or branch-protection change is part of this delivery.

## Other validation and practical limits

Broad full suite: **1177 passed / 0 failed / 221 opt-in environment-gated skips**, success true and zero failed suites. [Sanitized broad report](phase7-moderation-broad-193.json) records suite totals and the raw local report hash without private failure messages or parametrized payloads. The initial concurrent run had one existing architecture-boundary test failure under load (duration 6.9 seconds); its isolated rerun and the complete serial-file rerun passed without source/test changes. Broad skips are not required acceptance evidence.

Real Feedback predecessor: [57/57 with zero failures/skips and cleanup](phase7-feedback-192.json) on the exact same implementation commit/fingerprint. Real Reaction/Rating/crypto predecessor: [33/33 with zero failures/skips and cleanup](phase7-ratings-191.json) on the identical source fingerprint; its revision field precedes the implementation commit because that run occurred before committing the already settled source.

Pinned setup/readiness, typecheck, lint, architecture (including deliberately rejected leakage/cycle fixtures), runtime architecture, exactly-five-public-operation inventory, current Phase 5 context, deterministic compatible OpenAPI generation and production build passed. The backend build exposes only operational probes and the default not-found page. Public/Owner source contracts and generated HTTP artifacts have no diff.

The local Docker Linux engine could not be reached even after launching installed Docker Desktop, so a fresh Docker-emitted local Auth token run is not claimed. This slice executes real HMAC/ES256 signature/allowlist/revocation adapter tests against controlled non-production Auth/crypto fixtures and real PostgreSQL; the earlier merged Phase 4 gate provides emitted-token prerequisite evidence. Hosted Local Auth CI remains separate.

Hosted deterministic CI, the current Codex review and human approval remain separate. Live hosted status is reported in the PR/issue after delivery; local acceptance does not certify hosted checks or authorize merge.
