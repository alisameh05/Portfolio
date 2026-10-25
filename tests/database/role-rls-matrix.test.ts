import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declaredCapabilities } from "../../scripts/phase-contract-registry.mjs";

const DATABASE_URL = process.env["PHASE3_DATABASE_URL"];
if (process.env["PHASE3_REQUIRE_DATABASE"] === "1" && !DATABASE_URL) {
  throw new Error("PHASE3_DATABASE_URL is required for the Phase 3 integration gate.");
}

const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const ROOT = process.cwd();

const RETRY_RECOVERY_TABLES = Object.freeze(["incidents", "job_redrive_audit"]);

const REDRIVE_AUDIT_INSERT = `with original as (
  insert into operations.jobs (job_id, job_type, payload_version, payload, available_at)
  values ('018f4f7d-5000-7000-8000-000000000004', 'phase3.role.probe', 1, '{}'::jsonb, transaction_timestamp()) returning job_id
), replacement as (
  insert into operations.jobs (job_id, job_type, payload_version, payload, available_at)
  values ('018f4f7d-5000-7000-8000-000000000005', 'phase3.role.probe', 1, '{}'::jsonb, transaction_timestamp()) returning job_id
)
insert into operations.job_redrive_audit (original_job_id,replacement_job_id,operator_scope_hash,policy_version,payload_sha256)
select original.job_id, replacement.job_id, repeat('a',64), 'phase7-handlers-v1', repeat('b',64) from original, replacement`;

const RETRY_RECOVERY_MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["anon", "select incidents", "select count(*) from operations.incidents", false],
  ["anon", "select redrive audit", "select count(*) from operations.job_redrive_audit", false],
  ["authenticated", "select incidents", "select count(*) from operations.incidents", false],
  ["authenticated", "select redrive audit", "select count(*) from operations.job_redrive_audit", false],
  ["shipwithali_application", "select incidents", "select count(*) from operations.incidents", false],
  ["shipwithali_application", "select redrive audit", "select count(*) from operations.job_redrive_audit", false],
  ["shipwithali_worker", "select incidents", "select count(*) from operations.incidents", true],
  ["shipwithali_worker", "select redrive audit", "select count(*) from operations.job_redrive_audit", true],
  ["shipwithali_worker", "insert redrive audit", REDRIVE_AUDIT_INSERT, true],
  ["shipwithali_worker", "insert incidents", "insert into operations.incidents (incident_key,category,safe_error_code,severity) values ('probe:1','job','PROBE_FAILURE','critical')", true],
  ["shipwithali_worker", "update incident counters", "update operations.incidents set occurrences = occurrences where false", true],
  ["shipwithali_worker", "rewrite incident identity", "update operations.incidents set category = category where false", false],
  ["shipwithali_backup", "select incidents", "select count(*) from operations.incidents", true],
  ["shipwithali_backup", "select redrive audit", "select count(*) from operations.job_redrive_audit", true],
];

const RETRY_RECOVERY_POLICIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["incidents", "incidents_worker_insert_policy", "INSERT", "{shipwithali_worker}"],
  ["incidents", "incidents_worker_select_policy", "SELECT", "{shipwithali_worker}"],
  ["incidents", "incidents_worker_update_policy", "UPDATE", "{shipwithali_worker}"],
  ["incidents", "operations_backup_policy_incidents", "SELECT", "{shipwithali_backup}"],
  ["job_redrive_audit", "job_redrive_audit_worker_insert_policy", "INSERT", "{shipwithali_worker}"],
  ["job_redrive_audit", "job_redrive_audit_worker_select_policy", "SELECT", "{shipwithali_worker}"],
  ["job_redrive_audit", "operations_backup_policy_job_redrive_audit", "SELECT", "{shipwithali_backup}"],
];

const PORTABILITY_EXPORT_UUID = "018f4f7d-5000-7000-8000-000000000170";
const CONFIGURATION_EXPORT_PORTFOLIO = "018f4f7d-5000-7000-8000-000000000290";
const CONFIGURATION_EXPORT_OWNER = "018f4f7d-5000-7000-8000-000000000291";
const CONFIGURATION_EXPORT_FIXTURE_ID = "018f4f7d-5000-7000-8000-000000000292";
const CONFIGURATION_EXPORT_SNAPSHOT_ID = "018f4f7d-5000-7000-8000-000000000293";

const PORTABILITY_EXPORT_OWNER_SETTINGS = `set local shipwithali.owner_id = '${PORTABILITY_EXPORT_UUID}';`;
const PORTABILITY_EXPORT_OTHER_SETTINGS = `set local shipwithali.owner_id = '018f4f7d-5000-7000-8000-000000000271';`;
const PORTABILITY_EXPORT_INSERT = `${PORTABILITY_EXPORT_OWNER_SETTINGS} insert into portability.owner_exports (
  export_id, portfolio_id, owner_id, included_scopes, status, schema_version, requested_at
) values (
  '${PORTABILITY_EXPORT_UUID}', '${PORTABILITY_EXPORT_UUID}', '${PORTABILITY_EXPORT_UUID}',
  array['portfolio-content'], 'requested', '1.0', transaction_timestamp()
)`;
const PORTABILITY_EXPORT_OTHER_OWNER_INSERT = `${PORTABILITY_EXPORT_OWNER_SETTINGS} insert into portability.owner_exports (
  export_id, portfolio_id, owner_id, included_scopes, status, schema_version, requested_at
) values (
  '${PORTABILITY_EXPORT_UUID}', '${PORTABILITY_EXPORT_UUID}', '018f4f7d-5000-7000-8000-000000000271',
  array['portfolio-content'], 'requested', '1.0', transaction_timestamp()
)`;
const PORTABILITY_EXPORT_UNSCOPED_INSERT = `insert into portability.owner_exports (
  export_id, portfolio_id, owner_id, included_scopes, status, schema_version, requested_at
) values (
  '${PORTABILITY_EXPORT_UUID}', '${PORTABILITY_EXPORT_UUID}', '${PORTABILITY_EXPORT_UUID}',
  array['portfolio-content'], 'requested', '1.0', transaction_timestamp()
)`;

/**
 * Phase 8 #238 Owner-export matrix. Identity binding is the point: the
 * application may write only rows that carry its resolved Owner scope, and no
 * writer may remove rows through a delete path.
 */
const PORTABILITY_EXPORT_MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["anon", "select owner exports", "select count(*) from portability.owner_exports", false],
  ["authenticated", "select owner exports", "select count(*) from portability.owner_exports", false],
  ["shipwithali_application", "select owner exports", "select count(*) from portability.owner_exports", true],
  ["shipwithali_application", "insert owner export in Owner scope", PORTABILITY_EXPORT_INSERT, true],
  ["shipwithali_application", "insert owner export for another Owner", PORTABILITY_EXPORT_OTHER_OWNER_INSERT, false],
  ["shipwithali_application", "insert owner export without Owner scope", PORTABILITY_EXPORT_UNSCOPED_INSERT, false],
  [
    "shipwithali_application",
    "update owner exports",
    "update portability.owner_exports set status = status where false",
    true,
  ],
  ["shipwithali_application", "delete owner exports", "delete from portability.owner_exports where false", false],
  ["shipwithali_worker", "select owner exports", "select count(*) from portability.owner_exports", true],
  [
    "shipwithali_worker",
    "update owner exports",
    "update portability.owner_exports set status = status where false",
    true,
  ],
  ["shipwithali_worker", "insert owner exports", PORTABILITY_EXPORT_UNSCOPED_INSERT, false],
  ["shipwithali_worker", "delete owner exports", "delete from portability.owner_exports where false", false],
  ["shipwithali_backup", "select owner exports", "select count(*) from portability.owner_exports", true],
  ["shipwithali_backup", "insert owner exports", PORTABILITY_EXPORT_UNSCOPED_INSERT, false],
];

const PORTABILITY_EXPORT_POLICIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["owner_exports", "operations_backup_policy_owner_exports", "SELECT", "{shipwithali_backup}"],
  ["owner_exports", "owner_exports_application_insert_policy", "INSERT", "{shipwithali_application}"],
  ["owner_exports", "owner_exports_application_select_policy", "SELECT", "{shipwithali_application}"],
  ["owner_exports", "owner_exports_application_update_policy", "UPDATE", "{shipwithali_application}"],
  ["owner_exports", "owner_exports_worker_select_policy", "SELECT", "{shipwithali_worker}"],
  ["owner_exports", "owner_exports_worker_update_policy", "UPDATE", "{shipwithali_worker}"],
];

const FEEDBACK_EXPORT_MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["anon", "select private feedback export identity", "select feedback_id from interaction.feedback where false", false],
  ["authenticated", "select private moderation export identity", "select feedback_id from interaction.moderation_decisions where false", false],
  ["shipwithali_application", "select Feedback through owner export seam", "select feedback_id from interaction.feedback where false", true],
  ["shipwithali_application", "select Moderation through owner export seam", "select feedback_id from interaction.moderation_decisions where false", true],
  ["shipwithali_worker", "select Feedback through worker export seam", "select feedback_id from interaction.feedback where false", true],
  ["shipwithali_worker", "select Moderation through worker export seam", "select feedback_id from interaction.moderation_decisions where false", true],
  ["shipwithali_backup", "select Feedback export identity", "select feedback_id from interaction.feedback where false", false],
  ["shipwithali_backup", "select Moderation export identity", "select feedback_id from interaction.moderation_decisions where false", false],
];

const FEEDBACK_EXPORT_POLICIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["feedback", "feedback_owner_export_read", "SELECT", "{shipwithali_application}"],
  ["moderation_decisions", "moderation_owner_export_read", "SELECT", "{shipwithali_application}"],
  ["feedback", "feedback_worker_owner_export_read", "SELECT", "{shipwithali_worker}"],
  ["moderation_decisions", "moderation_worker_owner_export_read", "SELECT", "{shipwithali_worker}"],
];

const CONFIGURATION_EXPORT_READ_POLICIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["settings", "portfolio_settings_worker_export_select", "SELECT", "{shipwithali_worker}"],
  ["contact_channels", "portfolio_channels_worker_export_select", "SELECT", "{shipwithali_worker}"],
];

const CONTENT_EXPORT_READ_POLICIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["items", "content_items_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["project_status_values", "project_status_values_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["revisions", "content_revisions_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["revision_reviews", "content_revision_reviews_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["language_publications", "language_publications_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["testimonial_language_publications", "testimonial_publications_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["publication_history", "publication_history_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["testimonial_publication_history", "testimonial_publication_history_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["lifecycle_history", "lifecycle_history_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["public_routes", "public_routes_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["public_route_reservations", "public_route_reservations_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["public_route_history", "public_route_history_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["project_relationship_views", "project_relationship_views_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["project_relationship_history", "project_relationship_history_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["project_taxonomy_assignments", "project_taxonomy_assignments_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["roots", "taxonomy_roots_worker_owner_export", "SELECT", "{shipwithali_worker}"],
];

const TAXONOMY_EXPORT_READ_POLICIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["roots", "taxonomy_roots_worker_taxonomy_export", "SELECT", "{shipwithali_worker}"],
  ["taxonomy_values", "taxonomy_values_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["value_history", "taxonomy_value_history_worker_owner_export", "SELECT", "{shipwithali_worker}"],
  ["project_taxonomy_assignment_history", "project_taxonomy_assignment_history_worker_owner_export", "SELECT", "{shipwithali_worker}"],
];

const TAXONOMY_EXPORT_MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["shipwithali_worker", "select taxonomy roots in taxonomy export purpose",
    `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; set local shipwithali.worker_purpose = 'taxonomy.owner-export'; select count(*) from taxonomy.roots`, true],
  ["shipwithali_worker", "select taxonomy values in taxonomy export purpose",
    `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; set local shipwithali.worker_purpose = 'taxonomy.owner-export'; select count(*) from taxonomy.taxonomy_values`, true],
  ["shipwithali_worker", "select taxonomy history in taxonomy export purpose",
    `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; set local shipwithali.worker_purpose = 'taxonomy.owner-export'; select count(*) from taxonomy.value_history`, true],
  ["shipwithali_worker", "update taxonomy values", "update taxonomy.taxonomy_values set label = label where false", false],
  ["shipwithali_worker", "insert taxonomy history", "insert into taxonomy.value_history (portfolio_id,taxonomy_id,value_id,transition_sequence,action,previous_label,label,state,aggregate_version) values ('018f4f7d-5000-7000-8000-000000000290','01890f3e-7b2f-7cc0-98cf-5a2890378ef8','018f4f7d-5000-7000-8000-000000000294',1,'created',null,'Probe','active',1)", false],
];

const CONFIGURATION_EXPORT_OUTBOX_POLICY: ReadonlyArray<readonly [string, string, string, string]> = [
  ["outbox_events", "owner_export_produced_outbox_worker_insert", "INSERT", "{shipwithali_worker}"],
];

const CONFIGURATION_EXPORT_MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["shipwithali_worker", "insert produced event for unready export",
    "insert into operations.outbox_events (event_id, event_type, schema_version, aggregate_id, aggregate_version, payload, correlation_id, causation_id, occurred_at, available_at) " +
    "values ('018f4f7d-5000-7000-8000-000000000291', 'portability.export_produced.v1', 1, '018f4f7d-5000-7000-8000-000000000292', 2, " +
    "jsonb_build_object('exportId', '018f4f7d-5000-7000-8000-000000000292', 'manifest', jsonb_build_object('schemaVersion', '1.0', 'exportId', '018f4f7d-5000-7000-8000-000000000292', 'checksumSha256', repeat('a', 64), 'recordCounts', '{}'::jsonb)), " +
    "'018f4f7d-5000-7000-8000-000000000292', '018f4f7d-5000-7000-8000-000000000293', transaction_timestamp(), transaction_timestamp())", false],
  ["anon", "select configuration settings", "select count(*) from portfolio_config.settings", false],
  ["authenticated", "select configuration settings", "select count(*) from portfolio_config.settings", false],
  ["shipwithali_worker", "select configuration settings", `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; select count(*) from portfolio_config.settings`, true],
  ["shipwithali_worker", "select Contact channels", `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; select count(*) from portfolio_config.contact_channels`, true],
  ["shipwithali_worker", "update configuration settings", "update portfolio_config.settings set version = version where false", false],
  ["shipwithali_worker", "insert Contact channel", "insert into portfolio_config.contact_channels (portfolio_id, position, channel, label, destination, available_locales) values ('018f4f7d-5000-7000-8000-000000000290', 9, 'email', 'Email', 'owner@example.test', '[\"en\"]'::jsonb)", false],
];

const CONTENT_EXPORT_MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["shipwithali_worker", "select Content snapshot in exact Owner purpose",
    `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; set local shipwithali.worker_purpose = 'content.owner-export'; select count(*) from content.items`, true],
  ["shipwithali_worker", "select Content snapshot for another purpose",
    `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; set local shipwithali.worker_purpose = 'portability.configuration-export'; select count(*) from content.items`, true],
  ["shipwithali_worker", "update Content items", "update content.items set aggregate_version = aggregate_version where false", false],
  ["shipwithali_worker", "insert Content item", "insert into content.items (content_id, portfolio_id, content_type) values ('018f4f7d-5000-7000-8000-000000000294', '018f4f7d-5000-7000-8000-000000000290', 'project')", false],
  ["shipwithali_worker", "delete Content item", "delete from content.items where false", false],
];

/** The scoped assembly-job policy reviewed for #238 in operations.jobs. */
const OWNER_EXPORT_JOB_POLICIES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["jobs", "owner_export_jobs_application_insert", "INSERT", "{shipwithali_application}"],
];

/**
 * Expected capability state is read from the declared
 * `PHASE_DATABASE_CAPABILITIES` list, never learned from the database being
 * checked. The connection below is only a cross-guard: a ledger that stopped
 * at the Phase 3 release legitimately lacks the bounded-retry tables while a
 * connection that carries exactly one of the two objects instead of both is
 * treated as corruption and fails the matrix in every context.
 */
let retryRecoverySchema = false;
let portabilityExportSchema = false;
let feedbackExportSchema = false;
let configurationExportSchema = false;
let contentExportSchema = false;
let taxonomyExportSchema = false;
if (DATABASE_URL !== undefined) {
   const declared = (process.env["PHASE_DATABASE_CAPABILITIES"] ?? declaredCapabilities().join(","))
    .split(",").map((value) => value.trim()).filter(Boolean);
  // The default declared list carries every registry capability; a restricted
  // runner must name the bounded-retry capability so the era cross-guards
  // below mean what they say. Era mismatches for the portability capability
  // are caught by its dedicated cross-guard, so typos fail either way.
  if (!declared.includes("operations.bounded_retries") && declared.length > 0) {
    throw new Error("ROLE_MATRIX_DECLARED_CAPABILITY_UNKNOWN:" + declared.join(","));
  }
  const era = adminClient();
  await era.connect();
  try {
    const bounded = await era.query(
      `select to_regclass('operations.incidents') is not null as has_incidents,
              to_regclass('operations.job_redrive_audit') is not null as has_redrive,
              exists (
                select 1 from information_schema.columns
                 where table_schema = 'operations'
                   and table_name = 'outbox_events'
                   and column_name = 'dead_at'
               ) as has_dead_at`,
    );
    const boundedRow: Record<string, unknown> = bounded.rows[0] ?? {};
    if (boundedRow["has_incidents"] !== boundedRow["has_redrive"] || (boundedRow["has_incidents"] === false && boundedRow["has_dead_at"] === true)) {
      throw new Error("ROLE_MATRIX_SCHEMA_RECOVERY_INCOMPLETE");
    }
    retryRecoverySchema = boundedRow["has_incidents"] === true && boundedRow["has_dead_at"] === true;
    if (declared.includes("operations.bounded_retries") !== retryRecoverySchema) {
      throw new Error(
        declared.includes("operations.bounded_retries")
          ? "ROLE_MATRIX_DECLARED_CAPABILITY_NOT_INSTALLED:operations.bounded_retries"
          : "ROLE_MATRIX_DATABASE_HAS_UNDECLARED_CAPABILITY:operations.bounded_retries",
      );
    }
    const portability = await era.query(
      `select to_regclass('portability.owner_exports') is not null as has_owner_exports`,
    );
    portabilityExportSchema = portability.rows[0]?.["has_owner_exports"] === true;
    if (declared.includes("portability.owner_export_requests") !== portabilityExportSchema) {
      throw new Error(
        declared.includes("portability.owner_export_requests")
          ? "ROLE_MATRIX_DECLARED_CAPABILITY_NOT_INSTALLED:portability.owner_export_requests"
          : "ROLE_MATRIX_DATABASE_HAS_UNDECLARED_CAPABILITY:portability.owner_export_requests",
      );
    }
    const feedbackExportPolicies = await era.query(
      `select count(*)::int as policy_count,
              to_regprocedure('interaction.owner_feedback_export_scope_is_valid(uuid)') is not null as has_scope_function
         from pg_policies where schemaname = 'interaction'
          and policyname in ('feedback_owner_export_read', 'moderation_owner_export_read',
            'feedback_worker_owner_export_read', 'moderation_worker_owner_export_read')`,
    );
    feedbackExportSchema = Number(feedbackExportPolicies.rows[0]?.["policy_count"] ?? 0) === 4 &&
      feedbackExportPolicies.rows[0]?.["has_scope_function"] === true;
    if (declared.includes("portability.feedback_export") !== feedbackExportSchema) {
      throw new Error(declared.includes("portability.feedback_export")
        ? "ROLE_MATRIX_DECLARED_CAPABILITY_NOT_INSTALLED:portability.feedback_export"
        : "ROLE_MATRIX_DATABASE_HAS_UNDECLARED_CAPABILITY:portability.feedback_export");
    }
    const configurationPolicies = await era.query(
      `select count(*)::int as count from pg_policies
        where schemaname = 'portfolio_config'
          and policyname in ('portfolio_settings_worker_export_select', 'portfolio_channels_worker_export_select')`,
    );
    configurationExportSchema = Number(configurationPolicies.rows[0]?.["count"] ?? 0) === 2;
    if (declared.includes("portability.configuration_export") !== configurationExportSchema) {
      throw new Error(
        declared.includes("portability.configuration_export")
          ? "ROLE_MATRIX_DECLARED_CAPABILITY_NOT_INSTALLED:portability.configuration_export"
          : "ROLE_MATRIX_DATABASE_HAS_UNDECLARED_CAPABILITY:portability.configuration_export",
      );
    }
    const contentPolicies = await era.query(
      `select count(*)::int as policy_count,
              to_regprocedure('content.owner_export_scope_is_valid(uuid)') is not null as has_scope_function
         from pg_policies
        where (schemaname = 'content' and policyname = any($1::text[]))
           or (schemaname = 'taxonomy' and policyname = 'taxonomy_roots_worker_owner_export')`,
      [CONTENT_EXPORT_READ_POLICIES.filter(([, policy]) => policy !== "taxonomy_roots_worker_owner_export").map(([, policy]) => policy)],
    );
    contentExportSchema = Number(contentPolicies.rows[0]?.["policy_count"] ?? 0) === CONTENT_EXPORT_READ_POLICIES.length &&
      contentPolicies.rows[0]?.["has_scope_function"] === true;
    if (declared.includes("portability.content_export") !== contentExportSchema) {
      throw new Error(
        declared.includes("portability.content_export")
          ? "ROLE_MATRIX_DECLARED_CAPABILITY_NOT_INSTALLED:portability.content_export"
          : "ROLE_MATRIX_DATABASE_HAS_UNDECLARED_CAPABILITY:portability.content_export",
      );
    }
    const taxonomyPolicies = await era.query(
      `select count(*)::int as policy_count,
              to_regprocedure('taxonomy.owner_export_scope_is_valid(uuid)') is not null as has_scope_function
         from pg_policies
        where (schemaname = 'taxonomy' and policyname = any($1::text[]))
           or (schemaname = 'content' and policyname = any($2::text[]))`,
      [TAXONOMY_EXPORT_READ_POLICIES.filter(([, policy]) => policy !== "project_taxonomy_assignment_history_worker_owner_export").map(([, policy]) => policy),
        TAXONOMY_EXPORT_READ_POLICIES.filter(([, policy]) => policy === "project_taxonomy_assignment_history_worker_owner_export").map(([, policy]) => policy)],
    );
    taxonomyExportSchema = Number(taxonomyPolicies.rows[0]?.["policy_count"] ?? 0) === TAXONOMY_EXPORT_READ_POLICIES.length &&
      taxonomyPolicies.rows[0]?.["has_scope_function"] === true;
    if (declared.includes("portability.taxonomy_export") !== taxonomyExportSchema) {
      throw new Error(declared.includes("portability.taxonomy_export")
        ? "ROLE_MATRIX_DECLARED_CAPABILITY_NOT_INSTALLED:portability.taxonomy_export"
        : "ROLE_MATRIX_DATABASE_HAS_UNDECLARED_CAPABILITY:portability.taxonomy_export");
    }
  } finally {
    await era.end();
  }
}

const KNOWN_ROLES = Object.freeze([
  "anon",
  "authenticated",
  "shipwithali_application",
  "shipwithali_worker",
  "shipwithali_backup",
  "shipwithali_migration",
]);

const IDEMPOTENCY_INSERT = `insert into operations.idempotency_records (
  operation_scope, actor_scope, key_hash, request_hash, status, expires_at
) values (
  'phase3.role.probe', repeat('a', 64), repeat('b', 64), repeat('c', 64),
  'reserved', transaction_timestamp() + interval '1 day'
)`;

const OUTBOX_INSERT = `insert into operations.outbox_events (
  event_id, event_type, schema_version, aggregate_id, aggregate_version,
  payload, correlation_id, occurred_at, available_at
) values (
  '018f4f7d-5000-7000-8000-000000000001', 'phase3.role.probe', 1,
  '018f4f7d-5000-7000-8000-000000000002', 1, '{}'::jsonb,
  'phase3-role-probe', transaction_timestamp(), transaction_timestamp()
)`;

const JOB_INSERT = `insert into operations.jobs (
  job_id, job_type, payload_version, payload, available_at
) values (
  '018f4f7d-5000-7000-8000-000000000003', 'phase3.role.probe', 1,
  '{}'::jsonb, transaction_timestamp()
)`;

const OUTBOX_CLAIM = `select event_id from operations.outbox_events
   where completed_at is null
   order by available_at, event_id limit 1 for update skip locked`;

/** Every matrix row: the connected role, the attempted statement, and whether it must succeed. */
const BASE_MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["anon", "select idempotency", "select count(*) from operations.idempotency_records", false],
  ["anon", "select outbox", "select count(*) from operations.outbox_events", false],
  ["anon", "select jobs", "select count(*) from operations.jobs", false],
  ["anon", "insert outbox", OUTBOX_INSERT, false],
  ["anon", "read public projection", "select count(*) from public_read.__phase3_role_probe_view", false],
  ["authenticated", "select idempotency", "select count(*) from operations.idempotency_records", false],
  ["authenticated", "select outbox", "select count(*) from operations.outbox_events", false],
  ["authenticated", "select jobs", "select count(*) from operations.jobs", false],
  ["authenticated", "insert outbox", OUTBOX_INSERT, false],
  ["authenticated", "read public projection", "select count(*) from public_read.__phase3_role_probe_view", false],
  ["shipwithali_application", "select idempotency", "select count(*) from operations.idempotency_records", true],
  ["shipwithali_application", "insert idempotency", IDEMPOTENCY_INSERT, true],
  [
    "shipwithali_application",
    "update idempotency",
    "update operations.idempotency_records set expires_at = expires_at where false",
    true,
  ],
  [
    "shipwithali_application",
    "delete idempotency",
    "delete from operations.idempotency_records where false",
    false,
  ],
  ["shipwithali_application", "insert outbox", OUTBOX_INSERT, true],
  ["shipwithali_application", "select outbox", "select count(*) from operations.outbox_events", false],
  [
    "shipwithali_application",
    "update outbox",
    "update operations.outbox_events set available_at = available_at where false",
    false,
  ],
  ["shipwithali_application", "select jobs", "select count(*) from operations.jobs", false],
  ["shipwithali_application", "insert jobs", JOB_INSERT, false],
  [
    "shipwithali_application",
    "claim outbox lease",
    OUTBOX_CLAIM,
    false,
  ],
  [
    "shipwithali_application",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  [
    "shipwithali_application",
    "read future object",
    "select count(*) from operations.__phase3_role_probe",
    false,
  ],
  [
    "shipwithali_application",
    "read unrelated module object",
    "select count(*) from content.__phase3_role_probe",
    false,
  ],
  ["shipwithali_worker", "select jobs", "select count(*) from operations.jobs", true],
  ["shipwithali_worker", "insert jobs", JOB_INSERT, true],
  [
    "shipwithali_worker",
    "update jobs",
    "update operations.jobs set available_at = available_at where false",
    true,
  ],
  ["shipwithali_worker", "delete jobs", "delete from operations.jobs where false", false],
  ["shipwithali_worker", "select outbox", "select count(*) from operations.outbox_events", true],
  [
    "shipwithali_worker",
    "update outbox",
    "update operations.outbox_events set available_at = available_at where false",
    true,
  ],
  ["shipwithali_worker", "insert outbox", OUTBOX_INSERT, false],
  ["shipwithali_worker", "select idempotency", "select count(*) from operations.idempotency_records", false],
  ["shipwithali_worker", "insert idempotency", IDEMPOTENCY_INSERT, false],
  [
    "shipwithali_worker",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  [
    "shipwithali_worker",
    "create future module table",
    "create table content.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  ["shipwithali_worker", "read future object", "select count(*) from operations.__phase3_role_probe", false],
  ["shipwithali_worker", "claim outbox lease", OUTBOX_CLAIM, true],
  [
    "shipwithali_worker",
    "read unrelated module object",
    "select count(*) from content.__phase3_role_probe",
    false,
  ],
  ["shipwithali_backup", "select idempotency", "select count(*) from operations.idempotency_records", true],
  ["shipwithali_backup", "select outbox", "select count(*) from operations.outbox_events", true],
  ["shipwithali_backup", "select jobs", "select count(*) from operations.jobs", true],
  ["shipwithali_backup", "insert outbox", OUTBOX_INSERT, false],
  [
    "shipwithali_backup",
    "delete outbox",
    "delete from operations.outbox_events where false",
    false,
  ],
  [
    "shipwithali_backup",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    false,
  ],
  ["shipwithali_migration", "select outbox", "select count(*) from operations.outbox_events", true],
  [
    "shipwithali_migration",
    "create table",
    "create table operations.__phase3_role_probe_ddl (id integer)",
    true,
  ],
];

const MATRIX: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ...BASE_MATRIX,
  ...(retryRecoverySchema ? RETRY_RECOVERY_MATRIX : []),
  ...(portabilityExportSchema ? PORTABILITY_EXPORT_MATRIX : []),
  ...(configurationExportSchema ? CONFIGURATION_EXPORT_MATRIX : []),
  ...(contentExportSchema ? CONTENT_EXPORT_MATRIX : []),
  ...(taxonomyExportSchema ? TAXONOMY_EXPORT_MATRIX : []),
  ...(feedbackExportSchema ? FEEDBACK_EXPORT_MATRIX : []),
];

interface RoleAttempt {
  readonly sessionUser: string;
  readonly currentUser: string;
  readonly allowed: boolean;
  readonly rows: Array<Record<string, unknown>>;
}

let probeSequence = 0;
let probeTableOid = 0;
let probeSequenceOid = 0;
let probeFunctionOid = 0;

function adminClient() {
  return new Client({ connectionString: DATABASE_URL ?? "" });
}

/**
 * Connect as a disposable login whose only membership is the role under test,
 * then assert as that role. Probe names and passwords use closed alphabets, so
 * interpolating them into administration statements is injection-safe. Every
 * failure surfaces a stable code: raw provider errors and credentials never
 * enter test output.
 */
async function attemptAs(role: string | null, statement: string): Promise<RoleAttempt> {
  if (role !== null && !KNOWN_ROLES.includes(role)) throw new Error("ROLE_MATRIX_UNKNOWN_ROLE");
  const admin = adminClient();
  await admin.connect();
  const login = `phase3_probe_${process.pid}_${probeSequence++}`;
  const password = randomBytes(24).toString("hex");
  const probe = new Client({
    connectionString: buildLoginUrl(DATABASE_URL ?? "", login, password),
  });
  try {
    try {
      await admin.query(
        `create role "${login}" login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
      );
      if (role !== null) await admin.query(`grant ${role} to "${login}"`);
    } catch {
      throw new Error("ROLE_MATRIX_PROBE_SETUP_FAILED");
    }
    await probe.connect();
    await probe.query("begin");
    if (role !== null) await probe.query(`set role ${role}`);
    const identity = await probe.query("select session_user, current_user");
    const sessionUser = String(identity.rows[0]?.["session_user"] ?? "");
    const currentUser = String(identity.rows[0]?.["current_user"] ?? "");
    if (sessionUser !== login || currentUser !== (role ?? login)) {
      throw new Error("ROLE_MATRIX_IDENTITY_MISMATCH");
    }
    let allowed = true;
    let rows: Array<Record<string, unknown>> = [];
    try {
      const results = await probe.query(statement);
      const result = Array.isArray(results) ? results.at(-1) : results;
      rows = (result?.rows ?? []) as Array<Record<string, unknown>>;
    } catch {
      allowed = false;
    }
    await probe.query("rollback");
    return { sessionUser, currentUser, allowed, rows };
  } finally {
    try {
      await probe.end();
    } catch {
      // Probe teardown must not mask the recorded matrix outcome.
    }
    try {
      await admin.query(`drop role if exists "${login}"`);
    } catch {
      // Best effort: a leaked probe login holds no grants and cannot reach data.
    }
    await admin.end();
  }
}

function buildLoginUrl(base: string, login: string, password: string) {
  const url = new URL(base);
  url.username = login;
  url.password = password;
  return url.toString();
}

function migrationSources() {
  return readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((name) => /^\d{14}_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => readFileSync(join(ROOT, "supabase", "migrations", name), "utf8"))
    .join("\n");
}

function phase3MigrationSources() {
  return readdirSync(join(ROOT, "supabase", "migrations"))
    .filter((name) => /(?:establish_database_security_baseline|create_operations_primitives)\.sql$/u.test(name))
    .sort()
    .map((name) => readFileSync(join(ROOT, "supabase", "migrations", name), "utf8"))
    .join("\n");
}

describeDatabase("Phase 3 role, grant, and RLS matrix (#53)", () => {
  beforeAll(async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      await admin.query("set role shipwithali_migration");
      await admin.query("drop function if exists operations.__phase3_role_probe_function()");
      await admin.query("drop table if exists operations.__phase3_role_probe");
      await admin.query("drop sequence if exists operations.__phase3_role_probe_sequence");
      await admin.query("drop function if exists operations.__phase3_role_probe_function()");
      await admin.query("drop view if exists public_read.__phase3_role_probe_view");
      await admin.query("drop table if exists content.__phase3_role_probe");
      await admin.query("create table operations.__phase3_role_probe (id integer)");
      await admin.query("create sequence operations.__phase3_role_probe_sequence");
      await admin.query(
        "create function operations.__phase3_role_probe_function() returns integer language sql immutable as 'select 1'",
      );
      // PostgreSQL 17 does not apply default-privilege entries to new functions
      // (their system default stays PUBLIC EXECUTE), so every created function
      // must carry an explicit object-level revoke exactly as future migrations
      // are required to do. Tables and sequences below rely on true defaults.
      await admin.query(
        "revoke all on function operations.__phase3_role_probe_function() from public, anon, authenticated",
      );
      // A disposable public_read object proves anonymous and authenticated
      // clients gain no implicit projection access; a content table proves
      // capability roles cannot reach unrelated module objects.
      await admin.query(
        "create view public_read.__phase3_role_probe_view with (security_barrier = true) as select 1 as probe",
      );
      await admin.query("create table content.__phase3_role_probe (id integer)");
      await admin.query("reset role");
      const oids = await admin.query(
        `select to_regclass('operations.__phase3_role_probe')::oid as tbl,
                to_regclass('operations.__phase3_role_probe_sequence')::oid as seq,
                to_regprocedure('operations.__phase3_role_probe_function()')::oid as fn`,
      );
      probeTableOid = Number(oids.rows[0]?.["tbl"]);
      probeSequenceOid = Number(oids.rows[0]?.["seq"]);
      probeFunctionOid = Number(oids.rows[0]?.["fn"]);
      if (
        !Number.isInteger(probeTableOid) ||
        !Number.isInteger(probeSequenceOid) ||
        !Number.isInteger(probeFunctionOid)
      ) {
        throw new Error("ROLE_MATRIX_SETUP_FAILED");
      }
      if (configurationExportSchema) {
        await admin.query("delete from portability.owner_exports where export_id = $1", [CONFIGURATION_EXPORT_FIXTURE_ID]);
        await admin.query("delete from portfolio_config.contact_channels where portfolio_id = $1", [CONFIGURATION_EXPORT_PORTFOLIO]);
        await admin.query("delete from taxonomy.roots where portfolio_id = $1", [CONFIGURATION_EXPORT_PORTFOLIO]);
        await admin.query("delete from portfolio_config.settings where portfolio_id = $1", [CONFIGURATION_EXPORT_PORTFOLIO]);
        await admin.query(
          `insert into portfolio_config.settings (
             portfolio_id, owner_id, display_name, headline, bio,
             global_cta_label, global_cta_destination, global_cta_unavailable_fallback
           ) values ($1, $2, 'RLS fixture', 'Worker read test', 'Synthetic profile fixture',
             'Contact', 'https://example.test/contact', 'Unavailable')`,
          [CONFIGURATION_EXPORT_PORTFOLIO, CONFIGURATION_EXPORT_OWNER],
        );
        await admin.query(
          `insert into portfolio_config.contact_channels (portfolio_id, position, channel, label, destination, available_locales)
           values ($1, 0, 'email', 'Email', 'owner@example.test', '["en"]'::jsonb)`,
          [CONFIGURATION_EXPORT_PORTFOLIO],
        );
        await admin.query(
          `insert into portability.owner_exports (
             export_id, portfolio_id, owner_id, included_scopes, status, schema_version, requested_at,
             snapshot_id, snapshot_captured_at, configuration_version, snapshot_data
           ) values ($1, $2, $3, array['portfolio-content'], 'requested', '1.0', transaction_timestamp(),
             $4, transaction_timestamp(), 1, jsonb_build_object('privateMarker', 'owner-export-snapshot-private'))`,
          [CONFIGURATION_EXPORT_FIXTURE_ID, CONFIGURATION_EXPORT_PORTFOLIO, CONFIGURATION_EXPORT_OWNER, CONFIGURATION_EXPORT_SNAPSHOT_ID],
        );
      }
    } catch {
      throw new Error("ROLE_MATRIX_SETUP_FAILED");
    } finally {
      await admin.end();
    }
  });

  afterAll(async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      if (configurationExportSchema) {
        await admin.query("delete from portability.owner_exports where export_id = $1", [CONFIGURATION_EXPORT_FIXTURE_ID]);
        await admin.query("delete from portfolio_config.contact_channels where portfolio_id = $1", [CONFIGURATION_EXPORT_PORTFOLIO]);
        await admin.query("delete from taxonomy.roots where portfolio_id = $1", [CONFIGURATION_EXPORT_PORTFOLIO]);
        await admin.query("delete from portfolio_config.settings where portfolio_id = $1", [CONFIGURATION_EXPORT_PORTFOLIO]);
      }
      await admin.query("set role shipwithali_migration");
      await admin.query("drop table if exists operations.__phase3_role_probe");
      await admin.query("drop sequence if exists operations.__phase3_role_probe_sequence");
      await admin.query("drop function if exists operations.__phase3_role_probe_function()");
      await admin.query("drop view if exists public_read.__phase3_role_probe_view");
      await admin.query("drop table if exists content.__phase3_role_probe");
      await admin.query("reset role");
    } finally {
      await admin.end();
    }
  });

  it.each(MATRIX)("%s can %s: %s", async (role, label, statement, expected) => {
    const attempt = await attemptAs(role, statement);
    expect(attempt.currentUser, `${role} ${label}`).toBe(role);
    expect(attempt.allowed, `${role} ${label}`).toBe(expected);
  });

  it("denies every base-table path to logins holding no capability", async () => {
    for (const statement of [
      "select count(*) from operations.idempotency_records",
      "select count(*) from operations.outbox_events",
      "select count(*) from operations.jobs",
      OUTBOX_INSERT,
    ]) {
      const attempt = await attemptAs(null, statement);
      expect(attempt.currentUser).toBe(attempt.sessionUser);
      expect(attempt.allowed, statement).toBe(false);
    }
  });

  it("denies schema usage to public clients and confines capabilities to operations", async () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ["anon", "operations", false],
      ["anon", "public_read", false],
      ["authenticated", "operations", false],
      ["authenticated", "public_read", false],
      ["shipwithali_application", "operations", true],
      ["shipwithali_application", "public_read", false],
      ["shipwithali_worker", "operations", true],
      ["shipwithali_worker", "public_read", false],
      ["shipwithali_backup", "operations", true],
      ["shipwithali_backup", "public_read", false],
    ];
    for (const [role, schema, expected] of cases) {
      const attempt = await attemptAs(
        role,
        `select has_schema_privilege('${schema}', 'USAGE') as has_access`,
      );
      expect(attempt.rows[0]?.["has_access"], `${role} ${schema}`).toBe(expected);
    }
  });

  it("grants PUBLIC no privileges on application tables or probe routines", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const tables = await admin.query(
        `select grantee, privilege_type from information_schema.role_table_grants
          where table_schema = 'operations'
            and table_name in ('idempotency_records', 'outbox_events', 'jobs', '__phase3_role_probe')
            and grantee = 'PUBLIC'`,
      );
      expect(tables.rows).toEqual([]);
      const routines = await admin.query(
        `select grantee, privilege_type from information_schema.role_routine_grants
          where routine_schema = 'operations'
            and routine_name = '__phase3_role_probe_function'
            and grantee = 'PUBLIC'`,
      );
      expect(routines.rows).toEqual([]);
    } finally {
      await admin.end();
    }
  });

  it("grants new objects no access to public, anonymous, authenticated, application, worker, or backup", async () => {
    // OID literals avoid schema-name resolution, which itself requires USAGE.
    const inspections = [
      `select has_table_privilege(${probeTableOid}::oid, 'SELECT') as has_access`,
      `select has_sequence_privilege(${probeSequenceOid}::oid, 'USAGE') as has_access`,
      `select has_function_privilege(${probeFunctionOid}::oid, 'EXECUTE') as has_access`,
    ];
    for (const role of [
      "anon",
      "authenticated",
      "shipwithali_application",
      "shipwithali_worker",
      "shipwithali_backup",
    ]) {
      for (const statement of inspections) {
        const attempt = await attemptAs(role, statement);
        expect(attempt.rows[0]?.["has_access"], `${role} ${statement}`).toBe(false);
      }
    }
    for (const statement of inspections) {
      const attempt = await attemptAs(null, statement);
      expect(attempt.rows[0]?.["has_access"], `public ${statement}`).toBe(false);
    }
  });

  it("enables and forces RLS on every Phase 3 application table", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const tables = await admin.query(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'operations'
            and c.relname in ('idempotency_records', 'outbox_events', 'jobs', 'incidents', 'job_redrive_audit')
          order by c.relname`,
      );
      expect(tables.rows.map((row) => row["relname"])).toEqual([
        "idempotency_records",
        "jobs",
        "outbox_events",
        ...(retryRecoverySchema ? RETRY_RECOVERY_TABLES : []),
      ].sort());
      for (const row of tables.rows) {
        expect(row["relrowsecurity"], String(row["relname"])).toBe(true);
        expect(row["relforcerowsecurity"], String(row["relname"])).toBe(true);
      }
    } finally {
      await admin.end();
    }
  });

  it("publishes exactly the declared application and worker policies", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const policies = await admin.query(
        `select tablename, policyname, roles, cmd
           from pg_policies
          where schemaname = 'operations'
            and policyname <> 'measurement_event_jobs_application_insert'
            and policyname <> 'owner_export_jobs_application_insert'
          order by tablename, policyname`,
      );
      expect(
        policies.rows.map((row) => [
          row["tablename"],
          row["policyname"],
          row["cmd"],
          String(row["roles"]),
        ]),
      ).toEqual([
        ["idempotency_records", "idempotency_application_insert_policy", "INSERT", "{shipwithali_application}"],
        ["idempotency_records", "idempotency_application_select_policy", "SELECT", "{shipwithali_application}"],
        ["idempotency_records", "idempotency_application_update_policy", "UPDATE", "{shipwithali_application}"],
        ["idempotency_records", "operations_backup_policy_idempotency", "SELECT", "{shipwithali_backup}"],
        ...(retryRecoverySchema ? RETRY_RECOVERY_POLICIES : []),
        ["jobs", "jobs_worker_insert_policy", "INSERT", "{shipwithali_worker}"],
        ["jobs", "jobs_worker_select_policy", "SELECT", "{shipwithali_worker}"],
        ["jobs", "jobs_worker_update_policy", "UPDATE", "{shipwithali_worker}"],
        ["jobs", "operations_backup_policy_jobs", "SELECT", "{shipwithali_backup}"],
        ["outbox_events", "operations_backup_policy_outbox", "SELECT", "{shipwithali_backup}"],
        ["outbox_events", "outbox_application_insert_policy", "INSERT", "{shipwithali_application}"],
        ["outbox_events", "outbox_worker_select_policy", "SELECT", "{shipwithali_worker}"],
        ["outbox_events", "outbox_worker_update_policy", "UPDATE", "{shipwithali_worker}"],
        ...(configurationExportSchema ? CONFIGURATION_EXPORT_OUTBOX_POLICY : []),
      ]);
    } finally {
      await admin.end();
    }
  });

  if (configurationExportSchema) {
    it("publishes the configuration-only worker read boundary and scopes both tables by Owner and Portfolio", async () => {
      const admin = adminClient();
      await admin.connect();
      try {
        const policies = await admin.query(
          `select tablename, policyname, roles, cmd
             from pg_policies
            where schemaname = 'portfolio_config'
              and policyname in ('portfolio_settings_worker_export_select', 'portfolio_channels_worker_export_select')
            order by policyname`,
        );
        expect(policies.rows.map((row) => [row["tablename"], row["policyname"], row["cmd"], String(row["roles"])]))
          .toEqual([...CONFIGURATION_EXPORT_READ_POLICIES].sort((left, right) => left[1].localeCompare(right[1])));
      } finally {
        await admin.end();
      }
      const allowed = await attemptAs("shipwithali_worker",
        `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; select count(*)::int as count from portfolio_config.settings`);
      expect(allowed.rows.at(-1)?.["count"]).toBe(1);
      const wrongOwner = await attemptAs("shipwithali_worker",
        `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${PORTABILITY_EXPORT_UUID}'; select count(*)::int as count from portfolio_config.settings`);
      expect(wrongOwner.rows.at(-1)?.["count"]).toBe(0);
      const wrongPortfolio = await attemptAs("shipwithali_worker",
        `set local shipwithali.portfolio_id = '${PORTABILITY_EXPORT_UUID}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; select count(*)::int as count from portfolio_config.contact_channels`);
      expect(wrongPortfolio.rows.at(-1)?.["count"]).toBe(0);
      const unscopedSnapshot = await attemptAs("shipwithali_application",
        `select count(*)::int as count from portability.owner_exports where export_id = '${CONFIGURATION_EXPORT_FIXTURE_ID}'`);
      expect(unscopedSnapshot.rows.at(-1)?.["count"]).toBe(0);
      const scopedSnapshot = await attemptAs("shipwithali_application",
        `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; select snapshot_data->>'privateMarker' as marker from portability.owner_exports where export_id = '${CONFIGURATION_EXPORT_FIXTURE_ID}'`);
      expect(scopedSnapshot.rows.at(-1)?.["marker"]).toBe("owner-export-snapshot-private");
    });
  }

  if (feedbackExportSchema) {
    it("publishes the private Feedback and Moderation export boundary for the matching Owner and purpose only", async () => {
      const admin = adminClient();
      await admin.connect();
      try {
        const policies = await admin.query(
          `select tablename, policyname, roles, cmd from pg_policies
            where schemaname = 'interaction' and policyname = any($1::text[]) order by policyname`,
          [FEEDBACK_EXPORT_POLICIES.map(([, policy]) => policy)],
        );
        expect(policies.rows.map((row) => [row["tablename"], row["policyname"], row["cmd"], String(row["roles"])]))
          .toEqual([...FEEDBACK_EXPORT_POLICIES].sort((left, right) => left[1].localeCompare(right[1])));
      } finally {
        await admin.end();
      }
      const allowedWorker = await attemptAs("shipwithali_worker",
        `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; set local shipwithali.worker_purpose = 'interaction.owner-export'; set local shipwithali.feedback_access = 'owner-export'; select count(feedback_id)::int as count from interaction.feedback`);
      expect(allowedWorker.rows.at(-1)?.["count"]).toBe(0);
      const wrongPurpose = await attemptAs("shipwithali_worker",
        `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${CONFIGURATION_EXPORT_OWNER}'; set local shipwithali.worker_purpose = 'feedback.retention'; set local shipwithali.feedback_access = 'owner-export'; select count(feedback_id)::int as count from interaction.feedback`);
      expect(wrongPurpose.rows.at(-1)?.["count"]).toBe(0);
      const wrongOwner = await attemptAs("shipwithali_application",
        `set local shipwithali.portfolio_id = '${CONFIGURATION_EXPORT_PORTFOLIO}'; set local shipwithali.owner_id = '${PORTABILITY_EXPORT_UUID}'; set local shipwithali.feedback_access = 'owner-export'; select count(feedback_id)::int as count from interaction.feedback`);
      expect(wrongOwner.rows.at(-1)?.["count"]).toBe(0);
    });
  }

  if (contentExportSchema) {
    it("publishes the purpose-fenced Content export read boundary with no source writes", async () => {
      const admin = adminClient();
      await admin.connect();
      try {
        const policies = await admin.query(
          `select schemaname, tablename, policyname, roles, cmd, qual
             from pg_policies
            where schemaname in ('content', 'taxonomy')
              and policyname = any($1::text[])
            order by schemaname, tablename, policyname`,
          [[...CONTENT_EXPORT_READ_POLICIES.map(([, policy]) => policy),
            ...(taxonomyExportSchema ? TAXONOMY_EXPORT_READ_POLICIES.map(([, policy]) => policy) : [])]],
        );
        const workerPolicies = policies.rows;
        const actualPolicies = workerPolicies.map((row) => [
          row["tablename"], row["policyname"], row["cmd"], String(row["roles"]),
        ]);
        const expectedPolicies = [
          ...CONTENT_EXPORT_READ_POLICIES,
          ...(taxonomyExportSchema ? TAXONOMY_EXPORT_READ_POLICIES : []),
        ].map(([table, policy, command, roles]) => [table, policy, command, roles]);
        expect(actualPolicies).toHaveLength(expectedPolicies.length);
        expect(actualPolicies).toEqual(expect.arrayContaining(expectedPolicies));
        expect(workerPolicies.every((row) => typeof row["qual"] === "string" &&
          String(row["qual"]).includes("owner_export_scope_is_valid"))).toBe(true);

        const tables = await admin.query(
          `select n.nspname || '.' || c.relname as table_name, c.relrowsecurity, c.relforcerowsecurity,
                  has_table_privilege('shipwithali_worker', c.oid, 'select') as can_read,
                  has_table_privilege('shipwithali_worker', c.oid, 'insert') as can_insert,
                  has_table_privilege('shipwithali_worker', c.oid, 'update') as can_update,
                  has_table_privilege('shipwithali_worker', c.oid, 'delete') as can_delete
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where (n.nspname = 'content' and c.relname = any($1::text[]))
               or (n.nspname = 'taxonomy' and c.relname = any($2::text[]))
            order by n.nspname, c.relname`,
          [[...CONTENT_EXPORT_READ_POLICIES.filter(([table]) => table !== "roots").map(([table]) => table),
            ...(taxonomyExportSchema ? ["project_taxonomy_assignment_history"] : [])],
            taxonomyExportSchema ? [...new Set(TAXONOMY_EXPORT_READ_POLICIES.filter(([, policy]) => policy !== "project_taxonomy_assignment_history_worker_owner_export").map(([table]) => table))] : ["roots"]],
        );
        const expectedTableCount = new Set([
          ...CONTENT_EXPORT_READ_POLICIES.filter(([table]) => table !== "roots").map(([table]) => `content.${table}`),
          ...(taxonomyExportSchema ? ["content.project_taxonomy_assignment_history"] : []),
          ...(taxonomyExportSchema ? TAXONOMY_EXPORT_READ_POLICIES.filter(([, policy]) => policy !== "project_taxonomy_assignment_history_worker_owner_export").map(([table]) => `taxonomy.${table}`) : ["taxonomy.roots"]),
        ]).size;
        expect(tables.rows).toHaveLength(expectedTableCount);
        expect(tables.rows.every((row) => row["relrowsecurity"] === true && row["relforcerowsecurity"] === true &&
          row["can_read"] === true && row["can_insert"] === false && row["can_update"] === false &&
          row["can_delete"] === false)).toBe(true);

        const scopeFunction = await admin.query(
          `select p.prosecdef as security_definer,
                  has_function_privilege('shipwithali_worker', p.oid, 'execute') as worker_execute,
                  has_function_privilege('shipwithali_application', p.oid, 'execute') as application_execute,
                  has_function_privilege('shipwithali_backup', p.oid, 'execute') as backup_execute
             from pg_proc p
            where p.oid = to_regprocedure('content.owner_export_scope_is_valid(uuid)')`,
        );
        expect(scopeFunction.rows).toHaveLength(1);
        expect(scopeFunction.rows[0]?.["security_definer"]).toBe(false);
        expect(scopeFunction.rows[0]?.["worker_execute"]).toBe(true);
        expect(scopeFunction.rows[0]?.["application_execute"]).toBe(false);
        expect(scopeFunction.rows[0]?.["backup_execute"]).toBe(false);
        if (taxonomyExportSchema) {
          const taxonomyFunction = await admin.query(
            `select p.prosecdef as security_definer,
                    has_function_privilege('shipwithali_worker', p.oid, 'execute') as worker_execute,
                    has_function_privilege('shipwithali_application', p.oid, 'execute') as application_execute,
                    has_function_privilege('shipwithali_backup', p.oid, 'execute') as backup_execute
               from pg_proc p
              where p.oid = to_regprocedure('taxonomy.owner_export_scope_is_valid(uuid)')`,
          );
          expect(taxonomyFunction.rows).toHaveLength(1);
          expect(taxonomyFunction.rows[0]?.["security_definer"]).toBe(false);
          expect(taxonomyFunction.rows[0]?.["worker_execute"]).toBe(true);
          expect(taxonomyFunction.rows[0]?.["application_execute"]).toBe(false);
          expect(taxonomyFunction.rows[0]?.["backup_execute"]).toBe(false);
        }
      } finally {
        await admin.end();
      }
    });
  }

  if (portabilityExportSchema) {
    it("publishes the declared portability owner-export policies (#238)", async () => {
      const admin = adminClient();
      await admin.connect();
      try {
        const portability = await admin.query(
          `select tablename, policyname, roles, cmd
             from pg_policies
            where schemaname = 'portability' and tablename = 'owner_exports'
            order by policyname`,
        );
        expect(
          portability.rows.map((row) => [
            row["tablename"],
            row["policyname"],
            row["cmd"],
            String(row["roles"]),
          ]),
        ).toEqual([...PORTABILITY_EXPORT_POLICIES].sort((left, right) => left[1].localeCompare(right[1])));
        const jobs = await admin.query(
          `select tablename, policyname, roles, cmd
             from pg_policies
            where schemaname = 'operations' and tablename = 'jobs'
              and policyname in ('owner_export_jobs_application_insert')
            order by policyname`,
        );
        expect(
          jobs.rows.map((row) => [
            row["tablename"],
            row["policyname"],
            row["cmd"],
            String(row["roles"]),
          ]),
        ).toEqual(OWNER_EXPORT_JOB_POLICIES);
        const rel = await admin.query(
          `select c.relrowsecurity, c.relforcerowsecurity
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'portability' and c.relname = 'owner_exports'`,
        );
        expect(rel.rows).toHaveLength(1);
        expect(rel.rows[0]?.["relrowsecurity"]).toBe(true);
        expect(rel.rows[0]?.["relforcerowsecurity"]).toBe(true);
      } finally {
        await admin.end();
      }
    });
  }

  it("ships no privilege-elevated functions in Phase 3 operations", async () => {
    const admin = adminClient();
    await admin.connect();
    try {
      const elevated = await admin.query(
        `select n.nspname, p.proname
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'operations'
            and p.prosecdef
          order by n.nspname, p.proname`,
      );
      expect(elevated.rows).toEqual([]);
    } finally {
      await admin.end();
    }
    expect(phase3MigrationSources().toLowerCase()).not.toMatch(/security\s+definer/);
  });

  it("keeps migration and backup capabilities out of application runtime configuration", () => {
    const configuration = readFileSync(join(ROOT, "src", "bootstrap", "configuration.ts"), "utf8");
    const composition = readFileSync(join(ROOT, "src", "bootstrap", "composition-root.ts"), "utf8");
    for (const source of [configuration, composition]) {
      expect(source).not.toMatch(/env\["DATABASE_DIRECT_URL"\]/);
      expect(source).not.toMatch(/shipwithali_migration/);
      expect(source).not.toMatch(/shipwithali_backup/);
    }
    expect(composition).toMatch(/env\["DATABASE_URL"\]/);
  });

  it("grants executor membership only to the migration role", () => {
    const sources = migrationSources().toLowerCase();
    expect(sources).toMatch(/grant shipwithali_migration to current_user/);
    expect(sources).not.toMatch(/grant\s+.+\s+to\s+(?:anon|authenticated)/);
    expect(sources).not.toMatch(/grant\s+shipwithali_(?:application|worker|backup)\s+to\s+current_user/);
  });
});
