# Contract delivery gate

Phase 1 maintains separate public v1 and Owner v1 OpenAPI sources, canonical
bundles, generated transport types, and strict Zod validators. Generated files
are outputs: do not edit them manually and do not import them from domain or
application modules.

## Commands

- `npm run contract:generate` lints both source contracts, bundles them
  independently, generates only transport types and validators, and converts
  every generated object validator to a strict object.
- `npm run contract:drift` generates both surfaces twice in clean temporary
  directories, requires byte-for-byte equality, and compares the result with
  every committed bundle and generated file.
- `npm run contract:compatibility` compares both canonical bundles with the
  committed `master` snapshots under `openapi/baseline/master/`.
- `npm run contract:verify` composes generation, drift, and compatibility as
  the contract delivery gate used before the contract tests.
- `npm run contract:docs` renders local public and Owner HTML reference files
  under the ignored `artifacts/openapi-reference/` directory. The command does
  not publish a documentation site.

The drift command fails for missing, extra, stale, hand-edited, or
nondeterministic artifacts. The compatibility command rejects removed or
renamed fields, narrowed accepted inputs, newly required inputs, changed
security, removed operations, and removed response statuses. Additive optional
fields and operations remain compatible.
