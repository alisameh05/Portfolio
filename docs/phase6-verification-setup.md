# Phase 6 verification setup

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

ClamAV scans each of the six generated fixtures. The report records runtime/tool definitions, service availability, execution counts, per-format processor and clean scan results, private Storage byte hashes, source revision/tree identity, run ID, and cleanup. `phase6:focus:verification` exits nonzero if setup, any required service, any format processor, private access, a positive execution count, source-bound evidence, or cleanup fails. Missing runtime definitions and stale, skipped, zero-execution, fake-only, or malformed evidence are rejected by the report evaluator.

The command is safe to interrupt only after it has exited: an interrupted Docker run may leave its randomly named disposable network or Supabase project, which the stable `PHASE6_CLEANUP_FAILED` diagnostic identifies. The normal local development stack and its data volume are outside the isolated work directory and network.

## Predecessor context

Phase 4 issue #90 closed with merged PR #105. Its context report and run identity are recorded in `evidence/phase4-context-90-105.json`; the recorded source is the merge commit represented by PR #105, with five public operations, 39 Owner operations, six rejected negative fixtures, and both dependency-cruiser probes passing. Phase 5 issue #125 closed with merged PR #144; its current-source context report is `evidence/phase-5-context.json`, tied to the same source tree as this setup run. The current Phase 6 baseline includes merge commit `26d6efb3d9e281265cc9c099195492b5dcbec79d`. The Phase 4 activation policy remains historical: run its gate/context on the Phase 4 baseline represented by PR #105, because its current-tree rule intentionally rejects later Content/Taxonomy migrations. Do not weaken that historical restriction to make it pass on a later phase. Current context also preserves five public operations, provider boundaries, authorization/RLS ownership, Lab/frontend exclusions and fail-closed deferred services. The Phase 6 evaluator requires the recorded run identities, source provenance, assertion counts, and verdicts from both predecessor contexts.

This setup probe prepares execution for later feature tickets. It does not certify application Media/CV workflows, production authorization, RLS matrices, races, rollback, replay, production composition, or the final Phase 6 gate.
