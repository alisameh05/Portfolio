# Phase 8 incident delivery and core readiness (#252)

## Inventory and operator action

`phase8-dashboard.json` is the metric, alert, unknown-state, source, and operator inventory. Its `alerts` list links every active trigger to an owner and safe remediation pointer. Production destinations, monitoring installation, credentials, and dashboard deployment remain Phase 10 handoffs.

Reproduce the isolated PostgreSQL and restricted-role qualification from PowerShell:

```powershell
$env:TEMP = 'C:\t'
$env:TMP = 'C:\t'
$env:PHASE8_OPERATIONS_EVIDENCE_PATH = 'evidence/phase8-actionable-incidents-252.json'
npm run phase8:focus:incidents
```

The runner creates and removes its owned temporary cluster on both success and failure and writes named tests and cleanup results to that artifact. It contacts no production service or notification recipient.

The incident lifecycle is owned by `operations.incidents`. A stable policy key and a hash of the internal scope deduplicate repeated observations without placing the scope identifier in the delivery payload. The row retains first/last observation time, occurrence count, severity, owning role, remediation pointer, lifecycle state, safe delivery code, and bounded attempt state. Recovery is recorded once.

`OPERATIONS_ENVIRONMENT` accepts only `local`, `test`, `staging`, `production`, or `unknown` (the default). The incident pass includes this label in its internal deduplication scope and durable safe delivery payload. Set it explicitly when invoking `npm run operations:incidents -- --portfolio-id <Portfolio UUID>`. That command requires a loopback HTTP `OPERATIONS_INCIDENT_SINK_URL`; redirects are rejected and no destination is installed. Sink idempotency keys remain stable across retry claims within one incident episode. Existing UUIDv4 terminal-work incidents remain deliverable alongside new UUIDv7 observations.

For an existing terminal job or outbox incident, append `--recover-job-id <Job UUID>` or `--recover-outbox-id <DomainEvent UUID>` to that command. This distinct system recovery purpose verifies completed owning work in PostgreSQL, or completed replacement work linked by the existing redrive audit. Repeated recovery returns false without rewriting the recovery timestamp. Redrive admission alone and incomplete replacement work cannot resolve an incident. This path never reruns work or sends a notification; an unrecovered terminal row remains open.

On Windows, select the installed PostgreSQL 17 or 18 binary directory using `PHASE7_POSTGRES_BIN` if it is absent from `PATH`; this host uses `C:/Program Files/PostgreSQL/18/bin`. The focused gate validates the historical-to-current operations catalog and exact generated types, and proves rejection and restoration of a removed worker grant and attempt-bound constraint. Its Scenario 15 database publishes a Project, assigns taxonomy, accepts and activates a CV, approves Feedback, and then exercises optional work and Storage/notification failures before rereading those owning application services. Runtime readiness observes real database failure separately from identity/configuration failure. The gate removes its owned cluster on either result.

`createIncidentLifecycleService()` uses only its injected `IncidentDeliverySink`. The sink receives fixed safe fields: code, severity, owner, remediation pointer, timestamps, and occurrence count. It receives no source identifier, scope key, provider payload, exception, URL, credential, database coordinate, or stack. Configure only an isolated test sink for local qualification. No live delivery destination is provisioned by this phase.

One delivery claim is acquired immediately before each isolated sink call, using `FOR UPDATE SKIP LOCKED` and database-clock lease fencing. The whole observation/delivery pass has a ten-second deadline and stops before further work after cancellation. Delivery admits at most 25 claims with a two-second sink deadline. Database calls have bounded lock and statement deadlines, including summary collection; in-flight transactions finish or roll back during resource closure. Attempts are capped at eight with database-relative delays of 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours, 6 hours, and 12 hours, independent of the worker's observation clock. A terminal sink failure updates the same durable incident; it does not create a second alert. A process crash leaves a five-minute claim fence; after the final failed attempt, the row is immediately exhausted. Interrupted passes exit nonzero and report incomplete counts as unknown. `incidentShutdownProof.mode` distinguishes Windows cancellation from real Linux OS SIGTERM, which the hosted focused gate requires.

## Threshold and readiness rules

Core rules use strict greater-than comparisons: eligible outbox age above 900 seconds, relational source watermark above 24 hours, object source watermark above 168 hours, full rehearsal duration above 28,800,000 milliseconds, and measured capacity above 70 percent. Dead queue work, publication failures, retention/privacy failures, and failed rehearsals are actionable at any positive count. Completed/future-delayed jobs are excluded by the existing bounded summary query. Unknown or uninstalled sources never create an incident. Configured sustained rules require an explicit unit, bounded window, minimum sample count, owner, safe code, and runbook pointer.

A capped positive failure count still proves a failure. Incidents preserve `lowerBound` alongside that measured sample count; it is not an exact total. Capped or incomplete zero cannot certify recovery. Sustained rules require distinct valid UTC samples spanning the complete current window with fresh boundary samples; partial, stale, duplicate and future samples remain unknown.

## Operator runbook

Use the pointer printed in the restricted incident record to select one of these procedures. First confirm the incident is still open and compare its timestamps with the bounded Operations summary. Do not copy incident payloads into application logs or public dashboards.

| Remediation pointer | Owner action |
| --- | --- |
| `operations/general` | Inspect the restricted safe code and owning job or outbox state, then follow its procedure below. This fallback serves historical incidents without measured threshold metadata; missing measurements remain absent. |
| `operations/outbox` | Inspect the restricted outbox counts and oldest eligible age. Check the owning consumer's availability and safe error category; retry only through its existing bounded worker. |
| `operations/jobs` | Inspect dead, retrying, and expired-lease counts. Check the job type's existing recovery procedure, then use its approved retry or redrive path; do not edit queue rows directly. |
| `content/publication` | Check the publication job and public route through the Content application read. Repair through the normal Owner review and publish flow; do not force a route or alter a committed revision. |
| `privacy/retention` | Check the bounded retention cursor and last-complete period. Resume the owning retention worker from its durable cursor; never replay by broad table update. |
| `privacy/withdrawal` | Check the withdrawal cleanup job through its restricted status. Resume the existing cleanup worker and confirm its durable completion record before treating the signal as recovered. |
| `operations/owner-exports` | Inspect only restricted export status, safe error code, and integrity result. Retry by creating a fresh Owner export request when required; do not reuse a failed artifact. |
| `recovery/relational-backup` | The producer is not installed. Record the capability as unknown and follow the separately approved database backup procedure; do not infer a successful backup from missing data. |
| `recovery/object-backup` | Check the restricted object-backup ledger, source watermark, object/export counts, and safe failure code. A copy is usable only after encrypted destination read-back and integrity verification; if no current usable copy exists, report the metric unknown and follow the object-backup runbook. |
| `recovery/rehearsal` | The rehearsal producer is not installed. Record the capability as unknown; do not run a restore or report recovery success from this observer. |
| `operations/capacity` | Compare the restricted measured percentage with its declared threshold and window. Check the bounded pool and queue summary, then use the owning database or worker capacity procedure. |
| `operations/burn-rate` | Check the current complete measurement window, sample count, and owning producer. Treat missing, stale, duplicate, future, or capped samples as unknown and restore the producer before evaluating the rate. |
| `identity/auth` | Check the bounded identity dependency status and runtime readiness. Restore the configured identity service using its operations procedure; never inspect or log tokens or provider response bodies. |
| `operations/integration` | Check the bounded downstream dependency state and safe failure category. Restore the owning integration using its module procedure; the observer does not retry or send a notification. |
| `operations/downstream-gate` | Check the readiness summary for the required dependency and its safe status. Restore that dependency before resuming traffic; do not override the readiness result. |

After repair, run the restricted bounded read again and verify that the owning source reports a fresh healthy value before resolving the incident. The backup and recovery procedures above remain handoffs until #253–#255 install their real producers.

Database, identity, and required configuration remain mandatory readiness dependencies. Optional export/object storage, alert delivery, Measurement, and backup/recovery capabilities are inspected as separate signals; their failures do not invalidate a successful last-valid public query. Backup and rehearsal producers remain unknown until their owning tickets provide real observations.

Standard application assembly validates `SUPABASE_URL`, `SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`, and `OWNER_GITHUB_SUBJECTS`, and checks the configured Auth API's read-only health endpoint with a 500 ms bound. Hosted gateways may require the existing `SUPABASE_ANON_KEY` public capability. The probe retains neither credentials nor response bodies and rejects redirects. Worker assembly validates its system scope and database dependency. Custom composition factories supply an explicit identity readiness port; database-only predecessor tests inject an isolated identity dependency and do not qualify Auth. The focused standard-assembly test separately exercises the actual health adapter against an isolated HTTP service. See the [Auth health endpoint](https://supabase.com/docs/reference/self-hosting-auth/get-a-user).

Probes are read-only bounded database queries or existing module observations. The `npm run phase8:due-work` runner retains #249's stop-before-next-claim behavior and active-batch checkpoint boundary. Shutdown disables readiness before drain and closes resources after the bounded drain window. No probe performs backup, restore, replay, notification, or production mutation.

## Recovery and later phases

Resolve an incident only after the owning capability reports recovery. The store writes `resolved_at` and `recovery_recorded_at` once; duplicate recovery observations are idempotent. An exhausted delivery remains inspectable under the restricted system `operations.observability.read` purpose.

Phase 9 still owns deployed handler/route registration and transport qualification. Phase 10 still owns installed hosted schedules, credentials, monitoring destinations, deployment, and production recovery qualification. The backup watermark and rehearsal dashboard rows intentionally remain `unknown` until their real producers are installed and verified.
