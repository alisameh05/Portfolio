// Scratch updater: appends the #238 migration to operations-transformations.json
// using the exact catalog rows captured by the probe (byte-exact withCheck).
import { readFileSync, writeFileSync } from "node:fs";
const root = process.cwd();
const expectPath = join(root, "scripts/validation-contracts/operations-transformations.json");
const probePath = join(root, ".scratch/transformation-238.json");
import { join } from "node:path";

const expected = JSON.parse(readFileSync(expectPath, "utf8"));
const probe = JSON.parse(readFileSync(probePath, "utf8"));
if (expected.source.migrations[probe.migration]) throw new Error("ALREADY_PRESENT");
expected.source.migrations[probe.migration] = probe.checksum;
if (expected.transformations.some(t => t.migration === probe.migration)) throw new Error("ALREADY_PRESENT");

const [policy] = probe.policies;
expected.transformations.push({
  migration: probe.migration,
  operations: [
    {
      category: "policies",
      identity: `operations.jobs.${policy.name}`,
      before: null,
      after: policy,
    },
  ],
  stage: "expand",
  priorWriterCompatible: true,
  capability: "portability.owner_export_requests",
});
writeFileSync(expectPath, JSON.stringify(expected, null, 2) + "\n");
console.log("UPDATED", Object.keys(expected.source.migrations).length, "migration checksums,", expected.transformations.length, "transformations");
