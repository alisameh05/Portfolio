# Phase 8 acceptance gate

Run the final local acceptance gate from a clean, pinned checkout after validation setup:

```text
npm run setup:validation
npm run validation:ready
npm run phase8:gate
```

The gate writes `evidence/phase8-gate-report.json` and sanitized command logs under `evidence/phase8-gate-checks/`. It runs each backup test suite through its isolated test entry point; it does not invoke a configured backup destination or write to a developer or hosted database. On Windows it gives child test commands the existing `C:/t` temporary root required by the bounded worker qualification. The report records the source revision/tree, run interval, Node/npm versions, validation install fingerprint, each executed command, each criterion's matching executed assertion names and report paths, and each scenario's matching executed test names and artifacts. It also records the full migration checksum inventory, sanitized service roles and fixture-volume measurements, aggregate prerequisite/integrated results, and cleanup. A missing, stale, partial, skipped, failed, or cleanup-incomplete prerequisite/artifact fails the gate. It rechecks the source binding after all commands and rejects a source change.

The report is local Phase 8 acceptance evidence. Hosted CI, current Codex review, human approval, merge, and deployment remain separate states. Phase 9 still owns deployed transport registration/qualification; Phase 10 still owns hosted schedule installation, protected secrets/destinations, and production recovery qualification. Local fixtures and small isolated recovery volumes do not establish production RPO/RTO.

The gate itself has deterministic rejection coverage:

```text
npm run test:phase8:gate
```

Never copy secrets, production records, dumps, Feedback text, CV contents, or credentials into published evidence. Review the sanitized report before sharing it.
