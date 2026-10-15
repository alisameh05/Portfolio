# #195 current interaction summaries: acceptance evidence

Only Phase 7 slice 08 is delivered. The earlier incomplete PR #217 is continued
in an isolated checkout, with current master `2a77193` merged and unrelated
primary-checkout state preserved. Blockers #190/#191/#194 are closed with merged
PRs #212/#213/#216; prerequisite gates #90/#125 were completed previously.

Tested implementation: `af6b8236ba8792180572c0603ad2cddace283ece`.
Source fingerprint: `2998c790a4cfd8fd9a047a90d02ff8bdda8f4a0560f8a00b86653945c73122ce`.
Required run: `8edb1160-dad9-461b-8751-123c93f81f40`.
The delivery commit adds evidence only; its source fingerprint must remain equal.

Required command: `npm run phase7:focus:summaries`.
Result: **132 passed, 0 failed, 0 skipped, success true, 0 failed suites**,
with successful disposable-cluster cleanup. The machine report records
PostgreSQL 18.3, Node 24.21.0, npm 11.19.0, Supabase CLI version, all 39 migration
ledger entries/checksums, clean/upgrade equality, no-op migration replay, preserved
predecessor Rating/Feedback, restricted roles and sanitized natural query plans.
No developer or production database, Auth credentials or normal Supabase stack
is used. Mutation clocks are fixed; actual AES-GCM and signed Owner-session
regressions run through the inherited suites. No sleep is used as race proof.

## Criterion-to-test mapping

Tests are in `tests/phase7/summaries-postgres.test.ts` unless indicated.

| Criterion | Executed proof |
| --- | --- |
| T08-01 / P7-16 | Current replacement/retry test: like->dislike/current no-op; Rating 0/4/5 contributors, no low-sample average, 2.6 then replacement to 3.4 without inflation; same totals on en/ar. Existing Reaction/Rating suites cover concurrent upserts, same-key races and rollback. |
| T08-02 / P7-13 / P7-15 | Both public query interfaces reject unknown/Draft/Hidden/Archived/wrong-type/foreign Portfolio/no-language/unavailable-locale Projects; summary rejects foreign query scope and invalid IDs/locales. |
| T08-03 / P7-27 | Real Content create/review/publish en/ar, hide and archive commands immediately reject both locales' summary/page reads. Owner inspection retains all approved/pending/rejected/suppressed histories. |
| T08-04 / P7-27 / P7-28 | Real restore commands expose exactly the still-approved retained English row; suppressed/pending/rejected text stays absent. The removed Arabic publication pointer remains unavailable without fallback. No locale-withdrawal command exists in the phase, so that pointer is an explicit authoritative fixture change. |
| T08-05 / P7-14 | Independent-connection withdrawal-first barriers exercise hide and archive versus Reaction, Rating, Feedback and delayed summary queries; observed PostgreSQL Lock waits prove serialization. Each later mutation rejects and owns zero rows. Submission-first tests hold real hide until commit; later interactions/queries reject. |
| T08-06 / P7-14 | Actual leased queued on-read work stays paused through suppression, is reclaimed under a fresh lease, rejects stale completion, and rechecks summaries/pages after hide and replay. No projection write handler exists in the chosen on-read strategy. Worker SQL cannot write these aggregate views; no future aggregation worker is claimed as delivered. |
| T08-07 / P7-15 | Exact DTO keys and private sentinels; raw-vote SELECT remains subject-scoped even with summary settings. View role is NOLOGIN/NOBYPASSRLS/non-superuser and unavailable via runtime SET ROLE. Data API/worker/backup have no view grants. Unset/reused/invalid-locale scopes cannot expose counts. Inherited suppression suite verifies private count/history/text exclusion and signed Owner authorization. |
| T08-08 / P7-12 / P7-28 | Included Reaction/Rating real-crypto suites prove authoritative eligibility before identity issuance and again in committing mutations. Summary plans scan exactly five requested voters through each primary-key index, excluding 6,000 unrelated voters/table. Existing suppression query proves default/max/stable microsecond keyset pages and a natural partial-index plan over 5,000 auxiliary approved rows. |

The standard-runtime test invokes the assembled in-process summary service with
Measurement and workers absent, then verifies a closed required database returns
a safe temporary-unavailability rejection. The shared Content-before-Interaction
lock order acquires no inverse Media lock. Current numeric snapshots and approved
counts are read in one statement with database `asOf`; nothing joins Functional
subjects into Measurement. No public HTTP read endpoint is added.

## Standards

Independent read-only Codex review of `2a77193...af6b823`: **0 actionable
findings**. Reviewed module/provider boundaries, five-operation public scope,
view ownership/forced RLS/grants, migration safety, generated drift, negative
tests and forward-fix rollback. No baseline smell warranted remediation.

## Spec

Independent read-only Codex review against issue #195 and parent #187:
**0 actionable findings**. All T08 criteria have source and executed proof;
no unrequested frontend/public endpoint, Measurement join, retention or future
aggregation-worker implementation is included. Reviews themselves did not run
tests; final-source acceptance is the separate run identified above.

## Broader checks and reproduction

See `docs/agents/interaction-summary-validation.md` for setup, isolation,
view-ownership rationale, generated-type refresh and rollback details.

Pinned setup/readiness, typecheck, lint, deterministic contract
generation/drift/compatibility, architecture and invalid-boundary fixtures,
runtime boundary, exact-five-public/48-Owner inventory, current Phase 5 context,
tooling tests and production build are recorded separately in the validation
summary. Broad Vitest: **1,177 passed, 0 failed, 243 environment-gated skips,
success true, 0 failed suites**. Tooling: **68 passed, 0 failed, 0 skipped**.
These broad optional skips are never used as required database evidence.

Hosted CI and human approval remain separate. The original PR #217 hosted run
failed before any steps because GitHub reported failed recent account payments
or an insufficient spending limit. The delivery's fresh hosted state must be
checked and reported separately; local acceptance does not certify hosted CI.
No merge, production deployment, migration execution or schedule installation
is performed. Retention and general aggregate-job execution remain #205/#206;
integrated full-phase migration qualification remains #208.
