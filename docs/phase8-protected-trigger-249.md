# Protected due-work trigger handoff (#249)

`createProtectedDueWorkTrigger()` is an internal Web `Request` adapter around the
existing `getPhase7DueWorkWorkerService().runDueWork()` service. It is not a
Next.js Route Handler and does not add a public or Owner operation. The worker
continues to use the existing Operations queue, Portfolio scope, five
registered work types, durable retention barrier, and catch-up watermarks from
#248.

## Request and authority

The adapter accepts one `GET` request with no query string and no request body.
Authority comes only from a bounded `Authorization: Bearer <secret>` header
compared against the nonempty application setting `CRON_TRIGGER_SECRET` with a
constant-time digest comparison. Owner cookies are rejected. `User-Agent` and
`x-vercel-cron-schedule` are treated as untrusted metadata and never authorize
or select work. URL credentials and request input cannot choose a Portfolio,
worker identity, job type, purpose, target, code, SQL, or provider URL.

Vercel's protected cron setting is named `CRON_SECRET` and Vercel sends it in
the `Authorization: Bearer` header. Phase 9 must map the same configured value
to the application's `CRON_TRIGGER_SECRET`; Vercel does not infer that alias.
No secret value is part of this handoff. See [Managing Cron Jobs](https://vercel.com/docs/cron-jobs/manage-cron-jobs)
and [Cron Jobs](https://vercel.com/docs/cron-jobs). These official references
were rechecked on 2026-10-27.

Responses use fixed codes and `Cache-Control: no-store`. An authenticated run
that hits its budget returns HTTP 200 with `incomplete: true` and sanitized
counts. Adapter configuration or worker dependency failures return HTTP 503;
invalid requests return HTTP 400/413, unsupported methods return 405, and
invalid credentials return 401. Responses do not include job, Portfolio,
Owner, event, export, or lease IDs, exceptions, database coordinates, SQL,
payloads, credentials, or user-supplied text.

## Bounds and shutdown

The default host budget is 50 claims per phase, batches of at most 100 rows, at
most 15 catch-up periods, two Owner export assembly jobs, a 30-second invocation
window with 400 ms reserved for shutdown, and an observed RSS ceiling of 512
MiB. The runtime observation port supplies monotonic time and memory usage.
Budgets are validated against the existing 300-second Operations lease and the
existing service limits. Operators can lower the bounds for a host; they cannot
raise them beyond the registered Phase 7 limits or the lease fence.

An Owner claim cap of zero still runs bounded artifact cleanup after the durable
retention barrier, then leaves assembly jobs unclaimed and reports the Owner
backlog as incomplete. Shutdown is checked before cleanup and between cleanup
items, so a stop does not begin another deletion batch.

The portable CLI maps Node `SIGTERM` and `SIGINT` to the same cooperative stop
check. Scheduling, claims, Owner assembly handoff, and aggregation handoff stop
before starting another unit of work. The active module-owned batch is allowed
to finish and persist its checkpoint; queue transitions remain fenced so a
hard-killed process can be reclaimed without claiming that unprocessed work
completed. A hard host kill cannot guarantee that an active operation finishes.

The CLI starts its total monotonic budget before launching the TypeScript
compiler. Compilation runs as a cancellable child process; shutdown is forwarded
to the compiler. Before loading the application graph, the worker installs
SIGTERM/SIGINT latches and reports readiness over a private control pipe. The
launcher sends a bounded `GO` with only the remaining invocation budget; until
then the worker cannot initialize the database or run due work. A pending stop
receives `STOP` at readiness, while a post-admission stop is forwarded to the
worker. This makes zero-work incomplete totals truthful only before admission;
unexpected startup/import failures without a requested stop remain failures.
If startup leaves less than the minimum worker window, the CLI returns truthful
incomplete zero totals without initializing the database. Its exact owned
temporary build directory is removed after success, failure, signal, or budget
exhaustion.

Vercel currently documents only 500 ms of Function execution after `SIGTERM`.
Function duration and memory limits vary by plan/configuration, and longer
duration support has separate beta conditions. This Phase 8 repository does
not identify the deployed plan, route `maxDuration`, or memory setting. The
30-second budget is an application default, not evidence of a production host
limit; Phase 9/10 must inject a safe budget below the actual deployed cap and
retain the lease/reclaim behavior. See [Functions API Reference](https://vercel.com/docs/functions/functions-api-reference),
[Configuring Maximum Duration](https://vercel.com/docs/functions/configuring-functions/duration),
[Function Limits](https://vercel.com/docs/functions/limitations), and the
[30-minute duration announcement](https://vercel.com/changelog/vercel-functions-can-now-run-up-to-30-minutes).

The CLI is `npm run phase8:due-work`. It compiles the pinned repository source
into a fresh temporary directory, starts the same worker composition, and
removes only that directory when the process exits. It prints sanitized totals;
exit codes are 0 for complete, 2 for incomplete, and 1 for invalid configuration
or dependency failure. It requires five runtime settings: `DATABASE_URL`;
`PORTFOLIO_ID` and `OWNER_ID` as configured UUIDv7 identities; `NODE_ENV` set to
`development`, `test`, or `production`; and `APP_BASE_URL` as an absolute HTTP
or HTTPS URL. Production requires HTTPS except for the explicit loopback test
context. Request data cannot supply or override these settings, and this handoff
contains no configuration values.

The focused gate includes actual Linux OS-SIGTERM checks during compilation,
after worker spawn but before admission, and while the real CLI is held at a
PostgreSQL batch lock. The PR workflow runs this gate on Linux for pull requests
targeting `master` and stacked branches.

## Schedule handoff

`PHASE8_PROTECTED_DUE_WORK_HANDOFF` preserves the #248 daily and
missed/incomplete catch-up definitions and marks both as uninstalled. Its path
is a planned internal adapter path only. Phase 9 owns registering the deployed
handler; Phase 10 owns schedule installation, secret provisioning, target
selection, and hosted qualification. This ticket adds no `vercel.json` cron,
deployed route, or hosted schedule.
