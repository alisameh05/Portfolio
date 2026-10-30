# Phase 8 relational backup operator guide

## Ownership and limits

This job creates a logical relational copy for the declared application, operations,
Auth metadata, and Storage metadata scope. It does not copy Storage object bytes,
serve as an Owner export, or perform a production restore. Storage bytes and eligible
Owner export packages require the separate object-backup capability. Supabase
database dumps contain Storage metadata only; object bytes are separate. Supabase
does not include custom-role passwords in daily backups, so after an isolated restore
reset custom-role credentials from protected secrets.

Phase 8 supplies an executable job and schedule definition. Phase 10 must provision
an independently administered destination, install the nightly schedule, provision
the protected secrets, and qualify a live recovery rehearsal. The endpoint must
support durable authenticated PUT, GET, and DELETE for opaque object keys and must
not share the primary database provider's failure domain.

## Required protected configuration

Configure these values only in the protected backup job environment:

- DATABASE_DIRECT_URL: direct PostgreSQL connection for the backup-only role.
  Never put it in app runtime configuration.
- BACKUP_ENCRYPTION_KEY: base64 encoding of a random 32-byte AES-256 key,
  retrievable through a recovery process independent of the primary provider.
- BACKUP_KEY_VERSION: stable non-secret key version label.
- BACKUP_DESTINATION_NAME, BACKUP_DESTINATION_URL, and
  BACKUP_DESTINATION_TOKEN: isolated encrypted-copy service configuration.
- BACKUP_RETENTION_HOURS: explicitly configured lifetime from 24 through 8760.
- BACKUP_SOURCE_ALLOWLIST: exact permitted host/database identities in
  host/database form; wildcard entries are rejected.
- BACKUP_ENVIRONMENT: explicit local, test, staging, or production label.
- PG_DUMP_BIN and PG_DUMPALL_BIN: pinned client tool paths whose major versions
  match the source server.
- PG_DUMPALL_BIN: pinned pg_dumpall executable path.

Do not use the application pooled connection. Do not put these values in source,
CI artifacts, command arguments, logs, screenshots, or evidence. The worker role
must not have DDL or backup privileges. The backup role must not be used for restore
targets. A separately controlled restore identity is required.

## Nightly execution

The versioned schedule definition is
docs/operations/phase8-relational-backup-nightly.json. An operator can run the
focused command after protected configuration is installed:

~~~text
npm run phase8:focus:relational-backup
~~~

The job must fail closed on missing configuration, an unapproved source identity,
unsupported tools, an incomplete dump, a destination failure, read-back mismatch,
wrong key, or incompatible envelope. It records the database source watermark
separately from job start, upload completion, and verification time. A copy is
usable only after destination read-back and authenticated decryption succeed.

## Recovery handoff

1. Record the incident time and select the newest usable catalog entry whose
   source watermark meets the required recovery point.
2. Retrieve the key version through the independent key-recovery procedure.
   A key unavailable outside the failed provider is a recovery blocker.
3. Retrieve and authenticate the encrypted object. Never write plaintext to a
   shared or persistent directory.
   The portability-operations backup service exposes `recover(copy, key)` for this
   path. It checks the catalog against the committed ledger row, authenticates the
   envelope, then validates the SWDB manifest, role SQL, database archive, and
   every included migration digest before returning the components. Reject any
   payload error; do not attempt a partial restore.
4. Restore only into a newly created, allowlisted disposable target using separate
   restore credentials. Verify the target identity before executing any restore
   command. Never point restore tooling at the source or production target.
5. Restore database roles without stored passwords, then reset managed/custom
   credentials from the protected target configuration. Reconcile current privacy
   deletion state before any restored data is exposed.
6. Verify database constraints, grants, RLS, migration state, projections, and
   application readiness. Rebuild derived projections through their owning modules.
7. Capture sanitized evidence, then clean up only the owned disposable target and
   its temporary plaintext. Confirm cleanup on both success and failure.

This ticket does not claim that a checksum or successful backup run is a completed
restore rehearsal. Record actual restored bytes, elapsed end-to-end RTO, and the
selected source watermark in the later recovery qualification.

## Safe evidence

Publish only run ID, source watermark, tool versions, scope names, counts, byte
totals, state, duration, safe failure code, and owned-resource cleanup outcome.
Never publish database names, hostnames, object URLs/keys, role names from live
systems, SQL, row contents, passwords, tokens, encryption keys, or exception text.
