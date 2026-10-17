# Phase 6 verification setup

## Docker runner on Windows, macOS and Linux

From the repository directory, run:

```text
npm run docker:phase6
```

This builds `docker/validation/Dockerfile` through `compose.validation.yaml`
and runs both real Media integration and CV registration/migration gates.
Only a host Node executable, Git, Docker Compose and a running Linux Docker
engine are needed; host npm dependencies do not need installation first.
On Windows, start Docker Desktop in Linux containers mode. Allow at least
6 GiB of Docker memory and enough disk for the Supabase and processor images.
The first run downloads images and dependencies and can take several minutes.
Run one local acceptance gate at a time, including direct host npm gates, to
avoid competing scanner containers exhausting Docker Desktop memory.

Use `npm run docker:checks` for setup/tooling tests, typecheck, architecture,
lint, and the Media processing/CV unit tests, including the Docker file-limit
test. Both modes fail on unsuccessful checks. The launcher rejects a missing
engine, Windows containers, missing Compose, and concurrent validation runs.
It discovers Git metadata for both ordinary clones and linked worktrees.

The validation container runs a **privileged private Docker daemon** and should
be used only with a trusted checkout. It does not mount the host Docker socket
or expose a TCP daemon port. Source and Git metadata are mounted read-only,
then source is copied into a disposable Linux workspace; host `node_modules`
and `.env` files are excluded; the repository's `.env.example` is preserved.
Nested containers see their actual temporary
paths and loopback endpoints, avoiding host/container path and port mismatches.
The pinned Node/npm versions and lockfile are installed inside the runner.
The official pinned DinD bootstrap enables nested control groups so processor
CPU, memory, PID and file-size limits work on cgroup v2 hosts.
Production credentials are unnecessary: the existing gates create disposable
local PostgreSQL/Auth/Storage services and consume their keys in memory.

The runner exports only freshly generated sanitized reports to
`evidence/phase6-media-integration.json` and
`evidence/phase6-cv-portfolio-154.json`, including failure reports. An early
failure cannot export an old committed pass. Docker image and npm download
caches persist in the Compose project's named volumes. Startup and shutdown
remove disposable services from the private daemon, including interrupted-run
leftovers. The launcher removes the finished runner; no global host Docker
cleanup is performed. To remove its
caches after all validation runs have ended:

```text
docker compose -p portfolio-validation -f compose.validation.yaml down --volumes
```

In an ordinary clone, `docker compose -p portfolio-validation -f
compose.validation.yaml run --build --rm --name portfolio-validation-runner
validation phase6` also works. Prefer the npm launcher for linked worktrees.
These files still require a host engine; a restricted Node-only Codex Cloud
environment cannot run them merely by installing the Docker CLI. Use a
Docker-capable local host or the PR's Linux CI job for real acceptance.

The existing CI job runs the gates on its Linux host and additionally builds
this runner to catch broken tool images or Dockerfile dependencies. Production
processor containers retain their network, memory, CPU, PID and file limits.
PDF source/output scans each allow up to 24 seconds for Docker startup, pinned
definition loading and cleanup, capped by the remaining 60-second application
attempt. PDF processor stages also share a bounded 24-second processor budget.

Issue #146 establishes a disposable real-service setup probe for the Phase 6 Media/CV tickets. It uses Node `24.21.0` and npm `11.19.0`, plus the repository-locked Supabase CLI. Complete network-enabled dependency setup before running validation:

```text
npm run setup:validation
npm run validation:ready
npm run phase6:focus:verification
```

The probe allocates its own temporary Supabase project directory and Docker network. The API, PostgreSQL, Auth and private Storage endpoints bind to loopback ports 57321–57322; it never reuses the developer Supabase project. Local status credentials stay in process memory and are removed from the child environment before startup. No Owner session, production secret, remote Supabase project or test-only application route is used.

The storage probe creates one private bucket, uploads each safe fixture using the local service role, verifies an anonymous caller cannot read it, then checks the administrator read has identical bytes. The actual scanner and format processors run from explicit versioned container definitions:

| Kind and format | Processor |
| --- | --- |
| PDF | OCRmyPDF v17.12.1 |
| PNG, JPEG, WebP | ImageMagick |
| MP4, WebM | FFmpeg |

The video processor detects ISO-BMFF MP4 or EBML WebM from bytes, allows H.264 MP4 and VP8/VP9 WebM inputs, and rejects other codecs. It caps input at 50 MiB, the full processing attempt at 60 seconds, 1,800 decoded frames, 1,920×1,080 source dimensions, one CPU, 1 GiB memory, and any individual FFmpeg transcode at 25 seconds. The version and probe calls have smaller stage caps and all stages share the full attempt deadline. It writes one normalized create-only variant per candidate (H.264 MP4 or VP9 WebM, no audio, at most 1,280×720 and 50 MiB), scans the output, then probes and hashes it again. `npm run phase6:focus:video-processing` exercises actual MP4 and WebM candidates against the disposable PostgreSQL/Auth/Storage stack and records criterion evidence in `evidence/phase6-video-processing-151.json`.

ClamAV scans each of the six generated fixtures. The report records runtime/tool definitions, service availability, execution counts, per-format processor and clean scan results, private Storage byte hashes, source revision/tree identity, run ID, and cleanup. `phase6:focus:verification` exits nonzero if setup, any required service, any format processor, private access, a positive execution count, source-bound evidence, or cleanup fails. Missing runtime definitions and stale, skipped, zero-execution, fake-only, or malformed evidence are rejected by the report evaluator.

The command is safe to interrupt only after it has exited: an interrupted Docker run may leave its randomly named disposable network or Supabase project, which the stable `PHASE6_CLEANUP_FAILED` diagnostic identifies. The normal local development stack and its data volume are outside the isolated work directory and network.

For issue #148, `npm run phase6:focus:upload-intents` runs the same isolated setup and processors, then executes the actual Owner HTTP command against its PostgreSQL 17 and Storage services. The focused suite checks idempotent exact replay after target expiry, encrypted bearer storage, owner/portfolio RLS scope, exact-object signed upload, anonymous and non-Owner Storage denial, failed-commit rollback, and expired orphan cleanup. It writes sanitized, source-bound counts to `evidence/phase6-upload-intent-148.json`; the temporary local keys and service credentials are not included in evidence.

## Complete Media and CV integration validation

Run `npm run phase6:focus:media-integration` to execute all seven tests in
`tests/database/media-upload-intent.integration.test.ts`. The command provisions
the disposable PostgreSQL/Auth/private Storage stack, generates the six format
fixtures, and injects credentials and processor settings into the test process.
It requires each of the seven named tests to pass, zero failures, zero skips, real acceptance
for all six formats, and successful cleanup. It writes sanitized evidence to
`evidence/phase6-media-integration.json`. No external env file is needed.
Rejection uses a separate Owner/Portfolio fixture so retained CV versions and
rejected Media cannot contaminate baseline initialization or acceptance checks.
Auxiliary delivery/rejection acceptances are counted separately from the six
format acceptances and never enter the accepted-format Media collection.

Run `npm run phase6:focus:cv-portfolio` for the CV registration scenarios and
the preexisting-Owner migration upgrade proof. Both commands run sequentially
in the `Phase 6 Media and CV real-PostgreSQL-Storage` CI job on each PR.
The upgrade starts with only migrations preceding CV initialization, provisions
a legacy Owner, then applies every deferred CV and later migration in timestamp
order. Evidence requires both the version-1 backfill and the complete deferred
migration ledger; later domain migrations cannot enter the pre-CV baseline.

Direct `npm test` / Vitest runs still skip optional service suites when their
fixture environment is absent. Use the provisioning commands above for real
acceptance; a skipped direct run is never acceptance evidence. A Docker-capable
host is required; the Node-only Codex Cloud bootstrap cannot supply a daemon.

Source fingerprints hash the tracked and non-ignored untracked working files,
excluding `evidence/`. They require no `origin/master`, fetch, or network access,
and remain stable across staging, committing the same source, and remote-ref
changes. Changes or deletions in source invalidate old evidence. Fingerprints
from the former remote-diff algorithm must be regenerated by rerunning gates.

## Predecessor context

Phase 4 issue #90 closed with merged PR #105. Its context report and run identity are recorded in `evidence/phase4-context-90-105.json`; the recorded source is the merge commit represented by PR #105, with five public operations, 39 Owner operations, six rejected negative fixtures, and both dependency-cruiser probes passing. Phase 5 issue #125 closed with merged PR #144; its current-source context report is `evidence/phase-5-context.json`, tied to the same source tree as this setup run. The current Phase 6 baseline includes merge commit `26d6efb3d9e281265cc9c099195492b5dcbec79d`. The Phase 4 activation policy remains historical: run its gate/context on the Phase 4 baseline represented by PR #105, because its current-tree rule intentionally rejects later Content/Taxonomy migrations. Do not weaken that historical restriction to make it pass on a later phase. Current context also preserves five public operations, provider boundaries, authorization/RLS ownership, Lab/frontend exclusions and fail-closed deferred services. The Phase 6 evaluator requires the recorded run identities, source provenance, assertion counts, and verdicts from both predecessor contexts.

The base `phase6:focus:verification` command prepares execution for later feature tickets and does not certify application Media/CV workflows or the final Phase 6 gate. The `phase6:focus:upload-intents` variant adds the scoped #148 application, PostgreSQL, and Storage checks described above; it does not certify the remaining Phase 6 tickets or final gate.

## Integrated Media and CV acceptance

Run `npm run docker:phase6:media-cv-integration` to exercise the cross-feature
Media/CV matrices from issue #163 on one fresh disposable PostgreSQL, Local
Auth, and private Storage stack. The run combines real PDF/image/video
processing, Current CV activation and delivery, public capability checks,
Content publication and restoration with accepted Media, Media rejection
races, Owner composition, and the Owner session/CSRF policy checks. It records
all eleven T18 criteria with executed case IDs and counts in
`evidence/phase6-media-cv-integration-163.json`.

The Docker command runs the focused acceptance command in the private validation
container. It fails for a missing service or processor, a missing or skipped
matrix case, a source change during execution, any failed test, or unsuccessful
cleanup. It proves the integrated local behavior for this ticket; it does not
certify deployment outage survival, release qualification, frontend behavior,
Measurement interactions, or backup operations.

## Migration/access fixture regression

After validation setup, run:

```sh
node --test tests/database/phase6-migration-fixtures.live.mjs
```

This focused regression starts two disposable Supabase projects. It compares
current catalogs and generated database types, checks the exact table/column
grants and reviewed Worker retention capabilities, exercises transaction scope
on reused pooled backends, and imports the accepted-PDF/CV fixture history into
the second database. It verifies bounded indexed reads and removal of each
owned container and volume. The fixture represents processing history; real
scanner/processor and Storage API authorization proof remains required by the
full gate.

This regression emits no acceptance artifact. Run the complete source-bound
Phase 6 gate after changes; a passing fixture regression does not qualify
Phase 6 or permit dependent Phase 8 implementation.

Released migration files retain their original contents. The shared disposable
local bootstrap used by Phase 3, real-token Auth, settings and Phase 6 validation stages SQL
until CLI start/reset has initialized its restricted administrator. It applies
the early role-creation migrations with the normal local
administrator, then temporarily elevates that administrator for the historical
migration suffix that transfers ownership of a superuser-owned function. It
checks the exact fixture container identity and actual loopback-only published
database ports, and restores the original privilege
in a `finally` block. Application, Worker, and probe roles remain restricted.
Because some Docker host configurations override the network's default bind
address, startup supplies explicit `127.0.0.1` publish flags through a scoped
Docker command adapter. It rewrites only named containers carrying the exact
disposable project's Supabase label, denies unbounded or unsupported publishes,
and preserves all other arguments and streams without logging them. On Windows
the adapter reuses the pinned Node executable to preserve multiline SQL
arguments; on Linux it uses an argument-preserving shell launcher. Its temporary
files and environment belong to the fixture and are removed or restored during
cleanup. Actual port inspection remains mandatory before privilege elevation.
Reset also receives the project's explicit network ID: otherwise the pinned
CLI can restart Storage on a different network and lose its database DNS name.
The forward migration revokes direct execution of the aggregate checkpoint
trigger function without replaying an edited historical migration. The fixture
regression verifies that upgrade and a clean installation produce equivalent
catalogs and types, and that the administrator is restricted again afterward.

This bootstrap is limited to disposable local Docker projects. Managed Supabase
does not permit granting superuser to its `postgres` role; this local evidence
does not qualify the historical ownership transition for a managed deployment.

## Complete Phase 6 gate

After network-enabled setup has completed, run `npm run phase6:gate` on a
Linux host with Docker, or `npm run docker:phase6:gate` on Windows/macOS or a
host where isolated nested Docker is preferred. The gate independently checks
the pinned Node/npm and installed lockfile, then runs the focused setup,
upload, processing, acceptance, publication, CV lifecycle/delivery, Media/CV
integration, migration/access, contract, architecture, lint, typecheck, and
production-build checks. Each focused command stays independently runnable.
Any unavailable dependency/service, failed command, timeout, source change,
missing matrix, stale report, required skip, or cleanup failure makes the gate
fail.

`evidence/phase6-gate-report.json` contains the run/source identity, every
check's result, hashes and identities for each required ticket report, real
service/tool counts, and executable traceability for all 56 Phase 6 acceptance
criteria, 48 parent stories, and required evidence matrices. The AC-to-suite
and story-to-AC mappings are defined in
`scripts/phase6-gate-support.mjs` and copied into the report so a reviewer can
trace each item to a fresh report generated by that same gate run. CI uploads
the gate report and sanitized component logs/reports even when a check fails;
the runner deletes old reports before starting so an early failure cannot
re-publish a prior pass.

The gate validates backend metadata and locale capability behavior. It does
not certify frontend rendering/accessibility, deployment or TestSprite
behavior, release-load qualification, backup/restore operations, or outage
survival for already-issued Storage capabilities.
