# Agent Instructions

This repository uses the engineering workflow conventions documented in `docs/agents/`.

## Agent skills

### Issue tracker

Use GitHub Issues for specifications, implementation tickets, triage state, blocking relationships, and comments. Do not silently fall back to local Markdown when GitHub access is unavailable; report the access blocker instead. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage vocabulary documented in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant records in `docs/adr/` when they exist; create domain context lazily when a domain decision is actually resolved. See `docs/agents/domain.md`.

## Pull request review

Codex is the sole AI pull-request reviewer. Human approval and deterministic CI remain separate required branch-protection conditions; an AI approval can satisfy neither.

Instructions for Codex on every non-draft pull request targeting `master`:

1. Review domain invariants: the five-operation public boundary, owner CRUD isolation, projection/response contracts, and forbidden frontend/Lab presentation surfaces.
2. Detect illegal module dependencies: no provider-coupled implementation leakage, no runtime-handler routes, no frontend/JSX/TSX in backend packages.
3. Check provider-type leakage: Supabase adapters stay behind repository interfaces; no direct provider imports in domain or handler layers.
4. Verify authorization and RLS: roles supply only approved access; no over-broad grants; RLS policies match declared contracts.
5. Inspect secrets and privacy: no secrets in source, logs, or fixtures; privacy-sensitive fields masked or excluded from projections.
6. Confirm SQL/migration safety: migrations reviewed, timestamped, schema-source-of-truth preserved; no unreviewed DDL in PR.
7. Validate OpenAPI compatibility: contracts lint/bundle; generated stubs match source; no drift in public or owner surfaces.
8. Examine generated drift: pinned generator versions; generated artifacts match source; no floating `@v1` or `latest` pins.
9. Assess adequate negative tests: failure scenarios covered; rollback paths tested; operation boundaries enforced.
10. Check operational rollback: deployment targets isolated; staging promotion requires evidence; rollback target identified.
11. Confirm backend-only scope: no browser state, no React presentation, no generated server stubs used as source, no working Route Handlers outside approved boundary.

Require a fresh Codex review whenever substantive code, contracts, migrations, auth, CI, or test behavior changes after the prior review. Resolve each actionable finding in code or record an explicit human-reviewed rationale in the pull request; do not silently dismiss findings. Dismiss stale reviews after substantive pushes. Configure branch protection for `master` to require deterministic CI, the current Codex review/check, and at least one human approval.

CodeRabbit must not be added. No second AI reviewer is designated in this policy.

## Code Review Rules
### Actionable findings

- Only report issues that are actionable and worth fixing.
- For every finding, explain:
  1. Why the current code is a problem.
  2. What behavior should replace it.
  3. The smallest safe fix.
  4. Which tests or checks should verify the fix.
- Make remediation instructions specific enough that another Codex task can
  implement the fix without needing additional clarification.
