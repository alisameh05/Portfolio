# Phase 8 object backup operator guide

## Scope and ownership

The weekly job reads accepted Media originals and variants through the Media-owned
private object reader, captures the currently designated accepted CV-to-Media
binding through the CV-owned export snapshot, and copies ready, unexpired Owner-export artifacts that
remain unrevoked and undeleted. The encrypted recovery catalog records object IDs,
Media/CV/export maps, byte counts, lengths, hashes, source and relational inventory
watermarks, exclusions, and format/key versions. Each source object is stored as
its own authenticated encrypted shard, and the private recovery catalog is stored
in an encrypted manifest. The PostgreSQL ledger stores only restricted catalog
and ciphertext metadata; private identities and object maps stay encrypted.

The job uses a separate direct worker connection for purpose-bound source reads and
a backup-role connection for the protected catalog. Before reading objects, the job
compares its private scope configuration to the protected database owner-scope view;
an omitted, extra, or duplicate Portfolio/Owner pair fails the run. Phase 10
installs the hosted weekly schedule, administers the independent destination and
protected secrets, and qualifies the production recovery process. `installed: false`
in the schedule definition is intentional until that handoff.

## Protected configuration

Configure these only in the backup job's protected environment:

- `WORKER_DATABASE_DIRECT_URL`: direct connection for the restricted worker role.
- `DATABASE_DIRECT_URL`: direct connection for the backup role that can write the
  protected object-backup catalog and incidents.
- `BACKUP_SOURCE_ALLOWLIST`: exact `host/database` identities for both database
  connections. Wildcards are rejected.
- `BACKUP_OWNER_SCOPES`: JSON array of `{ "portfolioId": "...", "ownerId": "..." }`
  entries exactly matching the protected `operations.object_backup_owner_scopes`
  inventory. Keep this private configuration out of logs and evidence.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: private server-side object reads.
- `BACKUP_DESTINATION_NAME`, `BACKUP_DESTINATION_URL`, and
  `BACKUP_DESTINATION_TOKEN`: authenticated PUT/GET/DELETE destination in a failure
  domain independent of both the database and primary object store.
- `BACKUP_ENCRYPTION_KEY`: base64 encoding of a random 32-byte AES-256 key.
  `BACKUP_KEY_VERSION` is its non-secret stable identifier.
- `BACKUP_RETENTION_HOURS`: explicit recovery-copy lifetime from 24 through 8760.
- `BACKUP_ENVIRONMENT`: `local`, `test`, `staging`, or `production`.

Keep encryption keys in a key-recovery system administered independently from the
primary provider and destination. A destination copy without its key version's
independently retrievable key is not recoverable. Never include credentials, keys,
scope JSON, object keys, or provider URLs in logs, command arguments, or evidence.

## Weekly execution

The versioned schedule definition is
`docs/operations/phase8-object-backup-weekly.json`. After protected configuration
is installed, run:

~~~text
npm run phase8:focus:object-backup
~~~

Only one run per destination can execute at a time. Each attempt uses a fresh
immutable ID. The copy becomes usable only after every shard and the catalog
manifest have been read back, ciphertext digests match, and authenticated
decryption verifies each object's length and digest. Expired source exports are excluded;
source eligibility is rechecked after each read and before catalog completion.
Failed attempts are marked failed before best-effort deletion. The previous usable
catalog remains selected unless the new copy passes all verification.
If a worker is terminated before it can clean its in-flight upload, the next run
marks uploads older than 24 hours failed before deleting the manifest and every
shard recorded for that attempt.

The sanitized success record includes only the copy ID, watermarks, counts, byte
totals, key version, retention, state, and cleanup counts. It contains no object
identity, owner scope, URL, key, or plaintext bytes.

## Compatible recovery-set selection

Use `listUsableCopies()` to inspect unexpired verified object catalogs and select a
relational backup by its committed source watermark. After restoring the chosen
relational copy into an isolated target, read the required object IDs from that
restored relational state. Call `selectCompatibleRecoverySet()` with those IDs,
the selected relational source watermark, the candidate object catalog, and either
`full` or the explicitly approved `declared-loss-window` policy.

- Full integrity passes only when every required object reference occurs in the
  encrypted object catalog. Any unexplained missing object rejects the set.
- A declared Media-loss set reports the missing object IDs and the fixed seven-day
  loss window. It is eligible only when the relational watermark is no more than
  seven days newer than the object watermark. A newer object watermark is safe if
  all relational references are present.
- An incomplete catalog, bad key, digest mismatch, missing object, or expired copy
  blocks recovery. Do not expose restored data while the object set is incomplete.
- Reconcile current privacy deletions and export expiry/revocation state in the
  isolated target before access is enabled. A successful copy check is not a
  restore rehearsal or production recovery qualification.

Retrieve the encryption key through the independent key-recovery process. Use
`recoverTo(copy, key, writeObject)` to authenticate and deliver one object at a
time to an isolated, allowlisted target without collecting the full recovery set
in memory. `recover(copy, key)` remains available for small inventories and
returns all plaintext bytes to its caller. Remove temporary plaintext and verify
cleanup on success and failure.

## Focused reproducible checks

~~~text
npm run test:phase8:object-backup
node --test tests/tooling/phase-contract-registry.test.mjs
~~~

The focused command runs application tests plus disposable LocalStack S3 and
PostgreSQL 17 checks using the pinned `public.ecr.aws/localstack/localstack:4.5.0`
and `postgres:17-alpine` images. The S3 check stores encrypted Media, accepted CV
variant, and export bytes through the HTTP destination adapter, then independently
reads and decrypts the manifest and shards. It injects same-length corruption, a
missing shard, and a denied mid-copy upload, verifies compatible-set rejection
and last-good preservation, and removes its container in `finally`. The PostgreSQL
check applies the migration to an isolated database, verifies the backup role can
read only the scope view, and exercises begin/finalize/usable transitions through
the restricted role. Both emit sanitized JSON evidence and remove owned containers
in `finally`. The deterministic `backs up a 2 GiB logical inventory while clearing
each 50 MiB source buffer before reading the next` case proves per-object plaintext
is cleared before advancing. Docker is required. These checks do not qualify the production
provider or schedule; those remain Phase 10 evidence.
