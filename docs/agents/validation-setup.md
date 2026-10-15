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
