import { snapshotPhase4Database, assertPhase3OperationsContractPreserved } from "./phase4-migration-integrity.mjs";

/** Only called with the gate's owned disposable databases, never a deployed database. */
export async function proveIncidentSchema({ baselineUrl, currentUrl, currentClient, baselineFiles, currentFiles, baselineClient }) {
  for (const [client, files] of [[baselineClient, baselineFiles], [currentClient, currentFiles]]) {
    await client.query("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text not null)");
    for (const file of files) await client.query("insert into supabase_migrations.schema_migrations values ($1,$2)", [file.slice(0,14), file.slice(15,-4)]);
  }
  const baseline = await snapshotPhase4Database(baselineUrl);
  const verify = async () => assertPhase3OperationsContractPreserved(baseline, await snapshotPhase4Database(currentUrl));
  await verify();
  async function rejectMutation(mutate, restore) {
    try {
      await currentClient.query(`set role shipwithali_migration; ${mutate}; reset role`);
      let rejected = false;
      try { await verify(); } catch (error) {
        rejected = typeof error?.code === "string" && error.code.startsWith("PHASE3_OPERATIONS_CONTRACT_");
      }
      if (!rejected) throw new Error("GATE_INCIDENT_SCHEMA_MUTATION_NOT_REJECTED");
    } finally { await currentClient.query(`reset role; set role shipwithali_migration; ${restore}; reset role`); }
    await verify();
  }
  await rejectMutation("revoke update (environment) on operations.incidents from shipwithali_worker",
    "grant update (environment) on operations.incidents to shipwithali_worker");
  await rejectMutation("alter table operations.incidents drop constraint incidents_delivery_attempts_check",
    "alter table operations.incidents add constraint incidents_delivery_attempts_check check (delivery_attempts between 0 and 8)");
  return { preservation: "passed", missingWorkerGrantRejected: true, missingAttemptBoundRejected: true,
    schemaRestored: true, baselineMigrationCount: baselineFiles.length, currentMigrationCount: currentFiles.length };
}
