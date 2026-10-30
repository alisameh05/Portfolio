# Integrated Phase 8 verification (#256)

Run the integrated acceptance check with:

```text
npm run phase8:focus:integrated
```

The command runs focused Phase 8 service checks against disposable local PostgreSQL, Supabase Storage, encryption, and recovery targets, followed by contract, architecture, lint, typecheck, and production-build checks. It does not run the Phase 3–7 gates or `phase8:qualify`.

The run writes `evidence/phase8-integrated-verification-256.json`. The report binds every component artifact to the current commit and source-tree fingerprint, includes migration checksums and the executed test names from each service report, checks each component's aggregate failure/skip counts and cleanup, and records per-criterion command evidence. It fails if a component artifact is missing, stale, skipped, failed, or not source-bound, or if source files change while the check runs.

| #256 criterion | Executed checks and evidence |
| --- | --- |
| AC01–AC02 | `phase8:focus:exports` runs real Content/CV/Media/Moderation and export persistence PostgreSQL cases; `phase8:focus:reference-import` exercises the independent import boundary; `phase8:focus:recovery` verifies restored restricted roles and isolated targets. Their reports list individual executed tests, migration checksums, role grants, and cleanup. |
| AC03 | Export and reference-import compositions run with `phase8:focus:incidents`; its PostgreSQL report covers protected trigger, readiness, operational failure, and shutdown boundaries. |
| AC04 | `test:contracts` verifies both OpenAPI surfaces and generated drift; `test:arch` checks operation/module/provider boundaries. |
| AC05, AC07 | `phase8:focus:incidents` records bounded operational queries, real telemetry producers, actionable incident handling, safe labels, and degradation results. |
| AC06 | Export and reference-import PostgreSQL runs exercise capture, publication, approval, withdrawal, and retention barriers; isolated recovery checks deletion reconciliation. |
| AC08 | Contract, architecture, lint, typecheck, and production-build commands must all pass on the same unchanged source tree. |
| AC09 | The report records all nine command results, zero required failures/skips, source-bound component artifacts, and successful owned-resource cleanup. |

The component reports preserve the test names rather than treating a passing suite label as criterion evidence. The integrated report is local acceptance evidence; hosted CI, Codex review, human approval, merge, and deployment remain separate states.
