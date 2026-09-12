Init# Foundation and module guardrails

Status: ready-for-agent
Type: task

## Objective

Create the Next.js/TypeScript application shell, local Supabase development setup, CI checks, and nine domain-module packages plus Provider Adapters using the interfaces and dependency directions in `docs/architecture/module-interfaces.md`.

## Acceptance criteria

- Public and Owner route groups compile with English and Arabic locale shells.
- Domain modules expose only their declared interface entry points.
- Static dependency checks fail on Next.js/provider imports inside domain modules and cross-module implementation imports.
- Unit, type-check, lint, build, and architecture checks run in CI with deterministic seeds.
- No Lab route, navigation, Owner command, or public projection exists.

## Comments

The architecture model is `docs/architecture/workspace.dsl`; conformance evidence is Q-01 and D-14.
