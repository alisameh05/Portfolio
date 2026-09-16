# Phase 1 Dependency and Version Manifest

This document records the exact tool versions used in the Phase 1 architecture alignment
and contracts foundation. It is required evidence for Phase 1 completion.

## Runtime

| Tool | Exact Version | Pin Location |
|------|--------------|--------------|
| Node.js | `24.21.0` (LTS "Krypton") | `.nvmrc`, `package.json#engines.node` |
| npm | `11.19.0` | `package.json#packageManager`, `package.json#engines.npm` |

## TypeScript

| Package | Exact Version | Purpose |
|---------|--------------|---------|
| `typescript` | `6.0.3` | Type checking; proven pairing with OpenAPI generator |

TypeScript config flags enabled: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.

## Contract tooling

| Package | Exact Version | Purpose |
|---------|--------------|---------|
| `@redocly/cli` | `1.34.3` | OpenAPI 3.1 lint and canonical bundle |
| `@hey-api/openapi-ts` | `0.99.0` | Exact OpenAPI generator 0.99.0 pairing with TypeScript 6.0.3 |

> **Note**: `@hey-api/openapi-ts@0.99.0` is the exact OpenAPI generator 0.99.0 pairing
> referenced in the specification, paired with TypeScript 6.0.3 for deterministic
> transport type and client generation. Strictification of generated validators is
> handled by the `scripts/strictify-generated-validators.mjs` script (created in later Phase 1 tickets).

## Runtime validation

| Package | Exact Version | Purpose |
|---------|--------------|---------|
| `zod` | `3.25.51` | Runtime validator schemas for generated transport types |
| `valibot` | `1.1.0` | Alternative lightweight validator (available for transport adapters) |

## Testing

| Package | Exact Version | Purpose |
|---------|--------------|---------|
| `vitest` | `3.2.4` | Test runner; threads pool, singleThread for Windows safety |

Vitest execution setting: `pool: "threads"`, `singleThread: true`.
This is a deterministic Windows-safe setting, not a reduction in coverage.

## Architecture checking

| Package | Exact Version | Purpose |
|---------|--------------|---------|
| `dependency-cruiser` | `16.10.3` | Module dependency rules, cycle detection, provider-leakage detection |

## Identity

| Package | Exact Version | Purpose |
|---------|--------------|---------|
| `uuidv7` | `1.0.2` | UUIDv7 generation for opaque stable identities |

## Compatibility baseline

Compatibility checks against a `master` baseline are wired in a later Phase 1
ticket (#5 or equivalent). The initial baseline is committed when the OpenAPI
source contracts first pass lint and bundle.

## Evidence date

Generated: 2026-09-16
