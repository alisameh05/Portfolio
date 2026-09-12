# Content, publishing, and durable routes

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 03

## Objective

Implement Projects, Achievements, Testimonials, immutable localized Revisions, evidence validation, Public lifecycle, independent Language publication, Project relationships, External links, Public route identities, redirects, and cache-tag events.

## Acceptance criteria

- Publication succeeds only after review, evidence, media, locale, route, and release-boundary validation.
- Publication and route changes are atomic and append their outbox work in the same transaction.
- Saving a Draft or failing validation preserves the last valid public state.
- Slug changes retain stable identity, redirects, and canonical metadata.
- English and Arabic publish independently with no text fallback.
- D-01 through D-07, D-12 through D-15, I-01, and I-04 evidence pass where owned here.

## Comments

Implement the Content and Publishing interface; retain Testimonial semantics from ADR-0006 and exclude Lab per ADR-0007.
