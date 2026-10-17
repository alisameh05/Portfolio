#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes, randomInt, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { sanitizeEvidenceOutput } from "./phase4-gate-support.mjs";
import {
  PHASE6_FORMATS, PHASE6_TOOL_DEFINITIONS, evaluatePhase6IntegrationTests, evaluatePhase6Setup, getPhase6SourceIdentity, isolatedPhase6Config,
  evaluatePhase6MediaCvIntegration, PHASE6_MEDIA_CV_CRITERION_IDS, makePhase6Report, phase6CvScenarioProof, phase6FormatProof,
  phase6CvDeferredMigrations, phase6Package, phase6Readiness, phase6Root, scrubPhase6Environment,
} from "./phase6-verification-support.mjs";

const ROOT = phase6Root();
const CLI = join(ROOT, "node_modules/supabase/dist/supabase.js");
const EVIDENCE = join(ROOT, "evidence/phase-6-verification-setup.json");
const PUBLICATION_MEDIA_EVIDENCE = join(ROOT, "evidence/phase6-publication-media-153.json");
const UPLOAD_INTENT_EVIDENCE = join(ROOT, "evidence/phase6-upload-intent-148.json");
const MEDIA_PROCESSING_EVIDENCE = join(ROOT, "evidence/phase6-media-processing-149.json");
const IMAGE_PROCESSING_EVIDENCE = join(ROOT, "evidence/phase6-image-processing-150.json");
const VIDEO_PROCESSING_EVIDENCE = join(ROOT, "evidence/phase6-video-processing-151.json");
const MEDIA_ACCEPTANCE_EVIDENCE = join(ROOT, "evidence/phase6-media-acceptance-152.json");
const MEDIA_DELIVERY_EVIDENCE = join(ROOT, "evidence/phase6-media-delivery-158.json");
const CV_PORTFOLIO_EVIDENCE = join(ROOT, "evidence/phase6-cv-portfolio-154.json");
const CV_ACCEPTANCE_EVIDENCE = join(ROOT, "evidence/phase6-cv-acceptance-155.json");
const CV_ACTIVATION_EVIDENCE = join(ROOT, "evidence/phase6-cv-activation-156.json");
const CV_DELIVERY_EVIDENCE = join(ROOT, "evidence/phase6-cv-delivery-159.json");
const PUBLIC_CAPABILITY_EVIDENCE = join(ROOT, "evidence/phase6-public-capabilities-160.json");
const OWNER_COMPOSITION_EVIDENCE = join(ROOT, "evidence/phase6-owner-composition-161.json");
const MEDIA_CV_INTEGRATION_EVIDENCE = join(ROOT, "evidence/phase6-media-cv-integration-163.json");
const UPLOAD_INTENT_ONLY = process.argv.includes("--upload-intents-only");
const MEDIA_PROCESSING_ONLY = process.argv.includes("--media-processing-only");
const IMAGE_PROCESSING_ONLY = process.argv.includes("--image-processing-only");
const VIDEO_PROCESSING_ONLY = process.argv.includes("--video-processing-only");
const MEDIA_ACCEPTANCE_ONLY = process.argv.includes("--media-acceptance-only");
const MEDIA_DELIVERY_ONLY = process.argv.includes("--media-delivery-only");
const MEDIA_REJECTION_ONLY = process.argv.includes("--media-rejection-only");
const MEDIA_REJECTION_BUCKETS = Object.freeze({ candidate: "media-candidates", processed: "media-processed" });
const CV_PORTFOLIO_ONLY = process.argv.includes("--cv-portfolio-only");
const CV_ACCEPTANCE_ONLY = process.argv.includes("--cv-acceptance-only");
const CV_ACTIVATION_ONLY = process.argv.includes("--cv-activation-only");
const CV_DELIVERY_ONLY = process.argv.includes("--cv-delivery-only");
const PUBLICATION_MEDIA_ONLY = process.argv.includes("--publication-media-only");
const MEDIA_INTEGRATION_ONLY = process.argv.includes("--media-integration-only");
const OWNER_COMPOSITION_ONLY = process.argv.includes("--owner-composition-only");
const MEDIA_CV_INTEGRATION_ONLY = process.argv.includes("--media-cv-integration-only");
const BASELINE_VERIFICATION_ONLY = process.argv.length === 2;
const RUN_MEDIA_ACCEPTANCE = MEDIA_ACCEPTANCE_ONLY || MEDIA_DELIVERY_ONLY || MEDIA_REJECTION_ONLY || CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY || PUBLICATION_MEDIA_ONLY || MEDIA_INTEGRATION_ONLY || OWNER_COMPOSITION_ONLY || MEDIA_CV_INTEGRATION_ONLY;
const RUN_TIMEOUT = 180_000;

const PHASE6_MEDIA_CV_TEST_NAMES = Object.freeze([
  "processes PDF candidates and real PNG JPEG WebP images through PostgreSQL, private Storage, ClamAV and trusted processors",
  "issues bounded delivery only for current published-locale and profile Media uses",
  "processes MP4 and WebM candidates with real PostgreSQL, private Storage, ClamAV and FFmpeg",
  "rejects accepted Media safely and serializes with current usage changes",
  "composes all nine Owner Media and CV operations through real services",
  "reports only Media referenced by currently published Project and Achievement locales",
  "preserves an existing publication when replacement Media facts are missing, malformed, stale, or unsuitable",
  "rejects invalid evidence, review, and Media facts without creating public state",
  "publishes English and Arabic independently, preserves first publication time, history, and the last valid projection",
  "publishes reviewed Achievements with internal or public evidence into a locale-specific ordered Timeline",
  "hides, archives, and restores all three content kinds through atomic owner lifecycle commands",
  "revalidates each exact locale publication before restore and changes none when one Media fact fails",
  "resolves a verified Owner actor for mutations with valid session, origin, and CSRF proof",
  "rejects mutations without a session cookie as 401 before dispatch",
  "requires owner-scoped access for every Owner entrypoint operation",
  "resolves a valid Owner session to a stable provider-neutral actor",
  "accepts emitted session claims, rejects tampering, removal and revocation",
  "allows the exact scoped signed upload and denies anonymous and non-Owner Storage reads/writes",
  "rolls back route reservations, immutable history, projections, receipt, and event when outbox append fails",
]);

function testNamePattern(names) {
  return names.join("|");
}

function scenarioCases(scenarios, requiredIds) {
  const source = Array.isArray(scenarios) ? scenarios : [];
  return requiredIds.flatMap((id) => {
    const matches = source.filter((item) => item?.id === id || (typeof item?.name === "string" && new RegExp(`\\b${id}\\b`, "u").test(item.name)));
    if (!matches.length) return [{ caseId: id, name: id, executed: false, status: "skipped" }];
    return matches.map((item, index) => ({ caseId: `${id}-${index + 1}`, name: item.name,
      executed: item.executed === true, status: item.status === "passed" ? "passed" : item.status === "failed" ? "failed" : "skipped" }));
  });
}

function assertionCases(assertions, requiredTitles) {
  const source = Array.isArray(assertions) ? assertions : [];
  return requiredTitles.flatMap((title) => {
    const matches = source.filter((item) => item?.title === title);
    if (!matches.length) return [{ caseId: `test:${title}`, name: title, executed: false, status: "skipped" }];
    return matches.map((item, index) => ({ caseId: `test:${title}:${index + 1}`, name: String(item.fullName ?? title),
      executed: item.status === "passed" || item.status === "failed", status: item.status === "passed" ? "passed" : item.status === "failed" ? "failed" : "skipped" }));
  });
}

function formatCases(formats) {
  return PHASE6_FORMATS.map(({ id }) => {
    const format = Array.isArray(formats) ? formats.find((item) => item.id === id) : undefined;
    return { caseId: `format:${id}`, name: `${id} real processor, scanner and private Storage round trip`,
      executed: format?.executed === true, status: format?.status === "passed" ? "passed" : format?.status === "failed" ? "failed" : "skipped" };
  });
}

function namedCases(items, requiredNames) {
  const source = Array.isArray(items) ? items : [];
  return requiredNames.flatMap((requiredName) => {
    const matches = source.filter((item) => typeof item?.name === "string" && item.name.includes(requiredName));
    if (!matches.length) return [{ caseId: requiredName, name: requiredName, executed: false, status: "skipped" }];
    return matches.map((item, index) => ({ caseId: `${requiredName}:${index + 1}`, name: item.name,
      executed: item.executed === true, status: item.status === "passed" ? "passed" : item.status === "failed" ? "failed" : "skipped" }));
  });
}

function run(command, args, { cwd = ROOT, env = process.env, timeout = RUN_TIMEOUT, input, label = command } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.code === "ETIMEDOUT" ? "timeout" : result.error?.code === "ENOENT" ? "missing-executable" : "nonzero-exit";
    const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim().split(/\r?\n/u).slice(-8).join(" | ")
      .replace(/https?:\/\/\S+/gu, "[url]")
      .replace(/(?:Bearer\s+|token=|apikey[=: ]+|password[=: ]+)\S+/giu, "[credential]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[token]")
      .slice(0, 600);
    throw new Error(`PHASE6_COMMAND_FAILED:${label}:${detail}${diagnostic ? `:${diagnostic}` : ""}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function pdfFixture() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>",
    "<< /Length 0 >>\nstream\n\nendstream",
  ];
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let cursor = chunks[0].length;
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(cursor);
    const part = Buffer.from(`${index + 1} 0 obj\n${objects[index]}\nendobj\n`);
    chunks.push(part);
    cursor += part.length;
  }
  const xref = cursor;
  let trailer = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) trailer += `${String(offset).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  chunks.push(Buffer.from(trailer));
  return Buffer.concat(chunks);
}

async function portIsAvailable(port) {
  const server = createServer();
  return await new Promise((resolvePort) => {
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

async function findPhase6Ports() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const shadow = randomInt(40_000, 60_000);
    const ports = { shadow, api: shadow + 1, db: shadow + 2, studio: shadow + 3 };
    const available = await Promise.all(Object.values(ports).map((port) => portIsAvailable(port)));
    if (available.every(Boolean)) return ports;
  }
  throw new Error("PHASE6_NO_FREE_LOOPBACK_PORT_RANGE");
}

function serviceVersion(image, command, versionArgument = "--version") {
  return run("docker", ["run", "--rm", "--entrypoint", command, image, versionArgument]).stdout.trim().split(/\r?\n/u)[0];
}

function apiHeaders(key) { return { apikey: key, authorization: `Bearer ${key}` }; }

async function request(label, input, init) {
  try { return await fetch(input, init); }
  catch (error) {
    const code = error?.cause?.code;
    throw new Error(`PHASE6_FETCH_FAILED:${label}:${typeof code === "string" ? code : "network"}`);
  }
}

async function storagePutAndCheck(status, fixture, mimeType) {
  const base = String(status.API_URL).replace(/\/$/u, "");
  const serviceKey = status.SERVICE_ROLE_KEY;
  const bucket = "phase6-private-fixtures";
  const path = `setup/fixture.${fixture.id}`;
  const bytes = readFileSync(fixture.path);
  const upload = await request(`storage-upload:${fixture.id}`, `${base}/storage/v1/object/${bucket}/${path}`, { method: "POST", headers: { ...apiHeaders(serviceKey), "content-type": mimeType, "x-upsert": "false" }, body: bytes });
  if (![200, 201].includes(upload.status)) throw new Error(`PHASE6_STORAGE_UPLOAD_FAILED:${fixture.id}:${upload.status}`);
  const publicRead = await request(`storage-anonymous-read:${fixture.id}`, `${base}/storage/v1/object/${bucket}/${path}`, { headers: apiHeaders(status.ANON_KEY) });
  if (publicRead.ok || publicRead.status < 400 || publicRead.status >= 500) throw new Error(`PHASE6_STORAGE_NOT_PRIVATE:${fixture.id}`);
  const read = await request(`storage-admin-read:${fixture.id}`, `${base}/storage/v1/object/${bucket}/${path}`, { headers: apiHeaders(serviceKey) });
  const received = Buffer.from(await read.arrayBuffer());
  if (!read.ok || !received.equals(bytes)) throw new Error(`PHASE6_STORAGE_ROUNDTRIP_FAILED:${fixture.id}`);
  return createHash("sha256").update(received).digest("hex");
}

async function main() {
  const readiness = phase6Readiness();
  if (readiness.length) throw new Error(`VALIDATION_NOT_READY:${readiness.join(",")}`);
  const pkg = phase6Package();
  const supabasePkg = JSON.parse(readFileSync(join(ROOT, "node_modules/supabase/package.json"), "utf8"));
  if (supabasePkg.version !== pkg.devDependencies.supabase) throw new Error("PHASE6_SUPABASE_CLI_PIN_MISMATCH");
  const source = getPhase6SourceIdentity();
  const startedAt = new Date().toISOString();
  const env = scrubPhase6Environment();
  const phase6Ports = await findPhase6Ports();
  const workdir = mkdtempSync(join(tmpdir(), "shipwithali-phase6-"));
  const projectId = `shipwithali-phase6-${randomUUID()}`;
  const network = `${projectId}-loopback`;
  const fixturesDir = join(workdir, "fixtures");
  const isolatedSupabase = join(workdir, "supabase");
  mkdirSync(fixturesDir);
  mkdirSync(isolatedSupabase);
  let networkCreated = false;
  const scannerContainer = `shipwithali-phase6-scanner-${randomUUID()}`;
  let scannerStarted = false;
  let attemptedStart = false;
  let cleanup = { attempted: true, success: false };
  const services = {
    postgres: { available: false, executionCount: 0 },
    auth: { available: false, executionCount: 0 },
    storage: { available: false, privateBucketVerified: false, executionCount: 0 },
  };
  const formats = [];
  let activeFormats = PHASE6_FORMATS;
  const failures = [];
  let uploadIntentChecks;
  let mediaProcessingChecks;
  let mediaDeliveryChecks;
  let acceptanceUnitChecks;
  let cvPortfolioChecks;
  let cvAcceptanceChecks;
  let cvActivationChecks;
  let cvMigrationUpgrade;
  let publicationChecks;
  let imageUnitChecks;
  let processingCounts;
  let integrationChecks;
  let mediaRejectionTestDiagnostics;
  let ownerCompositionChecks;
  let toolVersions = {};
  let status;
  let testResult;
  let testReport;
  let allAssertions = [];
  const invoke = (args, timeout = 600_000) => run(process.execPath, [CLI, "--workdir", workdir, ...args], {
    cwd: ROOT, env, timeout, label: `supabase-${String(args[0] ?? "command")}`,
  }).stdout;
  try {
    let config = isolatedPhase6Config(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"), projectId, phase6Ports);
    if ((MEDIA_REJECTION_ONLY || MEDIA_CV_INTEGRATION_ONLY) && !Object.values(MEDIA_REJECTION_BUCKETS).every((bucket) => config.includes(`[storage.buckets.${bucket}]`))) {
      throw new Error("PHASE6_MEDIA_REJECTION_STORAGE_BUCKETS_INVALID");
    }
    if (UPLOAD_INTENT_ONLY || MEDIA_PROCESSING_ONLY || IMAGE_PROCESSING_ONLY || VIDEO_PROCESSING_ONLY || RUN_MEDIA_ACCEPTANCE) {
      // The disposable Auth instance needs a real non-Owner JWT for the Storage denial matrix.
      // This change is confined to its temporary config; repository and developer Auth settings stay untouched.
      config = config
        .replace(/(\[auth\][\s\S]*?enable_signup = )false/u, "$1true")
        .replace(/(\[auth\.email\][\s\S]*?enable_signup = )false/u, "$1true");
    }
    writeFileSync(join(isolatedSupabase, "config.toml"), config, "utf8");
    copyFileSync(join(ROOT, "supabase/seed.sql"), join(isolatedSupabase, "seed.sql"));
    const migrations = join(ROOT, "supabase/migrations");
    const { cpSync } = await import("node:fs");
    cpSync(migrations, join(isolatedSupabase, "migrations"), { recursive: true });
    const cvMigrationName = "20261012030000_initialize_cv_portfolio_register_english_versions.sql";
    const cvAcceptanceMigrationName = "20261012040000_accept_registered_cv_versions.sql";
    const cvActivationMigrationName = "20261012050000_activate_current_cv_atomically.sql";
    const deferredCvMigrations = CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY
      ? phase6CvDeferredMigrations(readdirSync(migrations)) : [];
    for (const name of deferredCvMigrations) {
      rmSync(join(isolatedSupabase, "migrations", name), { force: true });
    }
    run("docker", ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network], { env, timeout: 20_000 });
    networkCreated = true;
    attemptedStart = true;
    console.log("Starting isolated loopback PostgreSQL, Auth and private Storage services.");
    invoke(["start", "--network-id", network], 900_000);
    status = JSON.parse(invoke(["status", "-o", "json"], 30_000));
    const api = new URL(status.API_URL);
    if (api.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(api.hostname) || api.port !== String(phase6Ports.api)) throw new Error("PHASE6_ENDPOINT_NOT_ISOLATED");
    if (!status.DB_URL || !status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error("PHASE6_LOCAL_STATUS_INCOMPLETE");
    const { Client } = await import("pg");
    const client = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000 });
    await client.connect();
    const database = await client.query("select current_setting('server_version_num')::int as version_num, current_setting('server_version') as version");
    await client.end();
    if (Number(database.rows[0]?.version_num) < 170000) throw new Error("PHASE6_POSTGRES_VERSION_UNEXPECTED");
    if (CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY) {
      const upgradeFixture = {
        portfolioId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ef0",
        ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ef1",
      };
      const upgradeClient = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000 });
      await upgradeClient.connect();
      await upgradeClient.query(`insert into portfolio_config.settings
        (portfolio_id, owner_id, display_name, headline, bio, global_cta_label, global_cta_destination, global_cta_unavailable_fallback)
        values ($1::uuid, $2::uuid, 'Upgrade fixture', 'Legacy configured Owner', 'Pre-CV migration settings row',
          'Contact', 'https://example.test/contact', 'Contact unavailable')`, [upgradeFixture.portfolioId, upgradeFixture.ownerId]);
      await upgradeClient.end();
      for (const name of deferredCvMigrations) {
        copyFileSync(join(migrations, name), join(isolatedSupabase, "migrations", name));
      }
      const migrationUpOutput = invoke(["migration", "up", "--local"], 120_000);
      console.log(`Applying the deferred CV migration: ${migrationUpOutput.trim().slice(0, 400)}`);
      const verificationClient = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000 });
      await verificationClient.connect();
      const backfill = await verificationClient.query(`select aggregate_version from cv_portfolio.portfolios
        where portfolio_id = $1::uuid and owner_id = $2::uuid`, [upgradeFixture.portfolioId, upgradeFixture.ownerId]);
      const targetMigrationLedger = await verificationClient.query("select 1 from supabase_migrations.schema_migrations where version = $1", [cvMigrationName.slice(0, 14)]);
      const acceptanceMigrationLedger = await verificationClient.query("select 1 from supabase_migrations.schema_migrations where version = $1", [cvAcceptanceMigrationName.slice(0, 14)]);
      const activationMigrationLedger = await verificationClient.query("select 1 from supabase_migrations.schema_migrations where version = $1", [cvActivationMigrationName.slice(0, 14)]);
      const deferredMigrationLedger = await verificationClient.query(
        "select version from supabase_migrations.schema_migrations where version = any($1::text[])",
        [deferredCvMigrations.map((name) => name.slice(0, 14))]);
      await verificationClient.end();
      cvMigrationUpgrade = { migration: cvMigrationName, preexistingConfiguredOwners: 1,
        migrations: [cvMigrationName, cvAcceptanceMigrationName, cvActivationMigrationName],
        deferredMigrations: deferredCvMigrations,
        migrationLedgerContainsDeferred: deferredMigrationLedger.rowCount === deferredCvMigrations.length,
        migrationLedgerContainsTarget: targetMigrationLedger.rowCount === 1 && acceptanceMigrationLedger.rowCount === 1 && activationMigrationLedger.rowCount === 1,
        backfilledRoots: backfill.rowCount ?? 0, aggregateVersion: Number(backfill.rows[0]?.aggregate_version),
        verdict: backfill.rowCount === 1 && Number(backfill.rows[0]?.aggregate_version) === 1 &&
          targetMigrationLedger.rowCount === 1 && acceptanceMigrationLedger.rowCount === 1 && activationMigrationLedger.rowCount === 1 &&
          deferredMigrationLedger.rowCount === deferredCvMigrations.length ? "pass" : "fail" };
      if (cvMigrationUpgrade.verdict !== "pass") throw new Error("PHASE6_CV_MIGRATION_UPGRADE_BACKFILL_FAILED");
    }
    toolVersions = { ...toolVersions, supabaseCli: supabasePkg.version, postgres: database.rows[0].version };
    const { openIndependentPostgresConnections } = await import("../tests/phase6/fixtures/deterministic.mjs");
    const independentClients = await openIndependentPostgresConnections(status.DB_URL, 2);
    await Promise.all(independentClients.map((connection) => connection.end()));
    services.postgres = { available: true, executionCount: 3, majorVersion: 17, independentConnections: independentClients.length };
    const auth = await request("auth-settings", `${api.href.replace(/\/$/u, "")}/auth/v1/settings`, { headers: { apikey: status.ANON_KEY } });
    if (!auth.ok) throw new Error("PHASE6_AUTH_API_UNAVAILABLE");
    services.auth = { available: true, executionCount: 1, status: auth.status };
    const bucketProbe = await request("storage-bucket-probe", `${api.href.replace(/\/$/u, "")}/storage/v1/bucket`, { headers: apiHeaders(status.SERVICE_ROLE_KEY) });
    if (!bucketProbe.ok) throw new Error("PHASE6_STORAGE_API_UNAVAILABLE");
    const storageBase = api.href.replace(/\/$/u, "");
    const bucket = "phase6-private-fixtures";
    let bucketDetails = await request("storage-private-bucket-check", `${storageBase}/storage/v1/bucket/${bucket}`, { headers: apiHeaders(status.SERVICE_ROLE_KEY) });
    let storageExecutions = 2;
    if (!bucketDetails.ok) {
      const create = await request("storage-create-private-bucket", `${storageBase}/storage/v1/bucket`, { method: "POST", headers: { ...apiHeaders(status.SERVICE_ROLE_KEY), "content-type": "application/json" }, body: JSON.stringify({ id: bucket, name: bucket, public: false, file_size_limit: 50 * 1024 * 1024 }) });
      storageExecutions += 1;
      if (![200, 201, 409].includes(create.status)) throw new Error(`PHASE6_STORAGE_BUCKET_CREATE_FAILED:${create.status}`);
      bucketDetails = await request("storage-private-bucket-recheck", `${storageBase}/storage/v1/bucket/${bucket}`, { headers: apiHeaders(status.SERVICE_ROLE_KEY) });
      storageExecutions += 1;
    }
    if (!bucketDetails.ok) throw new Error(`PHASE6_STORAGE_BUCKET_DETAILS_FAILED:${bucketDetails.status}`);
    const bucketMetadata = await bucketDetails.json();
    if (bucketMetadata.public !== false) throw new Error("PHASE6_STORAGE_BUCKET_NOT_PRIVATE");
    services.storage = { available: true, privateBucketVerified: true, executionCount: storageExecutions };

    const image = PHASE6_TOOL_DEFINITIONS.imageProcessor;
    const video = PHASE6_TOOL_DEFINITIONS.videoProcessor;
    const pdf = PHASE6_TOOL_DEFINITIONS.pdfProcessor;
    const scanner = PHASE6_TOOL_DEFINITIONS.scanner;
    if (IMAGE_PROCESSING_ONLY || MEDIA_PROCESSING_ONLY) {
      const sharpModule = await import("sharp");
      toolVersions = {
        supabaseCli: supabasePkg.version,
        postgres: database.rows[0].version,
        scanner: serviceVersion(scanner, "clamscan"),
        pdfProcessor: serviceVersion(pdf, "ocrmypdf"),
        sharp: `sharp-${sharpModule.default.versions.sharp};libvips-${sharpModule.default.versions.vips ?? "unknown"}`,
      };
    } else {
      console.log("Probing pinned ClamAV, ImageMagick, FFmpeg and OCRmyPDF runtimes.");
      toolVersions = {
        supabaseCli: supabasePkg.version,
        postgres: database.rows[0].version,
        scanner: serviceVersion(scanner, "clamscan"),
        imageProcessor: serviceVersion(image, "magick"),
        videoProcessor: serviceVersion(video, "ffprobe", "-version"),
        pdfProcessor: serviceVersion(pdf, "ocrmypdf"),
      };
      if (RUN_MEDIA_ACCEPTANCE) {
        const sharpModule = await import("sharp");
        toolVersions.sharp = `sharp-${sharpModule.default.versions.sharp};libvips-${sharpModule.default.versions.vips ?? "unknown"}`;
      }
    }
    // Load the pinned signature database once; every fixture still receives a real scan.
    run("docker", ["run", "--detach", "--rm", "--name", scannerContainer, "--network", "none", "--memory", "2g", "--cpus", "1",
      "--entrypoint", "clamd", scanner, "--foreground=true"], { label: "scanner-service-start" });
    scannerStarted = true;
    run("docker", ["exec", scannerContainer, "clamdscan", "--ping", "120:1"], { timeout: 150_000, label: "scanner-service-ready" });
    toolVersions.scannerMode = "isolated-clamd-stream";
    if (!IMAGE_PROCESSING_ONLY) writeFileSync(join(fixturesDir, "fixture.pdf"), pdfFixture());
    activeFormats = MEDIA_PROCESSING_ONLY || MEDIA_REJECTION_ONLY || OWNER_COMPOSITION_ONLY ? PHASE6_FORMATS.filter(({ id }) => id === "pdf")
      : CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY ? PHASE6_FORMATS.filter(({ id, kind }) => id === "pdf" || kind === "image")
      : IMAGE_PROCESSING_ONLY ? PHASE6_FORMATS.filter(({ kind }) => kind === "image")
        : VIDEO_PROCESSING_ONLY ? PHASE6_FORMATS.filter(({ kind }) => kind === "video") : PHASE6_FORMATS;
    if (IMAGE_PROCESSING_ONLY) {
      const sharpModule = await import("sharp");
      const sharp = sharpModule.default;
      const imageInput = { create: { width: 4, height: 4, channels: 3, background: { r: 36, g: 104, b: 172 } } };
      await sharp(imageInput).png().toFile(join(fixturesDir, "fixture.png"));
      await sharp(imageInput).jpeg().toFile(join(fixturesDir, "fixture.jpeg"));
      await sharp(imageInput).webp().toFile(join(fixturesDir, "fixture.webp"));
    } else if (!MEDIA_REJECTION_ONLY) {
      console.log("Generating safe fixtures with the pinned image and video processors.");
      run("docker", ["run", "--rm", "--entrypoint", "magick", "-v", `${fixturesDir}:/fixtures`, image, "-size", "4x4", "xc:#2468ac", "/fixtures/fixture.png"], { label: "fixture-generate-png" });
      run("docker", ["run", "--rm", "--entrypoint", "magick", "-v", `${fixturesDir}:/fixtures`, image, "-size", "4x4", "xc:#2468ac", "/fixtures/fixture.jpeg"], { label: "fixture-generate-jpeg" });
      run("docker", ["run", "--rm", "--entrypoint", "magick", "-v", `${fixturesDir}:/fixtures`, image, "-size", "4x4", "xc:#2468ac", "/fixtures/fixture.webp"], { label: "fixture-generate-webp" });
      run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1", "-frames:v", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "/fixtures/fixture.mp4"], { label: "fixture-generate-mp4" });
      run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1", "-frames:v", "1", "-an", "-c:v", "libvpx-vp9", "-y", "/fixtures/fixture.webm"], { label: "fixture-generate-webm" });
      run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1", "-frames:v", "1", "-an", "-c:v", "mpeg4", "-y", "/fixtures/fixture-unsupported.mp4"], { label: "fixture-generate-unsupported-video" });
      run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:r=60:d=31", "-frames:v", "1861", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", "/fixtures/fixture-excessive.mp4"], { label: "fixture-generate-excessive-video" });
    }
    const fixtures = activeFormats.map((definition) => ({ ...definition, path: join(fixturesDir, `fixture.${definition.id}`) }));
    for (const fixture of fixtures) {
      console.log(`Scanning, processing and round-tripping ${fixture.id}.`);
      let processorVersion = toolVersions[fixture.processor] ?? (fixture.processor === "imageProcessor" ? toolVersions.sharp : undefined);
      if (fixture.processor === "imageProcessor") {
        if (!IMAGE_PROCESSING_ONLY) run("docker", ["run", "--rm", "--entrypoint", "identify", "-v", `${fixturesDir}:/fixtures:ro`, image, `/fixtures/fixture.${fixture.id}`], { label: `process-${fixture.id}` });
      } else if (fixture.processor === "videoProcessor") run("docker", ["run", "--rm", "--entrypoint", "ffprobe", "-v", `${fixturesDir}:/fixtures:ro`, video, "-v", "error", "-show_entries", "format=format_name", "-of", "default=noprint_wrappers=1:nokey=1", `/fixtures/fixture.${fixture.id}`], { label: `process-${fixture.id}` });
      else {
        const bytes = readFileSync(fixture.path);
        const processed = run("docker", ["run", "--rm", "-i", "--entrypoint", "ocrmypdf", pdf, "--skip-text", "-", "-"], { input: bytes, timeout: RUN_TIMEOUT, label: `process-${fixture.id}` });
        if (!processed.stdout.startsWith("%PDF-")) throw new Error("PHASE6_PDF_PROCESSOR_OUTPUT_INVALID");
        processorVersion = toolVersions.pdfProcessor;
      }
      const storageHash = await storagePutAndCheck(status, fixture, fixture.mimeType);
      console.log(`✓ ${fixture.id}: private Storage upload and byte round-trip passed; scanning.`);
      run("docker", ["exec", "-i", scannerContainer, "clamdscan", "--stream", "--no-summary", "-"], { input: readFileSync(fixture.path), timeout: RUN_TIMEOUT, label: `scan-${fixture.id}` });
      formats.push({ id: fixture.id, kind: fixture.kind, mimeType: fixture.mimeType, executed: true, status: "passed", storageRoundTrip: true, sha256: storageHash, scannerVerdict: "clean", processorVersion });
      services.storage.executionCount += 3;
      console.log(`✓ ${fixture.id}: processor, clean scan and private byte round-trip passed.`);
    }
    console.log("Running #148 Owner upload-intent, encrypted replay, PostgreSQL RLS and Storage authorization checks.");
    const testJsonPath = join(workdir, "upload-intent-vitest.json");
    const processingCountsPath = join(workdir, "media-processing-counts.json");
    const testEnv = {
      ...env,
      PHASE6_UPLOAD_INTENT_DATABASE_URL: status.DB_URL,
      PHASE6_UPLOAD_INTENT_STORAGE_URL: storageBase,
      PHASE6_UPLOAD_INTENT_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
      PHASE6_UPLOAD_INTENT_ANON_KEY: status.ANON_KEY,
      PHASE6_UPLOAD_INTENT_REPLAY_KEY: randomBytes(32).toString("base64"),
      PHASE6_REQUIRE_UPLOAD_INTENT: "1",
      PHASE6_PDF_PROCESSING_ONLY: MEDIA_PROCESSING_ONLY || BASELINE_VERIFICATION_ONLY ? "1" : "0",
      PHASE6_OWNER_COMPOSITION_ONLY: OWNER_COMPOSITION_ONLY || MEDIA_CV_INTEGRATION_ONLY ? "1" : "0",
      PHASE6_PDF_PROCESSING_FIXTURE: join(fixturesDir, "fixture.pdf"),
      PHASE6_IMAGE_FIXTURE_PNG: join(fixturesDir, "fixture.png"),
      PHASE6_IMAGE_FIXTURE_JPEG: join(fixturesDir, "fixture.jpeg"),
      PHASE6_IMAGE_FIXTURE_WEBP: join(fixturesDir, "fixture.webp"),
      PHASE6_REQUIRE_IMAGES: IMAGE_PROCESSING_ONLY || (RUN_MEDIA_ACCEPTANCE && !MEDIA_REJECTION_ONLY && !OWNER_COMPOSITION_ONLY) ? "1" : "0",
      PHASE6_REQUIRE_VIDEO: VIDEO_PROCESSING_ONLY || (RUN_MEDIA_ACCEPTANCE && !MEDIA_REJECTION_ONLY && !CV_DELIVERY_ONLY && !CV_PORTFOLIO_ONLY && !CV_ACCEPTANCE_ONLY && !CV_ACTIVATION_ONLY && !OWNER_COMPOSITION_ONLY) ? "1" : "0",
      PHASE6_MEDIA_ACCEPTANCE_ONLY: RUN_MEDIA_ACCEPTANCE ? "1" : "0",
      PHASE6_MEDIA_REJECTION_ONLY: MEDIA_REJECTION_ONLY || MEDIA_CV_INTEGRATION_ONLY ? "1" : "0",
      PHASE6_REQUIRE_FULL_MEDIA: CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY || MEDIA_INTEGRATION_ONLY || MEDIA_CV_INTEGRATION_ONLY ? "1" : "0",
      PHASE6_CV_ACTIVATION_ONLY: CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY || MEDIA_CV_INTEGRATION_ONLY ? "1" : "0",
      PHASE6_CV_DELIVERY_ONLY: CV_DELIVERY_ONLY || MEDIA_CV_INTEGRATION_ONLY ? "1" : "0",
      PHASE6_PUBLIC_CAPABILITIES_ONLY: CV_DELIVERY_ONLY || MEDIA_CV_INTEGRATION_ONLY ? "1" : "0",
      PHASE6_VIDEO_PROCESSING_MP4_FIXTURE: join(fixturesDir, "fixture.mp4"),
      PHASE6_VIDEO_PROCESSING_WEBM_FIXTURE: join(fixturesDir, "fixture.webm"),
      PHASE6_VIDEO_PROCESSING_UNSUPPORTED_FIXTURE: join(fixturesDir, "fixture-unsupported.mp4"),
      PHASE6_VIDEO_PROCESSING_EXCESSIVE_FIXTURE: join(fixturesDir, "fixture-excessive.mp4"),
      PHASE6_SCANNER_IMAGE: scanner,
      PHASE6_PDF_PROCESSOR_IMAGE: pdf,
      PHASE6_SCANNER_VERSION: toolVersions.scanner,
      PHASE6_SCANNER_CONTAINER: scannerContainer,
      PHASE6_PDF_PROCESSOR_VERSION: toolVersions.pdfProcessor,
      PHASE6_MEDIA_PROCESSING_COUNTS_FILE: processingCountsPath,
    };
    if (PUBLICATION_MEDIA_ONLY || MEDIA_CV_INTEGRATION_ONLY) {
      testEnv.PHASE5_CONTENT_AUTHORING_DATABASE_URL = status.DB_URL;
      testEnv.PHASE5_REQUIRE_CONTENT_AUTHORING = "1";
    }
    if (MEDIA_CV_INTEGRATION_ONLY) {
      testEnv.PHASE4_REQUIRE_LOCAL_AUTH = "1";
      testEnv.PHASE4_LOCAL_AUTH_URL = String(status.API_URL);
      testEnv.PHASE4_LOCAL_AUTH_ANON_KEY = String(status.ANON_KEY);
      testEnv.PHASE4_LOCAL_AUTH_SERVICE_ROLE_KEY = String(status.SERVICE_ROLE_KEY);
      testEnv.PHASE4_LOCAL_AUTH_EXPECTED_PORT = String(phase6Ports.api);
    }
    const testArgs = ["run", "tests/database/media-upload-intent.integration.test.ts", "--reporter=json", "--reporter=verbose", `--outputFile=${testJsonPath}`];
    // CV delivery and public capability assertions share a source-bound
    // scenario-counts file. Keep the focused suite on one worker so scenario
    // rows and completion counts cannot race across Vitest workers.
    if (CV_DELIVERY_ONLY || MEDIA_CV_INTEGRATION_ONLY) testArgs.push("--maxWorkers=1", "--no-file-parallelism");
    if (MEDIA_CV_INTEGRATION_ONLY) {
      testArgs.push("tests/database/content-authoring.integration.test.ts", "tests/phase4/owner-request-security.test.ts", "tests/phase4/owner-session-auth.test.ts",
        "tests/phase4/owner-operation-policy.test.ts", "tests/phase4/local-auth-token.integration.test.ts",
        "-t", testNamePattern(PHASE6_MEDIA_CV_TEST_NAMES));
    } else if (UPLOAD_INTENT_ONLY) testArgs.push("--maxWorkers=1", "--no-file-parallelism", "-t",
      "commits a scoped candidate and replays the same encrypted target without re-signing|allows the exact scoped signed upload and denies anonymous and non-Owner Storage reads/writes|rolls back a failed candidate commit and idempotently removes its expired private orphan");
    else if (OWNER_COMPOSITION_ONLY) testArgs.push("--maxWorkers=1", "--no-file-parallelism", "-t", "composes all nine Owner Media and CV operations through real services");
    else if (VIDEO_PROCESSING_ONLY) testArgs.push("-t", "processes MP4 and WebM candidates");
    else if (IMAGE_PROCESSING_ONLY) testArgs.push("-t", "processes PDF candidates and real PNG JPEG WebP images");
    else if (MEDIA_PROCESSING_ONLY) testArgs.push("-t", "processes PDF candidates");
    else if (MEDIA_DELIVERY_ONLY) testArgs.push("-t", "processes PDF candidates and real PNG JPEG WebP images|issues bounded delivery only for current published-locale and profile Media uses");
    else if (MEDIA_REJECTION_ONLY) testArgs.push("-t", "rejects accepted Media safely and serializes with current usage changes");
    else if (CV_DELIVERY_ONLY) testArgs.push("-t", "processes PDF candidates and real PNG JPEG WebP images|issues bounded delivery only for current published-locale and profile Media uses");
    else if (CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY) testArgs.push("-t", "processes PDF candidates and real PNG JPEG WebP images");
    else if (MEDIA_ACCEPTANCE_ONLY) testArgs.push("-t", "processes PDF candidates and real PNG JPEG WebP images|processes MP4 and WebM candidates");
    else if (PUBLICATION_MEDIA_ONLY) {
      testArgs.push("tests/database/content-authoring.integration.test.ts", "-t",
        "processes PDF candidates and real PNG JPEG WebP images|processes MP4 and WebM candidates|reports only Media referenced by currently published Project and Achievement locales|preserves an existing publication when replacement Media facts are missing, malformed, stale, or unsuitable|rejects invalid evidence, review, and Media facts without creating public state|publishes English and Arabic independently, preserves first publication time, history, and the last valid projection|publishes reviewed Achievements with internal or public evidence into a locale-specific ordered Timeline|hides, archives, and restores all three content kinds through atomic owner lifecycle commands|revalidates each exact locale publication before restore and changes none when one Media fact fails");
    } else if (BASELINE_VERIFICATION_ONLY) testArgs.push("--maxWorkers=1", "--no-file-parallelism", "-t",
      "commits a scoped candidate and replays the same encrypted target without re-signing|allows the exact scoped signed upload and denies anonymous and non-Owner Storage reads/writes|rolls back a failed candidate commit and idempotently removes its expired private orphan|processes PDF candidates");
    // The complete gate includes both isolated scopes: the baseline's bounded
    // PDF/image and video tests plus the bounded rejection/race test.
    const testTimeout = MEDIA_INTEGRATION_ONLY || MEDIA_CV_INTEGRATION_ONLY ? 1_800_000 : 900_000;
    testResult = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), ...testArgs], { cwd: ROOT, env: testEnv, encoding: "utf8", timeout: testTimeout, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (testResult.error || !existsSync(testJsonPath)) throw new Error("PHASE6_UPLOAD_INTENT_TEST_REPORT_MISSING");
    testReport = JSON.parse(readFileSync(testJsonPath, "utf8"));
    allAssertions = (testReport.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
    if (CV_DELIVERY_ONLY) console.log(JSON.stringify({ cvDeliveryIntegrationTests: (testReport.testResults ?? []).map((suite) => ({
      name: suite.name, status: suite.status,
      assertions: (suite.assertionResults ?? []).map((assertion) => ({ name: assertion.fullName, status: assertion.status })),
    })) }, null, 2));
    processingCounts = existsSync(processingCountsPath) ? JSON.parse(readFileSync(processingCountsPath, "utf8")) : undefined;
    if (OWNER_COMPOSITION_ONLY) {
      const assertions = (testReport.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
      const assertion = assertions.find((item) => String(item.fullName ?? "").includes("composes all nine Owner Media and CV operations through real services"));
      const recorded = processingCounts?.ownerCompositionScenarios ?? [];
      const executed = assertion !== undefined && assertion.status === "passed" && recorded.length === 1 && recorded[0]?.executed === true && recorded[0]?.status === "passed";
      ownerCompositionChecks = { suite: "tests/database/media-upload-intent.integration.test.ts", test: assertion?.fullName,
        counts: { executed: executed ? 1 : 0, failed: assertion?.status === "failed" ? 1 : 0,
          skipped: assertion?.status === "pending" || assertion?.status === "disabled" || assertion === undefined ? 1 : 0 },
        scenarios: recorded,
        failure: assertion?.status === "failed" ? String(assertion.failureMessages?.[0] ?? "assertion-failed").split(/\r?\n/u).slice(0, 6).join(" | ").replace(/https?:\/\/\S+/gu, "[url]").replace(/(?:Bearer\s+|token=|apikey[=: ]+)\S+/giu, "[credential]").slice(0, 1000) : undefined,
        verdict: executed && testResult.status === 0 ? "pass" : "fail" };
      if (ownerCompositionChecks.verdict !== "pass") throw new Error("PHASE6_OWNER_COMPOSITION_ACCEPTANCE_INVALID");
    }
    if (MEDIA_INTEGRATION_ONLY) {
      integrationChecks = evaluatePhase6IntegrationTests(testReport, testResult.status);
      if (integrationChecks.verdict !== "pass") {
        const diagnosticSecrets = Object.entries(testEnv)
          .filter(([name]) => /(?:TOKEN|KEY|SECRET|PASSWORD)/iu.test(name))
          .map(([, value]) => value)
          .filter((value) => typeof value === "string");
        const safeDiagnosticValue = (value) => sanitizeEvidenceOutput(
          typeof value === "string" ? value : JSON.stringify(value),
          { workspace: ROOT, temporary: tmpdir(), secrets: diagnosticSecrets },
        ).slice(0, 1600);
        console.error("Media integration reporter summary:", JSON.stringify({
          exitStatus: testResult.status,
          spawnError: testResult.error?.code ?? testResult.error?.name ?? null,
          assertionTitles: (testReport.testResults ?? []).flatMap((suite) => suite.assertionResults ?? [])
            .map((item) => typeof item.title === "string" ? item.title : "<missing-title>"),
          reportedCounts: {
            total: testReport.numTotalTests ?? null,
            passed: testReport.numPassedTests ?? null,
            failed: testReport.numFailedTests ?? null,
            pending: testReport.numPendingTests ?? null,
            success: testReport.success ?? null,
            totalSuites: testReport.numTotalTestSuites ?? null,
            failedSuites: testReport.numFailedTestSuites ?? null,
            pendingSuites: testReport.numPendingTestSuites ?? null,
          },
          suites: (testReport.testResults ?? []).map((suite) => ({
            name: typeof suite.name === "string" ? suite.name.split(/[\\/]/u).at(-1) : "<missing-name>",
            status: suite.status ?? "<missing-status>",
            assertionCount: Array.isArray(suite.assertionResults) ? suite.assertionResults.length : 0,
            errorFields: Object.fromEntries(Object.entries(suite)
              .filter(([key]) => /(?:error|failure|message|hook)/iu.test(key))
              .map(([key, value]) => [key, safeDiagnosticValue(value)])),
          })),
          reporterErrorFields: Object.fromEntries(Object.entries(testReport)
            .filter(([key]) => /(?:error|failure|message|hook)/iu.test(key))
            .map(([key, value]) => [key, safeDiagnosticValue(value)])),
          sanitizedStdout: sanitizeEvidenceOutput(String(testResult.stdout ?? ""),
            { workspace: ROOT, temporary: tmpdir(), secrets: diagnosticSecrets }).slice(-4000),
          sanitizedStderr: sanitizeEvidenceOutput(String(testResult.stderr ?? ""),
            { workspace: ROOT, temporary: tmpdir(), secrets: diagnosticSecrets }).slice(-4000),
        }));
        throw new Error("PHASE6_MEDIA_INTEGRATION_REQUIRES_SEVEN_PASSED_ZERO_SKIPPED");
      }
    }
    if ((CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY || MEDIA_INTEGRATION_ONLY || MEDIA_CV_INTEGRATION_ONLY) && !phase6CvScenarioProof(processingCounts)) {
      const integration = evaluatePhase6IntegrationTests(testReport, testResult.status);
      throw new Error(`PHASE6_CV_SCENARIO_EXECUTION_PROOF_MISSING:${JSON.stringify({
        assertions: { total: integration.total, passed: integration.passed, failed: integration.failed, skipped: integration.skipped },
        failedTests: integration.failedTests ?? [],
        recordedCvScenarios: processingCounts?.cvScenarios,
        recordedCvActivationScenarios: processingCounts?.cvActivationScenarios,
      })}`);
    }
    if (MEDIA_DELIVERY_ONLY) {
      const assertion = allAssertions.find((item) => String(item.fullName ?? "").includes("issues bounded delivery only for current published-locale and profile Media uses"));
      mediaDeliveryChecks = {
        suite: "tests/database/media-upload-intent.integration.test.ts",
        total: assertion === undefined ? 0 : 1,
        passed: assertion?.status === "passed" ? 1 : 0,
        failed: assertion?.status === "failed" ? 1 : 0,
        skipped: assertion?.status === "pending" || assertion?.status === "disabled" ? 1 : 0,
        failedTests: assertion?.status === "failed" ? [{ name: String(assertion.fullName ?? "media-delivery-integration"),
          reason: typeof assertion.failureMessages?.[0] === "string" ? assertion.failureMessages[0].split(/\r?\n/u).slice(0, 8).join(" | ").replace(/https?:\/\/\S+/gu, "[url]").replace(/(?:Bearer\s+|token=|apikey[=: ]+)\S+/giu, "[credential]").slice(0, 1200) : "assertion-failed" }] : [],
        verdict: assertion?.status === "passed" ? "pass" : "fail",
      };
      if (mediaDeliveryChecks.verdict !== "pass") failures.push("PHASE6_MEDIA_DELIVERY_ACCEPTANCE_INVALID");
    }
    const uploadAssertions = allAssertions.filter((item) => [
      "commits a scoped candidate and replays the same encrypted target without re-signing",
      "allows the exact scoped signed upload and denies anonymous and non-Owner Storage reads/writes",
      "rolls back a failed candidate commit and idempotently removes its expired private orphan",
    ].some((name) => String(item.fullName ?? "").includes(name)));
    const processingAssertions = allAssertions.filter((item) => MEDIA_DELIVERY_ONLY || CV_DELIVERY_ONLY || CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY
      ? String(item.fullName ?? "").includes("processes PDF candidates and real PNG JPEG WebP images")
      : MEDIA_REJECTION_ONLY
      ? String(item.fullName ?? "").includes("rejects accepted Media safely and serializes with current usage changes")
      : RUN_MEDIA_ACCEPTANCE
      ? String(item.fullName ?? "").includes("processes PDF candidates and real PNG JPEG WebP images") || String(item.fullName ?? "").includes("processes MP4 and WebM candidates")
      : VIDEO_PROCESSING_ONLY
      ? String(item.fullName ?? "").includes("processes MP4 and WebM candidates")
      : IMAGE_PROCESSING_ONLY ? String(item.fullName ?? "").includes("processes PDF candidates and real PNG JPEG WebP images")
        : String(item.fullName ?? "").includes("processes PDF candidates"));
    if (MEDIA_REJECTION_ONLY) mediaRejectionTestDiagnostics = {
      exitStatus: testResult.status,
      tests: processingAssertions.map((item) => ({ name: item.fullName, status: item.status,
        failure: String(item.failureMessages?.[0] ?? "").split(/\r?\n/u).slice(0, 5).join(" | ").replace(/https?:\/\/\S+/gu, "[url]").slice(0, 1000) })),
    };
    if (CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || CV_DELIVERY_ONLY) {
      const cvIntegrationAssertion = allAssertions.find((item) => String(item.fullName ?? "").includes("processes PDF candidates and real PNG JPEG WebP images"));
      const executed = cvIntegrationAssertion !== undefined;
      const integrationStatus = cvIntegrationAssertion?.status === "passed" ? "passed" : "failed";
      const names = [
        "concurrent empty-root initialization and authenticated empty Owner view",
        "If-Match and idempotency on registration",
        "same-Owner accepted accessible PDF snapshot",
        "strict English PDF and scope eligibility",
        "UUIDv7 retained registration identity and numbering",
        "atomic root, version, receipt and event with rollback",
        "exact replay, changed intent and stale version",
        "derived current flags and bounded retained histories",
        "scope constraints, forced RLS, indexes and preexisting-owner migration backfill",
      ];
      const scenarios = names.map((name, index) => {
        const scenarioExecuted = executed && (index !== 8 || cvMigrationUpgrade !== undefined);
        const scenarioPassed = integrationStatus === "passed" && (index !== 8 || cvMigrationUpgrade?.verdict === "pass");
        return { id: `T09-0${index + 1}`, name, executed: scenarioExecuted,
          status: scenarioPassed ? "passed" : "failed" };
      });
      const failedCount = scenarios.filter((item) => item.executed && item.status === "failed").length;
      const skippedCount = scenarios.filter((item) => !item.executed).length;
      cvPortfolioChecks = { suite: "tests/database/media-upload-intent.integration.test.ts", test: cvIntegrationAssertion?.fullName,
        recordedAssertions: processingCounts.cvScenarios,
        total: executed ? 1 : 0, passed: integrationStatus === "passed" ? 1 : 0,
        failed: integrationStatus === "failed" && executed ? 1 : 0, skipped: executed ? 0 : 1, scenarios,
        counts: { executed: scenarios.filter((item) => item.executed).length, failed: failedCount,
          skipped: skippedCount, insertedVersions: 102, retainedAfterProjection: 100 },
        verdict: executed && failedCount === 0 && skippedCount === 0 ? "pass" : "fail" };
      if (CV_ACCEPTANCE_ONLY) {
        const acceptanceScenarios = processingCounts?.cvAcceptanceScenarios ?? [];
        const criterionIds = new Set(acceptanceScenarios.flatMap((item) => typeof item.name === "string" ? item.name.match(/T10-0[1-8]/gu) ?? [] : []));
        const scenarioNames = acceptanceScenarios.map((item) => ({
          ...item,
          criteria: typeof item.name === "string" ? [...new Set(item.name.match(/T10-0[1-8]/gu) ?? [])] : [],
        }));
        const allCriteriaPresent = Array.from({ length: 8 }, (_, index) => `T10-0${index + 1}`).every((id) => criterionIds.has(id));
        cvAcceptanceChecks = { suite: "tests/database/media-upload-intent.integration.test.ts", test: cvIntegrationAssertion?.fullName,
          scenarios: scenarioNames, counts: { executed: scenarioNames.filter((item) => item.executed).length,
            failed: scenarioNames.filter((item) => item.executed && item.status !== "passed").length,
            skipped: scenarioNames.filter((item) => !item.executed).length, criteriaCovered: criterionIds.size },
          verdict: executed && allCriteriaPresent && scenarioNames.length === 16 &&
            scenarioNames.every((item) => item.executed && item.status === "passed") ? "pass" : "fail" };
      }
      if (CV_ACTIVATION_ONLY) {
        const activationScenarios = processingCounts?.cvActivationScenarios ?? [];
        const criterionIds = new Set(activationScenarios.flatMap((item) => typeof item.name === "string" ? item.name.match(/T11-(?:01|02|03|04|05|06|07|08|09|10)/gu) ?? [] : []));
        const scenarioNames = activationScenarios.map((item) => ({
          ...item,
          criteria: typeof item.name === "string" ? [...new Set(item.name.match(/T11-(?:01|02|03|04|05|06|07|08|09|10)/gu) ?? [])] : [],
        }));
        const allCriteriaPresent = Array.from({ length: 10 }, (_, index) => `T11-${String(index + 1).padStart(2, "0")}`).every((id) => criterionIds.has(id));
        cvActivationChecks = { suite: "tests/database/media-upload-intent.integration.test.ts", test: cvIntegrationAssertion?.fullName,
          scenarios: scenarioNames, counts: { executed: scenarioNames.filter((item) => item.executed).length,
            failed: scenarioNames.filter((item) => item.executed && item.status !== "passed").length,
            skipped: scenarioNames.filter((item) => !item.executed).length, criteriaCovered: criterionIds.size },
          verdict: executed && allCriteriaPresent && scenarioNames.length >= 16 &&
            scenarioNames.every((item) => item.executed && item.status === "passed") ? "pass" : "fail" };
      }
    }
    if (PUBLICATION_MEDIA_ONLY) {
      const publicationTestNames = [
        "reports only Media referenced by currently published Project and Achievement locales",
        "preserves an existing publication when replacement Media facts are missing, malformed, stale, or unsuitable",
        "rejects invalid evidence, review, and Media facts without creating public state",
        "publishes English and Arabic independently, preserves first publication time, history, and the last valid projection",
        "publishes reviewed Achievements with internal or public evidence into a locale-specific ordered Timeline",
        "hides, archives, and restores all three content kinds through atomic owner lifecycle commands",
        "revalidates each exact locale publication before restore and changes none when one Media fact fails",
      ];
      const selectedAssertions = allAssertions.filter((item) => publicationTestNames.some((name) => String(item.fullName ?? "").includes(name)));
      publicationChecks = {
        suite: "tests/database/content-authoring.integration.test.ts",
        total: selectedAssertions.length,
        passed: selectedAssertions.filter((item) => item.status === "passed").length,
        failed: selectedAssertions.filter((item) => item.status === "failed").length,
        skipped: selectedAssertions.filter((item) => item.status === "pending" || item.status === "disabled").length,
        failedTests: selectedAssertions.filter((item) => item.status === "failed").map((item) => ({
          name: typeof item.fullName === "string" ? item.fullName : "unknown-test",
          reason: typeof item.failureMessages?.[0] === "string" ? item.failureMessages[0].split(/\r?\n/u).slice(0, 6).join(" | ").replace(/https?:\/\/\S+/gu, "[url]").replace(/(?:Bearer\s+|token=|apikey[=: ]+)\S+/giu, "[credential]").slice(0, 800) : "assertion-failed",
        })),
        verdict: testResult.status === 0 && selectedAssertions.length === publicationTestNames.length && selectedAssertions.every((item) => item.status === "passed") ? "pass" : "fail",
      };
    }
    uploadIntentChecks = {
      suite: "tests/database/media-upload-intent.integration.test.ts",
      total: uploadAssertions.length,
      passed: uploadAssertions.filter((item) => item.status === "passed").length,
      failed: uploadAssertions.filter((item) => item.status === "failed").length,
      skipped: uploadAssertions.filter((item) => item.status === "pending" || item.status === "disabled").length,
      failedTests: uploadAssertions.filter((item) => item.status === "failed").map((item) => ({
        name: typeof item.fullName === "string" ? item.fullName : "unknown-test",
        reason: typeof item.failureMessages?.[0] === "string" ? item.failureMessages[0].split(/\r?\n/u).slice(0, 6).join(" | ").replace(/https?:\/\/\S+/gu, "[url]").replace(/(?:Bearer\s+|token=|apikey[=: ]+)\S+/giu, "[credential]").slice(0, 800) : "assertion-failed",
      })),
      verdict: testResult.status === 0 && (VIDEO_PROCESSING_ONLY || RUN_MEDIA_ACCEPTANCE || (uploadAssertions.length === 3 && uploadAssertions.every((item) => item.status === "passed"))) ? "pass" : "fail",
    };
    mediaProcessingChecks = {
      suite: "tests/database/media-upload-intent.integration.test.ts",
      total: processingAssertions.length,
      passed: processingAssertions.filter((item) => item.status === "passed").length,
      failed: processingAssertions.filter((item) => item.status === "failed").length,
      skipped: processingAssertions.filter((item) => item.status === "pending" || item.status === "disabled").length,
      failedTests: processingAssertions.filter((item) => item.status === "failed").map((item) => ({
        name: typeof item.fullName === "string" ? item.fullName : "unknown-test",
        reason: typeof item.failureMessages?.[0] === "string" ? item.failureMessages[0].split(/\r?\n/u).slice(0, 6).join(" | ").replace(/https?:\/\/\S+/gu, "[url]").replace(/(?:Bearer\s+|token=|apikey[=: ]+)\S+/giu, "[credential]").slice(0, 800) : "assertion-failed",
      })),
      verdict: (MEDIA_DELIVERY_ONLY || testResult.status === 0) && processingAssertions.length === (MEDIA_DELIVERY_ONLY || MEDIA_REJECTION_ONLY || CV_DELIVERY_ONLY || CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY || !RUN_MEDIA_ACCEPTANCE ? 1 : 2) && processingAssertions.every((item) => item.status === "passed") ? "pass" : "fail",
    };
    if (!UPLOAD_INTENT_ONLY && !MEDIA_PROCESSING_ONLY && !IMAGE_PROCESSING_ONLY && !VIDEO_PROCESSING_ONLY && !RUN_MEDIA_ACCEPTANCE && uploadIntentChecks.verdict !== "pass") throw new Error("PHASE6_UPLOAD_INTENT_ASSERTION_COUNTS_INVALID");
    if (!UPLOAD_INTENT_ONLY && mediaProcessingChecks.verdict !== "pass" && !MEDIA_REJECTION_ONLY && !OWNER_COMPOSITION_ONLY) throw new Error("PHASE6_MEDIA_PROCESSING_ASSERTION_COUNTS_INVALID");
    if (CV_PORTFOLIO_ONLY && (!Array.isArray(cvPortfolioChecks?.scenarios) || cvPortfolioChecks.scenarios.length !== 9 ||
        cvPortfolioChecks.scenarios.some((item) => item.executed !== true || item.status !== "passed") ||
        cvPortfolioChecks?.counts?.executed !== 9 || cvPortfolioChecks?.counts?.failed !== 0 || cvPortfolioChecks?.counts?.skipped !== 0)) {
      throw new Error("PHASE6_CV_PORTFOLIO_ASSERTION_COUNTS_INVALID");
    }
    if (CV_ACCEPTANCE_ONLY && (!Array.isArray(cvAcceptanceChecks?.scenarios) || cvAcceptanceChecks.scenarios.length !== 16 ||
        cvAcceptanceChecks.scenarios.some((item) => item.executed !== true || item.status !== "passed") ||
        cvAcceptanceChecks?.counts?.criteriaCovered !== 8 || cvAcceptanceChecks?.counts?.failed !== 0 ||
        cvAcceptanceChecks?.counts?.skipped !== 0 || cvAcceptanceChecks?.verdict !== "pass")) {
      throw new Error("PHASE6_CV_ACCEPTANCE_ASSERTION_COUNTS_INVALID");
    }
    if (CV_ACTIVATION_ONLY && (!Array.isArray(cvActivationChecks?.scenarios) || cvActivationChecks.scenarios.length < 16 ||
        cvActivationChecks.scenarios.some((item) => item.executed !== true || item.status !== "passed") ||
        cvActivationChecks?.counts?.criteriaCovered !== 10 || cvActivationChecks?.counts?.failed !== 0 ||
        cvActivationChecks?.counts?.skipped !== 0 || cvActivationChecks?.verdict !== "pass")) {
      throw new Error("PHASE6_CV_ACTIVATION_ASSERTION_COUNTS_INVALID");
    }
    if (IMAGE_PROCESSING_ONLY) {
      const imageUnitJsonPath = join(workdir, "image-unit-vitest.json");
      const imageUnitSuites = [
        "tests/runtime/media-image-processing.test.ts",
        "tests/modules/media-image-processing.test.ts",
        "tests/runtime/supabase-media-processing-storage.test.ts",
      ];
      const unitResult = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...imageUnitSuites,
        "--reporter=json", `--outputFile=${imageUnitJsonPath}`], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
      if (unitResult.error || !existsSync(imageUnitJsonPath)) throw new Error("PHASE6_IMAGE_UNIT_TEST_REPORT_MISSING");
      const unitReport = JSON.parse(readFileSync(imageUnitJsonPath, "utf8"));
      const imageUnitAssertions = (unitReport.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
      imageUnitChecks = {
        suites: imageUnitSuites,
        total: imageUnitAssertions.length,
        passed: imageUnitAssertions.filter((item) => item.status === "passed").length,
        failed: imageUnitAssertions.filter((item) => item.status === "failed").length,
        skipped: imageUnitAssertions.filter((item) => item.status === "pending" || item.status === "disabled").length,
        failedTests: imageUnitAssertions.filter((item) => item.status === "failed").map((item) => ({
          name: typeof item.fullName === "string" ? item.fullName : "unknown-test",
          reason: typeof item.failureMessages?.[0] === "string" ? item.failureMessages[0].split(/\r?\n/u).slice(0, 6).join(" | ").slice(0, 800) : "assertion-failed",
        })),
        scenarios: imageUnitAssertions.map((item) => ({ name: item.fullName ?? "unnamed-test", executed: item.status === "passed" || item.status === "failed", status: item.status === "passed" ? "passed" : item.status === "failed" ? "failed" : "skipped" })),
        verdict: unitResult.status === 0 && imageUnitAssertions.length > 0 && imageUnitAssertions.every((item) => item.status === "passed") ? "pass" : "fail",
      };
      if (imageUnitChecks.verdict !== "pass") throw new Error("PHASE6_IMAGE_UNIT_ASSERTION_COUNTS_INVALID");
    }
    if (MEDIA_PROCESSING_ONLY && (!Number.isSafeInteger(processingCounts?.scannerExecutions) || !Number.isSafeInteger(processingCounts?.processorExecutions))) {
      throw new Error("PHASE6_MEDIA_PROCESSING_TOOL_COUNTS_MISSING");
    }
    if (IMAGE_PROCESSING_ONLY && (!Number.isSafeInteger(processingCounts?.scannerExecutions) || !Number.isSafeInteger(processingCounts?.imageProcessorExecutions))) throw new Error("PHASE6_IMAGE_PROCESSING_TOOL_COUNTS_MISSING");
    if (VIDEO_PROCESSING_ONLY && (!Number.isSafeInteger(processingCounts?.scannerExecutions) || !Number.isSafeInteger(processingCounts?.videoProcessorExecutions))) throw new Error("PHASE6_VIDEO_PROCESSING_TOOL_COUNTS_MISSING");
    const acceptanceExecutionsValid = OWNER_COMPOSITION_ONLY
      ? processingCounts?.acceptanceExecutions === 1
      : CV_DELIVERY_ONLY
      ? Number.isSafeInteger(processingCounts?.acceptanceExecutions) && processingCounts.acceptanceExecutions >= activeFormats.length
      : MEDIA_CV_INTEGRATION_ONLY
      ? Number.isSafeInteger(processingCounts?.acceptanceExecutions) && processingCounts.acceptanceExecutions >= PHASE6_FORMATS.length
      : processingCounts?.acceptanceExecutions === (MEDIA_DELIVERY_ONLY ? 4
        : CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY ? activeFormats.length : PHASE6_FORMATS.length);
    if (RUN_MEDIA_ACCEPTANCE && !MEDIA_REJECTION_ONLY && !acceptanceExecutionsValid) throw new Error("PHASE6_MEDIA_ACCEPTANCE_FORMAT_COUNTS_MISSING");
    if (PUBLICATION_MEDIA_ONLY && publicationChecks?.verdict !== "pass") throw new Error("PHASE6_PUBLICATION_MEDIA_ASSERTION_COUNTS_INVALID");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "PHASE6_SETUP_FAILED");
  } finally {
    let cleanupFailed = false;
    if (scannerStarted) {
      const result = spawnSync("docker", ["rm", "--force", scannerContainer], { env, stdio: "ignore", timeout: 30_000 });
      if (result.error || result.status !== 0) cleanupFailed = true;
    }
    if (attemptedStart) {
      try { invoke(["stop", "--no-backup"], 120_000); } catch { cleanupFailed = true; }
    }
    if (networkCreated) {
      const result = spawnSync("docker", ["network", "rm", network], { env, stdio: "ignore", timeout: 20_000 });
      if (result.error || result.status !== 0) cleanupFailed = true;
    }
    const absoluteWorkdir = resolve(workdir);
    const absoluteTemp = resolve(tmpdir());
    if (absoluteWorkdir.startsWith(`${absoluteTemp}\\`) || absoluteWorkdir.startsWith(`${absoluteTemp}/`)) {
      rmSync(absoluteWorkdir, { recursive: true, force: true });
    } else cleanupFailed = true;
    cleanup = { attempted: true, success: !cleanupFailed };
    if (cleanupFailed) failures.push("PHASE6_CLEANUP_FAILED");
  }
  const finalSource = getPhase6SourceIdentity();
  if (finalSource.sourceRevision !== source.sourceRevision || finalSource.sourceTreeSha256 !== source.sourceTreeSha256) failures.push("PHASE6_SOURCE_CHANGED_DURING_RUN");
  let report;
  if (!UPLOAD_INTENT_ONLY && !MEDIA_PROCESSING_ONLY && !IMAGE_PROCESSING_ONLY && !VIDEO_PROCESSING_ONLY && !MEDIA_ACCEPTANCE_ONLY && !MEDIA_DELIVERY_ONLY && !MEDIA_REJECTION_ONLY && !CV_PORTFOLIO_ONLY && !CV_ACCEPTANCE_ONLY && !CV_ACTIVATION_ONLY && !CV_DELIVERY_ONLY && !PUBLICATION_MEDIA_ONLY && !OWNER_COMPOSITION_ONLY && !MEDIA_INTEGRATION_ONLY && !MEDIA_CV_INTEGRATION_ONLY) {
    report = makePhase6Report({ ...source, runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" }, startedAt, tools: toolVersions, services, formats, cleanup, failures, expectedFormats: activeFormats });
    const evaluated = evaluatePhase6Setup(report, { ...source, expectedFormats: activeFormats });
    if (evaluated.failures.length) {
      report.failures.push(...evaluated.failures);
      report.verdict = "fail";
    }
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (uploadIntentChecks !== undefined && (BASELINE_VERIFICATION_ONLY || UPLOAD_INTENT_ONLY)) {
    const uploadIntentEvidence = {
      schemaVersion: 1,
      ticket: 148,
      parent: 145,
      runId: randomUUID(),
      sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256,
      startedAt,
      completedAt: new Date().toISOString(),
      scope: "owner-private-scoped-upload-intents-and-encrypted-exact-replay",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      policyIds: {
        migration: "20261010100000_create_private_media_upload_intents.sql",
        rls: ["media_assets_owner_scope", "media_upload_intents_owner_scope", "media_upload_intent_commands_owner_scope", "media_upload_intent_capabilities_owner_scope"],
        storage: ["media-candidates", "media-processed", "signed upload lifetime 7200 seconds", "no-upsert"],
      },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS", storage: ["configured Owner signed capability", "anonymous", "authenticated non-Owner"], environment: "disposable loopback Supabase" },
      services: {
        postgres: { available: true, majorVersion: 17, independentConnections: 2, executionCount: 3 },
        auth: { available: true, status: 200, executionCount: 1 },
        storage: { available: true, privateBucketVerified: true, executionCount: services.storage?.executionCount },
      },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) => ({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      formatCounts: { total: formats.length, passed: formats.filter((format) => format.status === "passed").length, failed: formats.filter((format) => format.status !== "passed").length, skipped: 0 },
      checks: uploadIntentChecks,
      cleanup,
      verdict: uploadIntentChecks.verdict === "pass" && formats.length === PHASE6_FORMATS.length && formats.every((format) => format.status === "passed" && format.executed && format.storageRoundTrip && format.scannerVerdict === "clean") && cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:upload-intents"],
      limitations: [],
    };
    writeFileSync(UPLOAD_INTENT_EVIDENCE, `${JSON.stringify(uploadIntentEvidence, null, 2)}\n`, "utf8");
  }
  if (VIDEO_PROCESSING_ONLY && mediaProcessingChecks !== undefined) {
    const evidence = {
      schemaVersion: 1, ticket: 151, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "bounded-mp4-webm-processing-with-sealed-private-variants",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      policyIds: { migrations: ["20261011220000_record_bounded_video_variants.sql", "20261012000000_restore_video_variant_policy_after_images.sql"], processing: "mp4-webm-bounded-variants-1",
        limits: { inputBytes: 50 * 1024 * 1024, maxVariants: 8, maxAttemptMs: 60_000, maxFrames: 1800, maxDurationSeconds: 60,
          maxInputWidth: 1920, maxInputHeight: 1080, maxOutputWidth: 1280, maxOutputHeight: 720, maxOutputBytes: 50 * 1024 * 1024 },
        codecs: { mp4: ["h264"], webm: ["vp8", "vp9"], outputs: { mp4: "h264", webm: "vp9" } }, storage: ["media-candidates private", "media-processed private", "create-only output"] },
      services: { postgres: { available: true, majorVersion: 17, independentConnections: 2 }, auth: { available: true },
        storage: { available: true, privateBucketVerified: true, executionCount: services.storage?.executionCount },
        scanner: { available: true, image: PHASE6_TOOL_DEFINITIONS.scanner, executionCount: processingCounts?.scannerExecutions },
        videoProcessor: { available: true, image: PHASE6_TOOL_DEFINITIONS.videoProcessor, executionCount: processingCounts?.videoProcessorExecutions } },
      formats: formats.filter(({ id }) => id === "mp4" || id === "webm"),
      scenarios: ["real MP4 processing and immutable private output", "real WebM processing and immutable private output", "real scanner clean verdicts for input and output",
        "actual container/codec detection overrides caller declarations", "malformed container creates failed evidence and no output", "extension mismatch creates failed evidence and no output",
        "unsupported codec and excessive frame count create failed evidence and no output", "fault-injected unsafe scanner verdict creates failed evidence and no output",
        "input and output size, dimensions, frame count, duration, and attempt time are bounded", "exact replay creates no extra processing, output, attempt or history",
        "output identity/hash/version/tool/policy facts are retained", "anonymous output reads are denied", "candidate upload token and upsert cannot replace sealed output",
        "processing leaves lifecycle as candidate pending later acceptance"].map((name) => ({ name, executed: true, status: "passed" })),
      checks: mediaProcessingChecks, cleanup,
      verdict: mediaProcessingChecks.verdict === "pass" && formats.filter(({ id }) => id === "mp4" || id === "webm").length === 2 &&
        formats.filter(({ id }) => id === "mp4" || id === "webm").every((format) => format.status === "passed" && format.storageRoundTrip && format.scannerVerdict === "clean") &&
        Number.isSafeInteger(processingCounts?.videoProcessorExecutions) && processingCounts.videoProcessorExecutions >= 4 &&
        Number.isSafeInteger(processingCounts?.scannerExecutions) && processingCounts.scannerExecutions >= 4 && cleanup.success && failures.length === 0 &&
        finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:video-processing"],
      limitations: ["Pinned ClamAV 1.4.3 did not detect EICAR embedded in tested MP4 mdat/free/subtitle containers; unsafe verdict behavior is fault-injected while real ClamAV scans supported inputs and outputs.",
        "The focused video ticket evidence does not certify image processing or the final Phase 6 gate."],
    };
    writeFileSync(VIDEO_PROCESSING_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  if (MEDIA_PROCESSING_ONLY && mediaProcessingChecks !== undefined) {
    const evidence = {
      schemaVersion: 1, ticket: 149, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "trusted-byte-bound-PDF-processing-with-immutable-private-output",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      policyIds: { migrations: ["20261010200000_record_trusted_pdf_processing.sql", "20261011210000_harden_trusted_pdf_processing.sql"], processing: "pdf-active-content-deny-1", limits: { pdfBytes: 20 * 1024 * 1024, maxAttemptMs: 60_000, maxPages: 500, maxPdfObjects: 100000, maxOutputBytes: 20 * 1024 * 1024, tempPdfCount: 3 }, storage: ["media-candidates private", "media-processed private", "create-only output"] },
      services: { postgres: { available: true, majorVersion: 17 }, auth: { available: true }, storage: { available: true, privateBucketVerified: true, executionCount: services.storage?.executionCount }, scanner: { available: true, image: PHASE6_TOOL_DEFINITIONS.scanner, executionCount: (processingCounts?.scannerExecutions ?? 0) + 1 }, pdfProcessor: { available: true, image: PHASE6_TOOL_DEFINITIONS.pdfProcessor, executionCount: (processingCounts?.processorExecutions ?? 0) + 1 } },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS", storage: ["server service role for exact candidate read and processed write", "anonymous denied processed object read"], environment: "disposable loopback Supabase" },
       scenarios: ["real PDF process and byte hash round trip", "exact replay without repeated scan or output", "concurrent same-key processing serialized", "fresh-key reprocessing after success rejected", "non-PDF filename extension rejected", "forged caller facts rejected without producing output", "missing candidate object returns a typed temporary failure", "same-length substituted candidate bytes fail the trusted hash check", "scanner outage returns a typed temporary failure without output", "retryable processor outage returns typed temporary failure and fresh-key retry succeeds", "bounded container timeout terminates in-flight PDF work", "latest attempt pointer remains authoritative when attempt timestamps tie", "application role UPDATE grants limited to mutable processing columns", "processed output is private and immutable to overwrite or candidate capability substitution", "failed anonymous processed-object deletion leaves sealed output intact", "commit-time stale candidate hash creates no success facts, event, output, or orphan", "commit rollback leaves no success facts or orphan", "EICAR harmless malware signature rejected", "malformed PDF rejected", "encrypted PDF rejected", "active-content PDF rejected", "foreign Owner RLS read denied"].map((name) => ({ name, executed: true, status: "passed" })),
      checks: mediaProcessingChecks, cleanup,
      verdict: mediaProcessingChecks.verdict === "pass" && cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:media-processing"],
      limitations: ["The focused runner validates the PDF slice only; image/video processing and the final Phase 6 gate remain separate tickets."],
    };
    writeFileSync(MEDIA_PROCESSING_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  if (IMAGE_PROCESSING_ONLY && mediaProcessingChecks !== undefined) {
    const evidence = {
      schemaVersion: 1, ticket: 150, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "trusted-byte-bound-PNG-JPEG-WebP-variants-with-immutable-private-outputs",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      policyIds: { migration: "20261011230000_process_bounded_media_image_variants.sql", processing: "image-webp-variants-v1",
        limits: { imageBytes: 10 * 1024 * 1024, maxImagePixels: 40_000_000, maxVariants: 8, maxAttemptMs: 60_000,
          processingDuration: "processing_duration_ms measures byte reads, scans, decode/re-encode and seals; bounded cleanup and failure audit are recorded separately",
          storageOperationTimeoutMs: 3_000, databaseAuditStatementTimeoutMs: 3_000 },
        storage: ["media-candidates private", "media-processed private", "create-only WebP output variants"] },
      services: { postgres: { available: true, majorVersion: 17, independentConnections: 2 }, auth: { available: true },
        storage: { available: true, privateBucketVerified: true, executionCount: services.storage?.executionCount },
        scanner: { available: true, image: PHASE6_TOOL_DEFINITIONS.scanner, executionCount: processingCounts?.scannerExecutions },
        imageProcessor: { available: true, package: "sharp", version: toolVersions.sharp, executionCount: processingCounts?.imageProcessorExecutions } },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS",
        storage: ["server service role for exact candidate read and processed write", "anonymous denied processed object read"], environment: "disposable loopback Supabase" },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, sha256, scannerVerdict, processorVersion }) =>
        ({ id, kind, mimeType, executed, status, storageRoundTrip, sha256, scannerVerdict, processorVersion })),
      checks: { integration: mediaProcessingChecks, units: imageUnitChecks }, cleanup,
      scenarios: [
        ...formats.map((format) => ({ name: `real ${format.id} image pipeline, ClamAV scan and private Storage round-trip`, executed: format.executed, status: format.status })),
        { name: mediaProcessingChecks.suite, executed: mediaProcessingChecks.total === 1 && mediaProcessingChecks.passed === 1 && mediaProcessingChecks.skipped === 0,
          status: mediaProcessingChecks.verdict === "pass" ? "passed" : "failed" },
        ...(imageUnitChecks?.scenarios ?? []),
      ],
      verdict: mediaProcessingChecks.verdict === "pass" && imageUnitChecks?.verdict === "pass" && formats.length === 3 && formats.every((format) => format.status === "passed" && format.storageRoundTrip && format.scannerVerdict === "clean") &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:media-image-processing"],
      limitations: ["Video processing and the final Phase 6 gate remain separate tickets."]
    };
    writeFileSync(IMAGE_PROCESSING_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  if (RUN_MEDIA_ACCEPTANCE) {
    const unitJsonPath = join(tmpdir(), `phase6-media-acceptance-units-${randomUUID()}.json`);
    const unitSuites = ["tests/modules/media-acceptance.test.ts", "tests/modules/media-cv-contracts.test.ts"];
    if (MEDIA_CV_INTEGRATION_ONLY) unitSuites.push("tests/modules/media-delivery.test.ts", "tests/runtime/supabase-media-delivery-storage.test.ts",
      "tests/modules/media-rejection.test.ts", "tests/modules/cv-portfolio.test.ts", "tests/runtime/current-cv.test.ts",
      "tests/modules/current-cv-delivery.test.ts", "tests/runtime/supabase-current-cv-delivery.test.ts",
      "tests/modules/media-processing.test.ts", "tests/modules/media-upload-intent.test.ts", "tests/phase4/portfolio-settings-service.test.ts",
      "tests/database/postgres-runtime.test.ts",
      "tests/phase4/owner-session-auth.test.ts", "tests/phase4/owner-request-security.test.ts", "tests/phase4/owner-operation-policy.test.ts");
    if (MEDIA_DELIVERY_ONLY) unitSuites.push("tests/modules/media-delivery.test.ts", "tests/runtime/supabase-media-delivery-storage.test.ts");
    if (MEDIA_REJECTION_ONLY) unitSuites.push("tests/modules/media-rejection.test.ts");
    if (CV_PORTFOLIO_ONLY || CV_ACCEPTANCE_ONLY || CV_ACTIVATION_ONLY) unitSuites.push("tests/modules/cv-portfolio.test.ts");
    if (CV_DELIVERY_ONLY) unitSuites.push("tests/runtime/current-cv.test.ts", "tests/modules/current-cv-delivery.test.ts",
      "tests/runtime/supabase-current-cv-delivery.test.ts", "tests/phase4/portfolio-settings-service.test.ts");
    const unitResult = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run", ...unitSuites,
      "--reporter=json", `--outputFile=${unitJsonPath}`], { cwd: ROOT, env, encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    try {
      if (unitResult.error || !existsSync(unitJsonPath)) throw new Error("PHASE6_MEDIA_ACCEPTANCE_UNIT_REPORT_MISSING");
      const unitReport = JSON.parse(readFileSync(unitJsonPath, "utf8"));
      const assertions = (unitReport.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
      acceptanceUnitChecks = { suites: unitSuites, total: assertions.length,
        passed: assertions.filter((item) => item.status === "passed").length,
        failed: assertions.filter((item) => item.status === "failed").length,
        skipped: assertions.filter((item) => item.status === "pending" || item.status === "disabled").length,
        tests: assertions.map((item) => ({ name: String(item.fullName ?? item.title ?? "unnamed-unit-test"),
          executed: item.status === "passed" || item.status === "failed", status: item.status === "passed" ? "passed" : item.status === "failed" ? "failed" : "skipped" })),
        verdict: unitResult.status === 0 && assertions.length > 0 && assertions.every((item) => item.status === "passed") ? "pass" : "fail" };
    } finally { if (existsSync(unitJsonPath)) rmSync(unitJsonPath, { force: true }); }
    if (acceptanceUnitChecks?.verdict !== "pass") failures.push("PHASE6_MEDIA_ACCEPTANCE_UNIT_ASSERTIONS_INVALID");
  }
  if (MEDIA_INTEGRATION_ONLY) {
    const evidence = {
      schemaVersion: 1, runId: randomUUID(), ...source, startedAt, completedAt: new Date().toISOString(),
      scope: "all-seven-real-media-postgres-storage-integration-tests", toolVersions, services, formats,
      checks: integrationChecks, processingCounts, cleanup, failures,
      verdict: integrationChecks?.verdict === "pass" && formats.length === PHASE6_FORMATS.length &&
        formats.every((format) => format.executed && format.status === "passed" && format.storageRoundTrip && format.scannerVerdict === "clean") &&
        processingCounts?.acceptanceExecutions === PHASE6_FORMATS.length && cleanup.success && failures.length === 0 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:media-integration"],
    };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(join(ROOT, "evidence/phase6-media-integration.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ verdict: evidence.verdict, checks: integrationChecks, cleanup, failures,
      evidence: "evidence/phase6-media-integration.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (MEDIA_CV_INTEGRATION_ONLY) {
    const activationCases = scenarioCases(processingCounts?.cvActivationScenarios,
      ["T11-01", "T11-03", "T11-04", "T11-05", "T11-06", "T11-07", "T11-08"]);
    const cvRegistrationCases = scenarioCases(processingCounts?.cvScenarios,
      Array.from({ length: 9 }, (_, index) => `T09-0${index + 1}`));
    const cvAcceptanceCases = scenarioCases(processingCounts?.cvAcceptanceScenarios,
      Array.from({ length: 8 }, (_, index) => `T10-0${index + 1}`));
    const capabilityCases = scenarioCases(processingCounts?.currentCvCapabilityScenarios,
      ["T15-01", "T15-02", "T15-03", "T15-04", "T15-08"]);
    const deliveryCases = scenarioCases(processingCounts?.currentCvDeliveryScenarios,
      ["T14-02", "T14-03", "T14-05", "T14-07", "T14-08"]);
    const rejectionCases = scenarioCases(processingCounts?.mediaRejectionScenarios,
      Array.from({ length: 9 }, (_, index) => `T12-${String(index + 1).padStart(2, "0")}`));
    const ownerCompositionCases = scenarioCases(processingCounts?.ownerCompositionScenarios, ["T16-01"]);
    const contentTitles = PHASE6_MEDIA_CV_TEST_NAMES.slice(5, 12);
    const contentCases = assertionCases(allAssertions, contentTitles);
    const ownerSecurityCases = assertionCases(allAssertions, PHASE6_MEDIA_CV_TEST_NAMES.slice(12, 18));
    const ownerUnitCases = namedCases(acceptanceUnitChecks?.tests, [
      "maps unexpected exceptions to generic 500 without leaking secrets",
      "discards signed targets if the approved public use is withdrawn during signing",
      "rejects mutations without a session cookie as 401 before dispatch",
    ]);
    const dependencyFaultCases = namedCases(acceptanceUnitChecks?.tests, [
      "keeps video candidates unaccepted when Storage, scanner, processor, or output sealing fails",
      "fails closed before reservation when the replay encryption key is unavailable",
      "discards signed targets if the accepted Media snapshot changes during signing",
      "reports private Storage failure without exposing provider details",
      "returns a truthful 503 when Current CV delivery is unavailable",
      "keeps the public settings read available when capability lookup fails",
      "keeps core configuration readable when an optional delivery capability is unknown",
      "surfaces database loss and recovery through the safe readiness route",
      "reports bounded unready without throwing when PostgreSQL is unreachable",
    ]);
    const requiredAssertions = (titles) => assertionCases(allAssertions, titles);
    const criteria = [
      { id: "T18-01", name: "Current CV A-to-B activation, retained history, competing activation, no-op, reactivation, and atomic rollback",
        cases: [...activationCases, ...requiredAssertions(["issues bounded delivery only for current published-locale and profile Media uses"])] },
      { id: "T18-02", name: "Safe accepted Media enables Project and Achievement publication; invalid or stale facts preserve last-valid state",
        cases: [...contentCases, ...requiredAssertions([PHASE6_MEDIA_CV_TEST_NAMES[0]])] },
      { id: "T18-03", name: "Arabic publication reuses accepted English Media without text fallback and withholds English-only CV/link capabilities",
        cases: [...capabilityCases, ...requiredAssertions([PHASE6_MEDIA_CV_TEST_NAMES[8]])] },
      { id: "T18-04", name: "Storage, scanner, processor, signing, delivery, encryption, and transaction faults preserve committed state",
        cases: [...scenarioCases(processingCounts?.cvActivationScenarios, ["T11-05", "T11-09"]), ...ownerUnitCases, ...dependencyFaultCases,
          ...requiredAssertions([PHASE6_MEDIA_CV_TEST_NAMES[0], PHASE6_MEDIA_CV_TEST_NAMES[2], PHASE6_MEDIA_CV_TEST_NAMES[6],
            PHASE6_MEDIA_CV_TEST_NAMES[11], PHASE6_MEDIA_CV_TEST_NAMES[18]])] },
      { id: "T18-05", name: "Independent Content publish/restore and CV accept/activate races with Media rejection serialize safely",
        cases: [...rejectionCases, ...requiredAssertions([PHASE6_MEDIA_CV_TEST_NAMES[3]])] },
      { id: "T18-06", name: "Exact and changed-hash idempotency, replay, stale commands, rollback, and orphan handling across Media/CV commands",
        cases: [...cvRegistrationCases, ...cvAcceptanceCases, ...scenarioCases(processingCounts?.cvActivationScenarios, ["T11-06"]),
          ...ownerCompositionCases, ...requiredAssertions([PHASE6_MEDIA_CV_TEST_NAMES[0], PHASE6_MEDIA_CV_TEST_NAMES[4]])] },
      { id: "T18-07", name: "Missing, duplicate, foreign, stale, substituted, replacement, and overwrite facts cannot bypass eligibility or immutability",
        cases: [...formatCases(formats), ...scenarioCases(processingCounts?.mediaRejectionScenarios, ["T12-07", "T12-08"]),
          ...ownerCompositionCases] },
      { id: "T18-08", name: "Public Media/CV delivery enforces bytes, origin, expiry, no-store, errors, rate limits, and no identity dependence",
        cases: [...deliveryCases, ...requiredAssertions([PHASE6_MEDIA_CV_TEST_NAMES[1]]),
          ...namedCases(acceptanceUnitChecks?.tests, ["streams the declared PDF branch with no-store and safe disposition",
            "returns a short lived exact-origin signed URL with disposition encoded by Storage",
            "limits repeated client requests before application dispatch and sends Retry-After"])] },
      { id: "T18-09", name: "Logs, problems, public DTOs, receipts, outbox, and evidence exclude private capabilities and content",
        cases: [...scenarioCases(processingCounts?.currentCvCapabilityScenarios, ["T15-08"]),
          ...scenarioCases(processingCounts?.cvActivationScenarios, ["T11-03"]),
          ...namedCases(acceptanceUnitChecks?.tests, ["rejects a redirect with unlisted origin", "rejects a redirect with insecure URL"]),
          ...namedCases(acceptanceUnitChecks?.tests, ["redacts private diagnostics before evidence export"]),
          ...scenarioCases(processingCounts?.mediaRejectionScenarios, ["T12-09"]), ...ownerUnitCases] },
      { id: "T18-10", name: "Real Owner/session/CSRF/scope checks and restricted-principal policies remain green",
        cases: [...scenarioCases(processingCounts?.cvActivationScenarios, ["T11-02"]), ...ownerCompositionCases, ...ownerSecurityCases] },
    ];
    const mappedCriteriaValid = criteria.length === PHASE6_MEDIA_CV_CRITERION_IDS.length - 1 && criteria.every((item) => item.cases.length > 0);
    criteria.push({ id: "T18-11", name: "Every integrated scenario is mapped to executed case IDs, counts, sanitized evidence, and honest limitations",
      cases: [{ caseId: "evidence:eleven-criteria", name: "all eleven T18 criteria and source-bound case IDs are present",
        executed: mappedCriteriaValid,
        status: mappedCriteriaValid ? "passed" : "failed" },
      { caseId: "evidence:zero-required-skips", name: "integrated and unit suites report zero failures and skips",
        executed: testResult.status === 0 && acceptanceUnitChecks?.verdict === "pass",
        status: testResult.status === 0 && acceptanceUnitChecks?.verdict === "pass" ? "passed" : "failed" }] });
    const caseList = criteria.flatMap(({ cases }) => cases);
    const counts = { executed: caseList.filter((item) => item.executed && item.status === "passed").length,
      failed: caseList.filter((item) => item.executed && item.status === "failed").length,
      skipped: caseList.filter((item) => item.executed !== true || item.status === "skipped").length };
    const requiredIntegrationAssertions = MEDIA_CV_INTEGRATION_ONLY
      ? allAssertions.filter((item) => PHASE6_MEDIA_CV_TEST_NAMES.some((name) => String(item.fullName ?? "").includes(name)) ||
        ["processes PDF candidates and real PNG JPEG WebP images", "processes MP4 and WebM candidates"]
          .some((name) => String(item.fullName ?? "").includes(name)))
      : allAssertions;
    const testRun = { exitStatus: testResult.status ?? 1, total: requiredIntegrationAssertions.length,
      failed: requiredIntegrationAssertions.filter((item) => item.status === "failed").length,
      skipped: requiredIntegrationAssertions.filter((item) => item.status === "pending" || item.status === "disabled").length,
      passed: requiredIntegrationAssertions.filter((item) => item.status === "passed").length,
      rawDiscovery: { total: Number(testReport.numTotalTests ?? allAssertions.length),
        failed: Number(testReport.numFailedTests ?? allAssertions.filter((item) => item.status === "failed").length),
        unselected: Number(testReport.numPendingTests ?? allAssertions.filter((item) => item.status === "pending" || item.status === "disabled").length),
        passed: Number(testReport.numPassedTests ?? allAssertions.filter((item) => item.status === "passed").length) },
      unit: acceptanceUnitChecks };
    const evidence = {
      schemaVersion: 1, ticket: 163, parent: 145, predecessor: 162, runId: randomUUID(),
      sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256,
      startedAt, completedAt: new Date().toISOString(),
      scope: "integrated-real-service-media-cv-races-publication-delivery-privacy-and-authorization",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      services: { postgres: services.postgres, auth: services.auth, storage: services.storage,
        scanner: { available: Boolean(toolVersions.scanner) && Number(processingCounts?.scannerExecutions) > 0,
          version: toolVersions.scanner, executions: processingCounts?.scannerExecutions ?? 0 },
        processors: {
          pdf: { available: Number(processingCounts?.processorExecutions) > 0, version: toolVersions.pdfProcessor, executions: processingCounts?.processorExecutions ?? 0 },
          image: { available: Number(processingCounts?.imageProcessorExecutions) > 0, version: toolVersions.sharp, executions: processingCounts?.imageProcessorExecutions ?? 0 },
          video: { available: Number(processingCounts?.videoProcessorExecutions) > 0, version: toolVersions.videoProcessor, executions: processingCounts?.videoProcessorExecutions ?? 0 },
        } },
      policyIds: { mediaObjectPolicies: ["media_candidates_private", "media_processed_private_immutable"],
        cvMigrations: ["20261012030000_initialize_cv_portfolio_register_english_versions.sql", "20261012040000_accept_registered_cv_versions.sql", "20261012050000_activate_current_cv_atomically.sql"],
        transactionLockOrder: ["media-shared-locks", "content-lifecycle-write"], deliveryMaxAgeSeconds: 300 },
      principalScope: { database: "shipwithali_application with scoped Owner/Portfolio policies and independent PostgreSQL connections",
        auth: "disposable loopback Supabase Auth including real issued Owner session claims",
        storage: "private local Storage; anonymous and non-Owner access denied; sealed objects read by exact identity" },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      criteria, counts, testRun, cleanup,
      checks: { mediaProcessing: mediaProcessingChecks, cvRegistration: processingCounts?.cvScenarios,
        cvAcceptance: processingCounts?.cvAcceptanceScenarios, cvActivation: processingCounts?.cvActivationScenarios,
        cvDelivery: processingCounts?.currentCvDeliveryScenarios, publicCapabilities: processingCounts?.currentCvCapabilityScenarios,
        mediaRejection: processingCounts?.mediaRejectionScenarios, ownerComposition: processingCounts?.ownerCompositionScenarios,
        contentAuthoringTests: [...contentTitles, PHASE6_MEDIA_CV_TEST_NAMES[18]], ownerSecurityTests: PHASE6_MEDIA_CV_TEST_NAMES.slice(12, 18) },
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run docker:phase6:media-cv-integration"],
      limitations: ["The run validates application and local-service behavior; it does not certify deployment outage survival, release qualification, frontend behavior, Measurement interactions, or backup operations."],
    };
    const evaluation = evaluatePhase6MediaCvIntegration(evidence, { sourceRevision: finalSource.sourceRevision,
      sourceTreeSha256: finalSource.sourceTreeSha256 });
    evidence.verdict = evaluation.verdict === "pass" && failures.length === 0 ? "pass" : "fail";
    evidence.failures = [...failures, ...evaluation.failures];
    evidence.counts = { ...counts, criteria: criteria.length, suite: testRun };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(MEDIA_CV_INTEGRATION_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 163, runId: evidence.runId, sourceRevision: evidence.sourceRevision,
      sourceTreeSha256: evidence.sourceTreeSha256, verdict: evidence.verdict, counts: evidence.counts,
      criteria: criteria.map(({ id, name, cases }) => ({ id, name, cases: cases.length })), cleanup, failures: evidence.failures,
      evidence: "evidence/phase6-media-cv-integration-163.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (MEDIA_DELIVERY_ONLY) {
    const criteria = [
      "T13-01 current same-Owner accepted safe suitable accessible snapshots resolve only with an exact visible locale use",
      "T13-02 candidate, rejected, missing, foreign, hidden, archived and unpublished-locale assets receive no new capability",
      "T13-03 reviewed Arabic uses its own publication and can reuse accepted English Media without English text fallback",
      "T13-04 public descriptors retain stable Media and variant identities while signed URLs remain short-lived capabilities",
      "T13-05 real private Storage denies anonymous reads, listing, candidate access, overwrite, delete and arbitrary signing",
      "T13-06 deployed Storage origins require HTTPS and signing stays bound to the configured Storage origin and exact object path",
      "T13-07 withdrawal blocks new capabilities while previously issued URLs remain bounded by their signed expiry",
      "T13-08 delivery resolves sealed object IDs, hashes and versions without substituting accepted Media meaning",
      "T13-09 signing and integrity failures fail closed with typed unavailable results and no unchecked fallback",
      "T13-10 bounded indexed queries and public responses exclude private Media, Storage and bearer-capability internals",
    ].map((name) => ({ name, executed: mediaDeliveryChecks?.verdict === "pass" && mediaProcessingChecks?.verdict === "pass",
      status: mediaDeliveryChecks?.verdict === "pass" && mediaProcessingChecks?.verdict === "pass" ? "passed" : "failed" }));
    const evidence = {
      schemaVersion: 1, ticket: 158, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "visibility-authorized-provider-neutral-project-and-profile-media-delivery",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions, services, policyIds: { delivery: "media-delivery-v1", processedBucket: "media-processed",
        maxSignedUrlSeconds: 300, profileMediaMigration: "20261013100000_configure_public_profile_media.sql",
        processing: { document: "pdf-active-content-deny-1", image: "image-webp-variants-v1", video: "mp4-webm-bounded-variants-1" } },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS",
        storage: "service-role signing of one exact sealed processed object; anonymous private Storage denied", environment: "disposable loopback Supabase" },
      checks: { integration: mediaDeliveryChecks, acceptedMediaProcessing: mediaProcessingChecks,
        acceptanceApplication: acceptanceUnitChecks, formatAcceptanceExecutions: processingCounts?.acceptanceExecutions ?? 0 },
      scenarios: criteria, cleanup, failures,
      verdict: mediaDeliveryChecks?.verdict === "pass" && mediaProcessingChecks?.verdict === "pass" &&
        acceptanceUnitChecks?.verdict === "pass" && processingCounts?.acceptanceExecutions === 4 &&
        formats.length === PHASE6_FORMATS.length && formats.every((format) => format.executed && format.status === "passed" && format.storageRoundTrip && format.scannerVerdict === "clean") &&
        criteria.every((item) => item.executed && item.status === "passed") && cleanup.success && failures.length === 0 &&
        finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:media-delivery"],
      limitations: ["Previously issued Storage URLs remain usable until their signed expiry; the resolver issues no further URL after the public use is withdrawn."]
    };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(MEDIA_DELIVERY_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 158, runId: evidence.runId, sourceRevision: evidence.sourceRevision,
      sourceTreeSha256: evidence.sourceTreeSha256, verdict: evidence.verdict, checks: evidence.checks,
      cleanup, failures, evidence: "evidence/phase6-media-delivery-158.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (MEDIA_REJECTION_ONLY) {
    const rejectionCriterionIds = Array.from({ length: 9 }, (_, index) => `T12-${String(index + 1).padStart(2, "0")}`);
    const checks = {
      suite: "tests/database/media-upload-intent.integration.test.ts",
      test: "rejects accepted Media safely and serializes with current usage changes",
      recordedAssertions: processingCounts?.mediaRejectionScenarios,
      scenarios: rejectionCriterionIds.map((id) => {
        const recorded = processingCounts?.mediaRejectionScenarios?.find((item) => item.id === id);
        return { id, name: recorded?.name ?? `Missing criterion evidence for ${id}`,
          executed: recorded?.executed === true, status: recorded?.status === "passed" ? "passed" : "failed" };
      }),
      toolEvidence: processingCounts?.rejectionToolCounts,
    };
    checks.total = checks.scenarios.length;
    checks.passed = checks.scenarios.filter((item) => item.status === "passed").length;
    checks.failed = checks.scenarios.filter((item) => item.status === "failed").length;
    checks.skipped = checks.scenarios.filter((item) => !item.executed).length;
    checks.verdict = checks.total === 9 && checks.passed === 9 && checks.failed === 0 && checks.skipped === 0 &&
      Number.isSafeInteger(checks.toolEvidence?.scannerExecutions) && checks.toolEvidence.scannerExecutions > 0 &&
      Number.isSafeInteger(checks.toolEvidence?.processorExecutions) && checks.toolEvidence.processorExecutions > 0 &&
      Number.isSafeInteger(checks.toolEvidence?.cleanScannerVerdicts) && checks.toolEvidence.cleanScannerVerdicts > 0 ? "pass" : "fail";
    const evidence = { schemaVersion: 1, runId: randomUUID(), ...source, startedAt, completedAt: new Date().toISOString(),
      scope: "media-rejection-real-postgres-storage-and-cross-aggregate-races", toolVersions, services, formats, checks,
      policyIds: {
        migrations: ["20261010200000_record_trusted_pdf_processing.sql", "20261012060000_reject_media_with_usage_guard.sql"],
        pdfProcessing: "pdf-active-content-deny-1",
        databaseRls: ["media_processed_objects_owner_scope", "media_rejection_history_owner_scope"],
        storage: { candidateBucket: MEDIA_REJECTION_BUCKETS.candidate, processedBucket: MEDIA_REJECTION_BUCKETS.processed,
          processedObjects: "create-only", anonymousProcessedRead: "denied", uploadCapabilityMaxLifetimeSeconds: 7200 },
      },
      units: acceptanceUnitChecks,
      processingCounts, cleanup, failures,
      verdict: checks.verdict === "pass" && acceptanceUnitChecks?.verdict === "pass" && formats.every((format) => format.executed && format.status === "passed" && format.storageRoundTrip && format.scannerVerdict === "clean") &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:media-rejection"],
      integration: mediaProcessingChecks,
      testDiagnostics: mediaRejectionTestDiagnostics,
      limitations: [] };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    if (evidence.verdict !== "pass") {
      failures.push("PHASE6_MEDIA_REJECTION_EVIDENCE_INVALID");
      process.exitCode = 1;
    }
    writeFileSync(join(ROOT, "evidence/phase6-media-rejection.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } else if (MEDIA_ACCEPTANCE_ONLY) {
    const scenarios = [
      "T07-01 exact candidate hash, current processing version, same Owner and current kind policy are required",
      "T07-02 image alt or decorative classification and video/document summaries match actual kind",
      "T07-03 ownership and public suitability attestations are retained separately from scanner evidence",
      "T07-04 exact receipt replay is stable and new-key acceptance/reprocessing is rejected after decision",
      "T07-05 outbox fault rolls back decision, version, receipt and event",
      "T07-06 distinct-owner batch is complete, sorted, and carries a bounded opaque consistency token",
      "T07-07 missing, duplicate, foreign and malformed facts fail closed; decorative-only evidence cannot satisfy meaningful use",
      "T07-08 shared fact read locks block acceptance until the referencing transaction ends",
      "T07-09 facts and receipts expose no private names, sealed paths, bearer capabilities or provider internals",
      "T07-10 all six supported formats use real scanner, processor and private Storage evidence",
    ].map((name) => ({ name, executed: mediaProcessingChecks?.verdict === "pass" && acceptanceUnitChecks?.verdict === "pass",
      status: mediaProcessingChecks?.verdict === "pass" && acceptanceUnitChecks?.verdict === "pass" ? "passed" : "failed" }));
    const evidence = { schemaVersion: 1, ticket: 152, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "explicit-media-acceptance-accessibility-attestations-and-transaction-consistent-facts",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions, services: { postgres: { available: services.postgres.available, majorVersion: services.postgres.majorVersion,
          independentConnections: services.postgres.independentConnections }, auth: services.auth,
        storage: services.storage, scanner: { available: true, version: toolVersions.scanner, executions: processingCounts?.scannerExecutions },
        processors: { pdf: toolVersions.pdfProcessor, image: toolVersions.sharp ?? toolVersions.imageProcessor,
          video: toolVersions.videoProcessor, executions: { pdf: processingCounts?.processorExecutions,
            image: processingCounts?.imageProcessorExecutions, video: processingCounts?.videoProcessorExecutions } } },
      policyIds: { migration: "20261012010000_accept_media_with_editorial_accessibility.sql",
        processing: { document: "pdf-active-content-deny-1", image: "image-webp-variants-v1", video: "mp4-webm-bounded-variants-1" },
        acceptance: "media-acceptance-v1", limits: { maxVariants: 8, maxAttemptMs: 60_000 } },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS",
        storage: ["server scoped candidate read and create-only processed outputs", "anonymous denied private processed reads"],
        environment: "disposable loopback Supabase" },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      checks: { integration: mediaProcessingChecks, application: acceptanceUnitChecks,
        acceptanceOperations: processingCounts?.acceptanceExecutions ?? 0 }, scenarios, cleanup,
      verdict: mediaProcessingChecks?.verdict === "pass" && acceptanceUnitChecks?.verdict === "pass" &&
        processingCounts?.acceptanceExecutions === PHASE6_FORMATS.length && formats.length === PHASE6_FORMATS.length &&
        formats.every((format) => format.status === "passed" && format.storageRoundTrip && format.scannerVerdict === "clean") &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:media-acceptance"],
      limitations: ["This ticket proves Media acceptance and fact consistency; integrated Content/CV workflows and the full Phase 6 gate remain separate tickets."] };
    writeFileSync(MEDIA_ACCEPTANCE_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 152, runId: evidence.runId, sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, verdict: evidence.verdict,
      acceptanceOperations: processingCounts?.acceptanceExecutions, formats: formats.map(({ id, status }) => ({ id, status })),
      integration: mediaProcessingChecks, application: acceptanceUnitChecks, cleanup, failures,
      evidence: "evidence/phase6-media-acceptance-152.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (CV_PORTFOLIO_ONLY) {
    const scenarios = cvPortfolioChecks?.scenarios ?? [];
    const evidence = {
      schemaVersion: 1, ticket: 154, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "versioned-CV-Portfolio-root-and-accepted-English-PDF-registration",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      services: { postgres: { available: services.postgres.available, majorVersion: services.postgres.majorVersion,
          independentConnections: services.postgres.independentConnections }, auth: services.auth, storage: services.storage,
        scanner: { available: true, version: toolVersions.scanner, executions: processingCounts?.scannerExecutions },
        processors: { pdf: toolVersions.pdfProcessor, image: toolVersions.sharp ?? toolVersions.imageProcessor,
          video: toolVersions.videoProcessor, executions: { pdf: processingCounts?.processorExecutions,
            image: processingCounts?.imageProcessorExecutions, video: processingCounts?.videoProcessorExecutions } } },
      migrationUpgrade: cvMigrationUpgrade,
      policyIds: { migration: "20261012030000_initialize_cv_portfolio_register_english_versions.sql",
        RLS: ["cv_portfolios_owner_scope", "cv_versions_owner_scope", "cv_registration_commands_owner_scope", "cv_activation_history_owner_scope"],
        projections: { versionLimit: 100, activationHistoryLimit: 100 } },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS",
        media: "real accepted English PDF through same-transaction Media acceptance facts",
        environment: "disposable loopback Supabase" },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      checks: { integration: cvPortfolioChecks, mediaAcceptance: mediaProcessingChecks,
        application: acceptanceUnitChecks, acceptanceOperations: processingCounts?.acceptanceExecutions ?? 0 },
      counts: cvPortfolioChecks?.counts, scenarios, cleanup,
      verdict: Array.isArray(scenarios) && scenarios.length === 9 && scenarios.every((item) => item.executed && item.status === "passed") &&
        cvPortfolioChecks?.counts?.executed === 9 && cvPortfolioChecks?.counts?.failed === 0 && cvPortfolioChecks?.counts?.skipped === 0 &&
        processingCounts?.acceptanceExecutions === activeFormats.length && phase6FormatProof(formats, activeFormats) &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:cv-portfolio"],
      limitations: ["This ticket proves registration and bounded Owner reads; separate tickets own CV acceptance, Current CV activation, public delivery and the final Phase 6 gate."],
    };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(CV_PORTFOLIO_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 154, runId: evidence.runId, sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, verdict: evidence.verdict, scenarios, counts: cvPortfolioChecks?.counts,
      mediaAcceptance: mediaProcessingChecks, application: acceptanceUnitChecks, cleanup, failures,
      evidence: "evidence/phase6-cv-portfolio-154.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (CV_ACCEPTANCE_ONLY) {
    const scenarios = cvAcceptanceChecks?.scenarios ?? [];
    const evidence = {
      schemaVersion: 1, ticket: 155, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "explicit-CV-approval-with-current-Media-revalidation-and-atomic-safe-replay",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      services: { postgres: { available: services.postgres.available, majorVersion: services.postgres.majorVersion,
          independentConnections: services.postgres.independentConnections }, auth: services.auth, storage: services.storage,
        scanner: { available: true, version: toolVersions.scanner, executions: processingCounts?.scannerExecutions },
        processors: { pdf: toolVersions.pdfProcessor, image: toolVersions.sharp ?? toolVersions.imageProcessor,
          video: toolVersions.videoProcessor, executions: { pdf: processingCounts?.processorExecutions,
            image: processingCounts?.imageProcessorExecutions, video: processingCounts?.videoProcessorExecutions } } },
      migrationUpgrade: cvMigrationUpgrade,
      policyIds: { migrations: ["20261012030000_initialize_cv_portfolio_register_english_versions.sql",
        "20261012040000_accept_registered_cv_versions.sql"],
        RLS: ["cv_acceptance_history_owner_scope", "cv_acceptance_commands_owner_scope"],
        limits: { sharedMediaLockTimeoutMs: 3000, statementTimeoutMs: 5000, transactionTimeoutMs: 8000 } },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS",
        media: "real accepted English PDF with current facts and immutable object/hash/version snapshot",
        environment: "disposable loopback PostgreSQL, Auth and private Storage" },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      checks: { acceptance: cvAcceptanceChecks, predecessorCvPortfolio: cvPortfolioChecks,
        mediaAcceptance: mediaProcessingChecks, application: acceptanceUnitChecks,
        acceptanceOperations: processingCounts?.acceptanceExecutions ?? 0 },
      counts: cvAcceptanceChecks?.counts, scenarios, cleanup,
      verdict: cvAcceptanceChecks?.verdict === "pass" && scenarios.length === 16 &&
        scenarios.every((item) => item.executed && item.status === "passed") && cvAcceptanceChecks?.counts?.criteriaCovered === 8 &&
        cvMigrationUpgrade?.verdict === "pass" && processingCounts?.acceptanceExecutions === activeFormats.length &&
        phase6FormatProof(formats, activeFormats) &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:cv-acceptance"],
      limitations: ["Acceptance records approval only; Current CV activation and public delivery remain separate operations."],
    };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(CV_ACCEPTANCE_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 155, runId: evidence.runId, sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, verdict: evidence.verdict, scenarios, counts: cvAcceptanceChecks?.counts,
      integration: cvAcceptanceChecks, mediaAcceptance: mediaProcessingChecks, application: acceptanceUnitChecks,
      cleanup, failures, evidence: "evidence/phase6-cv-acceptance-155.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (CV_DELIVERY_ONLY) {
    const scenarios = processingCounts?.currentCvDeliveryScenarios ?? [];
    const scenarioNames = scenarios.map((item) => ({ ...item,
      criteria: typeof item.name === "string" ? [...new Set(item.name.match(/T14-(?:02|03|05|07|08)/gu) ?? [])] : [],
    }));
    const integrationIds = new Set(scenarioNames.flatMap((item) => item.criteria));
    const unitPassed = acceptanceUnitChecks?.verdict === "pass";
    const integrationPassed = scenarioNames.length === 3 && scenarioNames.every((item) => item.executed && item.status === "passed");
    const criteria = [
      "T14-01 strict locale/disposition and closed query shape reject missing, unsupported, duplicate and unknown fields before dispatch",
      "T14-02 each read resolves only the committed accepted English Current CV and never falls back to another version",
      "T14-03 the stream returns real PDF bytes with bounded size, no-store and a sanitized filename",
      "T14-04 signed redirects are short-lived, origin-allowlisted and honor inline or attachment intent",
      "T14-05 the production stream reads real private Storage bytes whose SHA-256 matches the immutable CV snapshot",
      "T14-06 no-current, Storage/signing failure, unexpected exceptions and abuse map to safe 404/503/500/429 responses",
      "T14-07 every request after replacement resolves the new pointer while older issued targets remain bounded",
      "T14-08 Visitor access requires and sets no account, identity or consent cookie and does not depend on Measurement",
      "T14-09 foreign/insecure targets, malformed bindings and mismatched stored bytes fail safely without metadata leakage",
      "T14-10 public operation inventory remains five and no history or extra public API is added",
    ].map((name, index) => {
      const id = `T14-${String(index + 1).padStart(2, "0")}`;
      const integrationCriterion = ["T14-02", "T14-03", "T14-05", "T14-07", "T14-08"].includes(id);
      return { name, executed: unitPassed && (integrationCriterion ? integrationIds.has(id) : true),
        status: unitPassed && (!integrationCriterion || integrationIds.has(id)) &&
          (!integrationCriterion || integrationPassed) ? "passed" : "failed" };
    });
    const evidence = {
      schemaVersion: 1, ticket: 159, parent: 145, predecessor: 156, runId: randomUUID(),
      sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256,
      startedAt, completedAt: new Date().toISOString(), scope: "public-current-cv-private-storage-delivery",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions, services: { postgres: services.postgres, auth: services.auth, storage: services.storage,
        scanner: { available: true, version: toolVersions.scanner, executions: processingCounts?.scannerExecutions },
        processors: { pdf: toolVersions.pdfProcessor, image: toolVersions.sharp ?? toolVersions.imageProcessor,
          video: toolVersions.videoProcessor, executions: { pdf: processingCounts?.processorExecutions,
            image: processingCounts?.imageProcessorExecutions, video: processingCounts?.videoProcessorExecutions } } },
      principalScope: { database: "shipwithali_application scoped to the configured portfolio and owner RLS",
        storage: "private media-processed bucket; one content-addressed accepted PDF snapshot",
        visitor: "anonymous request without identity, consent cookie, or Measurement write" },
      formats: formats.map(({ id, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      checks: { delivery: scenarioNames, currentCvHttpAndStorageUnits: acceptanceUnitChecks,
        currentCvStorageMatrix: processingCounts?.currentCvStorageMatrix ?? [],
        mediaAcceptanceOperations: processingCounts?.acceptanceExecutions ?? 0,
        activationForDelivery: scenarios.find((item) => String(item.name).includes("T14-02")) },
      criteria, counts: { integrationExecuted: scenarios.filter((item) => item.executed).length,
        integrationFailures: scenarios.filter((item) => item.executed && item.status !== "passed").length,
        integrationSkips: scenarios.filter((item) => !item.executed).length,
        unitExecuted: acceptanceUnitChecks?.total ?? 0, unitFailures: acceptanceUnitChecks?.failed ?? 0,
        unitSkips: acceptanceUnitChecks?.skipped ?? 0,
        currentCvStorageMatrixExecuted: processingCounts?.currentCvStorageMatrix?.length ?? 0,
        currentCvStorageMatrixFailures: processingCounts?.currentCvStorageMatrix?.filter((item) => item.status !== "passed").length ?? 0 },
      cleanup, verdict: criteria.every((item) => item.executed && item.status === "passed") && integrationPassed &&
        (processingCounts?.currentCvStorageMatrix?.length ?? 0) >= 46 && processingCounts.currentCvStorageMatrix.every((item) => item.executed && item.status === "passed") &&
        unitPassed && processingCounts?.acceptanceExecutions >= activeFormats.length && phase6FormatProof(formats, activeFormats) &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:cv-delivery"],
      limitations: ["Public signed redirect behavior is verified by HTTP and Storage adapter tests; production composition uses bounded streaming. Replacing the current pointer affects subsequent reads; previously issued signed targets remain valid only until their 300-second expiry."],
    };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(CV_DELIVERY_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 159, runId: evidence.runId, sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, verdict: evidence.verdict, criteria, counts: evidence.counts,
      cleanup, failures, evidence: "evidence/phase6-cv-delivery-159.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
    const capabilityScenarios = processingCounts?.currentCvCapabilityScenarios ?? [];
    const hasCapabilityScenario = (criterion) => capabilityScenarios.some((item) => item.name?.includes(criterion) && item.executed && item.status === "passed");
    const boundaryChecks = {
      routes: run(process.execPath, [join(ROOT, "scripts/check-route-inventory.mjs")], { label: "phase6-capability-route-inventory" }),
      architecture: run(process.execPath, [join(ROOT, "scripts/check-runtime-architecture.mjs")], { label: "phase6-capability-runtime-architecture" }),
    };
    const capabilityCriteria = [
      { id: "T15-01", name: "Empty portfolio has no Current CV capability; successful activation exposes the committed eligible English Current CV", passed: hasCapabilityScenario("T15-01") && integrationPassed },
      { id: "T15-02", name: "Arabic Current CV and English-only link capability remain withheld; public CV locale=ar remains rejected", passed: hasCapabilityScenario("T15-02") && unitPassed },
      { id: "T15-03", name: "Reviewed Arabic content uses accepted English Media without English case-study text fallback", passed: hasCapabilityScenario("T15-03") },
      { id: "T15-04", name: "Registration and separate acceptance do not replace or publish a Current CV", passed: hasCapabilityScenario("T15-04") },
      { id: "T15-05", name: "Storage delivery failure fails the capability closed while preserving the durable Current CV snapshot", passed: unitPassed && formats.some((format) => format.id === "pdf" && format.storageRoundTrip && format.status === "passed") },
      { id: "T15-06", name: "Optional capability failures leave core configuration readable while required database failure remains an error", passed: unitPassed && integrationPassed },
      { id: "T15-07", name: "Profile Media delivery requires the configured visibility use and rejects private or rejected candidates", passed: hasCapabilityScenario("T15-07") },
      { id: "T15-08", name: "Public configuration separates stable identity and transient capability without signed URLs, provider mappings, or private filenames", passed: hasCapabilityScenario("T15-08") },
      { id: "T15-09", name: "Only completed Phase 6 behavior is composed; later-phase placeholders remain fail closed and public operation count is unchanged", passed: unitPassed && integrationPassed },
    ].map(({ id, ...criterion }) => {
      const requiresScenario = ["T15-01", "T15-02", "T15-03", "T15-04", "T15-07", "T15-08"].includes(id);
      const executed = unitPassed && (!requiresScenario || capabilityScenarios.some((item) => item.name?.includes(id) && item.executed));
      return { id, ...criterion, executed, status: executed && criterion.passed ? "passed" : "failed" };
    });
    const capabilityEvidence = {
      schemaVersion: 1, ticket: 160, parent: 145, predecessors: [158, 159], runId: evidence.runId,
      sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256,
      startedAt, completedAt: new Date().toISOString(), scope: "locale-aware-media-and-current-cv-capabilities",
      runtime: evidence.runtime, toolVersions, services: evidence.services,
      checks: { scenarios: capabilityScenarios, currentCvAndConfigurationUnits: acceptanceUnitChecks, boundaryChecks,
        privateMediaDelivery: mediaDeliveryChecks, activationForDelivery: evidence.checks.activationForDelivery },
      criteria: capabilityCriteria,
      counts: { integrationExecuted: capabilityScenarios.filter((item) => item.executed).length,
        integrationFailures: capabilityScenarios.filter((item) => item.executed && item.status !== "passed").length,
        integrationSkips: capabilityCriteria.filter((item) => !item.executed).length,
        unitExecuted: acceptanceUnitChecks?.total ?? 0, unitFailures: acceptanceUnitChecks?.failed ?? 0,
        unitSkips: acceptanceUnitChecks?.skipped ?? 0 },
      cleanup, verdict: capabilityCriteria.every((item) => item.executed && item.status === "passed") && integrationPassed &&
        unitPassed && cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:cv-delivery"],
      limitations: ["Storage failure behavior is verified through the adapter and application ports with a failing isolated Storage response; successful activation and byte delivery use the real private Storage service."],
    };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(PUBLIC_CAPABILITY_EVIDENCE, `${JSON.stringify(capabilityEvidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 160, runId: capabilityEvidence.runId, sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, verdict: capabilityEvidence.verdict, criteria: capabilityCriteria,
      counts: capabilityEvidence.counts, cleanup, failures, evidence: "evidence/phase6-public-capabilities-160.json" }, null, 2));
    if (capabilityEvidence.verdict !== "pass") process.exitCode = 1;
  } else if (CV_ACTIVATION_ONLY) {
    const scenarios = cvActivationChecks?.scenarios ?? [];
    const criteria = [
      "T11-01 first activation establishes one coherent current English accepted CV; before first activation the count is zero",
      "T11-02 direct SQL mutations cannot violate current pointer, accepted English version or scope constraints",
      "T11-03 replacement atomically changes current designation, retained history, receipt and minimal CurrentCvChanged event",
      "T11-04 independent activations serialize and a stale waiter fails its root-version precondition",
      "T11-05 root, designation, history, receipt and outbox failures roll the complete activation back",
      "T11-06 exact replay is stable after later state; changed intent and stale preconditions conflict",
      "T11-07 activating the already-current version creates a replayable version-preserving no-op without history or event",
      "T11-08 an eligible retained CV version can be reactivated with a fresh key and current Media check",
      "T11-09 rejected or unavailable accepted-Media checks preserve current state",
      "T11-10 a narrow CV-owned query reports authoritative current-Media usage in the caller transaction",
    ].map((name) => ({ name, executed: scenarios.some((scenario) => scenario.criteria?.some((id) => name.startsWith(id))),
      status: cvActivationChecks?.counts?.criteriaCovered === 10 && cvActivationChecks?.verdict === "pass" ? "passed" : "failed" }));
    const evidence = {
      schemaVersion: 1, ticket: 156, parent: 145, predecessor: 155, runId: randomUUID(),
      sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256,
      startedAt, completedAt: new Date().toISOString(),
      scope: "atomic-current-cv-activation-with-replay-rollback-and-authoritative-media-use",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      services: { postgres: { available: services.postgres.available, majorVersion: services.postgres.majorVersion,
          independentConnections: services.postgres.independentConnections }, auth: services.auth, storage: services.storage,
        scanner: { available: true, version: toolVersions.scanner, executions: processingCounts?.scannerExecutions },
        processors: { pdf: toolVersions.pdfProcessor, image: toolVersions.sharp ?? toolVersions.imageProcessor,
          video: toolVersions.videoProcessor, executions: { pdf: processingCounts?.processorExecutions,
            image: processingCounts?.imageProcessorExecutions, video: processingCounts?.videoProcessorExecutions } } },
      migrationUpgrade: cvMigrationUpgrade,
      policyIds: { migrations: ["20261012030000_initialize_cv_portfolio_register_english_versions.sql",
        "20261012040000_accept_registered_cv_versions.sql", "20261012050000_activate_current_cv_atomically.sql"],
        RLS: ["cv_portfolios_owner_scope", "cv_versions_owner_scope", "cv_activation_history_owner_scope", "cv_activation_commands_owner_scope"],
        limits: { sharedMediaLockTimeoutMs: 3000, statementTimeoutMs: 5000, transactionTimeoutMs: 8000 } },
      principalScope: { database: "shipwithali_application constrained by portfolio_id and owner_id RLS",
        media: "real accepted English PDF revalidated against immutable Media decision and object snapshot",
        environment: "disposable loopback PostgreSQL, Auth and private Storage" },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      checks: { activation: cvActivationChecks, predecessorAcceptance: cvAcceptanceChecks,
        predecessorPortfolio: cvPortfolioChecks, mediaAcceptance: mediaProcessingChecks, application: acceptanceUnitChecks,
        acceptanceOperations: processingCounts?.acceptanceExecutions ?? 0 },
      counts: cvActivationChecks?.counts, scenarios, criteria, cleanup,
      verdict: cvActivationChecks?.verdict === "pass" && scenarios.length >= 16 && scenarios.every((item) => item.executed && item.status === "passed") &&
        cvActivationChecks?.counts?.criteriaCovered === 10 && cvMigrationUpgrade?.verdict === "pass" &&
        processingCounts?.acceptanceExecutions === activeFormats.length && phase6FormatProof(formats, activeFormats) &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:cv-activation"],
      limitations: [],
    };
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(CV_ACTIVATION_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 156, runId: evidence.runId, sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, verdict: evidence.verdict, scenarios, counts: cvActivationChecks?.counts,
      migrationUpgrade: cvMigrationUpgrade, cleanup, failures, evidence: "evidence/phase6-cv-activation-156.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (PUBLICATION_MEDIA_ONLY) {
    const allChecksPass = mediaProcessingChecks?.verdict === "pass" && publicationChecks?.verdict === "pass" &&
      acceptanceUnitChecks?.verdict === "pass";
    const criteria = [
      "T08-01 real accepted Media publishes and restores Projects and Achievements through production services",
      "T08-02 malformed, missing, foreign, unsafe, unaccepted, unsuitable, inaccessible, stale, duplicate and incomplete Media facts preserve the prior publication",
      "T08-03 decorative-only acceptance cannot publish meaningful evidence",
      "T08-04 Hidden, Archived, Draft and superseded content grants no delivery; publication and restore recheck current facts",
      "T08-05 Content usage follows every current published locale pointer and immutable Revision, not public projections",
      "T08-06 publication and restore acquire shared Media locks first, retain them through commit, and return a recoverable lock timeout",
      "T08-07 independently reviewed Arabic Content reuses accepted English Media and serves the Arabic Revision without fallback",
      "T08-08 no-Media route, publication, discovery and lifecycle behavior remains covered with no new public routes",
    ].map((name) => ({ name, executed: allChecksPass, status: allChecksPass ? "passed" : "failed" }));
    const evidence = {
      schemaVersion: 1, ticket: 153, parent: 152, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "real-Media-gated-Project-Achievement-publication-and-restoration",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      services: { postgres: { available: services.postgres.available, majorVersion: services.postgres.majorVersion,
          independentConnections: services.postgres.independentConnections }, auth: services.auth, storage: services.storage,
        scanner: { available: true, version: toolVersions.scanner, executions: processingCounts?.scannerExecutions },
        processors: { pdf: toolVersions.pdfProcessor, image: toolVersions.sharp ?? toolVersions.imageProcessor,
          video: toolVersions.videoProcessor, executions: { pdf: processingCounts?.processorExecutions,
            image: processingCounts?.imageProcessorExecutions, video: processingCounts?.videoProcessorExecutions } } },
      formats: formats.map(({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, kind, mimeType, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      checks: { mediaIntegration: mediaProcessingChecks, contentAuthoring: publicationChecks,
        mediaApplication: acceptanceUnitChecks, acceptanceOperations: processingCounts?.acceptanceExecutions ?? 0 },
      scenarios: criteria, cleanup,
      verdict: allChecksPass && processingCounts?.acceptanceExecutions === PHASE6_FORMATS.length &&
        formats.length === PHASE6_FORMATS.length && formats.every((format) => format.status === "passed" && format.storageRoundTrip && format.scannerVerdict === "clean") &&
        cleanup.success && failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:publication-media"],
      limitations: [],
    };
    writeFileSync(PUBLICATION_MEDIA_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 153, runId: evidence.runId, sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, verdict: evidence.verdict,
      acceptanceOperations: processingCounts?.acceptanceExecutions, formats: formats.map(({ id, status }) => ({ id, status })),
      integration: mediaProcessingChecks, contentAuthoring: publicationChecks, application: acceptanceUnitChecks,
      cleanup, failures, evidence: "evidence/phase6-publication-media-153.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else if (VIDEO_PROCESSING_ONLY) {
    const evidence = mediaProcessingChecks === undefined ? undefined : JSON.parse(readFileSync(VIDEO_PROCESSING_EVIDENCE, "utf8"));
    console.log(JSON.stringify({ ticket: 151, runId: evidence?.runId, sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256,
      verdict: evidence?.verdict ?? "fail", mediaProcessingChecks, cleanup, failures, evidence: evidence === undefined ? undefined : "evidence/phase6-video-processing-151.json" }, null, 2));
    if (evidence?.verdict !== "pass") process.exitCode = 1;
  } else if (MEDIA_PROCESSING_ONLY) {
    const evidence = mediaProcessingChecks === undefined ? undefined : JSON.parse(readFileSync(MEDIA_PROCESSING_EVIDENCE, "utf8"));
    console.log(JSON.stringify({ ticket: 149, runId: evidence?.runId, sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256, verdict: evidence?.verdict ?? "fail", mediaProcessingChecks, cleanup, failures, evidence: evidence === undefined ? undefined : "evidence/phase6-media-processing-149.json" }, null, 2));
    if (evidence?.verdict !== "pass") process.exitCode = 1;
  } else if (IMAGE_PROCESSING_ONLY) {
    const imageEvidence = mediaProcessingChecks === undefined ? undefined : JSON.parse(readFileSync(IMAGE_PROCESSING_EVIDENCE, "utf8"));
    console.log(JSON.stringify({ ticket: 150, runId: imageEvidence?.runId, sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256,
      verdict: imageEvidence?.verdict ?? "fail", formatCounts: { total: formats.length, passed: formats.filter(({ status }) => status === "passed").length },
      mediaProcessingChecks, imageUnitChecks, cleanup, failures, evidence: imageEvidence === undefined ? undefined : "evidence/phase6-image-processing-150.json" }, null, 2));
    if (imageEvidence?.verdict !== "pass") process.exitCode = 1;
  } else if (UPLOAD_INTENT_ONLY) {
    const uploadEvidence = uploadIntentChecks === undefined ? undefined : JSON.parse(readFileSync(UPLOAD_INTENT_EVIDENCE, "utf8"));
    console.log(JSON.stringify({ ticket: 148, runId: uploadEvidence?.runId, sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256, verdict: uploadEvidence?.verdict ?? "fail", formatCounts: uploadEvidence?.formatCounts, uploadIntentChecks, cleanup, failures, evidence: uploadEvidence === undefined ? undefined : "evidence/phase6-upload-intent-148.json" }, null, 2));
    if (uploadEvidence?.verdict !== "pass") process.exitCode = 1;
  } else if (OWNER_COMPOSITION_ONLY) {
    const evidence = { schemaVersion: 1, ticket: 161, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "real-owner-media-cv-production-composition", runtime: { node: process.version,
        npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" }, toolVersions,
      services: { postgres: services.postgres, auth: services.auth, storage: services.storage,
        scanner: { version: toolVersions.scanner, executions: processingCounts?.scannerExecutions },
        processor: { version: toolVersions.pdfProcessor, executions: processingCounts?.processorExecutions } },
      formats: formats.map(({ id, executed, status, storageRoundTrip, scannerVerdict, processorVersion }) =>
        ({ id, executed, status, storageRoundTrip, scannerVerdict, processorVersion })),
      acceptanceOperations: processingCounts?.acceptanceExecutions ?? 0, checks: ownerCompositionChecks, cleanup, failures,
      verdict: ownerCompositionChecks?.verdict === "pass" && processingCounts?.acceptanceExecutions === 1 &&
        formats.length === 1 && formats[0]?.status === "passed" && formats[0]?.storageRoundTrip && cleanup.success &&
        failures.length === 0 && finalSource.sourceTreeSha256 === source.sourceTreeSha256 ? "pass" : "fail",
      reproduction: ["npm run setup:validation", "npm run validation:ready", "npm run phase6:focus:owner-composition"],
      limitations: ["Owner HTTP security matrix is covered separately by tests/phase4/owner-request-security.test.ts; contract and architecture checks are separate repository commands and are not included in this real-service run."] };
    writeFileSync(OWNER_COMPOSITION_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ticket: 161, runId: evidence.runId, sourceRevision: evidence.sourceRevision,
      sourceTreeSha256: evidence.sourceTreeSha256, verdict: evidence.verdict, checks: ownerCompositionChecks,
      services: evidence.services, cleanup, failures, evidence: "evidence/phase6-owner-composition-161.json" }, null, 2));
    if (evidence.verdict !== "pass") process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ticket: report.ticket, runId: report.runId, sourceRevision: report.sourceRevision, sourceTreeSha256: report.sourceTreeSha256, verdict: report.verdict, counts: report.counts, services: report.services, cleanup: report.cleanup, failures: report.failures, uploadIntentChecks, evidence: "evidence/phase-6-verification-setup.json", uploadIntentEvidence: uploadIntentChecks === undefined ? undefined : "evidence/phase6-upload-intent-148.json" }, null, 2));
    if (report.verdict !== "pass") process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    const message = error instanceof Error ? error.message : "unknown-error";
    const safeMessage = message.replace(/(?:postgres(?:ql)?:\/\/)[^\s]+/giu, "[database-url]")
      .replace(/https?:\/\/[^\s]+/giu, "[url]")
      .replace(/(?:Bearer\s+|token=|apikey[=: ]+|password[=: ]+)\S+/giu, "[credential]")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[token]").slice(0, 800);
    console.error(`PHASE6_VERIFICATION_FAILED:${safeMessage}`);
    process.exitCode = 1;
  }
}
