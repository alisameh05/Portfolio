# Visitor interaction and Moderation

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 03, 04

## Objective

Implement idempotent Reactions, Ratings, private Feedback, immutable Moderation decisions, public aggregates, abuse controls, and retention-compatible histories without Visitor accounts.

## Acceptance criteria

- One functional Visitor identity has at most one current Reaction and Rating per Project.
- Feedback is never public before approval; rejection and later suppression remain in Owner history.
- Hidden or Archived Projects reject new interactions and expose no interaction summary or approved Feedback.
- Public mutation routes return typed validation, authorization, rate-limit, conflict, and unavailable results.
- Raw IP addresses are not persisted or emitted to analytics/logs.
- D-05, D-10, D-11, E-04, I-03, and applicable Q-04 evidence pass.

## Comments

Apply the 90-day rejected/unresolved and 12-month suppressed-history policy from ADR-0015.
