// Shared declarative source of truth for Phase 3Ã¢â‚¬â€œ8 database validation.
//
// Every historical checkpoint, migration boundary, reviewed operations-contract
// transformation, and paired database check is declared here. Historical gates
// consume this registry instead of holding ticket-specific hard-coded
// exceptions, so a future reviewed migration extends the contract through this
// file Ã¢â‚¬â€ never by editing historical checkers. A migration without a reviewed
// registry entry fails contract pairing before any expensive service startup.
//
// Registry rows are reviewed in pull requests: see
// docs/agents/validation-setup.md ("Phase contract registry") before editing.
import { migrationSha256 } from "./migration-checksum.mjs";
import { readFileSync } from "node:fs";

export const PHASE3_BASELINE_PATH = "supabase/baselines/phase3.json";
export const PHASE4_RELEASE_BOUNDARY = "20261005001318_create_content_authoring.sql";
export const PHASE5_MIGRATION_FIRST = "20261005001318_create_content_authoring.sql";
export const PHASE5_MIGRATION_LAST = "20261009100000_index_project_discovery_reads.sql";

// Positional phases every migration belongs to exactly once:
//   baseline | phase4-release | phase5 | operations-transformation | declared-additive
export const MIGRATION_CLASSIFICATIONS = Object.freeze([
  "baseline", "phase4-release", "phase5", "operations-transformation", "declared-additive",
]);

// Reviewed Phase 4 release admissions between the Phase 3 baseline and the
// Phase 5 boundary (the historical Phase 4 release, PR #105).
export const PHASE4_RELEASE_MIGRATION_COMPATIBILITY = Object.freeze({
  "20261001220000_create_identity_access_owner_links.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds the Owner identity link table; existing Phase 3 operations writes remain valid.",
  },
  "20261002120000_create_portfolio_configuration_settings.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds the Owner portfolio configuration aggregate with forced RLS; existing Phase 3 writes remain valid.",
  },
  "20261002130000_allow_versioned_portfolio_profile_updates.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds the versioned profile-update command; no prior contract changes.",
  },
  "20261002140000_allow_owner_contact_channel_replacement.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds the atomic channel-replacement command; no prior contract changes.",
  },
  "20261002150000_allow_versioned_portfolio_cta_updates.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds the versioned global CTA-update command; no prior contract changes.",
  },
});

// Reviewed Phase 5 additive content migrations. The full compatibility boundary
// for the historical Phase 5 range lives here.
export const PHASE5_MIGRATION_COMPATIBILITY = Object.freeze({
  "20261005001318_create_content_authoring.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds new content item and immutable revision tables; existing Phase 4 write paths are unchanged.",
  },
  "20261007090000_add_immutable_content_revision_reviews.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds review storage and revision identity uniqueness; existing content writes remain valid.",
  },
  "20261007170000_add_project_publication_routes.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds route, publication, history, and discovery tables without removing the previous content contract.",
  },
  "20261007190000_add_achievement_publication_timeline.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Broadens publication kinds and relaxes route identity for non-Project content; Project publications still require a route identity.",
  },
  "20261007200000_publish_localized_testimonials.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds testimonial publication and projection tables without changing existing write requirements.",
  },
  "20261008090000_preserve_project_route_history.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds immutable route history and broadens Owner discovery scope for lifecycle management.",
  },
  "20261008120000_add_content_lifecycle_history.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds an append-only lifecycle history table; existing content rows and writes remain valid.",
  },
  "20261008130000_add_project_status_and_featured.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds nullable status references and default-false Featured columns; existing Project inserts retain valid defaults.",
  },
  "20261008180000_add_project_relationships.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds relationship, view, and history tables without changing existing content writes.",
  },
  "20261008210000_provision_project_taxonomies.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds Taxonomy and assignment tables plus nullable discovery projection fields; existing Project writes remain valid.",
  },
  "20261009090000_record_taxonomy_evolution_actor_reason.sql": {
    stage: "lockstep", priorWriterCompatible: false,
    boundary: "The new history check requires Owner actor IDs for rename, retire, and merge writes. Deploy the actor-aware #120 writer with this migration and do not keep older actor-less writers online.",
  },
  "20261009100000_index_project_discovery_reads.sql": {
    stage: "expand", priorWriterCompatible: true,
    boundary: "Adds two indexes only; no application contract changes.",
  },
});

// Reviewed transformations of the historical Phase 3 operations contract.
// A transformation is the only sanctioned way a later migration may change the
// Phase 3 operations contract (constraints, indexes, columns, RLS, policies,
// grants). Every delta outside these declarations must survive byte-for-byte.
const OPERATIONS_EXPECTATION_PATH = new URL("./validation-contracts/operations-transformations.json", import.meta.url);
const OPERATIONS_EXPECTATIONS = JSON.parse(readFileSync(OPERATIONS_EXPECTATION_PATH, "utf8"));

// Each entry is a checked-in, reviewed set of complete catalog row replacements
// captured from the immutable canonical migration sequence. The expectation is
// checksum-bound and is never learned from a database under validation.
export const PHASE_DATABASE_TRANSFORMATIONS = Object.freeze([
  ...OPERATIONS_EXPECTATIONS.transformations.map((expectation) => Object.freeze({
    ...expectation,
    migrationSha256: OPERATIONS_EXPECTATIONS.source.migrations[expectation.migration],
  })),
]);

// Reviewed admissions for the later feature migrations. Every migration after
// the Phase 5 boundary must be declared here exactly once; pairing validation
// fails closed on an undeclared or duplicated file.
export const PHASE_DECLARED_ADDITIVE_MIGRATIONS = Object.freeze([
  Object.freeze({ migration: "20261010100000_create_private_media_upload_intents.sql", ticket: 146, capability: "media.upload_intents" }),
  Object.freeze({ migration: "20261010200000_record_trusted_pdf_processing.sql", ticket: 148, capability: "media.pdf_processing" }),
  Object.freeze({ migration: "20261011210000_harden_trusted_pdf_processing.sql", ticket: 149, capability: "media.pdf_processing" }),
  Object.freeze({ migration: "20261011220000_record_bounded_video_variants.sql", ticket: 151, capability: "media.video_processing" }),
  Object.freeze({ migration: "20261011230000_process_bounded_media_image_variants.sql", ticket: 150, capability: "media.image_processing" }),
  Object.freeze({ migration: "20261012000000_restore_video_variant_policy_after_images.sql", ticket: 150, capability: "media.image_processing" }),
  Object.freeze({ migration: "20261012010000_accept_media_with_editorial_accessibility.sql", ticket: 152, capability: "media.acceptance" }),
  Object.freeze({ migration: "20261012020000_index_current_visible_media_references.sql", ticket: 153, capability: "media.publication" }),
  Object.freeze({ migration: "20261012030000_initialize_cv_portfolio_register_english_versions.sql", ticket: 154, capability: "cv.registration" }),
  Object.freeze({ migration: "20261012040000_accept_registered_cv_versions.sql", ticket: 155, capability: "cv.acceptance" }),
  Object.freeze({ migration: "20261012050000_activate_current_cv_atomically.sql", ticket: 156, capability: "cv.activation" }),
  Object.freeze({ migration: "20261012060000_reject_media_with_usage_guard.sql", ticket: 157, capability: "media.rejection" }),
  Object.freeze({ migration: "20261013100000_configure_public_profile_media.sql", ticket: 158, capability: "media.public_delivery" }),
  Object.freeze({ migration: "20261014194925_measurement_consent.sql", ticket: 189, capability: "measurement.consent" }),
  Object.freeze({ migration: "20261014210000_persist_project_reactions.sql", ticket: 190, capability: "interaction.reactions" }),
  Object.freeze({ migration: "20261014211320_persist_project_ratings.sql", ticket: 191, capability: "interaction.ratings" }),
  Object.freeze({ migration: "20261015003000_persist_private_feedback.sql", ticket: 192, capability: "interaction.feedback" }),
  Object.freeze({ migration: "20261015010000_retain_feedback_moderation.sql", ticket: 193, capability: "interaction.moderation" }),
  Object.freeze({ migration: "20261015093040_query_current_interaction_summaries.sql", ticket: 195, capability: "interaction.summaries" }),
  Object.freeze({ migration: "20261015120000_persist_consented_public_events.sql", ticket: 196, capability: "measurement.events" }),
  Object.freeze({ migration: "20261015130000_enable_public_interaction_event_facts.sql", ticket: 197, capability: "measurement.event_facts" }),
  Object.freeze({ migration: "20261015150000_enable_configuration_interaction_event_facts.sql", ticket: 198, capability: "measurement.event_facts" }),
  Object.freeze({ migration: "20261015160000_persist_immutable_analytics_goal_versions.sql", ticket: 199, capability: "measurement.goal_versions" }),
  Object.freeze({ migration: "20261015170000_activate_analytics_goal_versions.sql", ticket: 200, capability: "measurement.goal_versions" }),
  Object.freeze({ migration: "20261015180000_match_analytics_goal_conversions.sql", ticket: 201, capability: "measurement.goal_conversions" }),
  Object.freeze({ migration: "20261015190000_persist_reproducible_daily_aggregates.sql", ticket: 202, capability: "measurement.aggregates" }),
  Object.freeze({ migration: "20261015200000_enable_fixed_aggregate_dimensions.sql", ticket: 202, capability: "measurement.aggregates" }),
  Object.freeze({ migration: "20261015202000_expire_measurement_detail_and_aggregate_retention.sql", ticket: 204, capability: "measurement.retention" }),
  Object.freeze({ migration: "20261015203000_retain_feedback_privacy.sql", ticket: 205, capability: "measurement.retention" }),
  Object.freeze({ migration: "20261017142000_revoke_public_aggregate_guard_execution.sql", ticket: 203, capability: "measurement.aggregate_privacy" }),
  Object.freeze({ migration: "20261018172500_bound_job_retries_and_incidents.sql", ticket: 237, capability: "operations.bounded_retries" }),
  Object.freeze({ migration: "20261023090000_reserve_owner_export_requests.sql", ticket: 238, capability: "portability.owner_export_requests" }),
  Object.freeze({ migration: "20261024120000_read_content_for_owner_exports.sql", ticket: 241, capability: "portability.content_export", includeInDeclaredCapabilities: true }),
  Object.freeze({ migration: "20261024130000_read_taxonomy_for_owner_exports.sql", ticket: 242, capability: "portability.taxonomy_export", includeInDeclaredCapabilities: true }),
  Object.freeze({ migration: "20261024140000_read_media_for_owner_exports.sql", ticket: 243, capability: "portability.media_export", includeInDeclaredCapabilities: true }),
  Object.freeze({ migration: "20261024233915_owner_cv_export_read_access.sql", ticket: 244, capability: "portability.cv_export", includeInDeclaredCapabilities: true }),
  Object.freeze({ migration: "20261025090000_read_feedback_for_owner_exports.sql", ticket: 245, capability: "portability.feedback_export", includeInDeclaredCapabilities: true }),
  Object.freeze({ migration: "20261025190828_retain_moderation_export_artifact_cleanup.sql", ticket: 245, capability: "portability.feedback_export" }),
  Object.freeze({ migration: "20261025200000_read_measurement_for_owner_exports.sql", ticket: 246, capability: "portability.analytics_export", includeInDeclaredCapabilities: true }),
  Object.freeze({ migration: "20261026011341_restrict_analytics_export_deletion.sql", ticket: 246, capability: "portability.analytics_export" }),
  Object.freeze({ migration: "20261026100000_reconcile_all_owner_export_artifacts.sql", ticket: 247, capability: "portability.owner_export_cleanup" }),
  Object.freeze({
    migration: "20261026164603_phase7_durable_policy_schedule_keys.sql",
    migrationSha256: "cdd65060a1363d35f93f76c289950e69b26ebb04f718f12fe0cf3563f75668ab",
    ticket: 248,
    capability: "operations.phase7_durable_schedules",
    includeInDeclaredCapabilities: true,
    operationsAdditions: Object.freeze([
      Object.freeze({ category: "columns", identity: "operations.jobs.semantic_scope_id",
        expected: Object.freeze({ schema: "operations", tableName: "jobs", name: "semantic_scope_id", type: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.jobs.semantic_period",
        expected: Object.freeze({ schema: "operations", tableName: "jobs", name: "semantic_period", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.jobs.work_incomplete",
        expected: Object.freeze({ schema: "operations", tableName: "jobs", name: "work_incomplete", type: "boolean", typeSchema: "pg_catalog", typeName: "bool", nullable: "YES", default: "false" }) }),
      Object.freeze({ category: "constraints", identity: "operations.jobs.jobs_semantic_schedule_pair_check",
        expected: Object.freeze({ schema: "operations", tableName: "jobs", name: "jobs_semantic_schedule_pair_check", type: "c", validated: true,
          definition: "CHECK (semantic_scope_id IS NULL AND semantic_period IS NULL OR semantic_scope_id IS NOT NULL AND semantic_period ~ '^\\d{4}-\\d{2}-\\d{2}(:\\d{4}-\\d{2}-\\d{2})?$'::text)" }) }),
      Object.freeze({ category: "indexes", identity: "operations.jobs.jobs_semantic_schedule_once",
        expected: Object.freeze({ schema: "operations", table: "jobs", name: "jobs_semantic_schedule_once",
          definition: "CREATE UNIQUE INDEX jobs_semantic_schedule_once ON operations.jobs USING btree (semantic_scope_id, job_type, semantic_period) WHERE (semantic_scope_id IS NOT NULL)" }) }),
      Object.freeze({ category: "indexes", identity: "operations.jobs.jobs_policy_period_status_idx",
        expected: Object.freeze({ schema: "operations", table: "jobs", name: "jobs_policy_period_status_idx",
          definition: "CREATE INDEX jobs_policy_period_status_idx ON operations.jobs USING btree (semantic_scope_id, semantic_period, job_type) INCLUDE (status, work_incomplete) WHERE ((semantic_scope_id IS NOT NULL) AND (job_type = ANY (ARRAY['measurement.daily-aggregate.v1'::text, 'measurement.detail-retention.v1'::text, 'measurement.aggregate-retention.v1'::text, 'measurement.withdrawal-cleanup.v1'::text, 'interaction.feedback-retention.v1'::text])))" }) }),
      Object.freeze({ category: "objects", identity: "operations.phase7_schedule_progress",
        expected: Object.freeze({ schema: "operations", name: "phase7_schedule_progress", kind: "r",
          owner: "shipwithali_migration", rlsEnabled: true, rlsForced: true }) }),
      ...[
        ["portfolio_id", "uuid", "uuid"],
        ["first_policy_period", "date", "date"],
        ["required_through_period", "date", "date"],
        ["retention_scheduled_through", "date", "date"],
        ["retention_complete_through", "date", "date"],
        ["aggregate_scheduled_through", "date", "date"],
        ["aggregate_finished_through", "date", "date"],
        ["last_complete_period", "date", "date"],
        ["phase", "text", "text"],
        ["updated_at", "timestamp with time zone", "timestamptz"],
      ].map(([name, type, typeName]) => Object.freeze({ category: "columns",
        identity: `operations.phase7_schedule_progress.${name}`,
        expected: Object.freeze({ schema: "operations", tableName: "phase7_schedule_progress", name,
          type, typeSchema: "pg_catalog", typeName, nullable: "NO",
          default: name === "phase" ? "'retention'::text" : name === "updated_at" ? "clock_timestamp()" : null }) })),
      ...[
        ["phase7_schedule_progress_pkey", "p", "PRIMARY KEY (portfolio_id)"],
        ["phase7_schedule_progress_phase_check", "c", "CHECK (phase = ANY (ARRAY['retention'::text, 'aggregate'::text]))"],
        ["phase7_schedule_progress_bounds_check", "c", "CHECK (required_through_period >= (first_policy_period - 1) AND retention_scheduled_through >= (first_policy_period - 1) AND retention_complete_through >= (first_policy_period - 1) AND aggregate_scheduled_through >= (first_policy_period - 1) AND aggregate_finished_through >= (first_policy_period - 1) AND last_complete_period >= (first_policy_period - 1) AND retention_complete_through <= retention_scheduled_through AND aggregate_scheduled_through <= retention_complete_through AND aggregate_finished_through <= aggregate_scheduled_through AND aggregate_finished_through <= retention_complete_through AND last_complete_period <= aggregate_finished_through AND last_complete_period <= aggregate_scheduled_through AND last_complete_period <= retention_complete_through)"],
      ].map(([name, type, definition]) => Object.freeze({ category: "constraints",
        identity: `operations.phase7_schedule_progress.${name}`,
        expected: Object.freeze({ schema: "operations", tableName: "phase7_schedule_progress", name, type, validated: true, definition }) })),
      Object.freeze({ category: "indexes", identity: "operations.phase7_schedule_progress.phase7_schedule_progress_pkey",
        expected: Object.freeze({ schema: "operations", table: "phase7_schedule_progress", name: "phase7_schedule_progress_pkey",
          definition: "CREATE UNIQUE INDEX phase7_schedule_progress_pkey ON operations.phase7_schedule_progress USING btree (portfolio_id)" }) }),
      ...[
        ["phase7_schedule_progress_worker_select", "SELECT", "true", ""],
        ["phase7_schedule_progress_worker_insert", "INSERT", "", "true"],
        ["phase7_schedule_progress_worker_update", "UPDATE", "true", "true"],
        ["operations_backup_policy_phase7_schedule_progress", "SELECT", "true", ""],
      ].map(([name, command, usingPredicate, withCheck]) => {
        const backup = name.startsWith("operations_backup_policy");
        return Object.freeze({ category: "policies", identity: `operations.phase7_schedule_progress.${name}`,
          expected: Object.freeze({ schema: "operations", tableName: "phase7_schedule_progress", name,
            permissive: "permissive", roles: backup ? "{shipwithali_backup}" : "{shipwithali_worker}",
            command, usingPredicate, withCheck }) });
      }),
      ...[
        ["shipwithali_worker", "INSERT"], ["shipwithali_worker", "SELECT"], ["shipwithali_worker", "UPDATE"],
        ["shipwithali_backup", "SELECT"],
        ...["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]
          .map((privilege) => ["shipwithali_migration", privilege]),
      ].map(([grantee, privilege]) => Object.freeze({ category: "grants",
        identity: `operations.phase7_schedule_progress.r.${grantee}:shipwithali_migration:${privilege}`,
        expected: Object.freeze({ schema: "operations", object: "phase7_schedule_progress", objectType: "r",
          grantee, grantor: "shipwithali_migration", privilege, grantable: false }) })),
    ]),
    operationsAdditionsByEngine: Object.freeze({
      "17": Object.freeze([]),
      "18": Object.freeze([
        "portfolio_id", "first_policy_period", "required_through_period", "retention_scheduled_through",
        "retention_complete_through", "aggregate_scheduled_through", "aggregate_finished_through",
        "last_complete_period", "phase", "updated_at",
      ].map((column) => Object.freeze({ category: "constraints",
        identity: `operations.phase7_schedule_progress.phase7_schedule_progress_${column}_not_null`,
        expected: Object.freeze({ schema: "operations", tableName: "phase7_schedule_progress",
          name: `phase7_schedule_progress_${column}_not_null`, type: "n", validated: true,
          definition: `NOT NULL ${column}` }) }))),
    }),
  }),
  Object.freeze({
    migration: "20261027014402_operations_observability_summary_indexes.sql",
    migrationSha256: "792f546244568e0f245dbcefe2042de151cec10bff8c58a26d521dd98e569511",
    ticket: 251,
    capability: "operations.observability",
    includeInDeclaredCapabilities: true,
    operationsAdditions: Object.freeze([
      ...[["outbox_events", "timestamptz"], ["jobs", "timestamptz"]].map(([tableName, typeName]) =>
        Object.freeze({ category: "columns", identity: `operations.${tableName}.lease_acquired_at`,
          expected: Object.freeze({ schema: "operations", tableName, name: "lease_acquired_at",
            type: "timestamp with time zone", typeSchema: "pg_catalog", typeName, nullable: "YES", default: null }) })),
      ...[
        ["outbox_events_operational_summary_dead_idx", "outbox_events",
          "CREATE INDEX outbox_events_operational_summary_dead_idx ON operations.outbox_events USING btree (dead_at, event_id) INCLUDE (attempt_count) WHERE (dead_at IS NOT NULL)"],
        ["outbox_events_operational_summary_retry_idx", "outbox_events",
          "CREATE INDEX outbox_events_operational_summary_retry_idx ON operations.outbox_events USING btree (available_at, occurred_at, event_id) INCLUDE (attempt_count) WHERE ((completed_at IS NULL) AND (dead_at IS NULL) AND (attempt_count > 0))"],
        ["outbox_events_operational_summary_lease_idx", "outbox_events",
          "CREATE INDEX outbox_events_operational_summary_lease_idx ON operations.outbox_events USING btree (lease_expires_at, event_id) INCLUDE (available_at, attempt_count, lease_acquired_at) WHERE ((lease_expires_at IS NOT NULL) AND (completed_at IS NULL) AND (dead_at IS NULL))"],
        ["outbox_events_operational_summary_eligible_idx", "outbox_events",
          "CREATE INDEX outbox_events_operational_summary_eligible_idx ON operations.outbox_events USING btree (occurred_at, event_id) INCLUDE (available_at, attempt_count, lease_expires_at, lease_acquired_at) WHERE ((completed_at IS NULL) AND (dead_at IS NULL))"],
        ["jobs_operational_summary_status_idx", "jobs",
          "CREATE INDEX jobs_operational_summary_status_idx ON operations.jobs USING btree (status, available_at, job_id) INCLUDE (attempt_count, lease_expires_at) WHERE (status = ANY (ARRAY['available'::text, 'leased'::text, 'dead'::text]))"],
        ["jobs_operational_summary_dead_idx", "jobs",
          "CREATE INDEX jobs_operational_summary_dead_idx ON operations.jobs USING btree (available_at, job_id) INCLUDE (attempt_count) WHERE (status = 'dead'::text)"],
        ["jobs_operational_summary_lease_idx", "jobs",
          "CREATE INDEX jobs_operational_summary_lease_idx ON operations.jobs USING btree (lease_expires_at, job_id) INCLUDE (attempt_count, lease_acquired_at) WHERE (status = 'leased'::text)"],
      ].map(([name, table, definition]) => Object.freeze({ category: "indexes",
        identity: `${table === "owner_exports" ? "portability" : "operations"}.${table}.${name}`,
        expected: Object.freeze({ schema: table === "owner_exports" ? "portability" : "operations", table, name, definition }) })),
    ]),
    portabilityAdditions: Object.freeze([
      Object.freeze({ category: "indexes", identity: "portability.owner_exports.owner_exports_operational_summary_recent_idx",
        expected: Object.freeze({ schema: "portability", table: "owner_exports", name: "owner_exports_operational_summary_recent_idx",
          definition: "CREATE INDEX owner_exports_operational_summary_recent_idx ON portability.owner_exports USING btree (portfolio_id, status, requested_at DESC, export_id DESC) INCLUDE (started_at, completed_at, artifact_content_length)" }) }),
      ...[
        ["owner_exports_operational_summary_ready_idx", "completed_at", "ready", "started_at, artifact_content_length"],
        ["owner_exports_operational_summary_failed_idx", "failed_at", "failed", null],
        ["owner_exports_operational_summary_expired_idx", "expired_at", "expired", null],
      ].map(([name, timestamp, status, include]) => Object.freeze({ category: "indexes",
        identity: `portability.owner_exports.${name}`, expected: Object.freeze({ schema: "portability", table: "owner_exports", name,
          definition: `CREATE INDEX ${name} ON portability.owner_exports USING btree (portfolio_id, ${timestamp} DESC, export_id DESC)${include === null ? "" : ` INCLUDE (${include})`} WHERE ((status = '${status}'::text) AND (${timestamp} IS NOT NULL))` }) })),
    ]),
  }),
  Object.freeze({
    migration: "20261029120000_actionable_incident_delivery.sql",
    migrationSha256: "9bb0b260a3831f9cd376f07deb707f38a447600458e491e0514573d92b3ebc9c",
    ticket: 252, capability: "operations.incident_delivery", includeInDeclaredCapabilities: true,
    operationsAdditions: Object.freeze([
      ...[
        ["measured_value", 11, "numeric", "numeric", "YES", null],
        ["threshold_value", 12, "numeric", "numeric", "YES", null],
        ["measurement_unit", 13, "text", "text", "YES", null],
        ["measurement_window_seconds", 14, "integer", "int4", "YES", null],
        ["owner_role", 15, "text", "text", "NO", "'operations'::text"],
        ["remediation_pointer", 16, "text", "text", "NO", "'runbook:operations/general'::text"],
        ["delivery_state", 17, "text", "text", "NO", "'pending'::text"],
        ["delivery_attempts", 18, "smallint", "int2", "NO", "0"],
        ["next_delivery_at", 19, "timestamp with time zone", "timestamptz", "YES", "clock_timestamp()"],
        ["delivery_lease_token", 20, "uuid", "uuid", "YES", null],
        ["delivery_lease_generation", 21, "bigint", "int8", "NO", "0"],
        ["delivery_lease_expires_at", 22, "timestamp with time zone", "timestamptz", "YES", null],
        ["delivery_error_code", 23, "text", "text", "YES", null],
        ["recovery_recorded_at", 24, "timestamp with time zone", "timestamptz", "YES", null],
        ["environment", 25, "text", "text", "NO", "'unknown'::text"],
        ["measurement_is_lower_bound", 26, "boolean", "bool", "NO", "false"],
      ].map(([name, position, type, typeName, nullable, defaultValue]) => Object.freeze({
        category: "columns", identity: `operations.incidents.${name}`,
        expected: Object.freeze({ schema: "operations", tableName: "incidents", name, position, type,
          typeSchema: "pg_catalog", typeName, nullable, default: defaultValue }),
      })),
      ...[
        ["incidents_measured_value_check", "CHECK (measured_value IS NULL OR measured_value >= 0::numeric)"],
        ["incidents_threshold_value_check", "CHECK (threshold_value IS NULL OR threshold_value >= 0::numeric)"],
        ["incidents_measurement_unit_check", "CHECK (measurement_unit IS NULL OR (measurement_unit = ANY (ARRAY['seconds'::text, 'milliseconds'::text, 'hours'::text, 'percent'::text, 'count'::text])))"],
        ["incidents_measurement_window_seconds_check", "CHECK (measurement_window_seconds IS NULL OR measurement_window_seconds >= 0 AND measurement_window_seconds <= 604800)"],
        ["incidents_owner_role_check", "CHECK (owner_role = ANY (ARRAY['operations'::text, 'content'::text, 'measurement'::text, 'backup'::text, 'identity'::text]))"],
        ["incidents_remediation_pointer_check", "CHECK (remediation_pointer ~ '^runbook:[a-z0-9/_-]{3,120}$'::text)"],
        ["incidents_delivery_state_check", "CHECK (delivery_state = ANY (ARRAY['pending'::text, 'delivered'::text, 'exhausted'::text, 'not-required'::text]))"],
        ["incidents_delivery_attempts_check", "CHECK (delivery_attempts >= 0 AND delivery_attempts <= 8)"],
        ["incidents_environment_check", "CHECK (environment = ANY (ARRAY['unknown'::text, 'local'::text, 'test'::text, 'staging'::text, 'production'::text]))"],
        ["incidents_delivery_error_code_check", "CHECK (delivery_error_code IS NULL OR delivery_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'::text)"],
        ["incidents_delivery_lease_generation_check", "CHECK (delivery_lease_generation >= 0)"],
        ["incidents_delivery_lease_pair_check", "CHECK (delivery_lease_token IS NULL AND delivery_lease_expires_at IS NULL OR delivery_lease_token IS NOT NULL AND delivery_lease_expires_at IS NOT NULL AND resolved_at IS NULL AND delivery_state = 'pending'::text)"],
      ].map(([name, definition]) => Object.freeze({ category: "constraints", identity: `operations.incidents.${name}`,
        expected: Object.freeze({ schema: "operations", tableName: "incidents", name, type: "c", validated: true, definition }) })),
      Object.freeze({ category: "indexes", identity: "operations.incidents.incidents_delivery_due_idx",
        expected: Object.freeze({ schema: "operations", table: "incidents", name: "incidents_delivery_due_idx",
          definition: "CREATE INDEX incidents_delivery_due_idx ON operations.incidents USING btree (next_delivery_at, incident_id) WHERE ((resolved_at IS NULL) AND (delivery_state = 'pending'::text))" }) }),
      ...["first_observed_at", "severity", "environment", "measurement_is_lower_bound", "measured_value", "threshold_value", "measurement_unit", "measurement_window_seconds", "owner_role", "remediation_pointer",
        "delivery_state", "delivery_attempts", "next_delivery_at", "delivery_lease_token", "delivery_lease_generation",
        "delivery_lease_expires_at", "delivery_error_code", "recovery_recorded_at"].map((column) => Object.freeze({
        // Match the established snapshot representation of column ACLs (internal char 'c').
        category: "grants", identity: `operations.incidents.${column}.c.shipwithali_worker:shipwithali_migration:UPDATE`,
        expected: Object.freeze({ schema: "operations", object: `incidents.${column}`, objectType: "c",
          grantee: "shipwithali_worker", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }),
      })),
    ]),
    operationsAdditionsByEngine: Object.freeze({
      "17": Object.freeze([]),
      "18": Object.freeze(["owner_role", "remediation_pointer", "delivery_state", "delivery_attempts", "delivery_lease_generation", "environment", "measurement_is_lower_bound"]
        .map((column) => Object.freeze({ category: "constraints", identity: `operations.incidents.incidents_${column}_not_null`,
          expected: Object.freeze({ schema: "operations", tableName: "incidents", name: `incidents_${column}_not_null`,
            type: "n", validated: true, definition: `NOT NULL ${column}` }) }))),
    }),
  }),
  Object.freeze({
    migration: "20261029150000_register_relational_backup_copies.sql",
    migrationSha256: "f29bb017d9b2344764223df3df0820a075b8d647177f94eb9b1ad142fba9bcde",
    ticket: 253,
    capability: "operations.relational_backup",
    includeInDeclaredCapabilities: true,
    operationsAdditions: Object.freeze([
      Object.freeze({ category: "objects", identity: "operations.relational_backup_copies",
        expected: Object.freeze({ schema: "operations", name: "relational_backup_copies", kind: "r",
          owner: "shipwithali_migration", rlsEnabled: true, rlsForced: true }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.copy_id",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "copy_id", type: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.destination_name",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "destination_name", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.object_key",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "object_key", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.envelope_version",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "envelope_version", type: "smallint", typeSchema: "pg_catalog", typeName: "int2", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.algorithm",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "algorithm", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.key_version",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "key_version", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.dump_tool",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "dump_tool", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.source_watermark_at",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "source_watermark_at", type: "timestamp with time zone", typeSchema: "pg_catalog", typeName: "timestamptz", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.dump_bytes",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "dump_bytes", type: "bigint", typeSchema: "pg_catalog", typeName: "int8", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.ciphertext_bytes",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "ciphertext_bytes", type: "bigint", typeSchema: "pg_catalog", typeName: "int8", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.catalog_sha256",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "catalog_sha256", type: "character", typeSchema: "pg_catalog", typeName: "bpchar", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.ciphertext_sha256",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "ciphertext_sha256", type: "character", typeSchema: "pg_catalog", typeName: "bpchar", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.state",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "state", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.failure_code",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "failure_code", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.attempted_at",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "attempted_at", type: "timestamp with time zone", typeSchema: "pg_catalog", typeName: "timestamptz", nullable: "NO", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.verified_at",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "verified_at", type: "timestamp with time zone", typeSchema: "pg_catalog", typeName: "timestamptz", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.committed_at",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "committed_at", type: "timestamp with time zone", typeSchema: "pg_catalog", typeName: "timestamptz", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.retention_lifetime_hours",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "retention_lifetime_hours", type: "integer", typeSchema: "pg_catalog", typeName: "int4", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.expires_at",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "expires_at", type: "timestamp with time zone", typeSchema: "pg_catalog", typeName: "timestamptz", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.deletion_acknowledged_at",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "deletion_acknowledged_at", type: "timestamp with time zone", typeSchema: "pg_catalog", typeName: "timestamptz", nullable: "YES", default: null }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.incident_environment",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "incident_environment", type: "text", typeSchema: "pg_catalog", typeName: "text", nullable: "NO", default: "'unknown'::text" }) }),
      Object.freeze({ category: "columns", identity: "operations.relational_backup_copies.incident_job_id",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "incident_job_id", type: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: "YES", default: null }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_algorithm_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_algorithm_check", type: "c", validated: true,
          definition: "CHECK (algorithm = 'AES-256-GCM'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_catalog_sha256_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_catalog_sha256_check", type: "c", validated: true,
          definition: "CHECK (catalog_sha256 ~ '^[0-9a-f]{64}$'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_ciphertext_bytes_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_ciphertext_bytes_check", type: "c", validated: true,
          definition: "CHECK (ciphertext_bytes >= 0 AND ciphertext_bytes <= '1099511627776'::bigint)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_ciphertext_sha256_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_ciphertext_sha256_check", type: "c", validated: true,
          definition: "CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_committed_usable_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_committed_usable_check", type: "c", validated: true,
          definition: "CHECK (committed_at IS NULL OR state = 'usable'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_deletion_state_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_deletion_state_check", type: "c", validated: true,
          definition: "CHECK (deletion_acknowledged_at IS NULL OR (state = ANY (ARRAY['uploading'::text, 'usable'::text])))" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_destination_name_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_destination_name_check", type: "c", validated: true,
          definition: "CHECK (destination_name ~ '^[a-z][a-z0-9-]{2,47}$'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_dump_bytes_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_dump_bytes_check", type: "c", validated: true,
          definition: "CHECK (dump_bytes >= 0 AND dump_bytes <= '1099511627776'::bigint)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_dump_tool_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_dump_tool_check", type: "c", validated: true,
          definition: "CHECK (dump_tool ~ '^[A-Za-z0-9 ./+-]{4,120}$'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_envelope_version_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_envelope_version_check", type: "c", validated: true,
          definition: "CHECK (envelope_version = 1)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_expiry_lifecycle_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_expiry_lifecycle_check", type: "c", validated: true,
          definition: "CHECK (expires_at IS NULL OR retention_lifetime_hours IS NOT NULL)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_failure_code_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_failure_code_check", type: "c", validated: true,
          definition: "CHECK (failure_code IS NULL OR state = 'failed'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_failure_shape_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_failure_shape_check", type: "c", validated: true,
          definition: "CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_incident_environment_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_incident_environment_check", type: "c", validated: true,
          definition: "CHECK (incident_environment = ANY (ARRAY['unknown'::text, 'local'::text, 'test'::text, 'staging'::text, 'production'::text]))" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_key_version_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_key_version_check", type: "c", validated: true,
          definition: "CHECK (key_version ~ '^[a-z0-9][a-z0-9-]{1,47}$'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_object_key_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_object_key_check", type: "c", validated: true,
          definition: "CHECK (object_key ~ '^[a-z0-9][a-z0-9._/-]{9,239}$'::text)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_pkey",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_pkey", type: "p", validated: true,
          definition: "PRIMARY KEY (copy_id)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_retention_lifetime_hours_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_retention_lifetime_hours_check", type: "c", validated: true,
          definition: "CHECK (retention_lifetime_hours IS NULL OR retention_lifetime_hours >= 24 AND retention_lifetime_hours <= 8760)" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_state_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_state_check", type: "c", validated: true,
          definition: "CHECK (state = ANY (ARRAY['uploading'::text, 'usable'::text, 'failed'::text]))" }) }),
      Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_usable_verified_check",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_usable_verified_check", type: "c", validated: true,
          definition: "CHECK (state <> 'usable'::text OR verified_at IS NOT NULL AND committed_at IS NOT NULL AND deletion_acknowledged_at IS NULL)" }) }),
      Object.freeze({ category: "policies", identity: "operations.relational_backup_copies.operations_backup_policy_relational_backup_copies",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "operations_backup_policy_relational_backup_copies", permissive: "permissive",
          roles: "{shipwithali_backup}", command: "SELECT", usingPredicate: "true", withCheck: "" }) }),
      Object.freeze({ category: "policies", identity: "operations.relational_backup_copies.relational_backup_copies_backup_insert",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_backup_insert", permissive: "permissive",
          roles: "{shipwithali_backup}", command: "INSERT", usingPredicate: "", withCheck: "(state = 'uploading'::text)" }) }),
      Object.freeze({ category: "policies", identity: "operations.relational_backup_copies.relational_backup_copies_backup_update",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_backup_update", permissive: "permissive",
          roles: "{shipwithali_backup}", command: "UPDATE",
          usingPredicate: "((state = 'uploading'::text) OR ((state = 'usable'::text) AND (deletion_acknowledged_at IS NULL) AND (expires_at <= clock_timestamp())))",
          withCheck: "(((state = ANY (ARRAY['usable'::text, 'failed'::text])) AND (deletion_acknowledged_at IS NULL)) OR ((state = 'usable'::text) AND (deletion_acknowledged_at IS NOT NULL) AND (expires_at <= clock_timestamp())))" }) }),
      Object.freeze({ category: "policies", identity: "operations.relational_backup_copies.relational_backup_copies_worker_inspect",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_worker_inspect", permissive: "permissive",
          roles: "{shipwithali_worker}", command: "SELECT", usingPredicate: "true", withCheck: "" }) }),
      Object.freeze({ category: "policies", identity: "operations.incidents.relational_backup_incidents_insert",
        expected: Object.freeze({ schema: "operations", tableName: "incidents", name: "relational_backup_incidents_insert", permissive: "permissive",
          roles: "{shipwithali_backup}", command: "INSERT", usingPredicate: "",
          withCheck: "((category = 'backup'::text) AND (owner_role = 'backup'::text) AND (remediation_pointer = 'runbook:recovery/relational-backup'::text))" }) }),
      Object.freeze({ category: "policies", identity: "operations.incidents.relational_backup_incidents_update",
        expected: Object.freeze({ schema: "operations", tableName: "incidents", name: "relational_backup_incidents_update", permissive: "permissive",
          roles: "{shipwithali_backup}", command: "UPDATE",
          usingPredicate: "((category = 'backup'::text) AND (owner_role = 'backup'::text) AND (remediation_pointer = 'runbook:recovery/relational-backup'::text))",
          withCheck: "((category = 'backup'::text) AND (owner_role = 'backup'::text) AND (remediation_pointer = 'runbook:recovery/relational-backup'::text))" }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.state.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies.state", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.failure_code.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies.failure_code", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.verified_at.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies.verified_at", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.committed_at.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies.committed_at", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.deletion_acknowledged_at.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies.deletion_acknowledged_at", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.safe_error_code.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "incidents.safe_error_code", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.last_observed_at.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "incidents.last_observed_at", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.occurrences.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "incidents.occurrences", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.resolved_at.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "incidents.resolved_at", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.recovery_recorded_at.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "incidents.recovery_recorded_at", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.delivery_state.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "incidents.delivery_state", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.next_delivery_at.c.shipwithali_backup:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "incidents.next_delivery_at", objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_backup:shipwithali_migration:INSERT",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "INSERT", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_backup:shipwithali_migration:SELECT",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.incidents.r.shipwithali_backup:shipwithali_migration:INSERT",
        expected: Object.freeze({ schema: "operations", object: "incidents", objectType: "r",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "INSERT", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:DELETE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "DELETE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:INSERT",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "INSERT", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:MAINTAIN",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "MAINTAIN", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:REFERENCES",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "REFERENCES", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:SELECT",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:TRIGGER",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "TRIGGER", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:TRUNCATE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "TRUNCATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_migration:shipwithali_migration:UPDATE",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_migration", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.relational_backup_copies.r.shipwithali_worker:shipwithali_migration:SELECT",
        expected: Object.freeze({ schema: "operations", object: "relational_backup_copies", objectType: "r",
          grantee: "shipwithali_worker", grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }) }),
      Object.freeze({ category: "indexes", identity: "operations.relational_backup_copies.relational_backup_copies_current_idx",
        expected: Object.freeze({ schema: "operations", table: "relational_backup_copies", name: "relational_backup_copies_current_idx",
          definition: "CREATE INDEX relational_backup_copies_current_idx ON operations.relational_backup_copies USING btree (destination_name, committed_at DESC, copy_id) WHERE (state = 'usable'::text)" }) }),
      Object.freeze({ category: "indexes", identity: "operations.relational_backup_copies.relational_backup_copies_pkey",
        expected: Object.freeze({ schema: "operations", table: "relational_backup_copies", name: "relational_backup_copies_pkey",
          definition: "CREATE UNIQUE INDEX relational_backup_copies_pkey ON operations.relational_backup_copies USING btree (copy_id)" }) }),
      Object.freeze({ category: "indexes", identity: "operations.relational_backup_copies.relational_backup_copies_retention_idx",
        expected: Object.freeze({ schema: "operations", table: "relational_backup_copies", name: "relational_backup_copies_retention_idx",
          definition: "CREATE INDEX relational_backup_copies_retention_idx ON operations.relational_backup_copies USING btree (expires_at, copy_id) WHERE ((state = 'usable'::text) AND (deletion_acknowledged_at IS NULL))" }) }),
    ]),
    operationsAdditionsByEngine: Object.freeze({
      "17": Object.freeze([]),
      "18": Object.freeze([
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_algorithm_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_algorithm_not_null", type: "n", validated: true,
            definition: "NOT NULL algorithm" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_attempted_at_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_attempted_at_not_null", type: "n", validated: true,
            definition: "NOT NULL attempted_at" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_catalog_sha256_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_catalog_sha256_not_null", type: "n", validated: true,
            definition: "NOT NULL catalog_sha256" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_ciphertext_bytes_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_ciphertext_bytes_not_null", type: "n", validated: true,
            definition: "NOT NULL ciphertext_bytes" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_ciphertext_sha256_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_ciphertext_sha256_not_null", type: "n", validated: true,
            definition: "NOT NULL ciphertext_sha256" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_copy_id_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_copy_id_not_null", type: "n", validated: true,
            definition: "NOT NULL copy_id" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_destination_name_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_destination_name_not_null", type: "n", validated: true,
            definition: "NOT NULL destination_name" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_dump_bytes_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_dump_bytes_not_null", type: "n", validated: true,
            definition: "NOT NULL dump_bytes" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_dump_tool_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_dump_tool_not_null", type: "n", validated: true,
            definition: "NOT NULL dump_tool" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_envelope_version_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_envelope_version_not_null", type: "n", validated: true,
            definition: "NOT NULL envelope_version" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_incident_environment_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_incident_environment_not_null", type: "n", validated: true,
            definition: "NOT NULL incident_environment" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_key_version_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_key_version_not_null", type: "n", validated: true,
            definition: "NOT NULL key_version" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_object_key_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_object_key_not_null", type: "n", validated: true,
            definition: "NOT NULL object_key" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_source_watermark_at_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_source_watermark_at_not_null", type: "n", validated: true,
            definition: "NOT NULL source_watermark_at" }) }),
        Object.freeze({ category: "constraints", identity: "operations.relational_backup_copies.relational_backup_copies_state_not_null",
          expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_state_not_null", type: "n", validated: true,
            definition: "NOT NULL state" }) }),
      ]),
    }),
  }),
  Object.freeze({
    migration: "20261030100000_register_object_backup_copies.sql",
      migrationSha256: "072ccc6b900803d95ce6fa8d59daa348bf248c28f814b0c3629248e78dd27fdc",
    ticket: 254, capability: "operations.object_backup", includeInDeclaredCapabilities: true,
    operationsAdditions: Object.freeze([
      Object.freeze({ category: "objects", identity: "operations.object_backup_copies",
        expected: Object.freeze({ schema: "operations", name: "object_backup_copies", kind: "r", owner: "shipwithali_migration", rlsEnabled: true, rlsForced: true }) }),
      Object.freeze({ category: "objects", identity: "operations.object_backup_owner_scopes",
        expected: Object.freeze({ schema: "operations", name: "object_backup_owner_scopes", kind: "v", owner: "shipwithali_migration", rlsEnabled: false, rlsForced: false }) }),
      Object.freeze({ category: "objects", identity: "operations.backup_copy_metrics",
        expected: Object.freeze({ schema: "operations", name: "backup_copy_metrics", kind: "v", owner: "shipwithali_migration", rlsEnabled: false, rlsForced: false }) }),
      ...[
        ["copy_id",1,"uuid","uuid","NO",null], ["destination_name",2,"text","text","NO",null],
        ["object_key",3,"text","text","NO",null], ["envelope_version",4,"smallint","int2","NO",null],
        ["algorithm",5,"text","text","NO",null], ["key_version",6,"text","text","NO",null],
        ["source_watermark_at",7,"timestamp with time zone","timestamptz","NO",null],
        ["relational_watermark_at",8,"timestamp with time zone","timestamptz","NO",null],
        ["object_count",9,"integer","int4","NO",null], ["media_bytes",10,"bigint","int8","NO",null],
        ["export_bytes",11,"bigint","int8","NO",null], ["ciphertext_bytes",12,"bigint","int8","NO",null],
        ["catalog_sha256",13,"character","bpchar","NO",null], ["ciphertext_sha256",14,"character","bpchar","NO",null],
        ["state",15,"text","text","NO",null], ["failure_code",16,"text","text","YES",null],
        ["attempted_at",17,"timestamp with time zone","timestamptz","NO",null], ["verified_at",18,"timestamp with time zone","timestamptz","YES",null],
        ["committed_at",19,"timestamp with time zone","timestamptz","YES",null], ["retention_lifetime_hours",20,"integer","int4","YES",null],
        ["expires_at",21,"timestamp with time zone","timestamptz","YES",null], ["deletion_acknowledged_at",22,"timestamp with time zone","timestamptz","YES",null],
        ["incident_environment",23,"text","text","NO","'unknown'::text"],
      ].map(([name,position,type,typeName,nullable,defaultValue]) => Object.freeze({ category: "columns",
        identity: `operations.object_backup_copies.${name}`,
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name, position, type,
          typeSchema: "pg_catalog", typeName, nullable, default: defaultValue }) })),
      Object.freeze({ category: "constraints", identity: "operations.object_backup_copies.object_backup_copies_pkey",
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name: "object_backup_copies_pkey", type: "p", validated: true, definition: "PRIMARY KEY (copy_id)" }) }),
      ...[
        ["object_backup_copies_destination_name_check", "CHECK (destination_name ~ '^[a-z][a-z0-9-]{2,47}$'::text)"],
        ["object_backup_copies_object_key_check", "CHECK (object_key ~ '^[a-z0-9][a-z0-9._/-]{9,239}$'::text)"],
        ["object_backup_copies_envelope_version_check", "CHECK (envelope_version = 1)"],
        ["object_backup_copies_algorithm_check", "CHECK (algorithm = 'AES-256-GCM'::text)"],
        ["object_backup_copies_key_version_check", "CHECK (key_version ~ '^[a-z0-9][a-z0-9-]{1,47}$'::text)"],
        ["object_backup_copies_object_count_check", "CHECK (object_count >= 0)"],
        ["object_backup_copies_media_bytes_check", "CHECK (media_bytes >= 0 AND media_bytes <= '1099511627776'::bigint)"],
        ["object_backup_copies_export_bytes_check", "CHECK (export_bytes >= 0 AND export_bytes <= '1099511627776'::bigint)"],
        ["object_backup_copies_ciphertext_bytes_check", "CHECK (ciphertext_bytes >= 0 AND ciphertext_bytes <= '1099511627776'::bigint)"],
        ["object_backup_copies_catalog_sha256_check", "CHECK (catalog_sha256 ~ '^[0-9a-f]{64}$'::text)"],
        ["object_backup_copies_ciphertext_sha256_check", "CHECK (ciphertext_sha256 ~ '^[0-9a-f]{64}$'::text)"],
        ["object_backup_copies_failure_code_check", "CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'::text)"],
        ["object_backup_copies_retention_lifetime_hours_check", "CHECK (retention_lifetime_hours IS NULL OR retention_lifetime_hours >= 24 AND retention_lifetime_hours <= 8760)"],
        ["object_backup_copies_incident_environment_check", "CHECK (incident_environment = ANY (ARRAY['unknown'::text, 'local'::text, 'test'::text, 'staging'::text, 'production'::text]))"],
        ["object_backup_copies_state_check", "CHECK (state = ANY (ARRAY['uploading'::text, 'usable'::text, 'failed'::text]))"],
        ["object_backup_copies_usable_verified_check", "CHECK (state <> 'usable'::text OR verified_at IS NOT NULL AND committed_at IS NOT NULL)"],
        ["object_backup_copies_failure_state_check", "CHECK (failure_code IS NULL OR state = 'failed'::text)"],
        ["object_backup_copies_committed_state_check", "CHECK (committed_at IS NULL OR state = 'usable'::text)"],
        ["object_backup_copies_expiry_check", "CHECK (expires_at IS NULL OR retention_lifetime_hours IS NOT NULL)"],
        ["object_backup_copies_deletion_check", "CHECK (deletion_acknowledged_at IS NULL OR (state = ANY (ARRAY['usable'::text, 'failed'::text])))"],
        ["object_backup_copies_watermark_order_check", "CHECK (source_watermark_at <= relational_watermark_at)"],
      ].map(([name,definition]) => Object.freeze({ category: "constraints", identity: `operations.object_backup_copies.${name}`,
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name, type: "c", validated: true, definition }) })),
      Object.freeze({ category: "indexes", identity: "operations.object_backup_copies.object_backup_copies_pkey",
        expected: Object.freeze({ schema: "operations", table: "object_backup_copies", name: "object_backup_copies_pkey",
          definition: "CREATE UNIQUE INDEX object_backup_copies_pkey ON operations.object_backup_copies USING btree (copy_id)" }) }),
      Object.freeze({ category: "indexes", identity: "operations.object_backup_copies.object_backup_copies_current_idx",
        expected: Object.freeze({ schema: "operations", table: "object_backup_copies", name: "object_backup_copies_current_idx",
          definition: "CREATE INDEX object_backup_copies_current_idx ON operations.object_backup_copies USING btree (destination_name, committed_at DESC, copy_id) WHERE ((state = 'usable'::text) AND (deletion_acknowledged_at IS NULL))" }) }),
      Object.freeze({ category: "indexes", identity: "operations.object_backup_copies.object_backup_copies_retention_idx",
        expected: Object.freeze({ schema: "operations", table: "object_backup_copies", name: "object_backup_copies_retention_idx",
          definition: "CREATE INDEX object_backup_copies_retention_idx ON operations.object_backup_copies USING btree (expires_at, copy_id) WHERE ((state = 'usable'::text) AND (deletion_acknowledged_at IS NULL))" }) }),
      Object.freeze({ category: "policies", identity: "operations.object_backup_copies.operations_backup_policy_object_backup_copies",
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name: "operations_backup_policy_object_backup_copies", permissive: "permissive", roles: "{shipwithali_backup}", command: "SELECT", usingPredicate: "true", withCheck: "" }) }),
      Object.freeze({ category: "policies", identity: "operations.object_backup_copies.object_backup_copies_worker_inspect",
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name: "object_backup_copies_worker_inspect", permissive: "permissive", roles: "{shipwithali_worker}", command: "SELECT", usingPredicate: "true", withCheck: "" }) }),
      Object.freeze({ category: "policies", identity: "operations.object_backup_copies.object_backup_copies_migration_metrics",
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name: "object_backup_copies_migration_metrics", permissive: "permissive", roles: "{shipwithali_migration}", command: "SELECT", usingPredicate: "true", withCheck: "" }) }),
      Object.freeze({ category: "policies", identity: "operations.relational_backup_copies.relational_backup_copies_migration_metrics",
        expected: Object.freeze({ schema: "operations", tableName: "relational_backup_copies", name: "relational_backup_copies_migration_metrics", permissive: "permissive", roles: "{shipwithali_migration}", command: "SELECT", usingPredicate: "true", withCheck: "" }) }),
      Object.freeze({ category: "policies", identity: "portfolio_config.settings.object_backup_owner_scope_inventory",
        expected: Object.freeze({ schema: "portfolio_config", tableName: "settings", name: "object_backup_owner_scope_inventory", permissive: "permissive", roles: "{shipwithali_migration}", command: "SELECT", usingPredicate: "true", withCheck: "" }) }),
      Object.freeze({ category: "policies", identity: "operations.object_backup_copies.object_backup_copies_backup_insert",
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name: "object_backup_copies_backup_insert", permissive: "permissive", roles: "{shipwithali_backup}", command: "INSERT", usingPredicate: "", withCheck: "(state = 'uploading'::text)" }) }),
      Object.freeze({ category: "policies", identity: "operations.object_backup_copies.object_backup_copies_backup_update",
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name: "object_backup_copies_backup_update", permissive: "permissive", roles: "{shipwithali_backup}", command: "UPDATE",
          usingPredicate: "((state = ANY (ARRAY['uploading'::text, 'failed'::text])) OR ((state = 'usable'::text) AND (deletion_acknowledged_at IS NULL) AND (expires_at <= clock_timestamp())))",
          withCheck: "(((state = 'uploading'::text) AND (deletion_acknowledged_at IS NULL)) OR ((state = ANY (ARRAY['usable'::text, 'failed'::text])) AND (deletion_acknowledged_at IS NULL)) OR ((state = 'failed'::text) AND (deletion_acknowledged_at IS NOT NULL)) OR ((state = 'usable'::text) AND (deletion_acknowledged_at IS NOT NULL) AND (expires_at <= clock_timestamp())))" }) }),
      Object.freeze({ category: "policies", identity: "operations.incidents.object_backup_incidents_insert",
        expected: Object.freeze({ schema: "operations", tableName: "incidents", name: "object_backup_incidents_insert", permissive: "permissive", roles: "{shipwithali_backup}", command: "INSERT", usingPredicate: "",
          withCheck: "((category = 'backup'::text) AND (owner_role = 'backup'::text) AND (remediation_pointer = 'runbook:recovery/object-backup'::text))" }) }),
      Object.freeze({ category: "policies", identity: "operations.incidents.object_backup_incidents_update",
        expected: Object.freeze({ schema: "operations", tableName: "incidents", name: "object_backup_incidents_update", permissive: "permissive", roles: "{shipwithali_backup}", command: "UPDATE",
          usingPredicate: "((category = 'backup'::text) AND (owner_role = 'backup'::text) AND (remediation_pointer = 'runbook:recovery/object-backup'::text))",
          withCheck: "((category = 'backup'::text) AND (owner_role = 'backup'::text) AND (remediation_pointer = 'runbook:recovery/object-backup'::text))" }) }),
      ...["SELECT","INSERT"].map(privilege => Object.freeze({ category: "grants",
        identity: `operations.object_backup_copies.r.shipwithali_backup:shipwithali_migration:${privilege}`,
        expected: Object.freeze({ schema: "operations", object: "object_backup_copies", objectType: "r", grantee: "shipwithali_backup",
          grantor: "shipwithali_migration", privilege, grantable: false }) })),
      Object.freeze({ category: "grants", identity: "operations.object_backup_copies.r.shipwithali_worker:shipwithali_migration:SELECT",
        expected: Object.freeze({ schema: "operations", object: "object_backup_copies", objectType: "r", grantee: "shipwithali_worker",
          grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }) }),
      ...[["object_backup_copies", "r"], ["object_backup_owner_scopes", "v"], ["backup_copy_metrics", "v"]].flatMap(([object, objectType]) =>
        ["DELETE", "INSERT", "MAINTAIN", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"].map(privilege => Object.freeze({ category: "grants",
          identity: `operations.${object}.${objectType}.shipwithali_migration:shipwithali_migration:${privilege}`,
          expected: Object.freeze({ schema: "operations", object, objectType, grantee: "shipwithali_migration",
            grantor: "shipwithali_migration", privilege, grantable: false }) }))),
      ...["state", "failure_code", "verified_at", "committed_at", "deletion_acknowledged_at", "object_count", "media_bytes", "export_bytes", "ciphertext_bytes", "catalog_sha256", "ciphertext_sha256"].map(column => Object.freeze({
        category: "grants", identity: `operations.object_backup_copies.${column}.c.shipwithali_backup:shipwithali_migration:UPDATE`,
        expected: Object.freeze({ schema: "operations", object: `object_backup_copies.${column}`, objectType: "c",
          grantee: "shipwithali_backup", grantor: "shipwithali_migration", privilege: "UPDATE", grantable: false }) })),
      ...[["backup_type", "text", "text"], ["state", "text", "text"],
        ["attempted_at", "timestamp with time zone", "timestamptz"], ["committed_at", "timestamp with time zone", "timestamptz"],
        ["source_watermark_at", "timestamp with time zone", "timestamptz"], ["expires_at", "timestamp with time zone", "timestamptz"],
        ["deletion_acknowledged_at", "timestamp with time zone", "timestamptz"], ["object_count", "integer", "int4"], ["object_bytes", "bigint", "int8"]]
        .map(([name, type, typeName], index) => Object.freeze({ category: "columns", identity: `operations.backup_copy_metrics.${name}`,
          expected: Object.freeze({ schema: "operations", tableName: "backup_copy_metrics", name, position: index + 1,
            type, typeSchema: "pg_catalog", typeName, nullable: "YES", default: null }) })),
      ...[["portfolio_id", 1], ["owner_id", 2]].map(([name,position]) => Object.freeze({ category: "columns",
        identity: `operations.object_backup_owner_scopes.${name}`,
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_owner_scopes", name, position,
          type: "uuid", typeSchema: "pg_catalog", typeName: "uuid", nullable: "YES", default: null }) })),
      Object.freeze({ category: "grants", identity: "operations.object_backup_owner_scopes.v.shipwithali_backup:shipwithali_migration:SELECT",
        expected: Object.freeze({ schema: "operations", object: "object_backup_owner_scopes", objectType: "v", grantee: "shipwithali_backup",
          grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.backup_copy_metrics.v.shipwithali_worker:shipwithali_migration:SELECT",
        expected: Object.freeze({ schema: "operations", object: "backup_copy_metrics", objectType: "v", grantee: "shipwithali_worker",
          grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }) }),
      Object.freeze({ category: "grants", identity: "operations.backup_copy_metrics.v.shipwithali_application:shipwithali_migration:SELECT",
        expected: Object.freeze({ schema: "operations", object: "backup_copy_metrics", objectType: "v", grantee: "shipwithali_application",
          grantor: "shipwithali_migration", privilege: "SELECT", grantable: false }) }),
    ]),
    operationsAdditionsByEngine: Object.freeze({
      "17": Object.freeze([]),
      "18": Object.freeze(["copy_id","destination_name","object_key","envelope_version","algorithm","key_version","source_watermark_at",
        "relational_watermark_at","object_count","media_bytes","export_bytes","ciphertext_bytes","catalog_sha256","ciphertext_sha256",
        "state","attempted_at","incident_environment"].map(column => Object.freeze({ category: "constraints",
        identity: `operations.object_backup_copies.object_backup_copies_${column}_not_null`,
        expected: Object.freeze({ schema: "operations", tableName: "object_backup_copies", name: `object_backup_copies_${column}_not_null`,
          type: "n", validated: true, definition: `NOT NULL ${column}` }) }))),
    }),
  }),
  Object.freeze({
    migration: "20261023100000_build_configuration_owner_exports.sql",
    migrationSha256: "3b2525935b8e8e1c83c64d1fe28ca0af60f6534cde53627bcb012059ce992966",
    ticket: 240,
    capability: "portability.configuration_export",
    includeInDeclaredCapabilities: true,
    operationsAdditions: Object.freeze([
      Object.freeze({
        category: "policies",
        identity: "operations.outbox_events.owner_export_produced_outbox_worker_insert",
        expected: Object.freeze({
          schema: "operations",
          tableName: "outbox_events",
          name: "owner_export_produced_outbox_worker_insert",
          permissive: "permissive",
          roles: "{shipwithali_worker}",
          command: "INSERT",
          usingPredicate: "",
        }),
      }),
      Object.freeze({
        category: "grants",
        identity: "operations.outbox_events.r.shipwithali_worker:shipwithali_migration:INSERT",
        expected: Object.freeze({
          schema: "operations",
          object: "outbox_events",
          objectType: "r",
          grantee: "shipwithali_worker",
          grantor: "shipwithali_migration",
          privilege: "INSERT",
          grantable: false,
        }),
      }),
      Object.freeze({
        category: "indexes",
        identity: "operations.outbox_events.owner_export_produced_outbox_once",
        expected: Object.freeze({
          schema: "operations",
          table: "outbox_events",
          name: "owner_export_produced_outbox_once",
          definition: "CREATE UNIQUE INDEX owner_export_produced_outbox_once ON operations.outbox_events USING btree (aggregate_id, aggregate_version) WHERE (event_type = 'portability.export_produced.v1'::text)",
        }),
      }),
    ]),
  }),
]);

// Historical checkpoints and their paired database checks. A suite whose
// declared required capabilities exceed a checkpoint's capabilities must never
// be paired with that checkpoint; pairing validation fails closed.
export const PHASE_DATABASE_CHECKPOINTS = Object.freeze([
  Object.freeze({
    id: "phase3-baseline",
    description: "The Phase 3 release baseline: the three historical baseline migrations only.",
    suites: Object.freeze([
      Object.freeze({ file: "tests/database/postgres-transaction-runner.test.ts", requires: Object.freeze([]) }),
      Object.freeze({ file: "tests/database/postgres-integration.test.ts", requires: Object.freeze([]) }),
      Object.freeze({ file: "tests/database/optimistic-concurrency.test.ts", requires: Object.freeze([]) }),
      Object.freeze({ file: "tests/database/idempotency.test.ts", requires: Object.freeze([]) }),
      Object.freeze({ file: "tests/database/outbox.test.ts", requires: Object.freeze([]) }),
      Object.freeze({ file: "tests/database/leased-jobs.test.ts", requires: Object.freeze([]) }),
      Object.freeze({ file: "tests/database/role-rls-matrix.test.ts", requires: Object.freeze([]) }),
    ]),
  }),
  Object.freeze({
    id: "current",
    description: "The fully migrated current schema: bounded-retry operations are declared here, so the restricted-role matrix runs against the upgraded schema as well.",
    suites: Object.freeze([
      Object.freeze({ file: "tests/database/role-rls-matrix.test.ts", requires: Object.freeze([]) }),
      Object.freeze({ file: "tests/database/portfolio-settings.integration.test.ts", requires: Object.freeze(["operations.bounded_retries"]) }),
      Object.freeze({ file: "tests/database/content-authoring.integration.test.ts", requires: Object.freeze(["operations.bounded_retries"]) }),
    ]),
  }),
]);

// Suites say which checkpoint they execute for via this variable instead of
// learning the schema era from the database under test. A declared set that
// contradicts the real database fails the suite.
export const DECLARED_CAPABILITIES_VARIABLE = "PHASE_DATABASE_CAPABILITIES";

export function validateTransformationShape(transformation) {
  if (!transformation || typeof transformation !== "object" || typeof transformation.migration !== "string") {
    throw new Error("PHASE_REGISTRY_TRANSFORMATION_INVALID");
  }
  if (!Array.isArray(transformation.operations) || transformation.operations.some((operation) =>
    !operation || typeof operation !== "object" || typeof operation.category !== "string" ||
    typeof operation.identity !== "string" || !(operation.before === null || typeof operation.before === "object") ||
    !(operation.after === null || typeof operation.after === "object") ||
    operation.before === null && operation.after === null ||
    operation.before !== null && operation.after !== null && JSON.stringify(operation.before) === JSON.stringify(operation.after))) {
    throw new Error(`PHASE_REGISTRY_TRANSFORMATION_INVALID:${transformation.migration}:operations`);
  }
  if (transformation.engineVariants !== undefined) {
    if (transformation.engineVariants === null || typeof transformation.engineVariants !== "object" ||
      Array.isArray(transformation.engineVariants) ||
      Object.entries(transformation.engineVariants).some(([major, operations]) =>
        !["17", "18"].includes(major) || !Array.isArray(operations) || operations.some((operation) =>
          !operation || typeof operation !== "object" || typeof operation.category !== "string" ||
          typeof operation.identity !== "string" || !(operation.before === null || typeof operation.before === "object") ||
          !(operation.after === null || typeof operation.after === "object") ||
          operation.before === null && operation.after === null))) {
      throw new Error(`PHASE_REGISTRY_TRANSFORMATION_INVALID:${transformation.migration}:engineVariants`);
    }
    if (Object.keys(transformation.engineVariants).length !== 2 ||
      !Object.hasOwn(transformation.engineVariants, "17") || !Object.hasOwn(transformation.engineVariants, "18")) {
      throw new Error(`PHASE_REGISTRY_TRANSFORMATION_INVALID:${transformation.migration}:engineVariants`);
    }
  }
}

// Preserve the old function name for callers while returning exact row
// operations. The comparator applies them in order to the trusted baseline.
export function composeOperationsBoundary(transformations = PHASE_DATABASE_TRANSFORMATIONS, postgresMajor) {
  const operations = [];
  if (postgresMajor !== 17 && postgresMajor !== 18) throw new Error(`PHASE3_OPERATIONS_ENGINE_UNSUPPORTED:${postgresMajor ?? "unknown"}`);
  const seen = new Set();
  for (const transformation of transformations) {
    validateTransformationShape(transformation);
    if (seen.has(transformation.migration)) {
      throw new Error(`PHASE_REGISTRY_DUPLICATE_TRANSFORMATION:${transformation.migration}`);
    }
    seen.add(transformation.migration);
    operations.push(...transformation.operations.map((operation) => ({ ...operation })));
    if (transformation.engineVariants !== undefined) {
      const variant = transformation.engineVariants[String(postgresMajor)];
      if (!Array.isArray(variant)) throw new Error(`PHASE3_OPERATIONS_ENGINE_VARIANT_MISSING:${transformation.migration}:${postgresMajor}`);
      operations.push(...variant.map((operation) => ({ ...operation })));
    }
  }
  return Object.freeze({ operations: Object.freeze(operations.map(Object.freeze)) });
}

export function declaredCapabilities(
  transformations = PHASE_DATABASE_TRANSFORMATIONS,
  additiveMigrations = PHASE_DECLARED_ADDITIVE_MIGRATIONS,
) {
  const capabilities = [];
  for (const transformation of transformations) {
    if (typeof transformation.capability === "string" && transformation.capability.length > 0 &&
      !capabilities.includes(transformation.capability)) capabilities.push(transformation.capability);
  }
  for (const migration of additiveMigrations) {
    if (migration.includeInDeclaredCapabilities === true && typeof migration.capability === "string" &&
      migration.capability.length > 0 && !capabilities.includes(migration.capability)) {
      capabilities.push(migration.capability);
    }
  }
  return Object.freeze(capabilities);
}

export function capabilitiesForMigrations(
  migrationFiles,
  transformations = PHASE_DATABASE_TRANSFORMATIONS,
  additiveMigrations = PHASE_DECLARED_ADDITIVE_MIGRATIONS,
) {
  const files = new Set(migrationFiles);
  const capabilities = declaredCapabilities(transformations, additiveMigrations);
  return Object.freeze(capabilities.filter((capability) =>
    transformations.some((entry) => entry.capability === capability && files.has(entry.migration)) ||
    additiveMigrations.some((entry) => entry.includeInDeclaredCapabilities === true &&
      entry.capability === capability && files.has(entry.migration))));
}

// Classifies every migration file exactly once, in declared registry order.
// Failures carry PHASE_CONTRACT_* codes: an undeclared migration, a duplicate
// declaration, or a declaration naming a file outside the inventory.
export function resolveMigrationClassifications(migrationFiles, {
  transformations = PHASE_DATABASE_TRANSFORMATIONS,
  additiveMigrations = PHASE_DECLARED_ADDITIVE_MIGRATIONS,
  phase4ReleaseCompatibility = PHASE4_RELEASE_MIGRATION_COMPATIBILITY,
  phase5Compatibility = PHASE5_MIGRATION_COMPATIBILITY,
  phase3Files = [],
  migrationContents = null,
} = {}) {
  if (new Set(migrationFiles).size !== migrationFiles.length) {
    throw new Error("PHASE_CONTRACT_MIGRATION_DUPLICATE");
  }
  const files = new Set(migrationFiles);
  const phase3Baseline = new Set(phase3Files);
  const phase5Names = new Set(Object.keys(phase5Compatibility));
  const phase4Names = new Set(Object.keys(phase4ReleaseCompatibility));
  const classifications = new Map();
  for (const file of [...files].sort()) {
    if (phase3Baseline.has(file)) {
      classifications.set(file, { kind: "baseline" });
      continue;
    }
    if (phase4Names.has(file)) {
      if (file.localeCompare(PHASE4_RELEASE_BOUNDARY) >= 0) {
        throw new Error(`PHASE_CONTRACT_PHASE4_RANGE_INVALID:${file}`);
      }
      classifications.set(file, { kind: "phase4-release", boundary: phase4ReleaseCompatibility[file] });
      continue;
    }
    if (phase5Names.has(file)) {
      if (file.localeCompare(PHASE5_MIGRATION_FIRST) < 0 || file.localeCompare(PHASE5_MIGRATION_LAST) > 0) {
        throw new Error(`PHASE_CONTRACT_PHASE5_RANGE_INVALID:${file}`);
      }
      classifications.set(file, { kind: "phase5", boundary: phase5Compatibility[file] });
      continue;
    }
    if (transformations.some((entry) => entry.migration === file)) {
      if (!transformations.some((entry) => entry.migration === file)) {
        throw new Error(`PHASE_CONTRACT_TRANSFORMATION_UNREVIEWED:${file}`);
      }
      const transformation = transformations.find((entry) => entry.migration === file);
      if (transformation.migrationSha256 && migrationContents instanceof Map) {
        const actual = migrationContents.has(file) ? migrationSha256(migrationContents.get(file)) : null;
        if (actual !== transformation.migrationSha256) throw new Error(`PHASE_CONTRACT_TRANSFORMATION_CHECKSUM_MISMATCH:${file}`);
      }
      classifications.set(file, { kind: "operations-transformation", transformation });
      continue;
    }
    if (additiveMigrations.some((entry) => entry.migration === file)) {
      if (additiveMigrations.filter((entry) => entry.migration === file).length !== 1) {
        throw new Error(`PHASE_CONTRACT_MIGRATION_DUPLICATE_DECLARATION:${file}`);
      }
      const additive = additiveMigrations.find((entry) => entry.migration === file);
      if (additive.migrationSha256 && migrationContents instanceof Map) {
        const actual = migrationContents.has(file) ? migrationSha256(migrationContents.get(file)) : null;
        if (actual !== additive.migrationSha256) throw new Error(`PHASE_CONTRACT_ADDITIVE_CHECKSUM_MISMATCH:${file}`);
      }
      classifications.set(file, { kind: "declared-additive", additive });
      continue;
    }
    throw new Error(`PHASE_CONTRACT_MIGRATION_UNDECLARED:${file}`);
  }
  for (const transformation of transformations) {
    validateTransformationShape(transformation);
    if (!additiveMigrations.some((entry) => entry.migration === transformation.migration)) {
      throw new Error(`PHASE_CONTRACT_TRANSFORMATION_ADMISSION_MISSING:${transformation.migration}`);
    }
    if (!files.has(transformation.migration)) {
      throw new Error(`PHASE_CONTRACT_TRANSFORMATION_MIGRATION_MISSING:${transformation.migration}`);
    }
  }
  for (const additive of additiveMigrations) {
    if (!files.has(additive.migration)) {
      throw new Error(`PHASE_CONTRACT_DECLARED_MIGRATION_MISSING:${additive.migration}`);
    }
  }
  return Object.freeze(classifications);
}

// Capabilities reachable at a given checkpoint: the current (fully migrated)
// schema declares every reviewed transformation's capability; the Phase 3
// baseline declares none of them.
export function capabilitiesForCheckpoint(checkpointId, classifications, {
  transformations = PHASE_DATABASE_TRANSFORMATIONS,
  phase3Files = [],
} = {}) {
  if (checkpointId !== "phase3-baseline" && checkpointId !== "current") {
    throw new Error(`PHASE_CONTRACT_CHECKPOINT_UNKNOWN:${checkpointId}`);
  }
  if (checkpointId === "phase3-baseline") return Object.freeze([]);
  const baseline = new Set(phase3Files);
  const capabilities = [];
  for (const [file, classification] of classifications) {
    if (baseline.has(file)) continue;
    if (classification.kind !== "operations-transformation") continue;
    const transformation = transformations.find((entry) => entry.migration === file);
    if (transformation && transformation.capability && !capabilities.includes(transformation.capability)) {
      capabilities.push(transformation.capability);
    }
  }
  return Object.freeze(capabilities);
}

// Validates the declared checkpoint pairing against the real test inventory.
// Fails closed when a paired suite is missing from the repository or its
// declared required capabilities exceed the checkpoint.
export function validateCheckpointPairing({ classifications, phase3Files, existingFiles }) {
  const errors = [];
  const baseline = new Set(phase3Files);
  for (const checkpoint of PHASE_DATABASE_CHECKPOINTS) {
    for (const suite of checkpoint.suites) {
      if (!existingFiles.has(suite.file)) {
        errors.push(`PHASE_CHECKPOINT_SUITE_MISSING:${checkpoint.id}:${suite.file}`);
        continue;
      }
      const missing = suite.requires.filter((capability) =>
        !capabilitiesForCheckpoint(checkpoint.id, classifications, { phase3Files }).includes(capability));
      if (missing.length > 0) {
        errors.push(`PHASE_CHECKPOINT_CAPABILITY_INVALID:${checkpoint.id}:${suite.file}:${missing.join("|")}`);
      }
    }
  }
  // Every baseline migration must reach the historical checkpoint; the
  // checkpoint itself is defined by the baseline snapshot.
  if (baseline.size === 0) errors.push("PHASE_CHECKPOINT_BASELINE_EMPTY");
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return Object.freeze(PHASE_DATABASE_CHECKPOINTS);
}
