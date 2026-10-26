/** Real Measurement Analytics export fixture for issue #246. */
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createOwnerAnalyticsExportSnapshotService } from "../../src/modules/measurement/application/owner-analytics-export.js";
import { createPostgresOwnerAnalyticsGoalRepository } from "../../src/modules/measurement/adapters/postgres-goals.js";
import { createPostgresDailyAggregateRepository } from "../../src/modules/measurement/adapters/postgres-daily-aggregates.js";
import { createPostgresOwnerAnalyticsExportSnapshotReader } from "../../src/modules/measurement/adapters/postgres-owner-analytics-export.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";
import { createPostgresRuntimeDatabase, resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import { createStableId, ok, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createSystemIdGenerator } from "../../src/runtime/ports.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresOwnerExportStore } from "../../src/modules/portability-operations/adapters/postgres-owner-export-store.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresContentAuthoringRepository } from "../../src/modules/content-publishing/adapters/postgres-authoring.js";
import { createOwnerExportService, isManifestShape } from "../../src/modules/portability-operations/application/owner-export-service.js";
import { createOwnerExportAssemblyService, type OwnerExportObjectStoragePort } from "../../src/modules/portability-operations/application/owner-export-assembly.js";
import { buildSelectedOwnerExportPackage, type OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { validateOwnerExportZip } from "../../scripts/owner-export/validator.mjs";
import { sql } from "kysely";

const APPLICATION_URL = process.env["PHASE8_OWNER_EXPORT_APPLICATION_URL"];
const WORKER_URL = process.env["PHASE8_OWNER_EXPORT_WORKER_URL"];
const ADMIN_URL = process.env["PHASE8_OWNER_EXPORT_ADMIN_URL"];
const enabled = Boolean(APPLICATION_URL && WORKER_URL && ADMIN_URL);

async function archiveBytes(content: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of content) { chunks.push(chunk); length += chunk.byteLength; }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

describe.runIf(enabled)("Phase 8 #246 real Analytics export fixture", () => {
  it("AC01-07 captures immutable histories and retained privacy-safe reports under Worker RLS", async () => {
    if (!APPLICATION_URL || !WORKER_URL || !ADMIN_URL) throw new Error("PHASE8_OWNER_EXPORT_DATABASE_REQUIRED");
    const admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();
    const worker = createPostgresRuntimeDatabase(WORKER_URL);
    const application = createPostgresRuntimeDatabase(APPLICATION_URL);
    const portfolioId = createStableId("Portfolio");
    const ownerId = createStableId("Owner");
    const availableGoalId = createStableId("AnalyticsGoal");
    const lowGoalId = createStableId("AnalyticsGoal");
    const suppressedGoalId = createStableId("AnalyticsGoal");
    const availableV1 = createStableId("AnalyticsGoalVersion");
    const availableV2 = createStableId("AnalyticsGoalVersion");
    const lowVersion = createStableId("AnalyticsGoalVersion");
    const suppressedVersion = createStableId("AnalyticsGoalVersion");
    const projectId = createStableId("Project");
    const routeId = createStableId("PublicRoute");
    const actorActivation = () => createStableId("Event");
    const fixtureGoalIds: StableId<"AnalyticsGoal">[] = [availableGoalId, lowGoalId, suppressedGoalId];
    let fixtureSeeded = false;
    try {
      await admin.query(`insert into portfolio_config.settings (
        portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback
      ) values ($1,$2,'Analytics owner','Builder','Private fixture','Contact','https://example.test/contact','Contact unavailable')`, [portfolioId, ownerId]);
      fixtureSeeded = true;
      const stamp = await admin.query<{ captured_at: Date | string }>("select transaction_timestamp() as captured_at");
      const capturedAt = stamp.rows[0]?.captured_at;
      if (capturedAt === undefined) throw new Error("PHASE8_ANALYTICS_CAPTURE_TIME_MISSING");
      const capturedInstant = capturedAt instanceof Date ? capturedAt.toISOString() : new Date(capturedAt).toISOString();
      const today = capturedInstant.slice(0, 10);
      const firstSeedDay = new Date(Date.parse(`${today}T00:00:00Z`) - 400 * 86_400_000).toISOString().slice(0, 10);
      await admin.query(`insert into measurement.daily_aggregate_checkpoints
        (portfolio_id,utc_day,source_event_count,source_conversion_count,policy_version,checkpoint_at,incomplete)
        select $1,day::date,0,0,'phase7.daily.v2',$2::timestamptz,false
          from generate_series($3::date,$4::date,interval '1 day') as day`, [portfolioId, capturedInstant, firstSeedDay, today]);
      await admin.query(`insert into measurement.daily_aggregate_checkpoints
        (portfolio_id,utc_day,source_event_count,source_conversion_count,policy_version,checkpoint_at,incomplete)
        values ($1,$2::date,0,0,'phase7.daily.v2',$3::timestamptz,false)
        on conflict (portfolio_id,utc_day) do nothing`, [portfolioId, today, capturedInstant]);
      const availableDefinition = { name: "Project completion", steps: [{ action: "project-viewed", projectIds: [projectId], publicRouteIds: [routeId] }] };
      const lowDefinition = { name: "Qualified project visit", steps: [{ action: "project-viewed", projectIds: [projectId] }] };
      const suppressedDefinition = { name: "Route completion", steps: [{ action: "page-viewed", publicRouteIds: [routeId] }] };
      const seedGoal = async (input: { goalId: StableId<"AnalyticsGoal">; versions: readonly { id: StableId<"AnalyticsGoalVersion">; number: number; definition: unknown }[]; active: StableId<"AnalyticsGoalVersion">; samples: number; count: number; smallDimension?: boolean }) => {
        await admin.query("insert into measurement.analytics_goals (portfolio_id,goal_id,aggregate_version,active_version_id) values ($1,$2,1,null)",
          [portfolioId, input.goalId]);
        for (const version of input.versions) {
          await admin.query(`insert into measurement.analytics_goal_versions
            (portfolio_id,goal_id,version_id,version_number,definition,created_at)
            values ($1,$2,$3,$4,$5::jsonb,transaction_timestamp())`, [portfolioId, input.goalId, version.id, version.number, JSON.stringify(version.definition)]);
        }
        for (const [index, version] of input.versions.entries()) {
          await admin.query(`insert into measurement.analytics_goal_activation_history
            (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
            values ($1,$2,$3,$4,$5,transaction_timestamp(),$6)`, [portfolioId, input.goalId, actorActivation(), version.id, index * 2 + 3, index + 1]);
        }
        await admin.query("update measurement.analytics_goals set aggregate_version=$3,active_version_id=$4 where portfolio_id=$1 and goal_id=$2",
          [portfolioId, input.goalId, input.versions.length * 2 + 1, input.active]);
        const versionId = input.active;
        const metricKey = `${input.goalId}:${versionId}`;
        await admin.query(`insert into measurement.daily_aggregates
          (portfolio_id,utc_day,metric_kind,metric_key,goal_id,goal_version_id,dimensions,event_count,sum_value,observed_subjects,
           returning_subjects,policy_version,checkpoint_at,incomplete)
          values ($1,$2::date,'goal',$3,$4,$5,'{}'::jsonb,$6,0,$7,0,'phase7.daily.v2',$8::timestamptz,false)`,
        [portfolioId, today, metricKey, input.goalId, versionId, input.count, input.samples, capturedInstant]);
        if (input.smallDimension) {
          await admin.query(`insert into measurement.daily_aggregates
            (portfolio_id,utc_day,metric_kind,metric_key,goal_id,goal_version_id,dimensions,event_count,sum_value,observed_subjects,
             returning_subjects,policy_version,checkpoint_at,incomplete)
            values ($1,$2::date,'goal',$3,$4,$5,'{"locale":"ar"}'::jsonb,$6,0,$7,0,'phase7.daily.v2',$8::timestamptz,false),
                   ($1,$2::date,'goal',$3,$4,$5,'{"locale":"en"}'::jsonb,1,0,1,0,'phase7.daily.v2',$8::timestamptz,false)`,
          [portfolioId, today, metricKey, input.goalId, versionId, input.count, input.samples, capturedInstant]);
        } else {
          await admin.query(`insert into measurement.daily_aggregates
            (portfolio_id,utc_day,metric_kind,metric_key,goal_id,goal_version_id,dimensions,event_count,sum_value,observed_subjects,
             returning_subjects,policy_version,checkpoint_at,incomplete)
            values ($1,$2::date,'goal',$3,$4,$5,'{"locale":"en"}'::jsonb,$6,0,$7,0,'phase7.daily.v2',$8::timestamptz,false)`,
          [portfolioId, today, metricKey, input.goalId, versionId, input.count, input.samples, capturedInstant]);
        }
      };
      await seedGoal({ goalId: availableGoalId,
        versions: [{ id: availableV1, number: 1, definition: availableDefinition }, { id: availableV2, number: 2, definition: availableDefinition }],
        active: availableV2, samples: 5, count: 7 });
      await seedGoal({ goalId: lowGoalId, versions: [{ id: lowVersion, number: 1, definition: lowDefinition }], active: lowVersion, samples: 4, count: 11 });
      await seedGoal({ goalId: suppressedGoalId, versions: [{ id: suppressedVersion, number: 1, definition: suppressedDefinition }], active: suppressedVersion, samples: 7, count: 8, smallDimension: true });
      const incompleteDay = new Date(Date.parse(`${today}T00:00:00Z`) - 45 * 86_400_000).toISOString().slice(0, 10);
      await admin.query("update measurement.daily_aggregate_checkpoints set incomplete=true where portfolio_id=$1 and utc_day=$2::date", [portfolioId, incompleteDay]);

      const reader = createOwnerExportSnapshotReader({
        configuration: { async getSettingsSnapshot() { throw new Error("Analytics-only export must not read Configuration"); } } as never,
        content: { async readOwnerExportSnapshot() { throw new Error("Analytics-only export must not read Content"); }, async readOwnerExportMediaLocales() { throw new Error("Content lookup is forbidden"); } } as never,
        analytics: createPostgresOwnerAnalyticsExportSnapshotReader(),
        transactions: worker.transactions,
        capabilities: { async read() { throw new Error("Analytics-only export must not read capability projections"); } },
      });
      const capture = await reader.capture({ portfolioId, ownerId, snapshotId: createStableId("OwnerExportArtifact"), includedScopes: ["analytics-reports"] });
      expect(capture.ok).toBe(true);
      if (!capture.ok || !("kind" in capture.value)) throw new Error("PHASE8_ANALYTICS_SNAPSHOT_CAPTURE_FAILED");
      const snapshot = capture.value as OwnerExportSelectedSnapshot;
      expect(snapshot.policyExpiresAt).toBe(snapshot.analytics!.policyExpiresAt);
      expect(snapshot.analytics?.records.map((record) => record.goalId)).toEqual([...fixtureGoalIds].sort());
      const available = snapshot.analytics!.records.find((record) => record.goalId === availableGoalId)!.value as { goal: { activeVersionId: string; activationHistory: readonly { activationSequence: number }[]; versions: readonly unknown[] }; reports: readonly Record<string, unknown>[] };
      expect(available.goal.versions).toHaveLength(2);
      expect(available.goal.activationHistory.map((entry) => entry.activationSequence)).toEqual([1, 2]);
      const availableCurrent = available.reports.at(-1);
      expect(availableCurrent).toMatchObject({ sampleState: "sufficient", countDisposition: "included", breakdown: "locale",
        cells: [{ utcDay: today, locale: "en", aggregateCount: 7 }] });
      const low = snapshot.analytics!.records.find((record) => record.goalId === lowGoalId)!.value as { reports: readonly Record<string, unknown>[] };
      expect(low.reports.at(-1)).toMatchObject({ sampleState: "low-sample", countDisposition: "withheld" });
      expect(Object.hasOwn(low.reports.at(-1)!, "aggregateCount")).toBe(false);
      const suppressed = snapshot.analytics!.records.find((record) => record.goalId === suppressedGoalId)!.value as { reports: readonly Record<string, unknown>[] };
      expect(suppressed.reports.at(-1)).toMatchObject({ sampleState: "low-sample", countDisposition: "withheld" });
      expect(Object.hasOwn(suppressed.reports.at(-1)!, "cells")).toBe(false);
      expect(snapshot.analytics!.records.some((record) => (record.value["reports"] as readonly Record<string, unknown>[]).some((report) => report["sampleState"] === "incomplete"))).toBe(true);

      const built = await buildSelectedOwnerExportPackage({ exportId: createStableId("OwnerExport"), snapshot });
      const archive = Buffer.from(await archiveBytes(built.content));
      const validation = validateOwnerExportZip(archive);
      expect(validation.manifest.schemaVersion).toBe("1.8");
      expect(isManifestShape(built.manifest)).toBe(true);
      expect(isManifestShape({ ...built.manifest, includedScopes: ["analytics-reports", "portfolio-configuration"] })).toBe(false);
      expect(isManifestShape({ ...built.manifest, entries: built.manifest.entries.map(entry => ({ ...entry,
        schemaVersion: "1.1", recordSchema: "urn:shipwithali:owner-export-schema:analytics-reports:1.1" })) })).toBe(false);
      expect(validation.includedScopes).toEqual(["analytics-reports"]);
      expect(validation.recordCounts["analytics-reports"]).toBe(3);
      expect(validation.dependencyCount).toBe(4);
      expect(archive.includes(Buffer.from(ownerId))).toBe(false);
      expect(archive.includes(Buffer.from("measurement_subject"))).toBe(false);
      expect(archive.includes(Buffer.from("consent_revision"))).toBe(false);
      expect(archive.includes(Buffer.from("activation_id"))).toBe(false);
      expect(archive.includes(Buffer.from("provider-session-secret"))).toBe(false);

      // Exercise the production request, lease, capture, upload and ready path.
      const clock = { now: () => capturedInstant };
      const ids = createSystemIdGenerator();
      const appOperations = createPostgresOperationsPersistence(application.database, clock);
      const appStore = createPostgresOwnerExportStore(application.database, { outbox: appOperations.outbox });
      const exportService = createOwnerExportService({ operations: appOperations, exports: appStore, clock, ids });
      const key = parseIdempotencyKey(createStableId("Key"));
      if (!key.ok) throw new Error("PHASE8_ANALYTICS_REQUEST_KEY_INVALID");
      const request = await exportService.requestOwnerExport({ portfolioId,
        actor: { kind: "owner", ownerId, sessionId: "analytics-assembly-test" },
        idempotencyKey: key.value, includedScopes: ["analytics-reports"] });
      expect(request.ok).toBe(true);
      if (!request.ok) throw new Error("PHASE8_ANALYTICS_REQUEST_FAILED");
      expect(await appStore.findOwnerExport({ portfolioId, ownerId, exportId: request.value.exportId }))
        .toMatchObject({ status: "requested", schemaVersion: "1.8" });
      let storedBytes: Uint8Array = new Uint8Array();
      const storage: OwnerExportObjectStoragePort = {
        async writeOwnerExport(input) { storedBytes = await archiveBytes(input.content); return ok(undefined); },
        async readOwnerExport(input) {
          return ok({ content: (async function* () { yield storedBytes; })(),
            contentLength: storedBytes.byteLength, sha256: input.expectedSha256 });
        },
      };
      const workerOperations = createPostgresOperationsPersistence(worker.database, clock);
      const workerStore = createPostgresOwnerExportStore(worker.database, { outbox: workerOperations.outbox });
      const assembly = createOwnerExportAssemblyService({ operations: workerOperations, exports: workerStore, artifacts: workerStore,
        snapshots: reader, storage, clock, ids });
      const assembled = await assembly.runOwnerExportAssembly({ workerId: "analytics-assembly-test" });
      expect(assembled, JSON.stringify(assembled))
        .toMatchObject({ ok: true, value: { claimed: 1, completed: 1, failed: 0, retried: 0 } });
      expect(await workerStore.findOwnerExport({ portfolioId, ownerId, exportId: request.value.exportId }))
        .toMatchObject({ status: "ready", schemaVersion: "1.8", integrityManifest: { includedScopes: ["analytics-reports"] } });
      expect(validateOwnerExportZip(storedBytes).recordCounts["analytics-reports"]).toBe(3);

      const mixedKey = parseIdempotencyKey(createStableId("Key"));
      if (!mixedKey.ok) throw new Error("PHASE8_ANALYTICS_REQUEST_KEY_INVALID");
      const mixed = await exportService.requestOwnerExport({ portfolioId,
        actor: { kind: "owner", ownerId, sessionId: "analytics-assembly-test" },
        idempotencyKey: mixedKey.value, includedScopes: ["analytics-reports", "portfolio-configuration"] });
      if (!mixed.ok) throw new Error("PHASE8_ANALYTICS_MIXED_REQUEST_FAILED");
      const mixedReader = createOwnerExportSnapshotReader({
        configuration: createPostgresPortfolioSettingsRepository(), content: createPostgresContentAuthoringRepository(),
        analytics: createPostgresOwnerAnalyticsExportSnapshotReader(), transactions: worker.transactions,
        capabilities: { async read() { return { currentCvAvailable: false, externalLinksAvailable: false }; } },
      });
      const mixedAssembly = await createOwnerExportAssemblyService({ operations: workerOperations,
        exports: workerStore, artifacts: workerStore, snapshots: mixedReader, storage, clock, ids,
      }).runOwnerExportAssembly({ workerId: "analytics-assembly-test" });
      expect(mixedAssembly).toMatchObject({ ok: true, value: { claimed: 1, completed: 1, failed: 0, retried: 0 } });
      const mixedRecord = await workerStore.findOwnerExport({ portfolioId, ownerId, exportId: mixed.value.exportId });
      expect(mixedRecord).toMatchObject({ status: "ready", schemaVersion: "1.9",
        integrityManifest: { schemaVersion: "1.9", includedScopes: ["analytics-reports", "portfolio-configuration"] } });
      expect(mixedRecord!.expiresAt).toBe((mixedRecord!.snapshot as OwnerExportSelectedSnapshot).policyExpiresAt);
      expect(validateOwnerExportZip(storedBytes).includedScopes).toEqual(["analytics-reports", "portfolio-configuration"]);

      const privilege = await admin.query(`select
        has_table_privilege('shipwithali_worker','measurement.analytics_goals','INSERT') as goal_insert,
        has_table_privilege('shipwithali_worker','measurement.analytics_goal_versions','UPDATE') as version_update,
        has_table_privilege('shipwithali_worker','measurement.analytics_goal_activation_history','SELECT') as activation_table_read,
        has_column_privilege('shipwithali_worker','measurement.analytics_goal_activation_history','activation_id','SELECT') as activation_id_read,
        has_column_privilege('shipwithali_worker','measurement.analytics_goal_activation_history','activation_sequence','SELECT') as sequence_read`);
      expect(privilege.rows[0]).toEqual({ goal_insert: false, version_update: false, activation_table_read: false, activation_id_read: false, sequence_read: true });

      const wrongPurpose = await worker.transactions.run(async (tx) => {
        const db = resolvePostgresTransaction(tx);
        await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true), set_config('shipwithali.owner_id', ${ownerId}, true),
          set_config('shipwithali.worker_purpose', 'content.owner-export', true)`.execute(db);
        return sql<{ count: number }>`select count(goal_id)::int as count from measurement.analytics_goals where portfolio_id=${portfolioId}::uuid`.execute(db);
      });
      expect(wrongPurpose.rows[0]?.count).toBe(0);
      const wrongHistoryPurpose = await worker.transactions.run(async (tx) => {
        const db = resolvePostgresTransaction(tx);
        await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true), set_config('shipwithali.owner_id', ${ownerId}, true),
          set_config('shipwithali.worker_purpose', 'content.owner-export', true)`.execute(db);
        return sql<{ versions: number; activations: number }>`select
          (select count(version_id)::int from measurement.analytics_goal_versions where portfolio_id=${portfolioId}::uuid) as versions,
          (select count(version_id)::int from measurement.analytics_goal_activation_history where portfolio_id=${portfolioId}::uuid) as activations`.execute(db);
      });
      expect(wrongHistoryPurpose.rows[0]).toEqual({ versions: 0, activations: 0 });
      const conversionPurpose = await worker.transactions.run(async (tx) => {
        const db = resolvePostgresTransaction(tx);
        await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true),
          set_config('shipwithali.worker_purpose', 'measurement.goal-conversion', true)`.execute(db);
        return sql<{ versions: number; activations: number }>`select
          (select count(version_id)::int from measurement.analytics_goal_versions where portfolio_id=${portfolioId}::uuid) as versions,
          (select count(version_id)::int from measurement.analytics_goal_activation_history where portfolio_id=${portfolioId}::uuid) as activations`.execute(db);
      });
      expect(conversionPurpose.rows[0]).toEqual({ versions: 4, activations: 4 });
      for (const scope of [portfolioId, createStableId("Portfolio")]) {
        const aggregatePurpose = await worker.transactions.run(async (tx) => {
          const db = resolvePostgresTransaction(tx);
          await sql`select set_config('shipwithali.portfolio_id', ${scope}, true),
            set_config('shipwithali.worker_purpose', 'measurement.aggregate', true)`.execute(db);
          return sql<{ versions: number; activations: number }>`select
            (select count(version_id)::int from measurement.analytics_goal_versions where portfolio_id=${portfolioId}::uuid) as versions,
            (select count(version_id)::int from measurement.analytics_goal_activation_history where portfolio_id=${portfolioId}::uuid) as activations`.execute(db);
        });
        expect(aggregatePurpose.rows[0]).toEqual({ versions: scope === portfolioId ? 4 : 0, activations: 0 });
      }
      const wrongOwner = await worker.transactions.run(async (tx) => {
        const db = resolvePostgresTransaction(tx);
        await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true), set_config('shipwithali.owner_id', ${createStableId("Owner")}, true),
          set_config('shipwithali.worker_purpose', 'measurement.owner-export', true)`.execute(db);
        return sql<{ count: number }>`select count(goal_id)::int as count from measurement.analytics_goals where portfolio_id=${portfolioId}::uuid`.execute(db);
      });
      expect(wrongOwner.rows[0]?.count).toBe(0);

      const deletionJobId = createStableId("Job");
      const expired = await admin.query<{ utc_day: string }>(
        "select (($1::timestamptz at time zone 'UTC')::date - interval '14 months')::date::text as utc_day", [capturedInstant]);
      const expiredDay = expired.rows[0]!.utc_day;
      await admin.query(`insert into measurement.daily_aggregates
        (portfolio_id,utc_day,metric_kind,metric_key,dimensions,event_count,sum_value,observed_subjects,
         returning_subjects,policy_version,checkpoint_at,incomplete)
        values ($1,$2::date,'action','page-viewed','{}'::jsonb,1,0,1,0,'phase7.daily.v2',$3::timestamptz,false)`,
      [portfolioId, today, capturedInstant]);
      await admin.query(`insert into measurement.daily_aggregate_checkpoints
        (portfolio_id,utc_day,source_event_count,source_conversion_count,policy_version,checkpoint_at,incomplete)
        values ($1,$2::date,0,0,'phase7.daily.v2',$3::timestamptz,false)`, [portfolioId, expiredDay, capturedInstant]);
      await admin.query(`insert into measurement.retention_checkpoints
        (portfolio_id,job_id,work_kind,requested_at,stage,updated_at)
        values ($1,$2,'aggregates',$3::timestamptz,'checkpoints',$3::timestamptz)`, [portfolioId, deletionJobId, capturedInstant]);
      for (const [purpose, scope] of [
        ["measurement.owner-export", portfolioId],
        ["measurement.aggregate", createStableId("Portfolio")],
        ["measurement.retention", createStableId("Portfolio")],
        ["content.owner-export", portfolioId],
      ] as const) {
        const deletion = await worker.transactions.run(async (tx) => {
          const db = resolvePostgresTransaction(tx);
          await sql`select set_config('shipwithali.portfolio_id', ${scope}, true),
            set_config('shipwithali.owner_id', ${ownerId}, true), set_config('shipwithali.worker_purpose', ${purpose}, true)`.execute(db);
          const visible = await sql<{ aggregates: number; checkpoints: number }>`select
            (select count(*)::int from measurement.daily_aggregates where portfolio_id=${portfolioId}::uuid
              and utc_day=${today}::date and metric_kind='action' and metric_key='page-viewed') as aggregates,
            (select count(*)::int from measurement.daily_aggregate_checkpoints where portfolio_id=${portfolioId}::uuid
              and utc_day=${expiredDay}::date) as checkpoints`.execute(db);
          const aggregates = await sql`delete from measurement.daily_aggregates where portfolio_id=${portfolioId}::uuid
            and utc_day=${today}::date and metric_kind='action' and metric_key='page-viewed' returning utc_day`.execute(db);
          const checkpoints = await sql`delete from measurement.daily_aggregate_checkpoints where portfolio_id=${portfolioId}::uuid
            and utc_day=${expiredDay}::date returning utc_day`.execute(db);
          return { visible: visible.rows[0], aggregates: aggregates.rows.length, checkpoints: checkpoints.rows.length };
        });
        const visible = purpose === "measurement.owner-export" ? 1 : 0;
        expect(deletion, JSON.stringify({ purpose, ...deletion }))
          .toEqual({ visible: { aggregates: visible, checkpoints: visible }, aggregates: 0, checkpoints: 0 });
      }
      expect((await admin.query(`select 1 from measurement.daily_aggregates where portfolio_id=$1
        and utc_day=$2::date and metric_kind='action' and metric_key='page-viewed'`, [portfolioId, today])).rows).toHaveLength(1);
      expect((await admin.query("select 1 from measurement.daily_aggregate_checkpoints where portfolio_id=$1 and utc_day=$2::date",
        [portfolioId, expiredDay])).rows).toHaveLength(1);
      const permittedDeletion = await worker.transactions.run(async (tx) => {
        const db = resolvePostgresTransaction(tx);
        await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true),
          set_config('shipwithali.worker_purpose', 'measurement.aggregate', true)`.execute(db);
        const aggregates = await sql`delete from measurement.daily_aggregates where portfolio_id=${portfolioId}::uuid
          and utc_day=${today}::date and metric_kind='action' and metric_key='page-viewed' returning utc_day`.execute(db);
        await sql`select set_config('shipwithali.worker_purpose', 'measurement.retention', true)`.execute(db);
        const checkpoints = await sql`delete from measurement.daily_aggregate_checkpoints where portfolio_id=${portfolioId}::uuid
          and utc_day=${expiredDay}::date returning utc_day`.execute(db);
        return { aggregates: aggregates.rows.length, checkpoints: checkpoints.rows.length };
      });
      expect(permittedDeletion).toEqual({ aggregates: 1, checkpoints: 1 });

      let signalRootsRead!: () => void;
      let releaseCapture!: () => void;
      const rootsRead = new Promise<void>((resolve) => { signalRootsRead = resolve; });
      const release = new Promise<void>((resolve) => { releaseCapture = resolve; });
      const baseGoals = createPostgresOwnerAnalyticsGoalRepository();
      const barrierGoals = {
        ...baseGoals,
        async listGoals(id: StableId<"Portfolio">, tx: Parameters<NonNullable<typeof baseGoals.listGoals>>[1]) {
          const roots = await baseGoals.listGoals!(id, tx);
          signalRootsRead();
          await release;
          return roots;
        },
      };
      const service = createOwnerAnalyticsExportSnapshotService({ goals: barrierGoals, aggregates: createPostgresDailyAggregateRepository() });
      const concurrentCapture = worker.transactions.run(async (tx) => {
        const db = resolvePostgresTransaction(tx);
        await sql`select set_config('shipwithali.portfolio_id', ${portfolioId}, true), set_config('shipwithali.owner_id', ${ownerId}, true),
          set_config('shipwithali.worker_purpose', 'measurement.owner-export', true)`.execute(db);
        const time = await sql<{ captured_at: Date | string }>`select transaction_timestamp() as captured_at`.execute(db);
        const raw = time.rows[0]?.captured_at;
        if (raw === undefined) throw new Error("PHASE8_ANALYTICS_CAPTURE_TIME_MISSING");
        const instant = raw instanceof Date ? raw.toISOString() : new Date(raw).toISOString();
        return service.readOwnerAnalyticsExportSnapshot({ portfolioId, ownerId, capturedAt: instant, transaction: tx });
      }, { isolationLevel: "repeatable read" });
      await rootsRead;
      const addedVersion = createStableId("AnalyticsGoalVersion");
      let mutationOpen = false;
      try {
        await admin.query("begin");
        mutationOpen = true;
        await admin.query(`insert into measurement.analytics_goal_versions
          (portfolio_id,goal_id,version_id,version_number,definition,created_at)
          values ($1,$2,$3,3,$4::jsonb,transaction_timestamp())`, [portfolioId, availableGoalId, addedVersion, JSON.stringify(availableDefinition)]);
        await admin.query("update measurement.analytics_goals set aggregate_version=7,active_version_id=$3 where portfolio_id=$1 and goal_id=$2", [portfolioId, availableGoalId, addedVersion]);
        await admin.query(`insert into measurement.analytics_goal_activation_history
          (portfolio_id,goal_id,activation_id,version_id,aggregate_version,activated_at,activation_sequence)
          values ($1,$2,$3,$4,7,transaction_timestamp(),3)`, [portfolioId, availableGoalId, actorActivation(), addedVersion]);
        await admin.query(`update measurement.daily_aggregates set event_count=99
          where portfolio_id=$1 and utc_day=$2::date and metric_kind='goal' and goal_id=$3 and goal_version_id=$4 and dimensions='{"locale":"en"}'::jsonb`,
        [portfolioId, today, availableGoalId, availableV2]);
        await admin.query("commit");
        mutationOpen = false;
      } finally {
        if (mutationOpen) await admin.query("rollback");
        releaseCapture();
      }
      const consistent = await concurrentCapture;
      expect(consistent.ok).toBe(true);
      if (!consistent.ok) throw new Error("PHASE8_ANALYTICS_REPEATABLE_READ_CAPTURE_FAILED");
      const consistentGoal = consistent.value.records.find((record) => record.goalId === availableGoalId)!.value as {
        goal: { aggregateVersion: number; activeVersionId: string; activationHistory: readonly { activationSequence: number }[] };
        reports: readonly Record<string, unknown>[];
      };
      expect(consistentGoal.goal.aggregateVersion).toBe(5);
      expect(consistentGoal.goal.activeVersionId).toBe(availableV2);
      expect(consistentGoal.goal.activationHistory.map((item) => item.activationSequence)).toEqual([1, 2]);
      expect(consistentGoal.reports.at(-1)).toMatchObject({ sampleState: "sufficient", cells: [{ locale: "en", aggregateCount: 7 }] });
    } finally {
      try {
        if (fixtureSeeded) {
          await admin.query("begin");
          await admin.query("set local session_replication_role = replica");
          await admin.query("delete from measurement.retention_checkpoints where portfolio_id=$1", [portfolioId]);
          await admin.query("delete from measurement.daily_aggregates where portfolio_id=$1", [portfolioId]);
          await admin.query("delete from measurement.daily_aggregate_checkpoints where portfolio_id=$1", [portfolioId]);
          await admin.query("delete from measurement.analytics_goal_activation_history where portfolio_id=$1", [portfolioId]);
          await admin.query("delete from measurement.analytics_goal_versions where portfolio_id=$1", [portfolioId]);
          await admin.query("delete from measurement.analytics_goals where portfolio_id=$1", [portfolioId]);
          await admin.query("delete from portfolio_config.settings where portfolio_id=$1", [portfolioId]);
          await admin.query("commit");
        } else {
          await admin.query("delete from portfolio_config.settings where portfolio_id=$1", [portfolioId]);
        }
      } finally {
        await application.resource.close();
        await worker.database.destroy();
        await admin.end();
      }
    }
  }, 120_000);
});
