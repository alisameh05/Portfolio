# Agent Instructions

This repository uses the engineering workflow conventions documented in `docs/agents/`.

## Agent skills

### Issue tracker

Use GitHub Issues for specifications, implementation tickets, triage state, blocking relationships, and comments. Do not silently fall back to local Markdown when GitHub access is unavailable; report the access blocker instead. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage vocabulary documented in `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `CONTEXT.md` and relevant records in `docs/adr/` when they exist; create domain context lazily when a domain decision is actually resolved. See `docs/agents/domain.md`.
