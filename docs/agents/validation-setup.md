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
does not claim database verification or phase-gate completion.
