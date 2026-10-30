import { execFileSync } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve, sep, join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { createRelationalBackupService, type RelationalBackupAttempt, type RelationalBackupCatalog } from "../../src/modules/portability-operations/application/relational-backup.js";
import { createObjectBackupService, selectCompatibleRecoverySet, type ObjectBackupAttempt, type ObjectBackupCatalog } from "../../src/modules/portability-operations/application/object-backup.js";
import { runRecoveryRehearsal, type RecoveryCopies, type RecoveryRehearsalPort, type RecoveryRehearsalReport } from "../../src/modules/portability-operations/application/recovery-rehearsal.js";
import { RECOVERY_DOMAIN_SCOPES, recoveryDomainSnapshotSha256, verifyRecoveryDomainMeaning } from "../../src/modules/portability-operations/application/recovery-domain-verification.js";
import type { OwnerExportSnapshotReaderPort } from "../../src/modules/portability-operations/application/owner-export-assembly.js";
import type { OwnerExportSelectedSnapshot } from "../../src/modules/portability-operations/application/owner-export-package.js";
import { ok } from "../../src/shared/domain/index.js";
import { createOwnerExportSnapshotReader } from "../../src/runtime/adapters/owner-export-snapshot.js";

function sha(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function hmac(key: Uint8Array | string, value: string): Buffer { return createHmac("sha256", key).update(value).digest(); }
function signingKey(secret: string, date: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, date), "us-east-1"), "s3"), "aws4_request");
}
type S3Credentials = Readonly<{ accessKey: string; secret: string }>;
const sourceObjectCredentials: S3Credentials = Object.freeze({ accessKey: "phase8-source-copy", secret: "source-copy-only-secret" });
const targetObjectCredentials: S3Credentials = Object.freeze({ accessKey: "phase8-target-restore", secret: "target-restore-only-secret" });
async function signedS3(endpoint: string, method: string, pathname: string, body = Buffer.alloc(0), credentials: S3Credentials = sourceObjectCredentials): Promise<Response> {
  const target = new URL(pathname, endpoint), payloadHash = sha(body);
  const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/gu, ""), date = timestamp.slice(0, 8);
  const headers = `host:${target.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const request = [method, target.pathname, "", headers, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/us-east-1/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", timestamp, scope, sha(Buffer.from(request))].join("\n");
  const signature = createHmac("sha256", signingKey(credentials.secret, date)).update(toSign).digest("hex");
  return fetch(target, { method, ...(method === "GET" || method === "DELETE" ? {} : { body }),
    headers: { "x-amz-content-sha256": payloadHash, "x-amz-date": timestamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` } });
}
function createS3ObjectDestination(endpoint: string, bucket: string, credentials: S3Credentials = sourceObjectCredentials) {
  return { name: "recovery-s3",
    async put(key: string, bytes: Uint8Array) {
      const response = await signedS3(endpoint, "PUT", `/${bucket}/${key}`, Buffer.from(bytes), credentials);
      if (!response.ok) throw new Error("OBJECT_BACKUP_UPLOAD_FAILED");
    },
    async get(key: string) {
      const response = await signedS3(endpoint, "GET", `/${bucket}/${key}`, Buffer.alloc(0), credentials);
      if (!response.ok) throw new Error("OBJECT_BACKUP_READBACK_FAILED");
      return Buffer.from(await response.arrayBuffer());
    },
    async delete(key: string) {
      const response = await signedS3(endpoint, "DELETE", `/${bucket}/${key}`, Buffer.alloc(0), credentials);
      if (!response.ok && response.status !== 404) throw new Error("OBJECT_BACKUP_DELETE_FAILED");
    },
  };
}
function ownedPath(root: string, relative: string): string {
  const path = resolve(root, relative);
  if (!path.startsWith(root + sep)) throw new Error("RECOVERY_OWNED_PATH_INVALID");
  return path;
}

const recoverySnapshotId = "0196a1b2-7c3d-7e11-9f22-000000000003";

/** Test module ports read the restored relations, then exercise the production owner-export projection. */
function productionRecoverySnapshotReader(client: Client, capturedAt: string, applyCurrentPrivacy = false): OwnerExportSnapshotReaderPort {
  const rows = async (sql: string) => (await client.query(sql)).rows as Array<Record<string, unknown>>;
  const tx = { async run<T>(work: (context: never) => Promise<T>) { return work({} as never); } };
  return createOwnerExportSnapshotReader({
    transactions: tx as never,
    capabilities: { async read() { return { currentCvAvailable: true, externalLinksAvailable: true }; } },
    configuration: { async getSettingsSnapshot() {
      const values = await rows("select setting_key,value,version from configuration.portfolio_settings order by setting_key");
      return ok({ capturedAt, settings: { portfolioId: "synthetic-portfolio", version: Math.max(0, ...values.map(row => Number(row["version"]))),
        profile: Object.fromEntries(values.map(row => [String(row["setting_key"]), row["value"]])) } as never });
    } },
    content: {
      async readOwnerExportSnapshot() {
        const facts = await rows("select id,locale,lifecycle,is_private,digest from content.domain_facts order by id");
        const revisions = await rows("select content_id,locale,sequence,published,digest from content.revision_history order by content_id,locale,sequence");
        const lifecycle = await rows("select content_id,sequence,state,changed_at from content.lifecycle_history order by content_id,sequence");
        const links = await rows("select source_id,target_id from content.domain_links order by source_id,target_id");
        const routes = await rows("select route_id,content_id,locale,published_at,discovery_order,redirected_to from content.routes order by route_id");
        return ok({ capturedAt, records: facts.filter(row => row["is_private"] !== true).map(row => {
          const id = String(row["id"]);
          const contentRoutes = routes.filter(item => item["content_id"] === id);
          const route = contentRoutes.find(item => item["redirected_to"] === null) ?? contentRoutes[0];
          const revisionRows = revisions.filter(item => item["content_id"] === id);
          const payload = { contentType: "project", title: id, summary: String(row["digest"]), body: String(row["digest"]),
            evidence: { claims: [{ text: String(row["digest"]), artifactIds: [] }], artifacts: [] } };
          return { contentId: id, contentType: "project", lifecycle: row["lifecycle"], aggregateVersion: Math.max(1, revisionRows.length),
            candidateSlug: route ? String(route["route_id"]) : null, firstPublishedAt: route ? new Date(route["published_at"] as string).toISOString() : null,
            projectStatus: null, featured: false,
            revisions: revisionRows.map(revision => ({ revisionId: `${id}-${revision["locale"]}-${revision["sequence"]}`,
              locale: revision["locale"], sequence: Number(revision["sequence"]), aggregateVersion: Number(revision["sequence"]),
              savedAt: capturedAt, payload: { ...payload, locale: revision["locale"] }, reviews: [] })),
            publications: revisionRows.filter(revision => revision["published"] === true).map(revision => ({ locale: revision["locale"],
              revisionId: `${id}-${revision["locale"]}-${revision["sequence"]}`, reviewId: `review-${revision["sequence"]}`,
              publicationSequence: Number(revision["sequence"]), publishedAt: capturedAt })),
            publicationHistory: [], lifecycleHistory: lifecycle.filter(item => item["content_id"] === id).map(item => ({ sequence: Number(item["sequence"]),
              previousLifecycle: "draft", lifecycle: String(item["state"]), aggregateVersion: Number(item["sequence"]), reason: null, changedAt: new Date(item["changed_at"] as string).toISOString() })),
            publicRoute: route ? { identity: String(route["route_id"]), canonicalSlug: String(route["route_id"]),
              firstPublishedAt: new Date(route["published_at"] as string).toISOString(), reservations: contentRoutes.map(item => ({
                slug: String(item["route_id"]), isCurrent: item["redirected_to"] === null, reservedAt: capturedAt })), history: [] } : null,
            relatedProjectIds: links.filter(item => item["source_id"] === id).map(item => String(item["target_id"])), relationshipHistory: [], taxonomyAssignments: [],
          };
        }) } as never);
      },
      async readOwnerExportMediaLocales() { return ok([{ mediaAssetId: "media-1", locales: ["en"] }] as never); },
    },
    taxonomy: { async readOwnerExportSnapshot() {
      const values = await rows("select value_id,name,state,merged_into from content.taxonomy_values order by value_id");
      const history = await rows("select value_id,sequence,action,name,state from content.taxonomy_history order by value_id,sequence");
      return ok({ capturedAt, taxonomies: [{ taxonomyId: "synthetic-taxonomy", aggregateVersion: 3, kind: "technology", values: values.map(value => ({
        valueId: value["value_id"], name: value["name"], state: value["state"], valueVersion: 1,
        ...(value["merged_into"] ? { mergedIntoValueId: value["merged_into"] } : {}) })),
        evolutionHistory: history.map(item => ({ valueId: item["value_id"], transitionSequence: Number(item["sequence"]), action: item["action"],
          previousName: null, name: item["name"], state: item["state"], changedAt: capturedAt,
          ...(item["action"] === "merged" ? { mergedIntoValueId: "tax-active" } : {}) })),
        assignments: [], assignmentHistory: [] }] } as never);
    } },
    media: { async readOwnerMediaExportSnapshot() {
      const records = await rows("select media_id,state,locale,alt_text,object_id,sha256 from content.media_metadata order by media_id");
      const decisions = await rows("select media_id,sequence,decision,policy_version from content.media_decisions order by media_id,sequence");
      return ok({ capturedAt, records: records.map(row => ({ mediaId: row["media_id"], value: { kind: "image", state: row["state"], aggregateVersion: 1,
        accessibilityMetadata: { kind: "described-image", altText: row["alt_text"] }, byteCoverage: "included", publicationEligibility: "eligible",
        decisions: decisions.filter(decision => decision["media_id"] === row["media_id"]) } })), assets: records.map(row => ({ mediaId: row["media_id"],
        objectId: row["object_id"], variantName: "original", mediaType: "image/png", byteLength: 22, sha256: row["sha256"], source: "original" })) } as never);
    }, async revalidateOwnerMediaExportSnapshot() { return ok(true); } },
    cv: { async readOwnerCvExportSnapshot() {
      const records = await rows("select version_id,active,media_id,activated_at from content.cv_history order by version_id");
      return ok({ capturedAt, aggregateVersion: records.length, currentVersionId: "cv-current", versions: records.map(row => ({ versionId: row["version_id"],
        mediaId: row["media_id"], locale: "en", label: String(row["version_id"]), state: "registered", isCurrent: row["active"], versionNumber: 1,
        registeredAt: capturedAt })), versionsTruncated: false,
        acceptanceHistory: [], acceptanceHistoryTruncated: false, activationHistory: [], activationHistoryTruncated: false } as never);
    } },
    moderation: { async readOwnerExportSnapshot() {
      const feedback = await rows("select feedback_id,state,private_text,redacted from moderation.feedback_history order by feedback_id");
      const decisions = await rows("select feedback_id,sequence,decision,decided_at from moderation.feedback_decisions order by feedback_id,sequence");
      return { capturedAt, records: feedback.map(row => ({ feedbackId: row["feedback_id"], projectId: "content-public", locale: "en", aggregateVersion: 1,
        state: applyCurrentPrivacy || row["redacted"] === true ? "suppressed" : row["state"], authorName: applyCurrentPrivacy || row["redacted"] === true ? null : "Synthetic owner",
        paragraph: applyCurrentPrivacy || row["redacted"] === true ? null : String(row["private_text"]), submittedAt: new Date(Date.parse(capturedAt) - 86_400_000).toISOString(),
        textErasedAt: applyCurrentPrivacy || row["redacted"] === true ? capturedAt : null, decisions: [
          ...decisions.filter(item => item["feedback_id"] === row["feedback_id"]).map(item => ({ sequence: Number(item["sequence"]),
            decision: item["decision"], reason: "synthetic", decidedAt: new Date(item["decided_at"] as string).toISOString() })),
          ...(applyCurrentPrivacy || row["redacted"] === true ? [{ sequence: decisions.filter(item => item["feedback_id"] === row["feedback_id"]).length + 1,
            decision: "suppressed", reason: "current-retention-reconciliation", decidedAt: capturedAt }] : []),
        ] })) } as never;
    } },
    analytics: { async readOwnerAnalyticsExportSnapshot() {
      const versions = await rows("select goal_id,version,active,rule_digest from measurement.goal_versions order by goal_id,version");
      const reports = await rows("select report_id,goal_version,period,suppressed,count_value from measurement.safe_reports order by report_id");
      return ok({ capturedAt, policyExpiresAt: new Date(Date.parse(capturedAt) + 86_400_000).toISOString(), records: [{ goalId: "goal-1", value: {
        goal: { versions }, reports: reports.map(row => ({ reportId: row["report_id"], goalVersion: row["goal_version"], period: row["period"],
          sampleState: row["suppressed"] === true ? "low-sample" : "sufficient", countDisposition: row["count_value"] === null ? "withheld" : "included" })) } }] } as never);
    } },
  });
}

async function captureProductionRecoverySnapshot(client: Client, capturedAt: string): Promise<OwnerExportSelectedSnapshot> {
  const result = await productionRecoverySnapshotReader(client, capturedAt, true).capture({
    portfolioId: "0196a1b2-7c3d-7e11-9f22-000000000001" as never,
    ownerId: "0196a1b2-7c3d-7e11-9f22-000000000002" as never,
    snapshotId: recoverySnapshotId as never,
    includedScopes: RECOVERY_DOMAIN_SCOPES,
  });
  if (!result.ok) throw new Error(`RECOVERY_OWNER_EXPORT_CAPTURE_FAILED:${result.error.code}`);
  if (!("kind" in result.value)) throw new Error("RECOVERY_OWNER_EXPORT_CONFIGURATION_ONLY");
  return result.value as OwnerExportSelectedSnapshot;
}

describe("#255 real isolated PostgreSQL recovery", () => {
  it.each([false, true])("skip retention reconciliation=%s: restores encrypted relational and object copies under quarantine, reconciles current privacy/effect state, verifies domain/RLS readiness, and cleans owned targets", async (skipRetentionReconciliation) => {
    const container = `phase8-recovery-${randomUUID().replaceAll("-", "")}`;
    const s3Container = `phase8-recovery-s3-${randomUUID().replaceAll("-", "")}`;
    const runId = randomUUID();
    const objectCopyBucket = `recovery-copy-${randomUUID().replaceAll("-", "")}`;
    const objectTargetBucket = `recovery-target-${randomUUID().replaceAll("-", "")}`;
    const password = `synthetic-${randomUUID()}`;
    const relationalCopyRoot = join(tmpdir(), `phase8-recovery-relational-copy-${randomUUID()}`);
    let containerStarted = false, s3ContainerStarted = false, targetPort = 0, s3Port = 0, s3Endpoint = "", verifiedIsolatedRestore = false;
    const objectTargetKeys = new Set<string>();
    let observedReport: RecoveryRehearsalReport | null = null;
    let admin: Client | undefined, source: Client | undefined, liveLedger: Client | undefined;
    const now = new Date().toISOString();
    const relationalWatermarkAt = new Date(Date.parse(now) - 3_600_000).toISOString();
    const objectWatermarkAt = new Date(Date.parse(now) - 5_400_000).toISOString();
    const objectBytes = Buffer.from("synthetic-media-object");
    const exportObjectBytes = Buffer.from([1, 2, 3]);
    const key = { keyVersion: "isolated-recovery-v1", bytes: Buffer.alloc(32, 7) };
    const objectKey = { keyVersion: "isolated-object-v1", bytes: Buffer.alloc(32, 9) };
    let usable: RelationalBackupAttempt | null = null;
    let attempt: RelationalBackupAttempt | null = null;
    let recoveryPayload: Uint8Array | null = null;
    const recoveryPayloadBuffers: Uint8Array[] = [];
    let objectAttempt: (ObjectBackupAttempt & { catalog: ObjectBackupCatalog }) | null = null;
    let expectedDomainSnapshotSha256 = "";
    const destination = { name: "isolated-relational-store",
      async put(objectKey: string, bytes: Uint8Array) {
          const file = ownedPath(relationalCopyRoot, objectKey);
        mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, bytes);
      },
      async get(objectKey: string) {
          const file = ownedPath(relationalCopyRoot, objectKey);
          if (!existsSync(file)) throw new Error("BACKUP_READBACK_FAILED");
        return readFileSync(file);
      },
        async delete(objectKey: string) { rmSync(ownedPath(relationalCopyRoot, objectKey), { force: true }); },
    };
    const catalog = {
      async begin(value: RelationalBackupAttempt) { attempt = value; },
      async markUsable(_id: string, verifiedAt: string, committedAt: string) { usable = { ...attempt!, state: "usable", verifiedAt, committedAt }; },
      async markFailed() { usable = null; }, async currentUsable() { return usable; },
    };
    try {
      mkdirSync(relationalCopyRoot);
      execFileSync("docker", ["run", "-d", "--rm", "--name", container, "-e", "POSTGRES_PASSWORD",
        "-p", "127.0.0.1::5432", "postgres:17-alpine"], {
        env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: "ignore", timeout: 30_000,
      });
      containerStarted = true;
      const mapping = execFileSync("docker", ["port", container, "5432/tcp"], { encoding: "utf8" }).trim();
      targetPort = Number(mapping.slice(mapping.lastIndexOf(":") + 1));
      if (!Number.isSafeInteger(targetPort) || targetPort < 1) throw new Error("RECOVERY_POSTGRES_PORT_INVALID");
      execFileSync("docker", ["run", "-d", "--rm", "--name", s3Container, "-e", "SERVICES=s3", "-e", "AWS_DEFAULT_REGION=us-east-1",
        "-p", "127.0.0.1::4566", "public.ecr.aws/localstack/localstack:4.5.0"], { stdio: "ignore", timeout: 30_000 });
      s3ContainerStarted = true;
      const s3Mapping = execFileSync("docker", ["port", s3Container, "4566/tcp"], { encoding: "utf8" }).trim();
      s3Port = Number(s3Mapping.slice(s3Mapping.lastIndexOf(":") + 1));
      if (!Number.isSafeInteger(s3Port) || s3Port < 1) throw new Error("RECOVERY_S3_PORT_INVALID");
      s3Endpoint = `http://127.0.0.1:${s3Port}`;
      let s3Healthy = false;
      for (let i = 0; i < 90; i += 1) {
        try { const response = await fetch(s3Endpoint + "/_localstack/health"); s3Healthy = response.ok; if (s3Healthy) break; }
        catch { /* LocalStack is starting. */ }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!s3Healthy) throw new Error("RECOVERY_S3_START_FAILED");
      expect(sourceObjectCredentials.accessKey).not.toBe(targetObjectCredentials.accessKey);
      expect(sourceObjectCredentials.secret).not.toBe(targetObjectCredentials.secret);
      for (const [bucket, credentials] of [[objectCopyBucket, sourceObjectCredentials], [objectTargetBucket, targetObjectCredentials]] as const) {
        const created = await signedS3(s3Endpoint, "PUT", `/${bucket}`, Buffer.alloc(0), credentials);
        if (!created.ok) throw new Error("RECOVERY_S3_BUCKET_CREATE_FAILED");
      }
      for (let i = 0; i < 30 && !admin; i += 1) {
        const candidate = new Client({ host: "127.0.0.1", port: targetPort, user: "postgres", password, database: "postgres", connectionTimeoutMillis: 2_000 });
        try { await candidate.connect(); admin = candidate; }
        catch { await candidate.end().catch(() => undefined); if (i === 29) throw new Error("RECOVERY_POSTGRES_START_FAILED");
          await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      if (!admin) throw new Error("RECOVERY_POSTGRES_START_FAILED");
      await admin.query(`create role backup_reader login password '${password}-source';
        create role recovery_reader login password '${password}-old-target'; create role target_restore login bypassrls password '${password}-restore';
        create role anon login password '${password}-anon';`);
      await admin.query("create database recovery_source");
      await admin.query("create database recovery_target owner target_restore");
      await admin.query("create database recovery_privacy_current");
      await admin.query("revoke connect on database recovery_target from public, recovery_reader");
      source = new Client({ host: "127.0.0.1", port: targetPort, user: "postgres", password, database: "recovery_source", connectionTimeoutMillis: 10_000 });
      await source.connect();
      await source.query(`create schema content; create schema operations; create schema portability; create schema privacy; create schema public_read;
        create schema moderation; create schema measurement; create schema configuration;
        create table content.domain_facts(id text primary key, locale text not null, lifecycle text not null, is_private boolean not null, digest text not null);
        alter table content.domain_facts enable row level security; alter table content.domain_facts force row level security;
        create policy recovery_reader_public on content.domain_facts for select to recovery_reader using (not is_private);
        grant usage on schema content to recovery_reader; grant select on content.domain_facts to recovery_reader;
        create table content.domain_links(source_id text, target_id text, primary key(source_id,target_id));
        create table content.revision_history(content_id text not null, locale text not null, sequence integer not null, published boolean not null, digest text not null, primary key(content_id,locale,sequence));
        create table content.lifecycle_history(content_id text not null, sequence integer not null, state text not null, changed_at timestamptz not null, primary key(content_id,sequence));
        create table content.relationship_history(source_id text not null, target_id text not null, sequence integer not null, state text not null, primary key(source_id,target_id,sequence));
        create table content.required_objects(object_id text primary key);
        create table content.routes(route_id text primary key, content_id text not null, locale text not null, published_at timestamptz not null, discovery_order integer not null, redirected_to text);
        create table content.taxonomy_values(value_id text primary key, name text not null, state text not null, merged_into text);
        create table content.taxonomy_history(value_id text not null, sequence integer not null, action text not null, name text not null, state text not null, primary key(value_id,sequence));
        create table content.media_metadata(media_id text primary key, state text not null, locale text not null, alt_text text not null, object_id text not null, sha256 text not null);
        create table content.media_decisions(media_id text not null, sequence integer not null, decision text not null, policy_version text not null, primary key(media_id,sequence));
        create table content.cv_history(version_id text primary key, active boolean not null, media_id text not null, activated_at timestamptz not null);
        create table moderation.feedback_history(feedback_id text primary key, state text not null, private_text text, redacted boolean not null);
        create table moderation.feedback_decisions(feedback_id text not null, sequence integer not null, decision text not null, decided_at timestamptz not null, primary key(feedback_id,sequence));
        create table measurement.goal_versions(goal_id text not null, version integer not null, active boolean not null, rule_digest text not null, primary key(goal_id,version));
        create table measurement.safe_reports(report_id text primary key, goal_version text not null, period text not null, suppressed boolean not null, count_value integer);
        create table configuration.portfolio_settings(setting_key text primary key, value text not null, version integer not null);
        create table configuration.settings_history(setting_key text not null, version integer not null, value_digest text not null, changed_at timestamptz not null, primary key(setting_key,version));
        create table operations.jobs(job_id text primary key, status text not null);
        create table operations.outbox_events(event_id text primary key, status text not null);
        create table operations.effect_deduplication(effect_id text primary key, state text not null);
        create table operations.external_effect_sink(effect_id text primary key, effect_type text not null);
        create table privacy.current_deletions(artifact_id text primary key, deleted_at timestamptz not null);
        create table portability.owner_exports(artifact_id text primary key, status text not null, bytes bytea);
        create table portability.restored_objects(object_id text primary key, bytes bytea not null, digest text not null);
        create table public_read.domain_projection(id text primary key, locale text not null, digest text not null);
        insert into content.domain_facts values ('content-public','en','published',false,'public-sha'),
          ('content-ar','ar','hidden',false,'arabic-sha'),('content-private','ar','draft',true,'private-sha');
        insert into content.revision_history values ('content-public','en',1,true,'public-sha'),('content-ar','ar',1,true,'arabic-sha'),('content-private','ar',1,false,'private-sha');
        insert into content.lifecycle_history values ('content-public',1,'draft','${now}'::timestamptz-interval '1 day'),('content-public',2,'published','${now}'),
          ('content-ar',1,'published','${now}'::timestamptz-interval '1 day'),('content-ar',2,'hidden','${now}');
        insert into content.relationship_history values ('content-public','content-private',1,'linked');
        insert into content.domain_links values ('content-public','content-private');
        insert into content.required_objects values ('media-1'),('export-1');
        insert into content.routes values ('route-en','content-public','en','${now}',1,null),('route-en-old','content-public','en','${now}',0,'route-en'),
          ('route-ar','content-ar','ar','${now}',2,null);
        insert into content.taxonomy_values values ('tax-active','Systems','active',null),('tax-merged','Service Layer','merged','tax-active'),('tax-retired','Legacy','retired',null);
        insert into content.taxonomy_history values ('tax-merged',1,'created','Service','active'),('tax-merged',2,'renamed','Service Layer','active'),('tax-merged',3,'merged','Service Layer','merged'),('tax-active',1,'created','Systems','active'),('tax-retired',1,'created','Legacy','active'),('tax-retired',2,'retired','Legacy','retired');
        insert into content.media_metadata values ('media-1','accepted','en','Accessible synthetic image','media-1','${sha(objectBytes)}');
        insert into content.media_decisions values ('media-1',1,'accepted','synthetic-policy-v1');
        insert into content.cv_history values ('cv-old',false,'media-1','${now}'::timestamptz-interval '1 day'),('cv-current',true,'media-1','${now}');
        insert into moderation.feedback_history values ('feedback-private','approved','synthetic private feedback',false);
        insert into moderation.feedback_decisions values ('feedback-private',1,'approved','${now}'::timestamptz-interval '1 day');
        insert into measurement.goal_versions values ('goal-1',1,false,'old-rule-hash'),('goal-1',2,true,'active-rule-hash');
        insert into measurement.safe_reports values ('report-safe','goal-v2','2026-10',true,null);
        insert into configuration.portfolio_settings values ('profile.locale','en,ar',3);
        insert into configuration.settings_history values ('profile.locale',1,'digest-v1','${now}'::timestamptz-interval '2 days'),('profile.locale',2,'digest-v2','${now}'::timestamptz-interval '1 day'),('profile.locale',3,'digest-v3','${now}');
        insert into operations.jobs values ('job-1','available');
        insert into operations.outbox_events values ('effect-1','pending');
        insert into operations.effect_deduplication values ('effect-1','reserved');
        insert into portability.owner_exports values ('export-1','ready',decode('010203','hex'));`);
      expectedDomainSnapshotSha256 = recoveryDomainSnapshotSha256(await captureProductionRecoverySnapshot(source, now));
      const archive = execFileSync("docker", ["exec", container, "pg_dump", "-U", "postgres", "--format=custom", "--no-owner", "--no-acl", "--dbname=recovery_source"], { timeout: 30_000 });
      const backupScope = ["content", "operations", "portability", "privacy", "public_read", "moderation", "measurement", "configuration"];
      const inventory = await source.query(`select count(distinct n.nspname)::int as schema_count,
        count(*) filter (where c.relkind in ('r','p','v','m','f'))::int as relation_count
        from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname=any($1::text[])`, [backupScope]);
      const emptyRoles = Buffer.alloc(0);
      const manifest = Buffer.from(JSON.stringify({ format: "SWDB", version: 1, database: "recovery_source", rolesBytes: 0,
        databaseBytes: archive.byteLength, rolesSha256: sha(emptyRoles), databaseSha256: sha(archive), migrationHashes: {}, migrationSources: [] }));
      const prefix = Buffer.alloc(8); prefix.write("SWDB", 0, "ascii"); prefix.writeUInt32BE(manifest.byteLength, 4);
      const dump = Buffer.concat([prefix, manifest, emptyRoles, archive]);
      const backupCatalog: RelationalBackupCatalog = { version: 1, scope: backupScope,
        sourceWatermarkAt: relationalWatermarkAt, startedAt: now, completedAt: new Date().toISOString(),
        dumpTool: "pg_dump", dumpToolVersion: "17", schemaCount: Number(inventory.rows[0]?.schema_count),
        relationCount: Number(inventory.rows[0]?.relation_count), migrationCount: 0,
        dumpBytes: dump.byteLength, complete: true,
        managedMetadata: { auth: "database-dump; reset custom credentials from protected secrets after restore",
          storage: "database metadata only; object bytes are backed up separately" } };
      const backupService = createRelationalBackupService({
        source: { capture: async () => ({ dump, catalog: backupCatalog }) }, destination,
        catalog, incidents: { recordFailure: async () => {} }, key, ids: { next: () => randomUUID() },
        clock: { now: () => now }, retentionLifetimeHours: 168,
      });
      attempt = await backupService.create(); usable = attempt;
      const objectDestination = createS3ObjectDestination(s3Endpoint, objectCopyBucket);
      const objectService = createObjectBackupService({
        source: { capture: async () => ({ sourceWatermarkAt: objectWatermarkAt, relationalWatermarkAt: attempt!.sourceWatermarkAt,
          items: [
            { kind: "media", portfolioId: "synthetic-portfolio", mediaId: "media-1", objectId: "media-1", source: "original",
              variantName: "original", mediaType: "image/png", byteLength: objectBytes.length, sha256: sha(objectBytes),
              eligibleAt: now, expiresAt: null, read: async () => Buffer.from(objectBytes) },
            { kind: "owner-export", portfolioId: "synthetic-portfolio", exportId: "export-1", objectId: "export-1", source: "export-artifact",
              variantName: "complete-package", mediaType: "application/zip", byteLength: exportObjectBytes.length,
              sha256: sha(exportObjectBytes), eligibleAt: now, expiresAt: null, read: async () => Buffer.from(exportObjectBytes) },
          ] }) },
        destination: objectDestination, catalog: {
          begin: async () => {}, finalizeUploading: async () => {}, markUsable: async () => {}, markFailed: async () => {},
          currentUsable: async () => null, listUsable: async () => [], listStaleUploading: async () => [], listExpired: async () => [], acknowledgeDeletion: async () => {},
        }, incidents: { recordFailure: async () => {} }, key: objectKey, ids: { next: () => randomUUID() }, clock: { now: () => now }, retentionLifetimeHours: 168,
      });
      objectAttempt = await objectService.create();
      liveLedger = new Client({ host: "127.0.0.1", port: targetPort, user: "postgres", password,
        database: "recovery_privacy_current", connectionTimeoutMillis: 10_000 });
      await liveLedger.connect();
      await liveLedger.query("create schema privacy; create schema moderation; create table privacy.current_deletions(artifact_id text primary key, deleted_at timestamptz not null); create table moderation.current_retention(feedback_id text primary key, expires_at timestamptz not null)");
      await liveLedger.query("insert into privacy.current_deletions values ('export-1',$1)", [now]);
      await liveLedger.query("insert into moderation.current_retention values ('feedback-private',$1)", [now]);
      const targetUrl = `postgres://recovery_reader:${encodeURIComponent(password + "-target")}@127.0.0.1:${targetPort}/recovery_target`;
      const sourceUrl = `postgres://backup_reader:${encodeURIComponent(password + "-source")}@127.0.0.1:${targetPort}/recovery_source`;
      const copies: RecoveryCopies = {
        relational: { copyId: attempt.copyId, sourceWatermarkAt: attempt.sourceWatermarkAt, encryptedBytes: attempt.ciphertextBytes,
          schemaCount: backupCatalog.schemaCount, relationCount: backupCatalog.relationCount, migrationCount: backupCatalog.migrationCount },
        object: null,
      };
      let databaseRestored = false, deletionApplied = false, credentialsReconciled = false, effectsFenced = false, released = false;
      const incidents: string[] = [];
      const targetClient = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
        const client = new Client({ connectionString: targetUrl });
        await client.connect();
        try { return await work(client); } finally { await client.end(); }
      };
      const targetOperator = async <T>(work: (client: Client) => Promise<T>): Promise<T> => {
        const client = new Client({ host: "127.0.0.1", port: targetPort, user: "target_restore",
          password: password + "-restore", database: "recovery_target" });
        await client.connect();
        try { return await work(client); } finally { await client.end(); }
      };
      const port: RecoveryRehearsalPort = {
        now: () => new Date().toISOString(),
        selectCopies: async () => {
          const selected = await catalog.currentUsable();
          if (selected === null || selected.copyId !== usable?.copyId) throw new Error("RECOVERY_RELATIONAL_COPY_NOT_DISCOVERED");
          return { ...copies, relational: { copyId: selected.copyId, sourceWatermarkAt: selected.sourceWatermarkAt,
            encryptedBytes: selected.ciphertextBytes, schemaCount: backupCatalog.schemaCount,
            relationCount: backupCatalog.relationCount, migrationCount: backupCatalog.migrationCount } };
        },
        verifyKeysAndCopies: async selected => {
          const recovered = await backupService.recover(usable!, key);
          try {
            if (recovered.catalog.sourceWatermarkAt !== selected.relational.sourceWatermarkAt) throw new Error("BACKUP_CATALOG_MISMATCH");
            recoveryPayload = Buffer.from(recovered.payload.database);
            recoveryPayloadBuffers.push(recoveryPayload);
          } finally {
            recovered.payload.database.fill(0);
            recovered.payload.roles.fill(0);
          }
        },
        verifyTarget: async () => {
          const protectedProbe = new Client({ connectionString: sourceUrl });
          await protectedProbe.connect(); await protectedProbe.end();
          if (targetUrl.includes("recovery_source")) throw new Error("RECOVERY_TARGET_PROTECTED");
        },
        enterQuarantine: async () => {
          const result = await admin!.query("select has_database_privilege('recovery_reader','recovery_target','connect') as allowed");
          if (result.rows[0].allowed) throw new Error("RECOVERY_QUARANTINE_FAILED");
        },
        restoreRelational: async () => {
          try {
            execFileSync("docker", ["exec", "-i", "-u", "postgres", container, "pg_restore", "--username=target_restore", "--exit-on-error", "--no-owner", "--no-acl",
              "--dbname=recovery_target"], { input: recoveryPayload!, stdio: ["pipe", "ignore", "ignore"] });
            databaseRestored = true;
          } finally { recoveryPayload?.fill(0); recoveryPayload = null; }
        },
        selectObjectCopy: async selected => {
          const required = await targetOperator(client => client.query("select object_id from content.required_objects"));
          const compatibility = selectCompatibleRecoverySet({ relational: { sourceWatermarkAt: selected.relational.sourceWatermarkAt! },
            object: objectAttempt!.catalog, requiredObjectIds: required.rows.map(row => String(row["object_id"])), integrity: "full" });
          if (!compatibility.compatible) throw new Error("RECOVERY_REQUIRED_OBJECTS_MISSING");
          return { copyId: objectAttempt!.copyId, sourceWatermarkAt: objectAttempt!.sourceWatermarkAt, encryptedBytes: objectAttempt!.ciphertextBytes,
            objectCount: objectAttempt!.objectCount, mediaBytes: objectAttempt!.mediaBytes, exportBytes: objectAttempt!.exportBytes,
            objectIds: objectAttempt!.catalog.objects.map(item => item.objectId) };
        },
        verifyObjectKeysAndCopies: async () => { await objectService.verify(objectAttempt!, objectKey); },
        restoreObjects: async () => {
          await objectService.recoverTo(objectAttempt!, objectKey, async (descriptor, bytes) => {
            if (!new Set(["media-1", "export-1"]).has(descriptor.objectId)) throw new Error("RECOVERY_OBJECT_MAPPING_INVALID");
            const targetKey = `recovered/${descriptor.objectId}`;
            const response = await signedS3(s3Endpoint, "PUT", `/${objectTargetBucket}/${targetKey}`, Buffer.from(bytes), targetObjectCredentials);
            if (!response.ok) throw new Error("RECOVERY_OBJECT_TARGET_WRITE_FAILED");
            objectTargetKeys.add(targetKey);
          });
        },
        reconcileCurrentDeletionLedger: async () => {
          const projectionCount = await targetOperator(async client => client.query("select count(*)::int as count from public_read.domain_projection"));
          if (Number(projectionCount.rows[0]?.count) !== 0) throw new Error("RECOVERY_PRIVACY_RECONCILIATION_ORDER_INVALID");
          const current = await liveLedger!.query("select artifact_id,deleted_at from privacy.current_deletions");
          for (const row of current.rows) await targetOperator(async client => {
            await client.query("insert into privacy.current_deletions values ($1,$2) on conflict do nothing", [row.artifact_id, row.deleted_at]);
            await client.query("update portability.owner_exports set status='expired',bytes=null where artifact_id=$1", [row.artifact_id]);
            const targetKey = `recovered/${String(row.artifact_id)}`;
            const removed = await signedS3(s3Endpoint, "DELETE", `/${objectTargetBucket}/${targetKey}`, Buffer.alloc(0), targetObjectCredentials);
            if (!removed.ok && removed.status !== 404) throw new Error("RECOVERY_OBJECT_TARGET_DELETE_FAILED");
            objectTargetKeys.delete(targetKey);
          });
          const currentRetention = await liveLedger!.query("select feedback_id,expires_at from moderation.current_retention");
          for (const row of skipRetentionReconciliation ? [] : currentRetention.rows) await targetOperator(async client => {
            await client.query("update moderation.feedback_history set state='expired',private_text=null,redacted=true where feedback_id=$1", [row.feedback_id]);
          });
          deletionApplied = true;
          return { revoked: current.rowCount ?? 0, acknowledgedDeleted: currentRetention.rowCount ?? 0 };
        },
        resetCredentialsAndReconcileGrants: async () => targetOperator(async client => {
          if (!deletionApplied) throw new Error("RECOVERY_CREDENTIAL_RECONCILIATION_ORDER_INVALID");
          await admin!.query(`alter role recovery_reader with password '${password}-target'`);
          await client.query("grant usage on schema content, public_read to recovery_reader; grant select on content.domain_facts, public_read.domain_projection to recovery_reader");
          credentialsReconciled = true;
        }),
        reconcileRecoveredEffects: async () => targetOperator(async client => {
          if (!credentialsReconciled) throw new Error("RECOVERY_EFFECT_RECONCILIATION_ORDER_INVALID");
          await client.query("update operations.jobs set status='suppressed' where status in ('available','leased')");
          await client.query("update operations.outbox_events set status='suppressed' where status='pending'");
          await client.query("update operations.effect_deduplication set state='review' where state='reserved'");
          const result = await client.query("select count(*)::int as pending from operations.jobs where status in ('available','leased')");
          effectsFenced = Number(result.rows[0].pending) === 0;
          return { suppressed: 3, unresolved: 0 };
        }),
        rebuildProjections: async () => targetOperator(async client => {
          if (!deletionApplied || !credentialsReconciled || !effectsFenced) throw new Error("RECOVERY_PROJECTION_REBUILD_ORDER_INVALID");
          await client.query("insert into public_read.domain_projection select id,locale,digest from content.domain_facts where not is_private");
        }),
        verifyDomainMeaning: async () => {
          const snapshotReader: OwnerExportSnapshotReaderPort = {
            capture: async request => targetOperator(async client => productionRecoverySnapshotReader(client, now).capture(request)),
          };
          const feedback = await targetOperator(client => client.query("select state,private_text,redacted from moderation.feedback_history where feedback_id='feedback-private'"));
          if (feedback.rows[0]?.state !== "expired" || feedback.rows[0]?.private_text !== null || feedback.rows[0]?.redacted !== true) {
            throw new Error("RECOVERY_MODERATION_PRIVACY_NOT_RECONCILED");
          }
          const currentState = await targetOperator(client => client.query("select status,bytes from portability.owner_exports where artifact_id='export-1'"));
          const mediaResponse = await signedS3(s3Endpoint, "GET", `/${objectTargetBucket}/recovered/media-1`, Buffer.alloc(0), targetObjectCredentials);
          const mediaBytes = Buffer.from(await mediaResponse.arrayBuffer());
          const exportObjectRemoved = (await signedS3(s3Endpoint, "GET", `/${objectTargetBucket}/recovered/export-1`, Buffer.alloc(0), targetObjectCredentials)).status === 404;
          return verifyRecoveryDomainMeaning({ snapshots: snapshotReader, portfolioId: "0196a1b2-7c3d-7e11-9f22-000000000001" as never,
            ownerId: "0196a1b2-7c3d-7e11-9f22-000000000002" as never, snapshotId: recoverySnapshotId as never,
            expectedSnapshotSha256: expectedDomainSnapshotSha256,
            currentPrivacyAndObjectChecks: { deletionApplied, revokedExportBytesCleared: currentState.rows[0]?.status === "expired" && currentState.rows[0]?.bytes === null,
              revokedExportObjectRemoved: exportObjectRemoved,
              mediaObjectDigestMatches: mediaResponse.ok && sha(mediaBytes) === sha(Buffer.from("synthetic-media-object")) } });
        },
        verifyRestrictedRlsAndReadiness: async () => {
          await admin!.query("grant connect on database recovery_target to recovery_reader");
          const staleCredentials = new Client({ host: "127.0.0.1", port: targetPort, user: "recovery_reader",
            password: password + "-old-target", database: "recovery_target", connectionTimeoutMillis: 2_000 });
          let staleCredentialsDenied = false;
          try { await staleCredentials.connect(); } catch { staleCredentialsDenied = true; }
          await staleCredentials.end().catch(() => undefined);
          if (!staleCredentialsDenied) return { allowCases: 0, denyCases: 0, ready: false };
          const permissions = await targetOperator(client => client.query(`select has_table_privilege('recovery_reader','content.domain_facts','SELECT') as can_read,
            has_table_privilege('recovery_reader','content.domain_facts','UPDATE') as can_update`));
          const reader = await targetClient(client => client.query("select id,locale,digest from content.domain_facts where not is_private order by id"));
          const rlsVisibleRows = await targetClient(client => client.query("select id from content.domain_facts order by id"));
          const lastValidQuery = await targetClient(client => client.query("select id,locale,digest from public_read.domain_projection order by id"));
          if (!permissions.rows[0]?.can_read || permissions.rows[0]?.can_update || lastValidQuery.rowCount !== 2) return { allowCases: 1, denyCases: 0, ready: false };
          if (reader.rowCount !== 2 || rlsVisibleRows.rowCount !== 2 || rlsVisibleRows.rows.some(row => row["id"] === "content-private") ||
              !databaseRestored || !deletionApplied || !effectsFenced) return { allowCases: 1, denyCases: 0, ready: false };
          await admin!.query("grant connect on database recovery_target to anon");
          const denied = new Client({ host: "127.0.0.1", port: targetPort, user: "anon", password: password + "-anon", database: "recovery_target" });
          await denied.connect();
          let denyCases = 0;
          try { await denied.query("select * from content.domain_facts"); } catch { denyCases += 1; }
          await denied.end();
          return { allowCases: 1, denyCases, ready: denyCases === 1 };
        },
        releaseQuarantine: async () => { released = true; },
        cleanupOwnedTargets: async () => {
          await admin!.query("revoke connect on database recovery_target from recovery_reader; select pg_terminate_backend(pid) from pg_stat_activity where datname='recovery_target'");
          await admin!.query("drop database recovery_target");
          for (const key of objectTargetKeys) await createS3ObjectDestination(s3Endpoint, objectTargetBucket, targetObjectCredentials).delete(key);
          objectTargetKeys.clear();
          if (objectAttempt) {
            const copyStore = createS3ObjectDestination(s3Endpoint, objectCopyBucket);
            for (const key of [objectAttempt.objectKey, ...objectAttempt.catalog.objects.map(item => item.backupObjectKey).filter((value): value is string => Boolean(value))]) {
              await copyStore.delete(key);
            }
          }
          const remainingTarget = await Promise.all(["recovered/media-1", "recovered/export-1"].map(key => signedS3(s3Endpoint, "GET", `/${objectTargetBucket}/${key}`, Buffer.alloc(0), targetObjectCredentials)));
          const db = await admin!.query("select exists(select 1 from pg_database where datname='recovery_target') as exists");
          const targetRemoved = !Boolean(db.rows[0]?.exists) && remainingTarget.every(response => response.status === 404);
          return { databases: 1, objects: 2, temporaryFiles: 1, complete: targetRemoved };
        },
        recordSafeIncident: async code => { incidents.push(code); },
      };
      const referenceEpoch = Date.now();
      const referenceAt = new Date(referenceEpoch).toISOString();
      const discoveryStartedAt = performance.now();
      const discoveredRelationalCopy = await catalog.currentUsable();
      const discoveredObjectCopy = objectAttempt?.catalog;
      if (discoveredRelationalCopy === null || discoveredObjectCopy === undefined) throw new Error("RECOVERY_COPY_DISCOVERY_INCOMPLETE");
      const encryptedObjectCatalog = await objectDestination.get(objectAttempt!.objectKey);
      if (encryptedObjectCatalog.byteLength === 0) throw new Error("RECOVERY_OBJECT_CATALOG_UNAVAILABLE");
      encryptedObjectCatalog.fill(0);
      const discoveryAccessMilliseconds = Math.max(1, Math.ceil(performance.now() - discoveryStartedAt));
      const startedAt = new Date(referenceEpoch + discoveryAccessMilliseconds).toISOString();
      const report = await runRecoveryRehearsal({ target: { environment: "test", targetIdentity: targetUrl, sourceIdentity: sourceUrl,
        protectedIdentities: ["postgres://127.0.0.1:5432/production", `postgres://127.0.0.1:${targetPort}/recovery_source`],
        allowlistedTargetIdentities: [`postgres://127.0.0.1:${targetPort}/recovery_target`],
        objectTargetIdentity: `s3://${objectTargetBucket}/recovered`,
        sourceObjectIdentity: `s3://${objectCopyBucket}/copies`,
        protectedObjectIdentities: ["s3://production/portfolio-media"],
        allowlistedObjectIdentities: [`s3://${objectTargetBucket}/recovered`] },
        referenceAt, relationalRpoHours: 24, mediaRpoHours: 168, rtoTargetMilliseconds: 28_800_000,
        startedAt, discoveryAccessMilliseconds, manualPauseMilliseconds: 0 }, port);
      observedReport = report;
      if (skipRetentionReconciliation) {
        expect(report).toMatchObject({ status: "failed", failureStage: "domain_verification", accessReleased: false });
        expect(released).toBe(false);
        expect(report.cleanup.complete).toBe(true);
        return;
      }
      expect(report).toMatchObject({ status: "complete", releaseBlocker: false, accessReleased: true,
        mediaBytes: objectBytes.length, exportBytes: exportObjectBytes.length,
        objectCount: 2,
        failureCode: null, failureStage: null,
        domain: { locales: true, lifecycle: true, routes: true, taxonomy: true, mediaAccessibility: true, cvHistory: true,
          moderationPrivacy: true, analyticsPrivacy: true, configuration: true,
          snapshotSha256: expectedDomainSnapshotSha256, expectedSnapshotSha256: expectedDomainSnapshotSha256 },
        cleanup: { databases: 1, objects: 2, temporaryFiles: 1, complete: true } });
      expect(report.relationalBytes).toBeGreaterThan(0);
      expect(report.relationalRpoHours).toBeGreaterThanOrEqual(1);
      expect(report.mediaRpoHours).toBeGreaterThanOrEqual(1.5);
      expect(report.objectCount).toBe(2);
      expect(report.schemaCount).toBeGreaterThan(0);
      expect(report.relationCount).toBeGreaterThan(0);
      expect(Date.parse(report.verifiedAt!)).toBeGreaterThanOrEqual(Date.parse(startedAt));
      expect(report.measuredRtoMilliseconds).toBe(discoveryAccessMilliseconds + Date.parse(report.verifiedAt!) - Date.parse(startedAt));
      expect(report.measuredRtoMilliseconds).toBeGreaterThan(0);
      expect(report.stageMilliseconds).toHaveProperty("relational_restore");
      expect(report.stageMilliseconds).toHaveProperty("object_copy_selection");
      expect(report.stageMilliseconds).toHaveProperty("object_download_decrypt_validate");
      expect(report.stageMilliseconds).toHaveProperty("object_restore");
      expect(report.incident).toBeNull();
      expect(incidents).toEqual([]);
      expect(released).toBe(true);
      expect((await source.query("select status,octet_length(bytes) as bytes from portability.owner_exports where artifact_id='export-1'")).rows)
        .toEqual([{ status: "ready", bytes: 3 }]);
      expect((await source.query(`select (select status from operations.jobs where job_id='job-1') as job,
        (select status from operations.outbox_events where event_id='effect-1') as outbox,
        (select state from operations.effect_deduplication where effect_id='effect-1') as effect,
        (select count(*)::int from privacy.current_deletions) as deletion_count`)).rows)
        .toEqual([{ job: "available", outbox: "pending", effect: "reserved", deletion_count: 0 }]);
      expect((await source.query("select count(*)::int as effects from operations.external_effect_sink")).rows[0]?.effects).toBe(0);
      expect((await source.query("select state,private_text,redacted from moderation.feedback_history where feedback_id='feedback-private'")).rows)
        .toEqual([{ state: "approved", private_text: "synthetic private feedback", redacted: false }]);
      expect((await liveLedger.query("select count(*)::int as current_retention from moderation.current_retention")).rows[0]?.current_retention).toBe(1);
      expect(JSON.stringify(report)).not.toContain(password);
      verifiedIsolatedRestore = report.status === "complete" && report.cleanup.complete;
    } finally {
      if (source) await source.end().catch(() => undefined);
      if (liveLedger) await liveLedger.end().catch(() => undefined);
      if (admin) {
        if (!verifiedIsolatedRestore) await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname='recovery_target'").catch(() => undefined);
        await admin.end().catch(() => undefined);
      }
      for (const payload of recoveryPayloadBuffers) payload.fill(0);
      for (const key of objectTargetKeys) await createS3ObjectDestination(s3Endpoint, objectTargetBucket, targetObjectCredentials).delete(key).catch(() => undefined);
      if (objectAttempt && s3Endpoint) {
        const copyStore = createS3ObjectDestination(s3Endpoint, objectCopyBucket);
        for (const key of [objectAttempt.objectKey, ...objectAttempt.catalog.objects.map(item => item.backupObjectKey).filter((value): value is string => Boolean(value))]) {
          await copyStore.delete(key).catch(() => undefined);
        }
      }
      if (containerStarted) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
      rmSync(relationalCopyRoot, { recursive: true, force: true });
      if (s3ContainerStarted) execFileSync("docker", ["rm", "-f", s3Container], { stdio: "ignore" });
      if (verifiedIsolatedRestore && observedReport) process.stdout.write(JSON.stringify({ evidence: "isolated-postgres-object-recovery-small-fixture",
        provenance: { runId, sourceCommitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
          databaseService: "postgres:17-alpine", objectService: "localstack:4.5.0", targetRoles: ["target_restore", "recovery_reader", "anon"],
          sourceAndTargetCredentialsDistinct: sourceObjectCredentials.accessKey !== targetObjectCredentials.accessKey &&
            sourceObjectCredentials.secret !== targetObjectCredentials.secret },
        checks: { encryptedRelationalCopyRetrievedAndVerified: true, encryptedObjectSetRetrievedAndVerified: true,
          requiredObjectsSelectedFromRestoredDatabase: true, restoredMediaDigestMatchedAndRevokedExportObjectRemoved: true,
          quarantineMaintainedThroughDomainAndRlsVerification: true, currentDeletionReconciled: true,
          externalEffectsFencedWithoutWorkerExecution: true, rlsAllowDenyVerified: true, domainFixtureCategoriesVerified: true,
          ownedDatabaseAndObjectTargetsRemoved: true },
        measurements: { referenceAt: observedReport.referenceAt, relationalWatermarkAt: observedReport.relationalWatermarkAt,
          mediaWatermarkAt: observedReport.mediaWatermarkAt, relationalRpoHours: observedReport.relationalRpoHours,
          mediaRpoHours: observedReport.mediaRpoHours, relationalEncryptedBytes: observedReport.relationalBytes,
          mediaBytes: observedReport.mediaBytes, exportBytes: observedReport.exportBytes, objectCount: observedReport.objectCount,
          schemaCount: observedReport.schemaCount, relationCount: observedReport.relationCount, migrationCount: observedReport.migrationCount,
          startedAt: observedReport.startedAt, verifiedAt: observedReport.verifiedAt, discoveryAccessMilliseconds: observedReport.discoveryAccessMilliseconds,
          manualPauseMilliseconds: observedReport.manualPauseMilliseconds, measuredRtoMilliseconds: observedReport.measuredRtoMilliseconds,
          stageMilliseconds: observedReport.stageMilliseconds, releaseBlocker: observedReport.releaseBlocker, cleanup: observedReport.cleanup },
        qualification: { fixture: "synthetic-small", productionVolumeQualified: false, productionRtoQualified: false } }) + "\n");
    }
  }, 180_000);
});
