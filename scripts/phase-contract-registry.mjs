// Shared declarative source of truth for Phase 3–8 database validation.
//
// Every historical checkpoint, migration boundary, reviewed operations-contract
// transformation, and paired database check is declared here. Historical gates
// consume this registry instead of holding ticket-specific hard-coded
// exceptions, so a future reviewed migration extends the contract through this
// file — never by editing historical checkers. A migration without a reviewed
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
