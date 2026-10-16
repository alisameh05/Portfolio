# Phase 7 gate coverage

`npm run phase7:gate` composes the focused Phase 7 PostgreSQL/Auth/crypto,
interaction, Moderation, Measurement, Analytics goal, aggregate, retention, and
leased-job runners. It then runs the Phase 7 HTTP dispatch matrix, the integrated
clean/upgrade and restricted-role suite, and repository contract, route,
architecture, lint, typecheck, and build checks.

The gate expands the parent specification into all 70 `P7-01` through `P7-70`
rows and maps each row to at least one freshly executed evidence component. It
also maps domain scenarios 2, 5, 10, 11, 13, 14, and the Phase 7 portion of 15.
Every component report and check log is bound to the same Git revision, source
tree fingerprint, and gate run ID. A report is accepted only when its required
suite succeeds with positive execution, zero failures, zero skips, and cleanup.

## Required checks

The gate requires Node 24.21.0, npm 11.19.0, and a current validation install.
It runs the focused commands for consent, Reactions, Ratings, Feedback,
Moderation, suppression, summaries, all three event slices, goal versions and
conversions, daily aggregates and privacy, both retention policies, leased jobs,
the seven Owner/four public HTTP dispatch surface, and clean/upgrade integration.
Contract generation/drift, tooling tests, deliberate gate-negative tests,
architecture, route inventory, runtime boundary, lint, typecheck, and production
build are required as well.

The HTTP assembly component requires exactly five public operations, 48 Owner
operations, two operational probes, and zero implemented product runtime
routes. The integrated PostgreSQL report must include clean/upgrade equivalence,
both generated database types, restricted-role evidence, at least five bounded
query plans, migration checksums, and successful cleanup.

## Deliberate rejection cases

`tests/tooling/phase7-gate.test.mjs` verifies that the evaluator rejects a wrong
runtime, missing real-service evidence, stale source fingerprints, absent or
incomplete evidence, skipped constituents, failed aggregate-suite status, and
failed cleanup. These fixtures exercise the rejection paths without pretending
to replace the real Phase 7 acceptance suites.

## Evidence and handoffs

The final report is `evidence/phase7-gate-report.json`; sanitized command output
is stored in `evidence/phase7-gate-checks/`. Focused reports retain migration,
role, race/replay, retention, aggregate, and cleanup details. Reproduction is:

```text
npm run setup:validation
npm run validation:ready
npm run phase7:gate
```

This gate proves local Phase 7 implementation behavior. Phase 8 still owns the
protected daily schedule, general dispatch, operational alerts, eligible export,
and backup/deletion integration. Hosted CI, human approval, deployment, and
production readiness are reported independently.
