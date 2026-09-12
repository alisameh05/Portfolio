# Taxonomy, discovery, and PostgreSQL search

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 04

## Objective

Implement controlled Taxonomies, assignment, rename, retirement, merge mappings, indexed public Project discovery, filters, newest-published ordering, and Featured presentation without an external search service.

## Acceptance criteria

- Retired values reject new assignments without losing history.
- Merge migrates affected assignments once and retains the old-to-survivor mapping.
- Public queries include Published Projects only and order canonical discovery by publication time descending.
- Featured remains independent of lifecycle, Project status, and canonical ordering.
- Full-text/trigram queries meet the documented p95 target at the seeded capacity.
- D-06, D-07, D-08, Q-02, and relevant Q-01 evidence pass.

## Comments

Use PostgreSQL until the `FutureExtraction` search trigger is sustained.
