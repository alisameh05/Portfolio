# Phase 8 isolated recovery rehearsal (#255)

## Scope and qualification limits

This runbook rehearses encrypted relational and object copies into a newly
created disposable PostgreSQL database and separate private LocalStack S3
backup and restore buckets. The focused integration fixture uses synthetic domain records, generated encryption keys,
independent source/current-ledger databases, and random target identities. It
does not restore or mutate the source, switch a domain or OAuth target, start a
production worker, send live notifications, or qualify production RPO/RTO.
Phase 9 owns deployed handler registration and transport qualification. Phase
10 owns hosted schedule installation and production qualification.

The executable orchestration contract is
`runRecoveryRehearsal()` in
`src/modules/portability-operations/application/recovery-rehearsal.ts`.
Its ports must be composed with the existing relational/object backup services,
isolated PostgreSQL and object storage, the protected current deletion ledger,
and owning-module domain verification. The coordinator rejects missing
watermarks/volumes and incomplete domain checks; it never converts absent
evidence to zero. Run the focused checks with:

~~~text
npm run test:phase8:recovery
~~~

The focused suite contains the named integration case `#255 real isolated
PostgreSQL recovery > restores encrypted relational and object copies under
quarantine, reconciles current privacy/effect state, verifies domain/RLS
readiness, and cleans owned targets`, plus orchestration, target-guard,
incident and corrupt-object tests. Its synthetic functional run restores an encrypted database, reads
required object IDs from that restored database, selects a compatible encrypted
object catalog, restores and hashes the mapped bytes, reconciles a live
post-snapshot privacy/retention ledger, suppresses queued work, and verifies
domain facts and restricted-role queries before release. The emitted evidence
explicitly marks the fixture small. It is not production timing evidence; do
not use it for the <1 GiB relational or <10 GiB Media planning envelope. Record
actual volumes and use measured throughput to plan a representative-scale
rehearsal.

## Roles and protected access

- **Incident lead:** declares the reference time and RPO policy and records
  discovery, access and manual-pause intervals.
- **Backup operator:** independently retrieves the catalog and key version;
  the key recovery system must be independent of the failed source provider.
- **Restore operator:** controls fresh disposable database/object targets and
  separate restore credentials. The backup identity is never a restore identity.
- **Verifier:** checks the sanitized report and keeps release blocked until the
  complete rehearsal passes.

Keep direct URLs, tokens, key bytes, object keys, target identities and owner
scope configuration in the protected operator environment. Do not place secrets
in shell arguments, source, logs, report files or issue/PR evidence. Pin the
PostgreSQL client major to the source server (17 or 18) and use the locked Node
24.21.0/npm 11.19.0 toolchain.

## Select and guard the recovery set

1. Record incident/rehearsal reference time before discovery. Record discovery
   and access elapsed time separately, then record `startedAt` when the selected
   copies and restore access are ready. The measured RTO adds that pre-start
   interval to wall-clock restore time through verified readiness.
2. Select the newest usable relational catalog whose source watermark meets the
   24-hour target. Retrieve its key version from the independent key-recovery
   system. Select the pre-created disposable target by exact normalized
   database and object-target identities; stop if either identity is protected
   or absent from its allowlist. Use separate restore credentials.
3. Retrieve and authenticate the relational envelope, manifest, payload and
   migration digests. Restore only to the allowlisted database while it remains
   quarantined. A corrupt, incompatible or undecryptable copy stops the run.
4. Read required object IDs from the restored relational state. Select a
   compatible unexpired object catalog for the restored watermark. Require full
   integrity unless a named incident decision explicitly approves the declared
   seven-day Media loss window. Independently retrieve, decrypt and verify every
   selected object before writing its mapped bytes to the fresh object target.
5. Verify ownership of both disposable targets before enabling cleanup. Record
   only safe target classes and owned resource counts in the result.

## Restore under quarantine

1. Keep application credentials disabled, deny query access, stop schedules,
   and block worker startup. Do not change DNS, OAuth callbacks or live
   destinations.
2. Authenticate and validate the selected relational envelope, SWDB manifest,
   database archive and migration digests. Missing/wrong keys, corrupt
   envelopes or incompatible versions fail before restore. Never attempt a
   partial restore.
3. After restoring the database under quarantine, select the compatible object
   set from restored required IDs. Missing bytes, a wrong key, corrupt envelope,
   or digest mismatch fails before restore release. Restore the database and
   mapped object bytes using only the isolated target
   credentials. Keep plaintext temporary files in an owned private temporary
   directory; clear them and verify cleanup on every path.
4. Read the current protected Owner-export invalidation ledger after restore.
   Apply current revocations/deletions and eligible retention state before
   projection rebuild or queries. Reset Auth/custom role credentials from the
   target's protected secret store and reconcile grants/RLS.
5. Reconcile old jobs, outbox rows, leases and effect-deduplication records.
   Suppress or mark ambiguous external effects for operator review. Never
   replay Visitor actions, exports, notifications, or any outbound effect
   automatically. Leave schedules disabled and unresolved work fenced.
6. Rebuild projections through their owning modules while still quarantined.
   Compare IDs, counts, relationships and hashes, then check both locales,
   publication/lifecycle, routes/discovery ties, taxonomy, Media accessibility,
   Current/old CV, private Moderation, privacy-safe Analytics, and
   configuration through approved interfaces.
7. Run the restricted-role allow/deny matrix, verify restored grants, execute
   readiness and safe last-valid queries. Release quarantine only after every
   check succeeds. Any failed, skipped, incomplete or over-target result emits
   one deduplicated safe incident and an explicit downstream release blocker.

## Measurement and evidence

Record each stage's start/end and manual pauses: discover/access, key recovery,
download/decrypt, database restore, object restore, deletion/credential/effect
reconciliation, projection rebuild, domain verification, RLS/readiness, and
cleanup. `startedAt` to verified readiness uses wall time and includes manual
pauses; add the separately measured discovery/access interval exactly once.
Compute RPO separately as reference time minus relational source watermark and
reference time minus object source watermark (the Media target is seven days).
The relational target is 24 hours and the full RTO target is eight hours.

Capture only run ID, safe copy IDs or their sanitized digests, source
watermarks, schema/relation/migration/object counts, restored byte totals,
stage durations, RPO/RTO, tool versions, fixed safe failure code, incident
recording outcome, release-blocker state, and cleanup counts/outcome. Omit
hostnames, database names, URLs, credentials, keys, SQL, object keys, row data,
Feedback text, exception text and private scope maps.

For a representative-scale rehearsal, record the observed relational encrypted
bytes and Media/export plaintext bytes, then run against isolated copies near
the planning envelope. Compare restore-stage elapsed time and complete RTO to
the small run; estimate required sustained throughput as observed bytes divided
by the measured restore-stage seconds. Treat the small run as a functional
check only and keep production qualification open until a representative copy
passes the full eight-hour RTO.

## Resume, abort, cleanup and escalation

- **Resume:** only resume from a recorded stage if the adapter proves its
  output digest, selected copy identity, target ownership and quarantine state
  still match. Otherwise clean the owned target and start with a newly created
  target. Never infer completion from a missing marker.
- **Abort:** stop the worker, keep access and schedules disabled, and preserve
  the release blocker. Terminate only resources named in the owned-resource
  record. Do not cancel or alter source backups.
- **Cleanup:** remove the disposable database, object namespace and temporary
  plaintext on success and failure. Verify each owned resource is gone; an
  unacknowledged cleanup is itself a safe incident and blocks release.
- **Escalate:** missing access/key, protected-target collision, incompatible
  copy, deletion-ledger uncertainty, unresolved external effect, failed
  readiness, over-target timing or incomplete cleanup goes to the incident
  lead. Keep the target quarantined and require an explicit forward-fix or
  repeat rehearsal decision.

## Schedule and downstream handoff

The Phase 8 schedule definitions are:

- `docs/operations/phase8-relational-backup-nightly.json` — nightly encrypted
  relational backup.
- `docs/operations/phase8-object-backup-weekly.json` — weekly encrypted Media
  and Owner-export object backup.
- `docs/operations/phase8-recovery-rehearsal-monthly.json` — monthly synthetic
  isolated functional rehearsal.

All definitions have `installed: false`. Phase 9 registers deployed handlers
and qualifies their transport. Phase 10 installs protected hosted schedules,
provisions production secrets/destinations and qualifies real production RPO and
RTO. This change does not create production credentials, hosted schedules or
deployments.

## Executed evidence map

The focused `tests/phase8/recovery-rehearsal.test.ts` cases exercise target
identity/credential rejection, target-before-decrypt ordering, corrupt encrypted
object blocking, exact discovery/manual RTO arithmetic, sanitized incidents and
release blocking. The named PostgreSQL integration case exercises encrypted
relational restore, post-restore required-object selection, encrypted object
recovery, post-snapshot deletion/retention reconciliation, effect suppression,
domain fixture checks, restricted-role allow/deny and owned-target cleanup. The
JSON result states that the fixture does not qualify production volume or RTO.
