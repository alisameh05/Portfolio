# Portable Owner export ZIP format

This document defines the offline `shipwithali-owner-export` package. A package is a data interchange artifact, not a database backup. Validation reads the ZIP in memory, checks its declared content, and never extracts entries or contacts a provider, application service, or network endpoint.

## Package layout

Each ZIP contains exactly the entries declared by `manifest.json`:

```text
manifest.json
schemas/manifest.schema.json             # pinned manifest schema; 1.4 for format 1.5, 1.5 for format 1.6
schemas/<scope>.schema.json              # one pinned record schema per selected scope/version
records/<scope>.ndjson                   # or records/<scope>.json
assets/<scope>/<stable-asset-id>          # legacy portable asset path
assets/media-metadata/sha256/<digest>      # Media v1.5 and exact accepted CV PDFs v1.6; shared by digest
```

The seven scope names are `portfolio-content`, `taxonomy`, `media-metadata`, `cv-metadata`, `moderation-history`, `analytics-reports`, and `portfolio-configuration`. Each selected scope has exactly one record entry, including a selected scope with no records. A non-empty NDJSON entry is UTF-8 without a BOM, has one JSON record per line, and ends with one LF. An empty selected scope is exactly zero bytes, has `recordCount: 0`, and uses the SHA-256 digest of the empty byte string. A zero-byte entry declared as JSON is invalid. JSON-array entries are UTF-8 without a BOM and contain one top-level array; an empty scope still uses the zero-byte NDJSON representation.

Record layout is fixed by the immutable `recordSchema` URI. A v1.0 record is flat: `scope` and its scope fields share the top level. A v1.1 record uses `{ "scope": "...", "value": { ... } }`. Record identities are stable lowercase UUIDv7 strings and retain their meaning across additive manifest minor versions. The `schemas/owner-export/v1.0/` files preserve the flat records; `schemas/owner-export/v1.1/` defines the wrapped records used by current exports. A manifest may not pair a record with a schema from another version.

| Scope | v1.1 `value` variant |
| --- | --- |
| `portfolio-content` | `contentId`, `contentType` (`project`, `achievement`, or `testimonial`), lifecycle and optional status/Featured facts, localized `revisions`, route identity/history, related project IDs, taxonomy value IDs, media asset IDs, and evidence items. Revisions require stable ID, locale, positive sequence, title/summary/body, review state, and current-publication state. Evidence requires claim, editorial state, and supporting artifact IDs; an optional `mediaAssetId` is a dependency. |
| `taxonomy` | `taxonomyId`, `aggregateVersion`, `kind`, values, rename history, and assignments. Values are active, retired, or merged; merged values require `mergedIntoId`. Rename entries carry value ID, previous/new names, and UTC instant. Assignment entries carry `targetId` and `taxonomyValueId`. Identities remain stable across rename, retirement, or merge. |
| `media-metadata` | V1.1 preserves the legacy record shape. V1.2 (manifest 1.5) records the aggregate version, current state, locales used by current published Project/Achievement revisions, accessibility metadata, processing and decision history, and every retained acceptance decision with its immutable variants. Histories are newest first, capped at 100, and carry truncation flags. The current accepted input is the `original` asset; accepted outputs are named variants. Both resolve to packaged bytes by SHA-256. Unaccepted, rejected, or withdrawn bytes are explicitly excluded. Locales describe current published Content usage. `publicationEligibility` reports current Media acceptance/accessibility policy, while `publicationState` describes current acceptance or Content publication; neither field performs an acceptance or publication action. Private filenames, rejection details, provider paths, object IDs, and signed URLs are excluded. |
| `cv-metadata` | CV v1.1–1.4 contain `aggregateVersion`, nullable `currentVersionId`, English `versions`, activation history, and optional truncation flags. CV v1.2 adds exact version registration/acceptance instants, approval and activation identities, acceptance history, and content-addressed PDF references. Arrays contain at most 100 newest entries; a true truncation flag requires 100 retained rows. |
| `moderation-history` | `feedbackId`, `projectId`, locale, aggregate version, moderation state, retention-eligible author/text fields, submission instant, and decision history. Each decision requires an approved/rejected/suppressed result, reason, and UTC instant. Removed text is never replaced with placeholder prose. |
| `analytics-reports` | Immutable `goal` identity/version/definition/activation history and `reports` with version, period, sample state, and aggregate count. A low-sample/suppressed report retains its state; it is not converted to a zero count. |
| `portfolio-configuration` | The `profile`, `contactChannels`, and `projectCta` configuration objects. Runtime credentials and environment secrets are never part of this record. |

Taxonomy schema 1.2 is used by manifest 1.4. It retains each taxonomy and value ID, current state and value version, full `evolutionHistory` (including create, rename, retirement, and merge source/target IDs), current assignments with assignment instants, and immutable `assignmentHistory` with project versions and sequence numbers. History retains the source per-value transition sequence and timestamp; it does not invent a global event version. Current value facts and all references must agree with their histories. Actor IDs and retirement reasons are not exported.

The pinned schemas close each record and every declared nested object to its supported fields. Contact channels contain the channel kind, label, destination, and one or more unique locales; profile and CTA objects contain only their documented display fields and optional profile media ID. Histories retain source array order. Unknown properties are invalid under a schema URI; changing record meaning requires a new record-schema URI and validator support. Omitted optional values remain omitted, `null` has only the meaning assigned by that field, and consumers must not synthesize values for absent history.

## Manifest versions and meaning

`packageFormat` is `shipwithali-owner-export`. Manifest schema versions use `major.minor` decimal notation. `1.0` is retained for read-only compatibility and uses flat v1.0 record schemas. It identifies its record schema per scope and declares exact record bytes and counts, but it does not claim transactional snapshot identity, complete dependency coverage, or packaged asset-byte integrity. The v1.0 portfolio-content record has no `projectStatus`, `featured`, or evidence `mediaAssetId`; the v1.0 taxonomy assignments use `projectId` and `valueId`, and merged values use `mergedIntoValueId`. The v1.0 media record requires its legacy `portableReference`. Its CV versions have no portable asset reference or truncation flags. V1.1 adds those fields under new schema URIs and the `{scope,value}` wrapper. The validator rejects v1.0 media record entries because that manifest version does not describe asset-byte integrity.

Manifest `1.1` adds stable export and transactional snapshot IDs, an ordered required-feature list, explicit dependencies and exclusions, pinned schema descriptors, and asset descriptors. Its selected records use the wrapped v1.1 record schemas. The five required features are, in order: `asset-integrity-v1`, `dependency-coverage-v1`, `record-integrity-v1`, `schema-integrity-v1`, and `snapshot-identity-v1`. The six exclusions, in order, are `raw-public-event-data`, `functional-visitor-identities`, `measurement-visitor-identities`, `sessions`, `credentials`, and `lab-entries`. `publicEventDataCoverage` is exactly `{ "mode": "excluded" }`.

Manifest `1.2` adds configuration snapshot facts in the optional `extensions.configurationSnapshot` object while preserving every v1.1 record schema URI and meaning. It records the retained configuration aggregate version (or `null` when no configuration row exists), the locales present in the captured channels, and the captured `currentCvAvailable`, `externalLinksAvailable`, and `globalProjectCtaAvailable` booleans. It does not reconstruct prior settings versions. A missing configuration row is represented by the selected zero-byte NDJSON entry with `recordCount: 0`.

Manifest `1.4` adds the taxonomy 1.2 record schema and complete identity, assignment, and evolution history. Taxonomy-only packages list Project dependencies as omitted with `scope-not-selected` and do not include Content records. When `portfolio-content` is selected with `taxonomy`, every current and historical Project reference must resolve to a Project record. Content-only and content-plus-configuration packages remain manifest 1.3; configuration-only packages remain manifest 1.2.

Manifest `1.5` is reserved for a standalone `media-metadata` selection and uses Media record schema 1.2 with the pinned manifest schema 1.4. The Media snapshot includes complete retained processing, decision, and acceptance history (with explicit truncation when a history exceeds 100 rows), current publication eligibility, and package-relative references to the exact accepted original and variant bytes. A Media package carries the bytes even though `cv-metadata` or `portfolio-content` was not selected. Identical SHA-256 objects share one archive member and descriptor. The reference is `assets/media-metadata/sha256/<lowercase-sha256>`; its descriptor and exact bytes must agree with every record reference. Rejected, withdrawn, unsafe, and not-yet-accepted objects have no packaged bytes and carry an explicit exclusion reason. No acceptance, publication, or other state transition is performed during export. This version caps each byte member at 50 MiB and the archive at 512 members (four fixed members plus up to 508 unique byte objects); the limits for earlier manifest versions retain their original values.

Manifest `1.6` supports `cv-metadata` alone or together with `media-metadata`. It pins the new manifest schema 1.5, which adds the CV record descriptor while preserving the published manifest schema 1.4 bytes used by 1.5 Media packages. It preserves the real CV version IDs, registration and acceptance times, approval IDs, activation IDs/times, and the nullable Current CV pointer from one repeatable-read snapshot. Every retained accepted English version must resolve to its exact currently eligible accepted PDF output; the export verifies that object's length and SHA-256 before packaging. A missing, rejected, withdrawn, stale, or corrupt required PDF fails the export. CV-only selections include the required PDF bytes and Media-owned asset descriptors without adding the `media-metadata` record scope. When both scopes are selected, identical objects share one content-addressed archive member. Each byte member is capped at 50 MiB; the archive allows up to 508 unique objects in CV-only packages or 506 when both record scopes are present.

The validator accepts additive `1.x` minors when they preserve those exact required semantics and keep new optional data inside `extensions`. Such a minor keeps the v1.1 record schema URIs, bytes, IDs, and meanings. It retains extension values as opaque manifest metadata. It rejects another major version, unknown required features, missing required features, and missing required fields with distinct validation codes. No producer may change the meaning or bytes of a published schema under its existing URI. A breaking manifest change requires a new major version; a record meaning change requires a new record-schema URI and explicit validator support. Version `1.0` remains readable and is not upgraded by guessing fields that it never declared.

For JSON fields, `null` means the source explicitly represented no value. An omitted optional property makes no claim about the source value and must not be converted to `null` or a fabricated default. There is no universal redaction sentinel. Sensitive values are omitted under their scope contract and recorded through the fixed package exclusions; if a required field cannot be safely represented, that record cannot be emitted as a valid record. These rules prevent consumers from confusing redaction with an actual domain value.

## Ordering and references

Ordering is part of the format:

1. `includedScopes` follows the scope order listed above.
2. `entries` has exactly one entry per selected scope in that order.
3. In v1.1+ manifests, `schemas` starts with the manifest schema, then one pinned record schema per selected scope in the same order. Manifest 1.4 uses the taxonomy 1.2 schema and may also include content 1.2 and configuration 1.1. A v1.0 manifest has only the selected v1.0 record schemas.
4. In v1.1 manifests, `dependencies` sorts by source-scope order, source ID, target-scope order, then target ID using lowercase ASCII ordinal order. Duplicate edges are invalid. V1.0 has no dependency table.
5. For scopes with multiple records, records sort by their stable identity ID in lowercase ASCII ordinal order. CV metadata and portfolio configuration each contain at most one aggregate record.
6. Content revisions group locale as `en`, then `ar`, and sort within each locale by ascending sequence and revision ID. Taxonomy values sort by value ID, evolution history by value ID and per-value transition sequence, assignments by target Project ID and value ID, and assignment history by target Project ID and sequence. Analytics goal versions sort by ascending version number, activation history by ascending UTC instant then version ID, and reports by period start, period end, then goal-version ID. CV versions and activation history preserve the owning CV view's newest-first order. Other domain history arrays preserve their source sequence; arrays are never reordered during canonical hashing.
7. Asset descriptors sort by ascending path. ZIP members are ordered as `manifest.json`, declared schemas, record entries, then assets in ascending path order.

An entry path is exactly `records/<scope>.ndjson` or `records/<scope>.json`. Its `recordSchema`, `schemaPath`, and `schemaVersion` must match the pinned schema for that scope and package generation. In v1.1+, the dependency table has one edge for every relationship in these portable fields: `relatedProjectIds`, `taxonomyValueIds`, `mediaAssetIds` and nested evidence `mediaAssetId`; taxonomy current and historical assignment targets/value IDs and merge targets (`mergedIntoId` or `mergedIntoValueId`); profile `mediaAssetId`; CV version `mediaId`; moderation `projectId`; and analytics step `projectIds`/`publicRouteIds`. Sources use the owning record identity; the singleton configuration's optional profile-media edge uses that media ID as both the source value and target identity. The validator extracts those references from parsed records and requires an exact edge-set match, so missing and invented dependency rows fail. `included` means the target is present and has no reason; `omitted` has one reason: `scope-not-selected`, `not-retained`, `unsupported-variant`, or `external-destination`. A target in an unselected scope must use `scope-not-selected`. All source IDs must resolve to entities in selected records; included target IDs must also resolve.

In v1.1–1.4, an asset belongs to `media-metadata` or `cv-metadata`, uses `assets/<scope>/<asset-id>`, and its descriptor supplies media type, byte length, and SHA-256. In Media v1.2 / manifest v1.5 and CV v1.2 / manifest v1.6, assets use digest-addressed Media paths, so identical output bytes share one ZIP member even when multiple Media or CV records refer to them. Each reference must match its descriptor's media type, byte length, and digest; CV references must resolve to a PDF descriptor. Every referenced asset must have one descriptor, and every declared asset must be referenced. Asset references are package-relative strings only; the validator never follows URLs or filesystem paths. V1.0 has no asset descriptors and is not interpreted as having byte-integrity coverage.

## Encoding and integrity

All text entries are strict UTF-8 without a BOM. JSON objects with duplicate keys are invalid. NDJSON has LF line endings and no empty lines. Arrays preserve order. Object keys are ordered by Unicode code point for canonical manifest hashing. Manifest JSON numbers are finite safe integers.

Each record entry digest hashes its exact decompressed member bytes, including NDJSON line terminators. Each asset digest hashes the exact asset bytes. In `1.1+`, each schema descriptor digest hashes the exact schema file bytes. The manifest digest is lowercase SHA-256 over compact UTF-8 JSON after recursively sorting object keys by Unicode code point and removing only the root object's `digest` property. Nested properties named `digest` remain in the canonical bytes. Array order is preserved. The digest is not a ZIP digest: the offline validator separately reports SHA-256 of the complete original ZIP byte sequence.

The independently published vectors are in `schemas/owner-export/vectors/`. `canonicalization-v1.json` covers Unicode ordering, nested objects and arrays, and removal of only the top-level digest. `exact-byte-sha256-v1.json` covers zero-byte scopes and exact UTF-8 bytes including a terminal LF. The package test implements its own canonicalizer and checks these fixed vectors; it does not import a producer canonicalizer.

Schema files embedded in a ZIP must match the corresponding pinned files in this repository byte-for-byte. A matching URI with altered bytes, a changed schema digest, or a descriptor that points to another path fails validation. This prevents silently redefining a schema under an old version.

## Bounded offline validation

The validator supports only single-disk ZIPs without ZIP64, comments, data descriptors, extra fields, directory entries, symlinks, or overlapping member ranges. It accepts stored and deflate members. Paths are lowercase ASCII, at most 240 bytes overall and 100 bytes per segment; absolute paths, drive prefixes, backslashes, percent encoding, traversal segments, duplicate normalized names, and non-file entries fail.

| Limit | Maximum |
| --- | ---: |
| ZIP archive bytes (checked before CLI allocation) | 64 MiB |
| ZIP member count | 512 |
| Expanded bytes per member | 50 MiB |
| Total expanded member bytes | 128 MiB |
| Asset bytes | 50 MiB |
| Manifest or schema bytes | 1,000,000 bytes |
| Deflate expansion ratio | 100:1 |
| Records per selected scope | 100,000 |
| JSON nesting depth | 64 |
| JSON values per entry | 500,000 |

The validator checks central and local ZIP headers, member bounds, CRC32, decompressed lengths, UTF-8, JSON structure, schema descriptors, record schemas, actual record counts, exact-byte hashes, asset references, dependency references, and the manifest digest before returning success. It does not write to disk, mutate application state, or read provider data. Malformed and over-limit archives fail with a bounded machine-readable error code.

## Local use

Run the validator from the repository root:

```sh
npm run owner-export:validate -- path/to/export.zip
```

The command prints a compact JSON summary with validity, version, selected scopes, record counts, verified schema/asset counts, dependency count, and the ZIP digest. It never prints record contents. The focused reproducible check is:

```sh
npm run test:phase8:owner-export-package
```
