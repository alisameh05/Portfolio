# Accountless Reaction delivery — #190

All T03 acceptance criteria passed against implementation `0f2692f65f4b5fa18080325bc40ee26254aaa367`,
source fingerprint `b1529a7681617ad3860dc079ea05502287d9a290279763c9ab5cf5b3dd6a524c`, run `be050198-a8c3-4bfd-8562-dcbec072b32e`.
The [machine report](phase7-reactions-190.json) records every assertion, all applied
migration checksums, tool/service versions, role scope, reproduction and cleanup.

Required acceptance: **16 passed, 0 failed, 0 skipped, success true,
0 failed suites**, using native disposable **postgres (PostgreSQL) 18.3** and actual AES-GCM
functional-token issuance/verification. Cleanup succeeded. This is the Reaction
portion of the linked parent criteria; Feedback, Rating and combined summaries
remain their own tickets.

| Criterion | Executed proof in `tests/phase7/reactions-postgres.test.ts` |
| --- | --- |
| T03-01 | Strict HTTP 200/DTO; contracted secure cookie; like→dislike replaces one row; per-choice counts reconcile. |
| T03-02 | Unknown/Draft/Hidden/Archived/wrong-type/foreign/no-language references deny before issuance and inside mutation. Both barrier-controlled real lifecycle/submit orders pass; unavailable replay rejects. |
| T03-03 | Denied/unknown consent permits functional use; read/Feedback/event purposes cannot obtain functional identity. No Measurement consent rows are created; other transport boundaries remain covered by predecessor suites. |
| T03-04 | Actual crypto rejects tampered, expired, wrong-purpose and retired-key tokens; supported previous key preserves subject and remaining lifetime. Functional-only assembly excludes optional Measurement configuration. |
| T03-05 | New-key same-value emits no duplicate changed fact; exact retry preserves the original receipt after a later change; conflicting key reuse changes nothing; independent-pool same-key races reconcile. |
| T03-06 | A pair-lock barrier and observed PostgreSQL lock wait prove independent connections serialize different-key choices into one final row. |
| T03-07 | Injected row/outbox/ledger reservation/receipt update failures return 503 with no cookie and roll back all counts. Removing each fault permits recovery. |
| T03-08 | Initial cookie loss under the same key creates independent subjects; recognized-subject replay remains one effect. Subjects/Projects/locales remain independent without language vote copies. |

The test corpus also verifies default-deny scoped RLS, absence of anonymous and
worker grants, pooled setting cleanup, subject-free receipts/outbox/logging,
standard database runtime assembly with absent/invalid Measurement configuration,
and safe required-database outage. Functional tokens expire within 30 days.
No functional facts are forwarded to Measurement.

## Standards

Fresh independent Codex Standards review of `6c41d48...0f2692f`: zero remaining
actionable findings. The initial optional-Measurement configuration coupling was
repaired and covered by actual functional-only/invalid-Measurement assembly tests.

## Spec

Fresh independent Codex Spec review of the same source against #190/#187: zero
remaining actionable findings; T03-01–08 and scope handoffs are covered.
Codex source review, hosted deterministic checks and human approval are separate.

## Reproduction and scope

See [Reaction validation](../docs/agents/reaction-validation.md) for the exact
pinned setup, isolated cluster, schema refresh/verify, lock order, cleanup,
rollback/forward-fix and privacy protocol. The runner requires complete successful
suites and unchanged source before publishing evidence. Full integrated upgrade
qualification remains #208; no production migration, route, deployment or
schedule was installed.

Required command: `npm run phase7:focus:reactions` (no type refresh on final run).
Node 24.21.0, npm 11.19.0. All repository migrations through
`20261014210000_persist_project_reactions.sql` applied; generated Interaction types matched.

## Broad verification

Full suite: **1170 passed, 0 failed, 178 environment-gated
skips; success true and 0 failed suites**. Reaction's 14 real PostgreSQL cases
are included among these optional skips in the broad command and are all executed
in the independent required 16-test acceptance above. No broad skip is counted
as required acceptance.

Command: `npm test -- --testTimeout=20000 --reporter=json --outputFile=artifacts/reactions-full-vitest.json`. Two earlier default-five-second runs
timed out in different exhaustive boundary scans on this Windows host; the first
failed file passed alone. The final complete run uses a 20-second per-test
deadline, with unchanged assertions and suite selection. Required Reaction
acceptance passes with the default deadline.

Typecheck, lint, deterministic contract generation/drift/compatibility,
architecture and negative fixtures, runtime boundary, five-operation inventory,
current Phase 5 context and production build all passed. The
[sanitized validation report](phase7-reactions-190-validation.json) records
commands, totals, suite status and source identity. Generated exploratory
predecessor evidence is excluded from this ticket's commit.

Hosted CI must be assessed from the PR after publication; local passes do not
assert hosted CI or human approval. Evidence-only delivery commits preserve
the reviewed/tested implementation fingerprint above.
