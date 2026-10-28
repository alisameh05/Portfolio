# Phase 7 retention schedule handoff (#248)

The shared Operations job queue stores the durable policy-period identity and completion state for the five existing versioned handlers. A per-Portfolio Operations cursor keeps the required horizon, contiguous retention and aggregation progress, and last fully complete policy period outside the recent detail window. Retention and withdrawal handlers run before dependent daily aggregation handlers. An empty claim does not open the aggregate phase: leased, delayed, dead, or incomplete retention work keeps admission closed. Each scheduled item is isolated by Portfolio, handler type, and UTC due period. Batches resume with the same job identity and UTC checkpoint anchor.

The portable invocation is `createPhase7DueWorkService(dependencies).runDueWork({ workerId })` from `src/runtime/phase7-due-work.ts`. The host supplies the existing Operations persistence ports and module-owned Measurement and Feedback services. Treat a rejected result or `value.incomplete === true` as an incomplete pass; a successful invocation alone does not certify that the backlog or aggregate coverage is complete. Inspect `oldestOverduePeriod`, `failed`, and `staleLeases` from the returned result when reporting status.

The executable handoff definitions in `PHASE7_DUE_WORK_SCHEDULES` are:

| Name | Cadence | Time zone | Bound | State |
| --- | --- | --- | --- | --- |
| `phase7-policy-daily` | Daily | UTC | Up to 15 newly scheduled policy periods total and 1,000 job claims per phase | Uninstalled |
| `phase7-policy-catch-up` | On missed period or incomplete pass | UTC | Up to 15 newly scheduled policy periods total and 1,000 job claims per phase | Uninstalled |

Both definitions invoke the same `runDueWork` service. One invocation spends its 15-period budget first on the oldest due retention periods, then uses only the remaining budget for aggregation after the durable retention watermark reaches the required horizon. Existing overdue jobs remain claimable from the durable queue and their oldest period stays visible in the run result. Owner export cleanup, orphan reconciliation, expiry, and assembly are dispatched through the existing Portability and Operations service after the dependent retention barrier; the export service keeps its own eligibility checks. The service does not install a scheduler or expose an HTTP trigger.

The additive schedule columns preserve ordinary queue producers and consumers after application rollback. Rollback leaves the nullable schedule metadata and unique key in place so already-created job identities remain durable; a follow-up migration is the forward-fix path.

The required UTC horizon advances on every invocation, including while older aggregation is still catching up. If the contiguous retention completion watermark trails that horizon, the durable phase reopens retention. Aggregate enqueue, cursor advancement, and claim admission check the current completion watermark and all required retention keys; the phase label and an empty local claim are not admission evidence. Progress remains contiguous and catch-up stays bounded to 15 policy periods per invocation.

Job `attempt_count` is a consecutive failure/crash streak. Claiming increments it; a transient failure or expired lease keeps the existing fifth-attempt terminalization and incident behavior, while permanent failures still terminalize immediately. When a handler returns successfully after committing a resumable cursor, releasing that lease resets the streak to zero. This lets an arbitrarily long sequence of successful bounded pages finish while still terminalizing repeated failures or crashes before the next successful checkpoint.

Owner assembly claims at most ten exports per pass. A full ten-job claim reports `incompleteBacklog` and propagates to `incompleteOwnerExports`, so the next invocation resumes remaining exports. The #248 object-effect fixture uses the production Storage adapter against an isolated loopback HTTP service; it does not establish hosted Supabase Storage or RLS behavior.
