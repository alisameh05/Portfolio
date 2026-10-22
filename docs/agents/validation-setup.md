# Reproducible PR validation

All PRs use the exact runtime in `.nvmrc` and `package.json`: Node 24.21.0,
npm 11.19.0. Dependencies are installed from the committed lockfile, including
development tools and platform binaries. No legacy peer override is required.

## Codex Cloud GitHub tasks

In the Portfolio environment at [Codex settings](https://chatgpt.com/codex/settings/environments),
select the universal image and manual setup. For **both setup and maintenance
scripts**, paste the contents of `scripts/codex-setup.sh`. The bootstrap supports
older PR branches that do not contain the new setup command. After merging these
files to `master`, new environments can instead use:

```bash
bash scripts/codex-setup.sh
```

The single-line command requires the script on the default branch because
initial setup checks out that branch. Reset the environment cache after activation.
The script selects the exact Node/npm versions, persists Node activation for
subsequent Bash shells, and runs `npm ci` before agent networking is restricted.
It also verifies the runtime and dependencies in a fresh login shell before setup
finishes. Existing login-profile precedence is preserved.
Initialization disables nvm's automatic version selection until the exact
`.nvmrc` version has been installed, so a Node 20 cold start cannot exit early.
Maintenance repeats the install for the selected PR's lockfile, so cached
containers cannot silently reuse another branch's dependencies.

Setup needs HTTPS access to `nodejs.org` (Node) and `registry.npmjs.org` (npm
and locked packages). Agent internet access can remain off for these checks.
Do not clear proxy settings, change registries, or disable TLS validation to
work around a denied request. An HTTP 403 is an environment access failure;
fix setup-phase access or the environment policy, then rerun setup. Repo files
cannot override that policy.

OpenAI documents the [separate setup session, maintenance and caching](https://learn.chatgpt.com/docs/environments/cloud-environment)
and [setup versus agent internet access](https://learn.chatgpt.com/docs/cloud/internet-access).

## Local and CI setup

Select Node from `.nvmrc` using your runtime manager and install npm 11.19.0
in that runtime. On Windows, put the pinned runtime's directory first on PATH;
do not mix a different Node executable with the npm shim.

```text
npm run setup:validation
npm run validation:ready
npm run typecheck
npm run phase4:focus:context
```

Setup fails before installation on a runtime mismatch and fails if installation
does not complete. It stamps the installed package/lockfile fingerprint only
after success. Validation rejects missing packages, wrong versions and stale
installs. After changing either manifest, rerun setup while networking is
available. A failed or blocked setup is never passing validation evidence.

The `PR validation` GitHub workflow performs a clean setup and these checks on
every PR to `master`, plus architecture and contract checks. Its npm cache speeds
downloads; it does not replace `npm ci` or cache `node_modules`. This workflow
does not claim phase-gate completion. Its separate `Local Auth real-token` job
runs on an Ubuntu host with a Linux Docker engine, outside the Node-only cloud
bootstrap container. It executes `npm run phase4:focus:local-auth` on every PR
and fails for a missing/inaccessible engine, failed startup, failed assertions,
skipped tests, or failed cleanup. Require this check in branch protection when
accepting Owner Auth changes.

## Local Auth integration

After validation setup, run:

```text
npm run phase4:focus:local-auth
```

Install a Docker-compatible Linux engine and allow the executing runner access
to it. On Windows, start Docker Desktop; an installed CLI alone is insufficient.
The command preflights `docker info`, creates a disposable Supabase project and
loopback-only Docker network on ports 56320–56322, enables only the required API
gateway/Auth services, applies repository migrations, captures status credentials
in memory, and runs the real-token suite with zero skips required. It cleans up
only its own project containers/volumes/network. The normal development stack and
its data are preserved. Reserve those ports for this command; do not run it twice
concurrently on one host. Initial image downloads require registry access.

Never print `supabase status -o env` to an agent transcript or CI log: it contains
local privileged keys and signing material. The command consumes JSON status
without exposing values or persisting an env file.

Codex Cloud's Node setup does not install or guarantee a running Docker daemon.
Installing a CLI in that runner does not supply an engine or engine privileges.
When its preflight reports `LOCAL_AUTH_DOCKER_MISSING` or
`LOCAL_AUTH_DOCKER_UNAVAILABLE`, use the PR's `Local Auth real-token` check or a
local Docker-capable host for the actual result. Deterministic fixture tests and
an opt-in test reported as skipped are never real-token acceptance evidence.

The `Portfolio settings real-PostgreSQL` CI check replays the historical Phase 4
release, PR #105 (`9806af81d4ce705c36d9b22089f77213d16887bc`), in a separate
checkout with its own pinned runtime and lockfile. Its Phase 3 predecessor
assertions intentionally reject later domain activations, including the Phase 6
Storage functions; running it on the current migration tree cannot prove that
historical contract. The check still requires real clean/upgrade PostgreSQL
projects, restricted roles, settings assertions, zero skips, and cleanup. Its
uploaded evidence describes that release, not current Phase 6 acceptance.
Current-source architecture, contracts, and typechecks remain in the validation
job; current media acceptance requires the focused gates documented in
`docs/phase6-verification-setup.md`.

## Refresh Phase 8 prerequisite evidence

After substantive source changes, commit the finished source and run:

```text
npm run phase8:qualify
```

This runs the validation environment check, all five Phase 3–7 gates (including
the Docker Phase 6 gate), then the prerequisite evaluator. It stops on the first
failure or source change. Docker Desktop must be running with Linux containers.
Keep the source tree unchanged during the run; generated evidence is excluded
from its fingerprint and can be committed afterward.

Qualification first checks that Docker is on PATH, its Linux engine is reachable,
and Compose is installed. Missing Docker, denied engine access, a stopped engine,
Windows containers or missing Compose stop the command before source inspection
or any evidence-producing gate. The existing evidence remains untouched. On
Windows, start Docker Desktop with Linux containers and allow the runner access.
A Node-only Codex Cloud environment cannot perform this qualification; run the
same committed branch on a Docker-capable local or CI host. Installing only the
Docker client does not provide an engine. Never replace this requirement with
skips or fabricated passing evidence.

The media hard-limit probe checks safe rejection on hosts without Docker. The
Docker validation `checks` mode explicitly requires the pinned processor image
and an observed output file within the kernel-enforced size cap; unavailable
processing cannot pass that real-container assertion.

`npm run phase8:prerequisites` only evaluates existing reports. A
`source-tree-mismatch` means those reports describe different source, even if
their original tests passed. Refresh them with `phase8:qualify`; do not edit
their source hashes or relax qualification. Historical fingerprint and migration
verification reads Git objects without creating temporary worktrees or requiring
write access to the repository's Git metadata.
Historical attribute files are reconstructed in an isolated temporary directory,
which is removed on success or failure. The caller's index and working files
are preserved, including on the validation image's Git 2.39.

## Validation evolution: registry edits and qualification reuse

Database-era expectations live in one shared registry,
`scripts/phase-contract-registry.mjs`: migration classifications
(`baseline`, `phase5`, `operations-transformation`, `declared-additive`),
the reviewed engineering-check-preservation contract for every declared
operations transformation, per-checkpoint paired suites, and the declared
database capabilities exported as the `PHASE_DATABASE_CAPABILITIES`
environment contract. Do not re-derive these facts inline in gates or tests;
prevention tests fail on undeclared drift.

Editing the registry (synthetic-evolution and preservation coverage):

```text
npm run test:validation-evolution
```

Every new migration file must be classified exactly once. An undeclared
migration fails its first consumer with
`PHASE_CONTRACT_MIGRATION_UNDECLARED:<file>`, so the declaration happens at
review time, never during an incident. A new operations-era migration is
declared with its reviewed source checksum, schema-qualified additions, and
expected security identities. New policy and grant rows specify their table,
role, command, scope, and grantability. Existing catalog definitions are
compared in full outside explicitly reviewed transformations.
`composeOperationsBoundary()` drives the Phase 3 preservation comparison;
anything not declared fails with
`PHASE3_OPERATIONS_CONTRACT_ALTERED|LOST|UNEXPECTED_ADDITION|REPLACEMENT_MISSING`
plus stage, check, category, and precise schema paths.

One qualification command: `npm run phase8:qualify`. It runs the DAG
validation-environment, phase1, phase2, phase3, phase4, phase5, phase6,
phase7, and the prerequisite evaluator, in topological order.

`--resume` reuses only successful, cleaned nodes from a previous run recorded in
`evidence/phase8-qualification-run.json`. The record binds to the current
committed revision and source tree, pinned migration checksum inventory, Node
and npm versions, host platform and architecture, and a digest of the process
environment. The DAG definition hash includes each node's script, arguments,
dependencies, report path, and exact required check inventory. Reused reports
must retain their digest, exact named checks, successful cleanup, recent
timestamps, and every referenced evidence artifact digest. Database checkpoints
also require matching source and tool identities, migration checksums, and a
successful isolated PostgreSQL service scope. The live validation-environment
preflight runs on every resume; a successful preflight preserves the verified
prefix. Failed, running, missing, or corrupted nodes and their descendants
rerun. A changed source or input invalidates the context.

The validation preflight records the observed Docker engine, Compose, pinned
Supabase CLI, selected native PostgreSQL executable, and locally available
validation image IDs/digests. Resume requires those identities to match. If a
required image is not already present, the preflight marks the service scope
unverified; service-free predecessor nodes can still be reused, while nodes
requiring that service rerun and may pull their pinned images during startup.
The operations catalog manifest has
explicit PostgreSQL 17 and 18 variants; a snapshot from an unsupported or
unmatched major fails closed.

Native Phase 7 validation also requires PostgreSQL 17 or 18 because Media
correctness transactions use `transaction_timeout`. Select the installed binary
directory with `PHASE7_POSTGRES_BIN`; qualification rejects unsupported majors
before running the DAG. The Ubuntu 24.04 Runtime and qualification jobs run
`node scripts/setup-ci-native-postgres.mjs`, which installs PostgreSQL 17 using
the [official signed PGDG repository](https://www.postgresql.org/download/linux/ubuntu/)
and exports that directory for subsequent steps. This setup script only runs
inside the hosted GitHub Ubuntu job. The actual installed minor version remains
part of the service identity and resume proof. Native clusters use short owned
OS temporary directories and reject socket filenames longer than 107 UTF-8 bytes.

Phase 6 runs its media tools in the nested daemon started by its validation
compose project. The host cannot inspect that daemon's image IDs, so a resume
always reruns Phase 6 and its Phase 7/evaluator descendants. The Phase 6 report
still checks the pinned tool definitions and observed processor versions.

The hosted qualification workflow targets the pull request's current head SHA.
After the Codex review bot finishes a clean review for that exact SHA, rerun the
failed `Codex review` check on the corresponding run with
`gh run rerun <current-head-Codex-run-id> --failed`. Confirm the run's head SHA
still matches the reviewed pull request before relying on its result; a review
or check for an older commit does not qualify the current head.

Focused diagnostics: prefer the gate's own log under `evidence/` first, then
the failing domain check (for database era questions,
`npm run phase3:focus:role-rls`, which now reads the declared
`PHASE_DATABASE_CAPABILITIES` list instead of inferring the era from the
database being checked).
