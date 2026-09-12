# ShipWithAli first-release implementation specification

Status: ready-for-agent

## Outcome

Implement the first release described by [`project-brief.md`](../../project-brief.md) as the domain-oriented modular monolith defined in [`docs/architecture/`](../../docs/architecture/). The application is one Next.js/TypeScript deployment on Vercel with Supabase PostgreSQL, Auth, and Storage behind provider adapters.

## Authority

1. Accepted records in `docs/adr/` override older proposals.
2. `CONTEXT.md` is the vocabulary authority.
3. `docs/domain-model.md` is the behavioral authority.
4. `docs/architecture/requirements.md` defines requirement identifiers and measurable targets.
5. `docs/architecture/module-interfaces.md` defines module seams and allowed dependency directions.
6. `docs/architecture/quality-attributes.md` defines security, consistency, privacy, operations, scaling, recovery, and rollout rules.
7. `docs/architecture/workspace.dsl` and `traceability.md` define the architecture model and required evidence.

## Completion criteria

- Every child issue is resolved in dependency order.
- All `A-*`, `D-*`, `I-*`, `E-*`, and `Q-*` evidence in `docs/architecture/traceability.md` is implemented and passing.
- The deployed Core public journey meets the documented capacity, accessibility, security, privacy, availability, and recovery gates.
- Architecture conformance tests prove module isolation and no first-release Lab surface or microservice dependency.

## Non-goals

Visitor accounts, public Lab entry behavior, automatic translation publication, automatic Project recommendations, Redis, Kafka, Kubernetes, GraphQL, an external search cluster, and a separate CMS are not part of this effort.
