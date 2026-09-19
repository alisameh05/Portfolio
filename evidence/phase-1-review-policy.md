# Phase 1 — Codex review policy and CodeRabbit removal evidence

Ticket: #10 — Establish the Codex review policy and remove competing AI review
Parent: #1
Status: blocked — external admin items unresolved (branch-protection config 403; Codex app authorization blocked)

## Search performed

- Repository file scan for "CodeRabbit", "coderabbit", "Code-Rabbit" outside `.git`, `node_modules`, and docs: only occurrence is the specification reference in `docs/implementation-guide.md` (expected). No workflow files, secrets, branch-protection configurations, or app installations found in repo.
- `.github/` directory: absent (no workflow files, no branch-protection settings file, no CODEOWNERS).
- Branch-protection checks inventory: no repository-controlled branch-protection configuration files found in repo; external endpoint `/repos/alisameh05/Portfolio/branches/master/protection` returned 403 (requires Pro/public repo). Treated as named external blocker (repo admin / GitHub org owner).
- `.scratch/`: only `phase-1-architecture-alignment-contracts/spec.md`; no CodeRabbit artifacts.
- GitHub REST (`repos/alisameh05/Portfolio/branches/master/protection`): returned 403 (requires Pro/public repo for branch-protection read). External admin verification blocked; treated as named blocker below.

## Removals / absences

- No repository-controlled CodeRabbit workflow jobs to delete.
- No repository-controlled CodeRabbit secrets or GitHub App requirement files.
- No `CODEOWNERS`, `.github/workflows/`, or `.github/` entries referencing CodeRabbit.
- `AGENTS.md` updated to declare Codex as sole AI reviewer and explicitly state CodeRabbit must not be added.

## Policy artifacts

- `AGENTS.md` — dedicated `Pull request review` section added covering all 11 required concern groups (domain invariants, illegal dependencies, provider leakage, authorization/RLS, secrets/privacy, SQL/migration safety, OpenAPI compatibility, generated drift, negative tests, rollback, backend-only scope), plus fresh-review, resolution, branch-protection, and second-AI prohibition rules.
- No second AI reviewer designated in policy.

## External administrative blockers (recorded, not silently removed)

- Branch protection for `master` requiring deterministic CI + Codex review + human approval: cannot verify or configure via available permissions (403 on protected branch endpoint). Responsible owner: repository admin / GitHub organization owner. Required action: configure branch protection rules to require CI, Codex review, and at least one human approval; confirm no CodeRabbit requirement checked.
- Codex app authorization / automatic non-draft PR review for `master`: requires repository-level install/authorization; blocked by external admin action, not repo file change.

## Deterministic check

- `scripts/check-review-policy.mjs` verifies `AGENTS.md` contains required concern keywords, no second AI reviewer, and policy presence.
