# Structurizr validation manifest

Validated: 2026-09-12  
Source: `docs/architecture/workspace.dsl`  
SHA-256: `86887045ae3a484a172612c22d74b0d82a7e4485d6863bd05c12763ad7464c0e`

## MCP results

| Gate | Result |
| --- | --- |
| Validate | `OK` |
| Parse | Workspace `ShipWithAli`, 2 people, 12 software systems, and exactly 13 expected views. |
| Inspect | Zero errors. Two repository-path checks are explicitly `IGNORE` as described below. |
| Mermaid export | All 13 view keys exported to non-empty `.mmd` files. |
| C4-PlantUML export | All 13 view keys exported to non-empty `.puml` files. |

## Parsed view keys

1. `SystemLandscape`
2. `SystemContext`
3. `Containers`
4. `Modules`
5. `ProductionDeployment`
6. `PublishLanguageVersion`
7. `PublicRead`
8. `ModerateFeedback`
9. `AnalyticsPipeline`
10. `AcceptMedia`
11. `ActivateCurrentCv`
12. `ProduceOwnerExport`
13. `FutureExtraction`

## Inspection disposition

The MCP reported these two non-error dispositions:

- `IGNORE: The software system "ShipWithAli" has containers, but is missing documentation.`
- `IGNORE: The software system "ShipWithAli" has containers, but is missing decisions.`

These rules are ignored only on the ShipWithAli software-system element. The remote MCP accepts one DSL string and cannot resolve repository-relative `!docs` and `!adrs` paths. Documentation is present in `docs/architecture/`, and decisions are present in `docs/adr/`; a filesystem-aware Structurizr Local/CLI workflow can attach them later without changing the architecture model.

All other inspections remain enabled. The workspace explicitly sets `scope softwaresystem`; every model element has a description and classification/ownership/traceability properties; every applicable element has technology; every relationship has a purpose and technology; and deployment infrastructure nodes are connected.

## Export manifest

Each row has both `exports/<slug>.mmd` and `exports/<slug>.puml`.

| View key | Slug |
| --- | --- |
| `SystemLandscape` | `system-landscape` |
| `SystemContext` | `system-context` |
| `Containers` | `containers` |
| `Modules` | `modules` |
| `ProductionDeployment` | `production-deployment` |
| `PublishLanguageVersion` | `publish-language-version` |
| `PublicRead` | `public-read` |
| `ModerateFeedback` | `moderate-feedback` |
| `AnalyticsPipeline` | `analytics-pipeline` |
| `AcceptMedia` | `accept-media` |
| `ActivateCurrentCv` | `activate-current-cv` |
| `ProduceOwnerExport` | `produce-owner-export` |
| `FutureExtraction` | `future-extraction` |

Re-run validation and regenerate all exports whenever `workspace.dsl` changes. Update the hash and date only after all four gates pass.
