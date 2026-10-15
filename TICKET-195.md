# Issue 195 — Interaction summaries (Phase 7 slice 08/22)

Selected as next unclaimed `ready-for-agent` ticket after open list review.
Blockers verified CLOSED: #190, #191, #194.
Branch: `codex/issue-195-interaction-summaries` from master.

Acceptance criteria covered (per issue body):
- T08-01..T08-08 (reconciliation, rejection of invalid projects/locales, hide/archive/restore races, DTO bounds)
- P7-12, P7-13, P7-14, P7-15, P7-16, P7-27, P7-28

Validation setup: `npm run setup:validation` required (currently stale per `validation:ready`).
Implementation approach: work from existing `interaction-moderation` and `measurement` modules, add public summary/query DTO paths, migrations, and focused tests.
