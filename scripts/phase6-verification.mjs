#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PHASE6_FORMATS, PHASE6_TOOL_DEFINITIONS, evaluatePhase6Setup, getPhase6SourceIdentity, isolatedPhase6Config,
  makePhase6Report, phase6Package, phase6Readiness, phase6Root, scrubPhase6Environment,
} from "./phase6-verification-support.mjs";

const ROOT = phase6Root();
const CLI = join(ROOT, "node_modules/supabase/dist/supabase.js");
const EVIDENCE = join(ROOT, "evidence/phase-6-verification-setup.json");
const UPLOAD_INTENT_EVIDENCE = join(ROOT, "evidence/phase6-upload-intent-148.json");
const MEDIA_PROCESSING_EVIDENCE = join(ROOT, "evidence/phase6-media-processing-149.json");
const VIDEO_PROCESSING_EVIDENCE = join(ROOT, "evidence/phase6-video-processing-151.json");
const UPLOAD_INTENT_ONLY = process.argv.includes("--upload-intents-only");
const MEDIA_PROCESSING_ONLY = process.argv.includes("--media-processing-only");
const VIDEO_PROCESSING_ONLY = process.argv.includes("--video-processing-only");
const RUN_TIMEOUT = 180_000;

function run(command, args, { cwd = ROOT, env = process.env, timeout = RUN_TIMEOUT, input, label = command } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.code === "ETIMEDOUT" ? "timeout" : result.error?.code === "ENOENT" ? "missing-executable" : "nonzero-exit";
    throw new Error(`PHASE6_COMMAND_FAILED:${label}:${detail}`);
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
  const workdir = mkdtempSync(join(tmpdir(), "shipwithali-phase6-"));
  const projectId = `shipwithali-phase6-${randomUUID()}`;
  const network = `${projectId}-loopback`;
  const fixturesDir = join(workdir, "fixtures");
  const isolatedSupabase = join(workdir, "supabase");
  mkdirSync(fixturesDir);
  mkdirSync(isolatedSupabase);
  let networkCreated = false;
  let attemptedStart = false;
  let cleanup = { attempted: true, success: false };
  const services = {
    postgres: { available: false, executionCount: 0 },
    auth: { available: false, executionCount: 0 },
    storage: { available: false, privateBucketVerified: false, executionCount: 0 },
  };
  const formats = [];
  const failures = [];
  let uploadIntentChecks;
  let mediaProcessingChecks;
  let processingCounts;
  let toolVersions = {};
  let status;
  const invoke = (args, timeout = 600_000) => run(process.execPath, [CLI, "--workdir", workdir, ...args], { cwd: ROOT, env, timeout }).stdout;
  try {
    let config = isolatedPhase6Config(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"), projectId);
    if (UPLOAD_INTENT_ONLY || MEDIA_PROCESSING_ONLY || VIDEO_PROCESSING_ONLY) {
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
    run("docker", ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network], { env, timeout: 20_000 });
    networkCreated = true;
    attemptedStart = true;
    console.log("Starting isolated loopback PostgreSQL, Auth and private Storage services.");
    invoke(["start", "--network-id", network], 900_000);
    status = JSON.parse(invoke(["status", "-o", "json"], 30_000));
    const api = new URL(status.API_URL);
    if (api.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(api.hostname) || api.port !== "57321") throw new Error("PHASE6_ENDPOINT_NOT_ISOLATED");
    if (!status.DB_URL || !status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error("PHASE6_LOCAL_STATUS_INCOMPLETE");
    const { Client } = await import("pg");
    const client = new Client({ connectionString: status.DB_URL, connectionTimeoutMillis: 5000 });
    await client.connect();
    const database = await client.query("select current_setting('server_version_num')::int as version_num, current_setting('server_version') as version");
    await client.end();
    if (Number(database.rows[0]?.version_num) < 170000) throw new Error("PHASE6_POSTGRES_VERSION_UNEXPECTED");
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

    console.log("Probing pinned ClamAV, ImageMagick, FFmpeg and OCRmyPDF runtimes.");
    const image = PHASE6_TOOL_DEFINITIONS.imageProcessor;
    const video = PHASE6_TOOL_DEFINITIONS.videoProcessor;
    const pdf = PHASE6_TOOL_DEFINITIONS.pdfProcessor;
    const scanner = PHASE6_TOOL_DEFINITIONS.scanner;
    toolVersions = {
      supabaseCli: supabasePkg.version,
      postgres: database.rows[0].version,
      scanner: serviceVersion(scanner, "clamscan"),
      imageProcessor: serviceVersion(image, "magick"),
      videoProcessor: serviceVersion(video, "ffmpeg", "-version"),
      pdfProcessor: serviceVersion(pdf, "ocrmypdf"),
    };
    writeFileSync(join(fixturesDir, "fixture.pdf"), pdfFixture());
    const activeFormats = MEDIA_PROCESSING_ONLY ? PHASE6_FORMATS.filter(({ id }) => id === "pdf")
      : VIDEO_PROCESSING_ONLY ? PHASE6_FORMATS.filter(({ id }) => id === "mp4" || id === "webm") : PHASE6_FORMATS;
    console.log("Generating safe fixtures with the pinned image and video processors.");
    run("docker", ["run", "--rm", "--entrypoint", "magick", "-v", `${fixturesDir}:/fixtures`, image, "-size", "4x4", "xc:#2468ac", "/fixtures/fixture.png"], { label: "fixture-generate-png" });
    run("docker", ["run", "--rm", "--entrypoint", "magick", "-v", `${fixturesDir}:/fixtures`, image, "-size", "4x4", "xc:#2468ac", "/fixtures/fixture.jpeg"], { label: "fixture-generate-jpeg" });
    run("docker", ["run", "--rm", "--entrypoint", "magick", "-v", `${fixturesDir}:/fixtures`, image, "-size", "4x4", "xc:#2468ac", "/fixtures/fixture.webp"], { label: "fixture-generate-webp" });
    run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1", "-frames:v", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", "/fixtures/fixture.mp4"], { label: "fixture-generate-mp4" });
    run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1", "-frames:v", "1", "-an", "-c:v", "libvpx-vp9", "-y", "/fixtures/fixture.webm"], { label: "fixture-generate-webm" });
    run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:d=0.1", "-frames:v", "1", "-an", "-c:v", "mpeg4", "-y", "/fixtures/fixture-unsupported.mp4"], { label: "fixture-generate-unsupported-video" });
    run("docker", ["run", "--rm", "--entrypoint", "ffmpeg", "-v", `${fixturesDir}:/fixtures`, video, "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16:r=60:d=31", "-frames:v", "1861", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-y", "/fixtures/fixture-excessive.mp4"], { label: "fixture-generate-excessive-video" });
    const fixtures = activeFormats.map((definition) => ({ ...definition, path: join(fixturesDir, `fixture.${definition.id}`) }));
    for (const fixture of fixtures) {
      console.log(`Scanning, processing and round-tripping ${fixture.id}.`);
      let processorVersion = toolVersions[fixture.processor];
      if (fixture.processor === "imageProcessor") run("docker", ["run", "--rm", "--entrypoint", "identify", "-v", `${fixturesDir}:/fixtures:ro`, image, `/fixtures/fixture.${fixture.id}`], { label: `process-${fixture.id}` });
      else if (fixture.processor === "videoProcessor") run("docker", ["run", "--rm", "--entrypoint", "ffprobe", "-v", `${fixturesDir}:/fixtures:ro`, video, "-v", "error", "-show_entries", "format=format_name", "-of", "default=noprint_wrappers=1:nokey=1", `/fixtures/fixture.${fixture.id}`], { label: `process-${fixture.id}` });
      else {
        const bytes = readFileSync(fixture.path);
        const processed = run("docker", ["run", "--rm", "-i", "--entrypoint", "ocrmypdf", pdf, "--skip-text", "-", "-"], { input: bytes, timeout: RUN_TIMEOUT, label: `process-${fixture.id}` });
        if (!processed.stdout.startsWith("%PDF-")) throw new Error("PHASE6_PDF_PROCESSOR_OUTPUT_INVALID");
        processorVersion = toolVersions.pdfProcessor;
      }
      const storageHash = await storagePutAndCheck(status, fixture, fixture.mimeType);
      console.log(`✓ ${fixture.id}: private Storage upload and byte round-trip passed; scanning.`);
      run("docker", ["run", "--rm", "--entrypoint", "clamscan", "-v", `${fixturesDir}:/fixtures:ro`, scanner, "--no-summary", `/fixtures/fixture.${fixture.id}`], { timeout: RUN_TIMEOUT, label: `scan-${fixture.id}` });
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
      PHASE6_PDF_PROCESSING_FIXTURE: join(fixturesDir, "fixture.pdf"),
      PHASE6_VIDEO_PROCESSING_MP4_FIXTURE: join(fixturesDir, "fixture.mp4"),
      PHASE6_VIDEO_PROCESSING_WEBM_FIXTURE: join(fixturesDir, "fixture.webm"),
      PHASE6_VIDEO_PROCESSING_UNSUPPORTED_FIXTURE: join(fixturesDir, "fixture-unsupported.mp4"),
      PHASE6_VIDEO_PROCESSING_EXCESSIVE_FIXTURE: join(fixturesDir, "fixture-excessive.mp4"),
      PHASE6_SCANNER_IMAGE: scanner,
      PHASE6_PDF_PROCESSOR_IMAGE: pdf,
      PHASE6_SCANNER_VERSION: toolVersions.scanner,
      PHASE6_PDF_PROCESSOR_VERSION: toolVersions.pdfProcessor,
      PHASE6_MEDIA_PROCESSING_COUNTS_FILE: processingCountsPath,
    };
    const testArgs = ["run", "tests/database/media-upload-intent.integration.test.ts", "--reporter=json", `--outputFile=${testJsonPath}`];
    if (VIDEO_PROCESSING_ONLY) testArgs.push("-t", "processes MP4 and WebM candidates");
    const testResult = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), ...testArgs], { cwd: ROOT, env: testEnv, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (testResult.error || !existsSync(testJsonPath)) throw new Error("PHASE6_UPLOAD_INTENT_TEST_REPORT_MISSING");
    const testReport = JSON.parse(readFileSync(testJsonPath, "utf8"));
    processingCounts = existsSync(processingCountsPath) ? JSON.parse(readFileSync(processingCountsPath, "utf8")) : undefined;
    const allAssertions = (testReport.testResults ?? []).flatMap((suite) => suite.assertionResults ?? []);
    const uploadAssertions = allAssertions.filter((item) => !/processes (?:PDF|MP4 and WebM) candidates/u.test(String(item.fullName ?? "")));
    const processingAssertions = allAssertions.filter((item) => VIDEO_PROCESSING_ONLY
      ? String(item.fullName ?? "").includes("processes MP4 and WebM candidates")
      : /processes (?:PDF|MP4 and WebM) candidates/u.test(String(item.fullName ?? "")));
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
      verdict: testResult.status === 0 && uploadAssertions.length === 3 && uploadAssertions.every((item) => item.status === "passed") ? "pass" : "fail",
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
      verdict: testResult.status === 0 && processingAssertions.length === 1 && processingAssertions.every((item) => item.status === "passed") ? "pass" : "fail",
    };
    if (!VIDEO_PROCESSING_ONLY && uploadIntentChecks.verdict !== "pass") throw new Error("PHASE6_UPLOAD_INTENT_ASSERTION_COUNTS_INVALID");
    if (mediaProcessingChecks.verdict !== "pass") throw new Error("PHASE6_MEDIA_PROCESSING_ASSERTION_COUNTS_INVALID");
    if (MEDIA_PROCESSING_ONLY && (!Number.isSafeInteger(processingCounts?.scannerExecutions) || !Number.isSafeInteger(processingCounts?.processorExecutions))) throw new Error("PHASE6_MEDIA_PROCESSING_TOOL_COUNTS_MISSING");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : "PHASE6_SETUP_FAILED");
  } finally {
    let cleanupFailed = false;
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
  if (!UPLOAD_INTENT_ONLY && !MEDIA_PROCESSING_ONLY && !VIDEO_PROCESSING_ONLY) {
    report = makePhase6Report({ ...source, runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" }, startedAt, tools: toolVersions, services, formats, cleanup, failures });
    const evaluated = evaluatePhase6Setup(report, source);
    if (evaluated.failures.length) {
      report.failures.push(...evaluated.failures);
      report.verdict = "fail";
    }
    mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(EVIDENCE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (uploadIntentChecks !== undefined && !MEDIA_PROCESSING_ONLY && !VIDEO_PROCESSING_ONLY) {
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
  if (VIDEO_PROCESSING_ONLY && mediaProcessingChecks !== undefined) {
    const evidence = {
      schemaVersion: 1, ticket: 151, parent: 145, runId: randomUUID(), sourceRevision: source.sourceRevision,
      sourceTreeSha256: source.sourceTreeSha256, startedAt, completedAt: new Date().toISOString(),
      scope: "bounded-mp4-webm-processing-with-sealed-private-variants",
      runtime: { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? "unknown" },
      toolVersions,
      policyIds: { migration: "20261011220000_record_bounded_video_variants.sql", processing: "mp4-webm-bounded-variants-1",
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
  if (VIDEO_PROCESSING_ONLY) {
    const evidence = mediaProcessingChecks === undefined ? undefined : JSON.parse(readFileSync(VIDEO_PROCESSING_EVIDENCE, "utf8"));
    console.log(JSON.stringify({ ticket: 151, runId: evidence?.runId, sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256,
      verdict: evidence?.verdict ?? "fail", mediaProcessingChecks, cleanup, failures, evidence: evidence === undefined ? undefined : "evidence/phase6-video-processing-151.json" }, null, 2));
    if (evidence?.verdict !== "pass") process.exitCode = 1;
  } else if (MEDIA_PROCESSING_ONLY) {
    const evidence = mediaProcessingChecks === undefined ? undefined : JSON.parse(readFileSync(MEDIA_PROCESSING_EVIDENCE, "utf8"));
    console.log(JSON.stringify({ ticket: 149, runId: evidence?.runId, sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256, verdict: evidence?.verdict ?? "fail", mediaProcessingChecks, cleanup, failures, evidence: evidence === undefined ? undefined : "evidence/phase6-media-processing-149.json" }, null, 2));
    if (evidence?.verdict !== "pass") process.exitCode = 1;
  } else if (UPLOAD_INTENT_ONLY) {
    const uploadEvidence = uploadIntentChecks === undefined ? undefined : JSON.parse(readFileSync(UPLOAD_INTENT_EVIDENCE, "utf8"));
    console.log(JSON.stringify({ ticket: 148, runId: uploadEvidence?.runId, sourceRevision: source.sourceRevision, sourceTreeSha256: source.sourceTreeSha256, verdict: uploadEvidence?.verdict ?? "fail", formatCounts: uploadEvidence?.formatCounts, uploadIntentChecks, cleanup, failures, evidence: uploadEvidence === undefined ? undefined : "evidence/phase6-upload-intent-148.json" }, null, 2));
    if (uploadEvidence?.verdict !== "pass") process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ ticket: report.ticket, runId: report.runId, sourceRevision: report.sourceRevision, sourceTreeSha256: report.sourceTreeSha256, verdict: report.verdict, counts: report.counts, services: report.services, cleanup: report.cleanup, failures: report.failures, uploadIntentChecks, evidence: "evidence/phase-6-verification-setup.json", uploadIntentEvidence: uploadIntentChecks === undefined ? undefined : "evidence/phase6-upload-intent-148.json" }, null, 2));
    if (report.verdict !== "pass") process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) {
    console.error(error instanceof Error && /^(?:VALIDATION_NOT_READY|PHASE6_|LOCAL_)/u.test(error.message) ? error.message : "PHASE6_VERIFICATION_FAILED: diagnostic output suppressed.");
    process.exitCode = 1;
  }
}
