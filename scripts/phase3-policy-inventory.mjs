import { PHASE_DECLARED_ADDITIVE_MIGRATIONS } from "./phase-contract-registry.mjs";

export function assertCurrentOperationsPolicies(rows) {
  const expectedPolicies = [
    ...PHASE_DECLARED_ADDITIVE_MIGRATIONS.filter((item) => item.ticket >= 253).flatMap((item) => item.operationsAdditions ?? [])
      .filter((entry) => entry.category === "policies" && entry.expected.schema === "operations")
      .map((entry) => [entry.expected.tableName, entry.expected.name, entry.expected.command, entry.expected.roles.slice(1, -1)]),
    ["idempotency_records", "idempotency_application_insert_policy", "INSERT", "shipwithali_application"],
    ["idempotency_records", "idempotency_application_select_policy", "SELECT", "shipwithali_application"],
    ["idempotency_records", "idempotency_application_update_policy", "UPDATE", "shipwithali_application"],
    ["idempotency_records", "operations_backup_policy_idempotency", "SELECT", "shipwithali_backup"],
    ["jobs", "jobs_worker_insert_policy", "INSERT", "shipwithali_worker"],
    ["jobs", "jobs_worker_select_policy", "SELECT", "shipwithali_worker"],
    ["jobs", "jobs_worker_update_policy", "UPDATE", "shipwithali_worker"],
    ["jobs", "measurement_event_jobs_application_insert", "INSERT", "shipwithali_application"],
    ["jobs", "owner_export_jobs_application_insert", "INSERT", "shipwithali_application"],
    ["jobs", "operations_backup_policy_jobs", "SELECT", "shipwithali_backup"],
    ["incidents", "incidents_worker_insert_policy", "INSERT", "shipwithali_worker"],
    ["incidents", "incidents_worker_select_policy", "SELECT", "shipwithali_worker"],
    ["incidents", "incidents_worker_update_policy", "UPDATE", "shipwithali_worker"],
    ["incidents", "operations_backup_policy_incidents", "SELECT", "shipwithali_backup"],
    ["job_redrive_audit", "job_redrive_audit_worker_insert_policy", "INSERT", "shipwithali_worker"],
    ["job_redrive_audit", "job_redrive_audit_worker_select_policy", "SELECT", "shipwithali_worker"],
    ["job_redrive_audit", "operations_backup_policy_job_redrive_audit", "SELECT", "shipwithali_backup"],
    ["outbox_events", "operations_backup_policy_outbox", "SELECT", "shipwithali_backup"],
    ["outbox_events", "outbox_application_insert_policy", "INSERT", "shipwithali_application"],
    ["outbox_events", "outbox_worker_select_policy", "SELECT", "shipwithali_worker"],
    ["outbox_events", "outbox_worker_update_policy", "UPDATE", "shipwithali_worker"],
    ["outbox_events", "owner_export_produced_outbox_worker_insert", "INSERT", "shipwithali_worker"],
    ["phase7_schedule_progress", "operations_backup_policy_phase7_schedule_progress", "SELECT", "shipwithali_backup"],
    ["phase7_schedule_progress", "phase7_schedule_progress_worker_insert", "INSERT", "shipwithali_worker"],
    ["phase7_schedule_progress", "phase7_schedule_progress_worker_select", "SELECT", "shipwithali_worker"],
    ["phase7_schedule_progress", "phase7_schedule_progress_worker_update", "UPDATE", "shipwithali_worker"],
  ];
  const policyMatches = expectedPolicies.every(([table, policy, command, role]) =>
    rows.some(
      (row) =>
        row.tablename === table &&
        row.policyname === policy &&
        row.cmd === command &&
        String(row.roles) === `{${role}}`,
    ),
  );
  if (rows.length !== expectedPolicies.length || !policyMatches) {
    throw new Error("RLS_POLICIES_INCOMPLETE");
  }
}
