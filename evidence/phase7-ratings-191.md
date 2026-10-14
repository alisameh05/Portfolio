# Independent Project Rating delivery — #191

Implements only [#191](https://github.com/alisameh05/Portfolio/issues/191),
under [#187](https://github.com/alisameh05/Portfolio/issues/187).
Base: `ea84d875598e0735be385e7b366add2259f387f3` (merged #190 / PR #212).
Tested implementation: `fa6405b814bba3716577f9c2656fda42f8f81a02`.
Source fingerprint: `0abd2173784574de9837562735dd38e62883841ad33012b2443ebaae69e39b46`.
Required run: `0e1b7b62-e2cb-40c4-90a4-eadfdfa8ee0e`.

Required acceptance: **33 passed, 0 failed, 0 skipped, success true,
0 failed suites, cleanup true**. This includes 17 Rating checks and the 16
existing Reaction checks. The machine report is
[phase7-ratings-191.json](phase7-ratings-191.json); it records every assertion,
tool/service versions, migration names/checksums, runtime roles and cleanup.

## Criterion-to-test evidence

The named T04 tests are in `tests/phase7/ratings-postgres.test.ts` except the
additional application-boundary test in `tests/phase7/ratings.test.ts`.

| Criterion | Executed evidence |
| --- | --- |
| T04-01 | Strict HTTP 200, encrypted Secure/HttpOnly/SameSite=Lax cookie, 1-to-5 replacement, one current row and two changed events. |
| T04-02 | Invalid application values (0, fraction, 6, string, null, object/array, undefined, NaN, Infinity), invalid/malformed/unknown-field HTTP bodies, unchanged Rating/outbox/ledger totals; database range constraints. |
| T04-03 | Rating-first and Reaction-first reuse one verified subject, changing each preserves the other; en/ar requests share the same Rating, no added locale field, independent Projects/subjects and explicit initial-cookie-loss behavior. |
| T04-04 | New-key same-value creates a safe receipt without another changed event; exact retry after a subsequent change returns the original receipt; changed-payload key reuse conflicts without changing the current row. |
| T04-05 | Same-key exact/conflicting requests and different-key changes across independent pools; explicit barriers hold the first pair lock while PostgreSQL reports the second connection waiting; one current row and serialized final value. |
| T04-06 | Unknown/Draft/Hidden/Archived/wrong-type/no-public-language/foreign-Portfolio references reject before issuance and inside the mutation; withdrawal-first rejects stale preflight/replay, submission-first blocks lifecycle withdrawal until commit. |
| T04-07 | Denied/unknown consent permits Rating and creates no Measurement consent; actual AES-GCM previous-key rotation preserves the subject through 1-to-5 replacement; forged/expired/wrong-purpose/retired tokens reject. Functional assembly succeeds with absent/invalid optional Measurement configuration. |
| T04-08 | Injected Rating insert, outbox insert, ledger insert and receipt-update failures return 503, no cookie, unchanged state/outbox/ledger totals; events and receipts omit raw subjects, strict response omits subjects and logs omit encrypted cookies. |

Additional restricted-principal checks prove forced RLS, default deny, no
anonymous/authenticated/worker/backup CRUD grants, non-bypassing runtime roles,
Portfolio/subject isolation, denied reassignment and foreign writes, and cleared
transaction-local settings after pool reuse. The current-pair query uses the
`ratings_pkey` index. Unique constraints reject an additional row for the pair.
The complete #190 suite also passes against the expanded schema.

## Standards

Independent Codex review of `ea84d87...fa6405b`: **0 actionable findings**.
The diff follows provider boundaries, Content-before-Interaction lock ordering,
atomic state/replay/outbox writes, scoped RLS and subject-free receipts/events.
Cookie issuance follows successful response validation. The focused runner
checks aggregate suite success, zero skips, source stability and cleanup.
The Rating service mirrors the existing Reaction workflow; the reviewer did not
consider a shared abstraction worthwhile for this slice.

## Spec

Independent Codex review against live #191/#187: **0 actionable findings**.
T04-01–08 map to persistence/HTTP/crypto, independent-connection races, lifecycle
serialization, RLS, replay/privacy and rollback evidence. No missing behavior or
scope creep was found. Summary/Low-sample and integrated upgrade handoffs remain
appropriately deferred. Review inspected the report; it did not independently
rerun acceptance. Codex review, hosted CI and human approval are separate.

## Validation and reproduction

Node **24.21.0**, npm **11.19.0**, PostgreSQL **18.3**, Supabase CLI **2.117.0**.
The CLI created `20261014211320_persist_project_ratings.sql`; migration checksum
is `fff307d5158a7edbc15dd93114b1e5319f944fce74c3a0dd9f33072b78fecbdf`.
All migrations apply to a disposable cluster on a dynamically chosen loopback
port. Real non-production crypto and trusted Owner lifecycle fixtures are used;
no external Owner Auth service or production/developer data is required here.

```text
npm run setup:validation
npm run validation:ready
npm run phase7:focus:ratings
npm run typecheck
npm run lint
npm run contract:verify
npm run test:arch
npm run runtime:architecture
npm run runtime:boundary
npm run route:inventory
npm run phase5:context
npm test -- --testTimeout=20000 --reporter=json --outputFile=artifacts/ratings-full-vitest.json
npm run build
git diff --check
```

All commands passed. Full suite: **1,171 passed, 0 failed, 194 environment-gated
skips, success true, 0 failed suites**. The broad Windows timeout is for exhaustive
boundary scans; required real-service acceptance retains the default deadline.
The 194 broad skips are not counted as required acceptance. A sanitized broad
summary and raw-report hash are in `phase7-ratings-191-validation.json`.
Contract generation is deterministic, compatible and drift-free; exactly five
public operations and backend-only boundaries remain. Production build passes.

Phase 4 #90 / PR #105 and Phase 5 #125 / PR #144 are completed/merged, their
published gate evidence was inspected, and both merge commits are ancestors of
this base. Current Phase 5 context passes; this slice does not recertify their
full historical gates. All tests settled before final fingerprinted acceptance;
evidence-only delivery preserves the tested source fingerprint.

The runner stops its own disposable PostgreSQL cluster and removes its own
temporary directory. No normal Supabase stack is reset. Rollback disables Rating
assembly while retaining rows; corrections use a new expand-compatible migration.
See `docs/agents/rating-validation.md` for setup and type-refresh instructions.
Current summary/Low-sample behavior belongs to #195; integrated prior-release
upgrade qualification belongs to #208. No new endpoint, removal operation,
Measurement consumer, production migration/deployment or scheduling is included.

Hosted CI is reported separately in the PR and issue delivery comments after
publication. Local acceptance does not establish hosted CI or human approval.
