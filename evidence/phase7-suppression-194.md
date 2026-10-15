# Feedback suppression and public keyset pages — #194

Only [#194](https://github.com/alisameh05/Portfolio/issues/194), under parent #187, is delivered. Blocker #193 is completed and PR #215 merged. Phase 4 #90/PR #105 and Phase 5 #125/PR #144 are completed merged prerequisites, verified live. Base master remains eb1b6d2b6426dac7f370d4ac7e46ab929a1b13ad. The primary checkout's unrelated package.json edit is preserved.

## Exact source and results

Implementation commit: 4fdf1bf7e58bbf1526a1aaf35b3e8a9c14c3f934; Git tree: 5a547aa51b2ae0c78f219580371f4ac58f3623a3.
Source fingerprint: a84164376f4d997e07c6f9d1a63737ff655bd196b4891ccee4f73ffac04acc9b; required run: 34e3e0c1-de5e-4d82-9f89-87b386f8d906.
[Required machine report](phase7-suppression-194.json): **93 passed, 0 failed, 0 skipped**, success true, zero failed suites, cleanup true. Evidence-only delivery changes retain this source fingerprint.

PostgreSQL postgres (PostgreSQL) 18.3; Node 24.21.0/npm 11.19.0; pinned Supabase CLI 2.117.0, Kysely codegen 0.20.0, Vitest 3.2.4. The report carries migration checksums, actual Supabase clean/upgrade ledgers and schema fingerprint, roles and sanitized natural query plan.

## Criterion-to-test proof

Principal seam: [application/HTTP real PostgreSQL acceptance](../tests/phase7/suppression-postgres.test.ts), plus the 80 existing moderation, signed Auth and request-security assertions included in the required gate. Confirmed seams come from parent #187.

| Criterion | Executed proof |
| --- | --- |
| T07-01 / P7-24 | Workers are absent. Approved→suppressed commits version 3, ordered private history, safe fact and receipt. The scoped public eligibility/count query changes 1→0 immediately; approved application pages become empty. Owner name, paragraph and ordered history remain eligible privately. |
| T07-02 / P7-25 | Exact retry returns the original receipt with no duplicate decision, fact or ledger effect. Changed payload conflicts; pending/rejected/suppressed illegal transitions and new-key terminal repeats conflict. Stale If-Match returns HTTP 412. |
| T07-03 / P7-26 | Independent pools hold the first suppression transaction at an explicit barrier. Concurrent reads observe the prior committed approval/count, then empty/count zero after commit. A second suppression retry waits on an observed PostgreSQL lock and returns the same result; only one suppression fact/decision exists. Five real trigger failures (decision insert, state/projection update, outbox insert, ledger reservation and receipt update) fully roll back state/version/history/eligibility/ledger/fact; retry succeeds. No sleeps establish races. |
| T07-04 / P7-28 | Separate en/ar approval fixtures expose only submitted-locale text. Pending/rejected/suppressed fixtures are excluded. Withdrawing Arabic publication returns unavailable; Hidden/Archived returns unavailable; published Project without eligible Feedback returns empty. No fallback or duplicate language stream exists. |
| T07-05 / P7-29 | Public DTO equality limits fields to Feedback/Project IDs, original locale, approved name/paragraph and display time. Private states, decisions, reasons, subjects/provider metadata are absent. Private sentinels are excluded from logs, receipts, outbox and ledger; public-purpose RLS exposes no history. Measurement receives no Feedback data. |
| T07-06 / P7-28 | 103 same-time records traverse default 25-record pages in descending stable-ID order with no duplicates; max 100 yields 100+3. Explicit integer limits 1–100 validate; malformed/extra-field/invalid-date/non-UUIDv7 cursors reject. PostgreSQL microsecond timestamp ordering remains exact. Restricted natural EXPLAIN ANALYZE over 5,000 auxiliary approved fixtures uses feedback_approved_locale and returns exactly 26 bounded lookahead rows. The report retains a sanitized actual node tree without predicates/parameters/private text. |
| T07-07 | Application rejects Visitor, non-Owner, foreign Portfolio and missing session. Existing HTTP rejects missing/tampered/expired/nonallowlisted signed sessions. Allowlist removal, session revocation and current application authorization deny replay without effects. Origin/CSRF, abuse Retry-After, reason validation and quoted positive If-Match remain enforced. Standard runtime assembles real suppression/public pages with optional Measurement/workers absent; closed DB fails safely. |
| T07-08 | Suppression history sequence 2 retains its later server decidedAt independently of original approval display time. This is #205's 12-calendar-month text/name/reason cleanup anchor. No deletion or reapproval operation is added. |

## Persistence and boundaries

No new DDL is required: existing #193 migration 20261015010000_retain_feedback_moderation.sql owns append-only decisions, scoped column UPDATE grants, FORCE RLS, and the approved exact-locale partial index. Clean and prior-release upgrade qualification, migration no-op replay, retained Feedback/Rating preservation and generated types all pass in the disposable cluster. Restricted access, history immutability and pooled-scope isolation remain covered by the included moderation acceptance.

Content root is acquired before Feedback/ledger locks. Public queries hold current Project and exact-locale publication facts and read only committed approved rows. Approved-count eligibility is the synchronous state predicate, rather than a worker-maintained cache; full summary composition remains #195. Suppression preserves approved display time and records its own later history timestamp. Public cursors are live views: subsequent pages recheck eligibility and never freeze withdrawn text. The in-process query defaults to 25 and accepts integer limits 1–100.

The five public HTTP operations and compatible Owner contracts remain unchanged. Backend/provider boundaries, deterministic contract generation, typecheck, lint, route inventory, Phase 5 context and production build passed; [validation/review summary](phase7-suppression-validation-194.json). CI now requires the suppression gate and uploads sanitized evidence. No production database, deployment, scheduling or merge is included. Operational rollback is disabling suppression application assembly while preserving retained private rows and then a reviewed forward fix; no schema rollback is required.

## Reproduction and cleanup

Run pinned npm setup/readiness, then npm run phase7:focus:suppression. The shared native PostgreSQL runner discovers PostgreSQL binaries (Windows PostgreSQL18 directory or pg_config --bindir; PHASE7_POSTGRES_BIN overrides), chooses an ephemeral loopback-only port, applies repository migrations via pinned Supabase CLI to its disposable project/cluster, tests restricted non-superuser/non-bypassrls roles, closes connections and verifies removal of only its own temporary directory. Normal developer Supabase and production data are untouched.

On this Windows checkout, Kysely verification initially encountered CRLF versus generated LF. The explicit --refresh-types setup path produced no semantic type/schema diff; final acceptance used ordinary verify mode. The first new count fixtures missed Content's scoped Owner context and correctly read zero under RLS; final fixtures use the same scope as application assembly and assert actual visible counts. These exploratory runs are not final evidence.

## Standards

Independent read-only review of eb1b6d2...4fdf1bf7e58bbf1526a1aaf35b3e8a9c14c3f934: **0 actionable findings**. Five-operation/provider boundaries, authorization before replay, scoped RLS/privacy, atomicity, bounded paging and fail-closed evidence were verified. No baseline smell warranted a finding.

## Spec

Independent read-only review of #194/#187 against the same diff: **0 actionable findings**. All T07-01–08 are implemented and covered by required executable proof; no scope creep. Final source-bound rerun is the report above.

Standards: 0 actionable findings. Spec: 0 actionable findings.

## Broad-suite and external status

[Sanitized full-suite report](phase7-suppression-broad-194.json): **1,177 passed, 0 failed, 234 environment-gated skips**, success true and zero failed suites across 106 files. These skips do not certify required integrations. The initial default-budget run had one existing Phase4 architecture subprocess exceed its five-second test timeout (5.34 seconds). Standalone architecture passed. Full rerun with file parallelism disabled, testTimeout=15000 and build activity stopped passed; assertions and source behavior were unchanged.

Required acceptance uses real controlled non-production Owner signature/allowlist/revocation adapters and disposable PostgreSQL. A fresh Docker-emitted Auth token run is not claimed; merged Phase 4 prerequisite evidence and the separate hosted Local Auth check remain distinct. Hosted deterministic CI, current Codex review and human approval are separate requirements. Live hosted status is reported after PR creation, without inferring green from local proof.
