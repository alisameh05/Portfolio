# System architecture implementation map

## Frontier

Start with `issues/01-foundation-and-module-guardrails.md`. Select the first numbered `ready-for-agent` issue whose blockers are all resolved.

## Decisions so far

- Domain-oriented modular monolith: `docs/adr/0012-domain-oriented-modular-monolith.md`.
- Vercel/Supabase deployment behind provider seams: `docs/adr/0013-vercel-supabase-with-provider-seams.md`.
- Strong transactions plus PostgreSQL outbox/jobs: `docs/adr/0014-transactional-outbox-and-consistency.md`.
- Consent-first measurement and conservative retention: `docs/adr/0015-consent-first-measurement-retention.md`.
- Stable module interfaces and dependency directions: `docs/architecture/module-interfaces.md`.
- Quality and operational gates: `docs/architecture/quality-attributes.md`.
- Complete traceability target: `docs/architecture/traceability.md`.

## Ticket graph

```text
01 Foundation
  -> 02 Data platform
      -> 03 Identity and configuration
      -> 04 Content and publishing
      -> 05 Taxonomy and discovery
      -> 06 Media and CV
      -> 07 Interaction and Moderation
      -> 08 Measurement
          -> 09 Portability and operations
              -> 10 Public and Owner experiences
                  -> 11 Release evidence
```
