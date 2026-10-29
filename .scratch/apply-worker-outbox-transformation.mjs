// Scratch updater (not committed): folds the captured worker outbox append
// rows into the reviewed #238 operations transformation. Requires the probe
// output at .scratch/transformation-238-worker-outbox.json.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { migrationSha256 } from "../scripts/migration-checksum.mjs";

const root = process.cwd();
const expectPath = join(root, "scripts/validation-contracts/operations-transformations.json");
const probePath = join(root, ".scratch/transformation-238-worker-outbox.json");
const migrationPath = join(root, "supabase/migrations/20261023090000_reserve_owner_export_requests.sql");

const expected = JSON.parse(readFileSync(expectPath, "utf8"));
const probe = JSON.parse(readFileSync(probePath, "utf8"));
const actualChecksum = migrationSha256(readFileSync(migrationPath, "utf8"));
if (probe.checksum !== actualChecksum) throw new Error("PROBE_CHECKSUM_MISMATCH");

const entry = expected.transformations.find(t => t.migration === probe.migration);
if (!entry) throw new Error("TRANSFORMATION_ENTRY_MISSING");
if (probe.registryChecksum !== undefined && expected.source.migrations[probe.migration] === probe.registryChecksum) {
  // Already folded; keep policies/grants idempotent below.
}
const outboxPolicy = probe.outboxPolicy;
const outboxGrant = probe.outboxGrant;
const policyIdentity = `operations.outbox_events.${outboxPolicy.name}`;
const grantIdentity = `operations.outbox_events.${outboxGrant.objectType}.${outboxGrant.grantee}:${outboxGrant.grantor}:${outboxGrant.privilege}`;
const freshOps = [
  ...entry.operations.filter(op =>
    !(op.category === "policies" && op.identity === policyIdentity) &&
    !(op.category === "grants" && op.identity === grantIdentity)),
  entry.operations.find(op => op.category === "policies" && op.identity === "operations.jobs.owner_export_jobs_application_insert"),
  {
    category: "policies",
    identity: policyIdentity,
    before: null,
    after: outboxPolicy,
  },
  {
    category: "grants",
    identity: grantIdentity,
    before: null,
    after: outboxGrant,
  },
];
entry.operations = freshOps;
expected.source.migrations[probe.migration] = probe.checksum;
writeFileSync(expectPath, JSON.stringify(expected, null, 2) + "\n");
console.log("UPDATED", probe.migration, "checksum ->", probe.checksum);
console.log("OPERATIONS", entry.operations.map(op => op.identity));
