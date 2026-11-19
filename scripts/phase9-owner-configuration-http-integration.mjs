#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { initializeLocalMigrationProject } from "./local-migration-bootstrap.mjs";
import { isolatedConfig, localEnvironment, requireDocker } from "./local-auth-integration.mjs";
import { PHASE6_TOOL_DEFINITIONS } from "./phase6-verification-support.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { safeAssertionDiagnostic } from "./validation-errors.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "node_modules/supabase/dist/supabase.js");
const NEXT = join(ROOT, "node_modules/next/dist/bin/next");
const ticket = process.argv.includes("--ticket-305") ? 305 : process.argv.includes("--ticket-304") ? 304 : process.argv.includes("--ticket-303") ? 303 : process.argv.includes("--ticket-302") ? 302 : process.argv.includes("--ticket-299") ? 299 : process.argv.includes("--ticket-298") ? 298 : process.argv.includes("--ticket-295") ? 295 : 294;
const contentAuthoringTicket = ticket === 295 || ticket === 298 || ticket === 299;
const REPORT = join(ROOT, ticket === 305
  ? "evidence/phase9-feedback-http-305.json"
  : ticket === 304
  ? "evidence/phase9-rating-http-304.json"
  : ticket === 303
  ? "evidence/phase9-reaction-http-303.json"
  : ticket === 302
  ? "evidence/phase9-cv-http-302.json"
  : ticket === 299 ? "evidence/phase9-taxonomy-http-299.json"
    : ticket === 298 ? "evidence/phase9-project-status-http-298.json"
      : ticket === 295 ? "evidence/phase9-content-authoring-http-295.json" : "evidence/phase9-owner-configuration-http-294.json");

function configureIsolatedMediaStorage(config) {
  const storageHeader = config.indexOf("[storage]");
  if (storageHeader < 0) throw new Error("PHASE9_OWNER_HTTP_STORAGE_CONFIG_MISSING");
  const sectionEnd = config.indexOf("\n[", storageHeader + "[storage]".length);
  const end = sectionEnd < 0 ? config.length : sectionEnd;
  const section = config.slice(storageHeader, end);
  if (!/^\[storage\]\r?\nenabled = false\s*$/mu.test(section)) {
    throw new Error("PHASE9_OWNER_HTTP_STORAGE_CONFIG_UNEXPECTED");
  }
  const enabled = section.replace(/^\[storage\]\r?\nenabled = false/mu, "[storage]\nenabled = true");
  const configured = `${config.slice(0, storageHeader)}${enabled}${config.slice(end)}`;
  return `${configured.trimEnd()}\n\n[storage.buckets.media-candidates]\npublic = false\nfile_size_limit = "50MiB"\nallowed_mime_types = ["application/pdf", "image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]\n\n[storage.buckets.media-processed]\npublic = false\nfile_size_limit = "50MiB"\nallowed_mime_types = ["application/pdf", "image/png", "image/jpeg", "image/webp", "video/mp4", "video/webm"]\n`;
}

async function availablePorts(count) {
  const servers = [];
  try {
    while (servers.length < count) {
      const server = createServer();
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); }
}

function quoteRole(value) {
  if (!/^phase9_owner_http_[a-z0-9_]+$/u.test(value)) throw new Error("PHASE9_OWNER_HTTP_ROLE_INVALID");
  return `"${value}"`;
}

async function waitForServer(child, port) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("PHASE9_OWNER_HTTP_SERVER_EXITED");
    const connected = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("PHASE9_OWNER_HTTP_SERVER_TIMEOUT");
}

function stopServer(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 10_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

function runSupabase(workdir, env, args, timeout = 600_000) {
  const result = spawnSync(process.execPath, [CLI, "--workdir", workdir, ...args], {
    cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout,
  });
  if (result.error || result.status !== 0) throw new Error(`PHASE9_OWNER_HTTP_SUPABASE_FAILED:${args[0]}`);
  return result.stdout;
}

async function main() {
  requireDocker();
  let reactionPrerequisiteEvidence;
  if (ticket === 303) {
    try {
      reactionPrerequisiteEvidence = JSON.parse(readFileSync(join(ROOT, "evidence/phase7-reactions-190.json"), "utf8"));
    } catch { throw new Error("PHASE9_REACTION_PHASE7_EVIDENCE_MISSING"); }
    if (reactionPrerequisiteEvidence.cleanup !== true || reactionPrerequisiteEvidence.required?.success !== true ||
        reactionPrerequisiteEvidence.required?.passed !== 17 || reactionPrerequisiteEvidence.required?.failed !== 0 ||
        reactionPrerequisiteEvidence.required?.skipped !== 0 ||
        reactionPrerequisiteEvidence.sourceTreeSha256 !== workingTreeSourceSha256()) {
      throw new Error("PHASE9_REACTION_PHASE7_EVIDENCE_STALE_OR_INCOMPLETE");
    }
  }
  let ratingPrerequisiteEvidence;
  if (ticket === 304) {
    try {
      ratingPrerequisiteEvidence = JSON.parse(readFileSync(join(ROOT, "evidence/phase7-ratings-191.json"), "utf8"));
    } catch { throw new Error("PHASE9_RATING_PHASE7_EVIDENCE_MISSING"); }
    if (ratingPrerequisiteEvidence.cleanup !== true || ratingPrerequisiteEvidence.required?.success !== true ||
        ratingPrerequisiteEvidence.required?.passed !== 34 || ratingPrerequisiteEvidence.required?.failed !== 0 ||
        ratingPrerequisiteEvidence.required?.skipped !== 0 ||
        ratingPrerequisiteEvidence.sourceTreeSha256 !== workingTreeSourceSha256()) {
      throw new Error("PHASE9_RATING_PHASE7_EVIDENCE_STALE_OR_INCOMPLETE");
    }
  }
  let feedbackPrerequisiteEvidence;
  if (ticket === 305) {
    try {
      feedbackPrerequisiteEvidence = JSON.parse(readFileSync(join(ROOT, "evidence/phase7-feedback-192.json"), "utf8"));
    } catch { throw new Error("PHASE9_FEEDBACK_PHASE7_EVIDENCE_MISSING"); }
    if (feedbackPrerequisiteEvidence.cleanup !== true || feedbackPrerequisiteEvidence.required?.success !== true ||
        feedbackPrerequisiteEvidence.required?.passed !== 57 || feedbackPrerequisiteEvidence.required?.failed !== 0 ||
        feedbackPrerequisiteEvidence.required?.skipped !== 0 || feedbackPrerequisiteEvidence.required?.failedSuites !== 0 ||
        feedbackPrerequisiteEvidence.sourceTreeSha256 !== workingTreeSourceSha256()) {
      throw new Error("PHASE9_FEEDBACK_PHASE7_EVIDENCE_STALE_OR_INCOMPLETE");
    }
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const installed = JSON.parse(readFileSync(join(ROOT, "node_modules/supabase/package.json"), "utf8"));
  if (installed.version !== pkg.devDependencies.supabase) throw new Error("PHASE9_OWNER_HTTP_CLI_PIN_MISMATCH");
  if (ticket === 302) {
    for (const image of [PHASE6_TOOL_DEFINITIONS.scanner, PHASE6_TOOL_DEFINITIONS.pdfProcessor]) {
      const pulled = spawnSync("docker", ["pull", image], {
        env: localEnvironment(), encoding: "utf8", stdio: "ignore", timeout: 240_000,
      });
      if (pulled.error || pulled.status !== 0) throw new Error("PHASE9_OWNER_HTTP_MEDIA_TOOLS_UNAVAILABLE");
    }
  }
  const [apiPort, dbPort, shadowPort, ...appPorts] = await availablePorts(6);
  const workdir = mkdtempSync(join(tmpdir(), "shipwithali-owner-http-"));
  const projectId = `shipwithali-auth-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const env = localEnvironment();
  const network = `${projectId}-loopback`;
  const project = { projectId, workdir, network };
  const servers = [];
  let admin;
  let postgresVersion = "unavailable";
  let role;
  let networkCreated = false;
  let attemptedStart = false;
  let cleanupFailed = false;
  let failure;
  let stage = "setup";
  let executedTests = [];
  let passedTestCount = 0;
  const logs = [];
  try {
    const supabaseDir = join(workdir, "supabase");
    mkdirSync(supabaseDir);
    const isolatedSupabaseConfig = isolatedConfig(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"), projectId,
      { api: apiPort, db: dbPort, shadow: shadowPort });
    writeFileSync(join(supabaseDir, "config.toml"), ticket === 302
      ? configureIsolatedMediaStorage(isolatedSupabaseConfig)
      : isolatedSupabaseConfig);
    cpSync(join(ROOT, "supabase/migrations"), join(supabaseDir, "migrations"), { recursive: true });
    copyFileSync(join(ROOT, "supabase/seed.sql"), join(supabaseDir, "seed.sql"));
    const created = spawnSync("docker", ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network], {
      env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (created.error || created.status !== 0) throw new Error("PHASE9_OWNER_HTTP_NETWORK_FAILED");
    networkCreated = true;
    attemptedStart = true;
    console.log("Starting an isolated loopback Supabase Auth and PostgreSQL project for #294.");
    stage = "migrations";
    initializeLocalMigrationProject(project, {
      initialize: (_network, dockerEnv) => runSupabase(workdir, { ...env, ...dockerEnv }, ["start", "--network-id", network]),
      migrate: () => runSupabase(workdir, env, ["migration", "up", "--local"]),
    });
    stage = "status";
    const status = JSON.parse(runSupabase(workdir, env, ["status", "-o", "json"], 30_000));
    const api = new URL(status.API_URL);
    const db = new URL(status.DB_URL);
    if (api.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(api.hostname) || api.port !== String(apiPort) ||
        !["127.0.0.1", "localhost"].includes(db.hostname) || db.port !== String(dbPort)) {
      throw new Error("PHASE9_OWNER_HTTP_ENDPOINT_NOT_ISOLATED");
    }
    if (typeof status.ANON_KEY !== "string" || typeof status.SERVICE_ROLE_KEY !== "string") throw new Error("PHASE9_OWNER_HTTP_STATUS_KEYS_MISSING");

    stage = "database";
    admin = new Client({ connectionString: status.DB_URL });
    await admin.connect();
    role = `phase9_owner_http_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const password = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    await admin.query(`create role ${quoteRole(role)} login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query(`grant shipwithali_application to ${quoteRole(role)}`);
    const restricted = new URL(status.DB_URL);
    restricted.username = role;
    restricted.password = password;
    const portfolioId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1";
    const ownerId = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2";
    const appBase = `http://127.0.0.1:${appPorts[0]}`;
    const serverEnv = {
      ...env, NODE_ENV: "production", NODE_OPTIONS: "", NEXT_TELEMETRY_DISABLED: "1",
      APP_BASE_URL: appBase, DATABASE_URL: restricted.toString(), PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId,
      SUPABASE_URL: status.API_URL, SUPABASE_ANON_KEY: status.ANON_KEY,
      ...(ticket === 302 ? {
        PHASE9_REQUIRE_OWNER_HTTP: "1",
        // This credential belongs only to the disposable local Supabase project.
        SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
        MEDIA_UPLOAD_REPLAY_ENCRYPTION_KEY: Buffer.from(
          `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`, "hex",
        ).toString("base64"),
      } : {}),
      ...(ticket === 303 ? {
        FUNCTIONAL_ID_HASH_KEY: randomBytes(32).toString("base64url"),
        FUNCTIONAL_ID_HASH_KEY_VERSION: "1",
      } : {}),
      ...(ticket === 304 ? {
        FUNCTIONAL_ID_HASH_KEY: randomBytes(32).toString("base64url"),
        FUNCTIONAL_ID_HASH_KEY_VERSION: "1",
      } : {}),
      SUPABASE_JWT_ISSUER: `${status.API_URL}/auth/v1`, SUPABASE_JWT_AUDIENCE: "authenticated",
      OWNER_GITHUB_SUBJECTS: "910294,910296,910298", HOSTNAME: "127.0.0.1",
    };
    stage = "server";
    for (const port of appPorts) {
      if (port === appPorts[2]) break;
      const server = spawn(process.execPath, [NEXT, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
        cwd: ROOT, env: serverEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      server.stdout.on("data", (chunk) => logs.push(String(chunk)));
      server.stderr.on("data", (chunk) => logs.push(String(chunk)));
      servers.push(server);
      await waitForServer(server, port);
    }
    const unavailableEnv = { ...serverEnv };
    delete unavailableEnv.OWNER_GITHUB_SUBJECTS;
    const unavailableServer = spawn(process.execPath, [NEXT, "start", "--hostname", "127.0.0.1", "--port", String(appPorts[2])], {
      cwd: ROOT, env: unavailableEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    unavailableServer.stdout.on("data", (chunk) => logs.push(String(chunk)));
    unavailableServer.stderr.on("data", (chunk) => logs.push(String(chunk)));
    servers.push(unavailableServer);
    await waitForServer(unavailableServer, appPorts[2]);
    const reportPath = join(workdir, "vitest-report.json");
    const testEnv = {
      ...env, PHASE9_REQUIRE_OWNER_HTTP: "1", PHASE9_OWNER_HTTP_ADMIN_DATABASE_URL: status.DB_URL,
      PHASE9_OWNER_HTTP_DATABASE_URL: restricted.toString(), PHASE9_OWNER_HTTP_SUPABASE_URL: status.API_URL,
      PHASE9_OWNER_HTTP_ANON_KEY: status.ANON_KEY, PHASE9_OWNER_HTTP_SERVICE_KEY: status.SERVICE_ROLE_KEY,
      PHASE9_OWNER_HTTP_URLS: JSON.stringify(appPorts.slice(0, 2).map((port) => `http://127.0.0.1:${port}`)),
      PHASE9_OWNER_HTTP_UNREADY_URL: `http://127.0.0.1:${appPorts[2]}`,
      OWNER_ID: ownerId, PORTFOLIO_ID: portfolioId,
      ...(ticket === 302 ? { PHASE9_CV_HTTP_ACCEPTANCE: "1" } : {}),
      ...(ticket === 303 ? {
        PHASE9_REACTION_HTTP_ADMIN_DATABASE_URL: status.DB_URL,
        PHASE9_REACTION_HTTP_URLS: JSON.stringify(appPorts.slice(0, 2).map((port) => `http://127.0.0.1:${port}`)),
      } : {}),
      ...(ticket === 304 ? {
        PHASE9_RATING_HTTP_ADMIN_DATABASE_URL: status.DB_URL,
        PHASE9_RATING_HTTP_URLS: JSON.stringify(appPorts.slice(0, 2).map((port) => `http://127.0.0.1:${port}`)),
      } : {}),
      ...(ticket === 305 ? {
        PHASE9_FEEDBACK_HTTP_ADMIN_DATABASE_URL: status.DB_URL,
        PHASE9_FEEDBACK_HTTP_URLS: JSON.stringify(appPorts.slice(0, 2).map((port) => `http://127.0.0.1:${port}`)),
      } : {}),
      ...(contentAuthoringTicket ? { PHASE5_REQUIRE_CONTENT_AUTHORING: "1", PHASE5_CONTENT_AUTHORING_DATABASE_URL: status.DB_URL } : {}),
    };
    stage = "tests";
    // Keep draining the live servers' pipes while tests send HTTP requests.
    // Blocking this event loop can fill a server's stdout pipe on Linux and
    // stall its responses until the test's request deadline expires.
    const test = await new Promise((resolve) => {
      const suites = ticket === 305 ? [
        "tests/runtime/feedback.test.ts",
        "tests/runtime/feedback-limits.test.ts",
        "tests/runtime/feedback-http.network.integration.test.ts",
        "tests/routes/phase9-route-registration.test.ts",
      ] : ticket === 304 ? [
        "tests/runtime/rating.test.ts",
        "tests/runtime/rating-http.network.integration.test.ts",
        "tests/routes/phase9-route-registration.test.ts",
      ] : ticket === 303 ? [
        "tests/runtime/reaction.test.ts",
        "tests/runtime/reaction-http.network.integration.test.ts",
        "tests/routes/phase9-route-registration.test.ts",
      ] : [
        "tests/runtime/owner-configuration-network.integration.test.ts",
        ...(contentAuthoringTicket ? ["tests/runtime/owner-content-http.test.ts", "tests/runtime/owner-publication.test.ts"] : []),
        ...(ticket === 298 ? ["tests/runtime/owner-project-status.test.ts", "tests/contracts/owner-contract.test.ts",
          "tests/routes/phase9-route-registration.test.ts"] : []),
        ...(ticket === 299 ? ["tests/runtime/owner-taxonomy.test.ts", "tests/runtime/owner-project.test.ts",
          "tests/contracts/owner-contract.test.ts", "tests/routes/phase9-route-registration.test.ts"] : []),
        ...(ticket === 302 ? ["tests/runtime/owner-cv.test.ts", "tests/runtime/current-cv.test.ts",
          "tests/runtime/supabase-current-cv-delivery.test.ts", "tests/contracts/owner-contract.test.ts",
          "tests/routes/phase9-route-registration.test.ts"] : []),
        "tests/runtime/owner-configuration-http-bootstrap.test.ts",
        "tests/runtime/owner-configuration.test.ts",
        "tests/phase4/owner-request-security.test.ts",
        "tests/phase4/owner-session-auth.test.ts",
        "tests/phase8/operations-observability.test.ts",
        ...(contentAuthoringTicket ? ["tests/database/content-authoring.integration.test.ts"] : []),
      ];
      const child = spawn(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run",
      "--config", "vitest.owner-configuration-network.config.ts",
      ...suites,
      "--reporter=json", "--reporter=verbose", `--outputFile.json=${reportPath}`], {
        cwd: ROOT, env: testEnv, timeout: 240_000, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let error;
      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (cause) => { error = cause; });
      child.on("close", (status) => resolve({ status, error, stdout, stderr }));
    });
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (test.error || test.status !== 0 || report.success !== true || report.numPassedTests <= 3 ||
        report.numFailedTests !== 0 || report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
        report.testResults?.length !== (ticket === 305 ? 4 : ticket === 304 ? 3 : ticket === 303 ? 3 : ticket === 302 ? 11 : ticket === 299 ? 13 : ticket === 298 ? 12 : contentAuthoringTicket ? 9 : 6) ||
        report.testResults.some((suite) => suite.status !== "passed")) {
      const failedAssertions = report.testResults?.flatMap((suite) => suite.assertionResults ?? [])
        .filter((assertion) => assertion.status !== "passed")
        .map((assertion) => {
          const failureMessages = assertion.failureMessages?.join("\n") ?? "";
          const statusMismatch = failureMessages.match(/expected (200|201|400|401|403|404|409|412|422|429|500|503) to be (200|201|400|401|403|404|409|412|422|429|500|503)/u);
          return { ...safeAssertionDiagnostic(assertion),
            test: [...(assertion.ancestorTitles ?? []), assertion.title].join(" / "),
            authCode: failureMessages.match(/PHASE9_AUTH_DIAGNOSTIC:(SESSION_MALFORMED|UNSUPPORTED_ALGORITHM|UNKNOWN_SIGNING_KEY|INVALID_SIGNATURE|SESSION_EXPIRED|INVALID_CLAIMS|SESSION_REVOKED|AUTH_PROVIDER_UNAVAILABLE|UNTRUSTED_PROVIDER_IDENTITY|NOT_OWNER)/u)?.[1] ?? null,
            httpStatus: statusMismatch ? { actual: Number(statusMismatch[1]), expected: Number(statusMismatch[2]) } : null,
          };
        }) ?? [];
      const diagnosticCodes = [...new Set((JSON.stringify(report) + test.stdout + test.stderr + logs.join("")).match(/\b(?:PHASE9_[A-Z0-9_]+|OWNER_RATE_LIMIT_[A-Z0-9_]+|RATE_LIMIT_UNAVAILABLE|INVALID_CLAIMS|INVALID_SIGNATURE|SESSION_REVOKED|AUTH_PROVIDER_UNAVAILABLE|UNKNOWN_SIGNING_KEY)\b/gu) ?? [])];
      const contentCreateFailure = (test.stdout + test.stderr + logs.join("")).match(/PHASE9_CONTENT_CREATE_HTTP:(\d{3}):([a-z_]+)/u);
      const contentLimitFailure = (test.stdout + test.stderr + logs.join("")).match(/PHASE9_CONTENT_RATE_LIMIT_PREFLIGHT:([A-Z0-9_]+)/u);
      console.error(JSON.stringify({ code: "PHASE9_OWNER_HTTP_ACCEPTANCE_TESTS_FAILED", assertions: failedAssertions, diagnosticCodes,
        ...(contentCreateFailure ? { contentCreate: { status: Number(contentCreateFailure[1]), code: contentCreateFailure[2] } } : {}),
        ...(contentLimitFailure ? { contentRateLimit: contentLimitFailure[1] } : {}) }));
      throw new Error("PHASE9_OWNER_HTTP_ACCEPTANCE_TESTS_FAILED");
    }
    executedTests = report.testResults.flatMap((suite) => (suite.assertionResults ?? []).map((assertion) => ({
      file: suite.name.replaceAll("\\", "/").split("/").slice(-3).join("/"),
      name: [...(assertion.ancestorTitles ?? []), assertion.title].join(" / "), status: assertion.status,
    })));
    passedTestCount = report.numPassedTests;
    postgresVersion = (await admin.query("select current_setting('server_version') as version")).rows[0]?.version ?? "unavailable";
    console.log(`Phase 9 ticket #${ticket} built HTTP acceptance passed: ${report.numPassedTests} passed, 0 skipped.`);
    process.exitCode = 0;
  } catch (error) {
    // Only expose our fixed diagnostic codes; dependency messages may contain credentials.
    const code = error instanceof Error ? error.message.match(/^((?:PHASE9_OWNER_HTTP|PHASE6_MIGRATION_BOOTSTRAP|LOCAL_MIGRATION)_[A-Z_]+)(?::(start|status|migration))?$/u)?.[0] : undefined;
    failure = new Error(code ?? `PHASE9_OWNER_HTTP_RUN_FAILED:${stage}: isolated acceptance did not complete; diagnostics suppressed.`);
  } finally {
    for (const server of [...servers].reverse()) await stopServer(server);
    if (admin) {
      if (role) {
        try { await admin.query(`alter role ${quoteRole(role)} nologin`); } catch { cleanupFailed = true; }
        try { await admin.query(`drop role if exists ${quoteRole(role)}`); } catch { cleanupFailed = true; }
      }
      try { await admin.end(); } catch { cleanupFailed = true; }
    }
    if (attemptedStart) {
      try { runSupabase(workdir, env, ["stop", "--project-id", projectId, "--no-backup"], 90_000); }
      catch { cleanupFailed = true; }
    }
    if (networkCreated) {
      const result = spawnSync("docker", ["network", "rm", network], { env, stdio: "ignore", timeout: 20_000 });
      if (result.error || result.status !== 0) cleanupFailed = true;
    }
    const absoluteWorkdir = resolve(workdir);
    const absoluteTemp = resolve(tmpdir());
    if (!cleanupFailed && (absoluteWorkdir.startsWith(`${absoluteTemp}\\`) || absoluteWorkdir.startsWith(`${absoluteTemp}/`))) {
      try { rmSync(absoluteWorkdir, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    }
    const capturedLogs = logs.join("");
    if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|SERVICE_ROLE_KEY\s*[=:]\s*\S+|password\s*[=:]\s*\S+|SHOULD_NEVER_APPEAR_PHASE9_SECRET_7d0b0a|PRIVATE_FEEDBACK_(?:NAME|TEXT)_SENTINEL_305/i.test(capturedLogs)) {
      failure = new Error("PHASE9_OWNER_HTTP_LOG_PRIVACY_FAILED");
    }
    if (cleanupFailed) failure = new Error("PHASE9_OWNER_HTTP_CLEANUP_FAILED: disposable validation resources remain; acceptance failed.");
  }
  if (failure) throw failure;
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const npmVersion = spawnSync("npm", ["--version"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const supabaseVersion = JSON.parse(readFileSync(join(ROOT, "node_modules/supabase/package.json"), "utf8")).version;
  const nextVersion = JSON.parse(readFileSync(join(ROOT, "node_modules/next/package.json"), "utf8")).version;
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((name) => name.endsWith(".sql")).sort()
    .map((name) => ({ name, sha256: digest(readFileSync(join(ROOT, "supabase/migrations", name))) }));
  const contractBundles = Object.fromEntries(["public", "owner"].map((name) => {
    const path = join(ROOT, `openapi/generated/${name}-v1.json`);
    return [name, digest(readFileSync(path))];
  }));
  mkdirSync(join(ROOT, "evidence"), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify({
    ticket, scope: ticket === 305
      ? "built-next-public-identity-free-feedback-http-real-postgresql-replay-privacy-and-lifecycle"
      : ticket === 304
      ? "built-next-public-rating-http-real-postgresql-functional-identity-and-shared-rate-limit"
      : ticket === 303
      ? "built-next-public-reaction-http-real-postgresql-functional-identity-and-shared-rate-limit"
      : ticket === 302
      ? "built-next-owner-cv-and-public-current-cv-http-real-auth-restricted-postgresql"
      : ticket === 299 ? "built-next-owner-controlled-taxonomy-workflows-http-real-auth-restricted-postgresql"
        : ticket === 298 ? "built-next-owner-project-status-catalogue-http-real-auth-postgresql"
          : ticket === 295 ? "built-next-owner-content-authoring-review-preview-history-http-real-auth-postgresql"
            : "built-next-owner-configuration-http-real-auth-postgresql",
    runId: randomUUID(), githubRunId: process.env.GITHUB_RUN_ID ?? null, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    source: { commit: commit.status === 0 ? commit.stdout.trim() : "unavailable", treeSha256: workingTreeSourceSha256() },
    ...(ticket === 304 ? { phase7Prerequisite: {
      artifact: "evidence/phase7-ratings-191.json",
      sourceTreeSha256: ratingPrerequisiteEvidence.sourceTreeSha256,
      required: ratingPrerequisiteEvidence.required,
      cleanupVerified: ratingPrerequisiteEvidence.cleanup,
    } } : {}),
    ...(ticket === 303 ? { phase7Prerequisite: {
      artifact: "evidence/phase7-reactions-190.json",
      sourceTreeSha256: reactionPrerequisiteEvidence.sourceTreeSha256,
      required: reactionPrerequisiteEvidence.required,
      cleanupVerified: reactionPrerequisiteEvidence.cleanup,
    } } : {}),
    ...(ticket === 305 ? { phase7Prerequisite: {
      artifact: "evidence/phase7-feedback-192.json",
      sourceTreeSha256: feedbackPrerequisiteEvidence.sourceTreeSha256,
      required: feedbackPrerequisiteEvidence.required,
      cleanupVerified: feedbackPrerequisiteEvidence.cleanup,
    } } : {}),
    contractBundles, migrations,
    toolIdentity: { node: process.version, npm: npmVersion.status === 0 ? npmVersion.stdout.trim() : "unavailable",
      next: nextVersion, supabaseCli: supabaseVersion, postgres: postgresVersion },
    databaseRole: "restricted login granted shipwithali_application; bypassrls=false",
    fixtures: ticket === 305
      ? { portfolio: "synthetic isolated test portfolio", projects: "synthetic Published, Hidden, foreign and unavailable Projects", identity: "none", measurementConsent: "none" }
      : ticket === 304
      ? { portfolio: "synthetic isolated test portfolio", projects: "synthetic Published, Hidden and Archived Projects", measurementConsent: "none" }
      : ticket === 303
      ? { portfolio: "synthetic isolated test portfolio", projects: "synthetic Published, Hidden and Archived Projects", measurementConsent: "none" }
      : { owner: "synthetic linked GitHub test identity", portfolio: "synthetic configured test portfolio", session: "temporary Auth sessions" },
    verdict: "passed", namedChecks: ticket === 305 ? [
      "built-next-public-feedback-route-and-production-composition",
      "201-schema-valid-minimal-pending-receipt-and-private-version-one-row",
      "no-functional-or-measurement-cookies-or-subjects-created-or-required",
      "strict-transport-body-byte-text-and-exact-locale-rejection",
      "cross-server-concurrent-exact-replay-and-changed-input-conflict",
      "project-lifecycle-rechecked-before-replay-and-unavailable-foreign-denial",
      "feedback-text-confined-to-private-row-and-redacted-from-events-responses-and-logs",
      "real-postgresql-rollback-race-and-cleanup-phase7-regressions",
    ] : ticket === 304 ? [
      "built-next-public-rating-route-and-production-composition",
      "valid-200-rating-receipt-shared-secure-host-only-functional-cookie-no-store-non-indexable",
      "one-current-rater-row-and-one-aggregate-contribution-after-change",
      "concurrent-exact-retry-original-safe-receipt-and-changed-key-conflict",
      "functional-rating-independent-of-measurement-events-across-languages",
      "invalid-input-and-ineligible-projects-rejected-before-effects",
      "shared-postgresql-rating-budget-fail-closed-outage-and-lost-cookie-limit",
      "rating-crypto-lifecycle-race-and-subject-redaction-phase7-regressions",
    ] : ticket === 303 ? [
      "built-next-public-reaction-route-and-production-composition",
      "valid-200-receipt-secure-host-only-functional-cookie-no-store-non-indexable",
      "language-independent-current-row-and-idempotency-replay-across-servers",
      "malformed-input-rejected-before-rate-limit-identity-or-mutation",
      "hidden-archived-and-missing-project-denial-before-cookie-issuance",
      "functional-interaction-independent-of-measurement-events",
      "shared-postgresql-30-per-minute-rate-limit-and-fail-closed-outage",
      "functional-cookie-crypto-tamper-expiry-purpose-rotation-and-lost-first-cookie-regression",
    ] : ["all-three-configuration-operations", "valid-receipts-private-headers",
      "cross-instance-exact-replay-and-version-conflict", "csrf-origin-forwarded-host-and-non-owner-denials",
      "revoked-session-denial", "shared-database-rate-limit", "limiter-outage-fails-closed", "log-privacy",
      ...(ticket === 295 ? ["all-six-content-authoring-http-operations", "content-cross-instance-exact-replay-and-conflict",
        "foreign-and-revoked-content-read-and-replay-denial", "strict-content-transport-validation-before-effects",
        "postgres-content-save-preserves-public-projection"] : []),
      ...(ticket === 298 ? ["all-four-project-status-catalogue-http-operations", "status-cross-instance-exact-replay-and-conflict",
        "private-status-headers-and-operation-specific-preconditions", "foreign-invalid-and-stale-status-denials",
        "postgres-status-history-retirement-and-usage-race"] : []),
      ...(ticket === 299 ? ["all-six-controlled-taxonomy-http-operations", "taxonomy-cross-instance-assignment-and-merge-replay",
        "rename-stable-id-retirement-history-and-merge-mapping", "invalid-foreign-stale-and-conflicting-key-denials",
        "restricted-postgres-merge-assignment-history-and-retirement-evidence", "postgres-rollback-and-independent-connection-races"] : []),
      ...(ticket === 302 ? ["five-CV-operation-routes-bound-to-the-canonical-contract-inventory",
        "built-http-all-five-CV-operations-use-accepted-isolated-pdf-bytes",
        "built-http-private-CV-portfolio-and-real-database-missing-media-or-version-denials",
        "current-CV-English-only-absence-and-Problem-contract", "owner-CV-rate-limit-operations-accepted-by-restricted-postgresql",
        "CV-adapter-stream-redirect-rate-limit-and-privacy-regression-suites",
        "real-PDF-activation-and-storage-evidence-is-produced-by-the-required-Phase-6-gate"] : [])],
    ...(ticket === 305 ? { acceptanceCriteria: {
      AC01: ["tests/runtime/feedback-http.network.integration.test.ts :: AC01-02 stores a private pending version-1 row through the built route with a schema-valid 201 receipt"],
      AC02: ["tests/runtime/feedback-http.network.integration.test.ts :: AC01-02 proves no Set-Cookie or Measurement consent row; production composition requires no functional identity"],
      AC03: ["tests/runtime/feedback-http.network.integration.test.ts :: AC03 rejects malformed, unknown, oversized, blank, control, and unpublished-locale input",
        "tests/runtime/feedback-limits.test.ts :: streamed body bound rejects a deceptive Content-Length"],
      AC04: ["tests/runtime/feedback-http.network.integration.test.ts :: AC04-05 replays the original receipt across servers and conflicts on changed input",
        "tests/phase7/feedback-postgres.test.ts :: T05-05 independent-pool same-key races produce one row/fact; changed payload conflicts"],
      AC05: ["tests/runtime/feedback-http.network.integration.test.ts :: AC04-05 rechecks Project lifecycle before replay; AC05 rejects unavailable and foreign Projects",
        "tests/phase7/feedback-postgres.test.ts :: T05-07 hide-first and submit-first real lifecycle races; T05-06 limiter outage has no effects"],
      AC06: ["tests/runtime/feedback-http.network.integration.test.ts :: receipt contains only contracted fields, the real approved public projection excludes pending Feedback, and outbox payload omits private text",
        "tests/phase7/feedback-postgres.test.ts :: T05-08 Feedback text exists only in the private row; outbox, ledger, Measurement and logs are redacted",
        "isolated loopback Supabase cleanup :: disposable PostgreSQL and application instances removed after suite"],
    } } : ticket === 304 ? { acceptanceCriteria: {
      AC01: ["tests/runtime/rating-http.network.integration.test.ts :: AC01 returns a schema-valid current Rating receipt and shared secure functional cookie"],
      AC02: ["tests/runtime/rating-http.network.integration.test.ts :: AC02 changes one current row and one aggregate contribution instead of adding a rater",
        "tests/phase7/ratings-postgres.test.ts :: T04-01 returns strict HTTP 200, secure cookie and one replacement row with reconciled counts",
        "tests/runtime/rating-http.network.integration.test.ts :: AC02 changes one current row and one aggregate contribution instead of adding a rater (restricted summary view returns average null below five raters)"],
      AC03: ["tests/runtime/rating-http.network.integration.test.ts :: AC03 preserves original safe receipts for concurrent exact retry and conflicts on changed-key reuse",
        "tests/phase7/ratings-postgres.test.ts :: T04-04 new-key same-value is a no-op; exact retry retains original safe result; conflicting reuse changes nothing",
        "tests/phase7/ratings-postgres.test.ts :: T04-05 same-key races across independent pools yield one effect; differing payload yields one conflict"],
      AC04: ["tests/runtime/rating-http.network.integration.test.ts :: AC04 keeps a functional Rating across language requests without Measurement identity or event joins",
        "tests/phase7/ratings-postgres.test.ts :: T04-03 consent denial/unknown permits functional use and non-interaction issuance rejects",
        "tests/phase7/ratings-postgres.test.ts :: T04-03 Rating and Reaction preserve each other across language views and operation-scoped replay"],
      AC05: ["tests/runtime/rating-http.network.integration.test.ts :: AC05 rejects invalid cookie, transport, and ineligible Projects before Rating state or cookie issuance",
        "tests/runtime/rating.test.ts :: fails closed when the limiter or trusted client address is unavailable",
        "tests/phase7/ratings-postgres.test.ts :: T04-06 withdrawal-first serialization rejects preflight-authorized submission and retained replay",
        "tests/phase7/ratings-postgres.test.ts :: T04-06 submission-first holds real lifecycle withdrawal until commit; later writes reject"],
      AC06: ["tests/runtime/rating-http.network.integration.test.ts :: AC06 applies the shared per-operation limiter, fails closed on outage, and preserves the lost-first-cookie limit",
        "tests/runtime/rating.test.ts :: returns 429 with Retry-After before application dispatch when the shared limiter denies",
        "tests/phase7/ratings-postgres.test.ts :: T04-07 actual crypto rejects tampered/expired/wrong-purpose/retired tokens; rotation preserves subject",
        "tests/phase7/ratings-postgres.test.ts :: T04-03 losing the initial cookie creates independent actors even for the same key",
        "tests/phase7/ratings-postgres.test.ts :: restricted principal RLS scopes votes and pooled settings; no anonymous/worker grants or subject leakage",
        "evidence/phase7-ratings-191.json :: actual assertion results, sanitized environment identity and verified cleanup"],
    } } : {}),
    ...(ticket === 303 ? { acceptanceCriteria: {
      AC01: ["tests/runtime/reaction-http.network.integration.test.ts :: AC01 returns a schema-valid personalized receipt and secure functional cookie over the built route"],
      AC02: ["tests/runtime/reaction-http.network.integration.test.ts :: AC02-03 shares one language-independent subject and preserves replay and current-row semantics across servers",
        "tests/phase7/reactions-postgres.test.ts :: T03-08 subjects and Projects remain independent and votes have no locale copy"],
      AC03: ["tests/runtime/reaction-http.network.integration.test.ts :: AC02-03 shares one language-independent subject and preserves replay and current-row semantics across servers",
        "tests/phase7/reactions-postgres.test.ts :: T03-05 new-key same-value is a no-op; exact retry retains original safe result; conflicting reuse changes nothing",
        "tests/phase7/reactions-postgres.test.ts :: T03-05 same-key races across independent pools yield one effect; differing payload yields one conflict"],
      AC04: ["tests/runtime/reaction-http.network.integration.test.ts :: AC04 rejects malformed keys and bodies before the limiter, identity, or mutation",
        "tests/runtime/reaction.test.ts :: rejects malformed JSON, missing or malformed Idempotency-Key, invalid choice and unknown body before dispatch"],
      AC05: ["tests/runtime/reaction-http.network.integration.test.ts :: AC05 denies hidden, archived, and missing Projects before cookie issuance",
        "tests/phase7/reactions-postgres.test.ts :: T03-02 withdrawal-first serialization rejects preflight-authorized submission and retained replay",
        "tests/phase7/reactions-postgres.test.ts :: T03-02 submission-first holds real lifecycle withdrawal until commit; later writes reject"],
      AC06: ["tests/runtime/reaction-http.network.integration.test.ts :: AC06 permits functional Reaction without Measurement consent or event writes",
        "tests/phase7/reactions-postgres.test.ts :: T03-03 consent denial/unknown permits functional use and non-interaction issuance rejects",
        "tests/phase7/reactions-postgres.test.ts :: restricted principal RLS scopes votes and pooled settings; no anonymous/worker grants or subject leakage"],
      AC07: ["tests/runtime/reaction-http.network.integration.test.ts :: AC07 enforces the shared 30-per-minute PostgreSQL budget and fails closed on limiter outage",
        "tests/phase7/reactions-postgres.test.ts :: T03-04 actual crypto rejects tampered/expired/wrong-purpose/retired tokens; rotation preserves subject",
        "tests/phase7/reactions-postgres.test.ts :: T03-06 enforces 30 requests per client-minute across independent PostgreSQL instances",
        "tests/phase7/reactions-postgres.test.ts :: T03-08 losing the initial cookie creates independent actors even for the same key",
        "evidence/phase7-reactions-190.json :: actual assertion results, sanitized environment identity and verified cleanup"],
    } } : {}),
    ...(ticket === 299 ? { acceptanceCriteria: {
      AC01: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history"],
      AC02: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / renames and retires Taxonomy values while preserving assignments, public labels, and restoration"],
      AC03: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / merges active values atomically across Projects, deduplicates survivors, preserves history, and replays the original receipt"],
      AC04: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / rolls back every Project when a multi-Project merge projection or outbox write fails",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / serializes assignment against merge and simultaneous merges on independent connections",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / serializes Taxonomy retirement against new assignments"],
      AC05: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        "tests/runtime/owner-taxonomy.test.ts :: Owner Taxonomy commands (#30) / rejects command inputs before dispatch and translates typed authorization, version, and conflict rejections",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / rejects foreign-scope Taxonomy values and non-Project assignment targets"],
      AC06: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / merges active values atomically across Projects, deduplicates survivors, preserves history, and replays the original receipt",
        "tests/routes/phase9-route-registration.test.ts :: Phase 9 guarded route registration (#293) / derives the exact 53 operation identifiers and keeps pending declarations"],
    } } : {}),
    ...(ticket === 302 ? { acceptanceCriteria: {
      AC01: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / executes all five CV operations over built HTTP with accepted PDF bytes and rejects invalid CV states",
        "tests/runtime/owner-cv.test.ts :: Owner CV Portfolio HTTP adapters / registers a CV version once and returns the declared 201 receipt",
        "tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / streams the declared PDF branch with no-store and safe disposition",
        "evidence/phase6-cv-delivery-159.json :: real private Storage PDF verification and Current CV delivery"],
      AC02: ["evidence/phase6-cv-activation-156.json :: atomic Current CV replacement, competing activation and retained history"],
      AC03: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / executes all five CV operations over built HTTP with accepted PDF bytes and rejects invalid CV states",
        "tests/runtime/owner-cv.test.ts :: Owner CV version acceptance and activation (#31) / accepts a CV version once without requiring a body",
        "tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / rejects missing locale as 400 before dispatch",
        "tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / rejects invalid locale as 400 before dispatch",
        "tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / rejects duplicate query key as 400 before dispatch"],
      AC04: ["tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / rejects a redirect with unlisted origin",
        "tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / rejects a redirect with insecure URL",
        "tests/runtime/supabase-current-cv-delivery.test.ts :: Supabase Current CV private delivery / returns a short lived exact-origin signed URL and rejects mismatched bytes or origins"],
      AC05: ["tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / cancels the byte source when the visitor cancels a backpressured response",
        "tests/runtime/supabase-current-cv-delivery.test.ts :: Supabase Current CV private delivery / reads the exact private processed PDF, validates its hash, and uses bounded chunks",
        "evidence/phase6-cv-delivery-159.json :: real private Storage delivery and resource-bound evidence"],
      AC06: ["tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / limits repeated client requests before application dispatch and sends Retry-After",
        "tests/runtime/current-cv.test.ts :: GET Current CV adapter (#28) / fails closed when the hosting rate limiter is unavailable"],
      AC07: ["evidence/phase6-public-capabilities-160.json :: Current CV English-only and Arabic capability assertions for scenarios 9 and 13",
        "evidence/phase6-media-cv-integration-163.json :: real Media/CV transaction and cleanup evidence"],
    } } : {}),
    ...(ticket === 298 ? { acceptanceCriteria: {
      AC01: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts"],
      AC02: ["tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / keeps Project status identities, histories, Featured state, and published projections atomic"],
      AC03: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts",
        "tests/runtime/owner-project-status.test.ts :: Owner Project status HTTP adapters / rejects unknown body properties before dispatch and applies If-Match to retirement"],
      AC04: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts",
        "tests/runtime/owner-project-status.test.ts :: Owner Project status HTTP adapters / rejects unknown body properties before dispatch and applies If-Match to retirement"],
      AC05: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / keeps Project status identities, histories, Featured state, and published projections atomic"],
      AC06: ["tests/contracts/owner-contract.test.ts :: Owner v1 contract / documents examples for all four Project status catalogue operations",
        "tests/routes/phase9-route-registration.test.ts :: Phase 9 guarded route registration (#293) / derives the exact 53 operation identifiers and keeps pending declarations",
        "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts"],
    } } : {}),
    ...(ticket === 298 ? { traceability: [
      { method: "GET", route: "/api/owner/v1/project-status-values", operation: "listOwnerProjectStatusValues",
        application: "dispatchOwnerProjectStatusHttp(listOwnerProjectStatusValues) -> ContentAuthoringService.listProjectStatusValues",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts",
        assertions: ["200 schema-valid catalogue with private headers", "list succeeds without invented mutation headers", "retired values remain listed"] },
      { method: "POST", route: "/api/owner/v1/project-status-values", operation: "createOwnerProjectStatusValue",
        application: "dispatchOwnerProjectStatusHttp(createOwnerProjectStatusValue) -> ContentAuthoringService.createProjectStatusValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts",
        assertions: ["201 schema-valid receipt and private headers", "concurrent cross-instance exact replay", "changed-input 409", "missing key and invalid label rejected"] },
      { method: "POST", route: "/api/owner/v1/project-status-values/{valueId}/commands/rename", operation: "renameOwnerProjectStatusValue",
        application: "dispatchOwnerProjectStatusHttp(renameOwnerProjectStatusValue) -> ContentAuthoringService.renameProjectStatusValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts",
        assertions: ["200 schema-valid receipt and private headers", "stable identity", "concurrent replay", "missing precondition 400 and stale version 412"] },
      { method: "POST", route: "/api/owner/v1/project-status-values/{valueId}/commands/retire", operation: "retireOwnerProjectStatusValue",
        application: "dispatchOwnerProjectStatusHttp(retireOwnerProjectStatusValue) -> ContentAuthoringService.retireProjectStatusValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all four Project status catalogue operations over built HTTP with exact replay and private contracts",
        assertions: ["200 schema-valid receipt and private headers", "concurrent replay", "retired history retained", "invalid ID and missing preconditions rejected"] },
    ] } : {}),
    ...(ticket === 295 ? { acceptanceCriteria: {
      AC01: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP"],
      AC02: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / serializes same-key and stale-version races and preserves the original replay receipt",
        "tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / persists immutable exact-snapshot reviews atomically and does not transfer them to later Revisions"],
      AC03: ["tests/database/content-authoring.integration.test.ts :: Content authoring production PostgreSQL invariants / publishes reviewed Achievements with internal or public evidence into a locale-specific ordered Timeline"],
      AC04: ["tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP"],
      AC05: ["tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects unknown draft fields before dispatch",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / records an exact-snapshot review through strict contract and concurrency validation",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects create with missing Idempotency-Key before dispatch",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects create with malformed Idempotency-Key before dispatch",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects review with missing Idempotency-Key before dispatch",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects review with malformed Idempotency-Key before dispatch",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects review with missing If-Match before dispatch",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects review with malformed If-Match before dispatch",
        "tests/runtime/owner-content-http.test.ts :: Owner content authoring HTTP adapters / rejects an invalid review path before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command malformed JSON revisions as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command missing Idempotency-Key revisions as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command malformed Idempotency-Key revisions as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command missing If-Match commands/publish-language as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command invalid If-Match commands/hide as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command malformed If-Match revisions as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command invalid contentId commands/archive as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command absent body fields revisions as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command unknown closed-shape property commands/publish-language as 400 before dispatch",
        "tests/runtime/owner-publication.test.ts :: Owner Publication commands (#30) / rejects command out-of-shape body commands/restore as 400 before dispatch"],
      AC06: "traceability",
    } } : {}),
    ...(ticket === 295 ? { traceability: [
      { method: "POST", route: "/api/owner/v1/content", operation: "createOwnerContent",
        application: "dispatchOwnerContentAuthoringHttp(createOwnerContent) -> ContentAuthoringService.create",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP",
        assertions: ["201 response contract and private headers", "exact cross-instance replay", "403 replay denial for foreign session", "401 replay denial after revocation"] },
      { method: "GET", route: "/api/owner/v1/content/{contentId}", operation: "getOwnerContentAggregate",
        application: "dispatchOwnerContentAuthoringHttp(getOwnerContentAggregate) -> ContentAuthoringService.getOwnerContentAggregate",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP",
        assertions: ["200 response contract and private headers", "foreign 403 and revoked 401"] },
      { method: "POST", route: "/api/owner/v1/content/{contentId}/revisions", operation: "saveOwnerContentRevision",
        application: "dispatchOwnerContentAuthoringHttp(saveOwnerContentRevision) -> ContentAuthoringService.saveRevision",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP",
        assertions: ["201 response contract and private headers", "exact cross-instance replay", "changed-key 409", "stale-version 412", "foreign 403 and revoked 401 replay denial"] },
      { method: "GET", route: "/api/owner/v1/content/{contentId}/revisions/{revisionId}/preview", operation: "previewOwnerContentRevision",
        application: "dispatchOwnerContentAuthoringHttp(previewOwnerContentRevision) -> ContentAuthoringService.preview",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP",
        assertions: ["200 response contract and private non-indexable/no-store headers", "foreign 403 and revoked 401"] },
      { method: "POST", route: "/api/owner/v1/content/{contentId}/revisions/{revisionId}/review", operation: "reviewOwnerContentRevision",
        application: "dispatchOwnerContentAuthoringHttp(reviewOwnerContentRevision) -> ContentAuthoringService.review",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP",
        assertions: ["200 response contract and private headers", "exact cross-instance replay", "foreign 403 and revoked 401 replay denial"] },
      { method: "GET", route: "/api/owner/v1/content/{contentId}/history", operation: "getOwnerContentHistory",
        application: "dispatchOwnerContentAuthoringHttp(getOwnerContentHistory) -> ContentAuthoringService.history",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves all six private Content authoring, review, preview and history operations over built HTTP",
        assertions: ["200 response contract and private headers", "ordered retained revisions", "foreign 403 and revoked 401"] },
    ] } : {}),
    ...(ticket === 299 ? { traceability: [
      { method: "GET", route: "/api/owner/v1/taxonomies/{taxonomyId}", operation: "getOwnerTaxonomyAggregate",
        application: "dispatchOwnerTaxonomyHttp(getOwnerTaxonomyAggregate) -> TaxonomyOwnerService.getOwnerTaxonomy",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        assertions: ["200 schema-valid aggregate with value mapping/history/assignment history", "private no-store and non-indexable headers", "invalid and foreign requests denied"] },
      { method: "POST", route: "/api/owner/v1/taxonomies/{taxonomyId}/values", operation: "createOwnerTaxonomyValue",
        application: "dispatchOwnerTaxonomyHttp(createOwnerTaxonomyValue) -> TaxonomyOwnerService.createOwnerTaxonomyValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        assertions: ["201 schema-valid receipt and private headers", "If-Match and Idempotency-Key honored"] },
      { method: "POST", route: "/api/owner/v1/taxonomy-values/{valueId}/commands/rename", operation: "renameOwnerTaxonomyValue",
        application: "dispatchOwnerTaxonomyHttp(renameOwnerTaxonomyValue) -> TaxonomyOwnerService.renameOwnerTaxonomyValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        assertions: ["200 schema-valid receipt", "stable value ID and retained rename history", "stale version denied without changing state"] },
      { method: "POST", route: "/api/owner/v1/taxonomy-values/{valueId}/commands/retire", operation: "retireOwnerTaxonomyValue",
        application: "dispatchOwnerTaxonomyHttp(retireOwnerTaxonomyValue) -> TaxonomyOwnerService.retireOwnerTaxonomyValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        assertions: ["200 schema-valid receipt", "earlier assignment retained", "later assignment rejected"] },
      { method: "POST", route: "/api/owner/v1/taxonomy-values/{valueId}/commands/merge", operation: "mergeOwnerTaxonomyValue",
        application: "dispatchOwnerTaxonomyHttp(mergeOwnerTaxonomyValue) -> TaxonomyOwnerService.mergeOwnerTaxonomyValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        assertions: ["cross-instance exact replay and conflicting-key 409", "atomic assignment migration, mapping, history and private response"] },
      { method: "POST", route: "/api/owner/v1/projects/{projectId}/commands/assign-taxonomy-value", operation: "assignOwnerProjectTaxonomyValue",
        application: "dispatchOwnerProjectHttp(assignOwnerProjectTaxonomyValue) -> ContentAuthoringService.assignProjectTaxonomyValue",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / serves controlled Taxonomy workflows over built HTTP and verifies real PostgreSQL assignment history",
        assertions: ["200 schema-valid receipt", "cross-instance exact replay", "retired value rejected without new assignment"] },
    ] } : {}),
    ...(ticket === 305 ? { traceability: [
      { method: "POST", route: "/api/v1/projects/{projectId}/feedback", operation: "postProjectFeedback",
        application: "dispatchPostProjectFeedbackHttp -> getFeedbackRuntimeServices -> handlePostProjectFeedback -> InteractionModerationService.submitFeedback",
        executedTest: "tests/runtime/feedback-http.network.integration.test.ts :: Phase 9 #305 production-built Feedback HTTP acceptance",
        assertions: ["201 generated response schema", "pending row with original submission facts and aggregateVersion 1", "no functional or Measurement identity", "Cache-Control no-store", "X-Robots-Tag noindex, nofollow", "private text excluded from receipt and durable non-row facts"] },
    ] } : ticket === 304 ? { traceability: [
      { method: "PUT", route: "/api/v1/projects/{projectId}/rating", operation: "putProjectRating",
        application: "dispatchPutProjectRatingHttp -> getRatingRuntimeServices -> handlePutProjectRating -> InteractionModerationService.submitRating",
        executedTest: "tests/runtime/rating-http.network.integration.test.ts :: Phase 9 #304 production-built Rating HTTP acceptance",
        assertions: ["200 generated response schema", "shared secure host-only functional cookie", "Cache-Control no-store", "X-Robots-Tag noindex", "functional subject redacted"] },
    ] } : {}),
    ...(ticket === 303 ? { traceability: [
      { method: "PUT", route: "/api/v1/projects/{projectId}/reaction", operation: "putProjectReaction",
        application: "dispatchPutProjectReactionHttp -> getReactionRuntimeServices -> handlePutProjectReaction -> InteractionModerationService.submitReaction",
        executedTest: "tests/runtime/reaction-http.network.integration.test.ts :: Phase 9 #303 production-built Reaction HTTP acceptance",
        assertions: ["200 generated response schema", "secure host-only functional cookie", "Cache-Control no-store", "X-Robots-Tag noindex", "functional subject redacted"] },
    ] } : {}),
    ...(ticket === 302 ? { traceability: [
      { method: "GET", route: "/api/owner/v1/cv", operation: "getOwnerCvPortfolio",
        application: "dispatchOwnerCvHttp(getOwnerCvPortfolio) -> OwnerCvApplicationService.getOwnerCvPortfolio",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / executes all five CV operations over built HTTP with accepted PDF bytes and rejects invalid CV states",
        assertions: ["200 generated response schema", "private no-store and non-indexable headers", "current version matches activated accepted PDF"] },
      { method: "POST", route: "/api/owner/v1/cv/versions", operation: "registerOwnerCvVersion",
        application: "dispatchOwnerCvHttp(registerOwnerCvVersion) -> OwnerCvApplicationService.registerOwnerCvVersion",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / executes all five CV operations over built HTTP with accepted PDF bytes and rejects invalid CV states",
        assertions: ["201 generated response schema", "private no-store and non-indexable headers", "registers real accepted Media PDF"] },
      { method: "POST", route: "/api/owner/v1/cv/versions/{versionId}/commands/accept", operation: "acceptOwnerCvVersion",
        application: "dispatchOwnerCvHttp(acceptOwnerCvVersion) -> OwnerCvApplicationService.acceptOwnerCvVersion",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / executes all five CV operations over built HTTP with accepted PDF bytes and rejects invalid CV states",
        assertions: ["200 generated response schema", "private no-store and non-indexable headers", "If-Match and Idempotency-Key supplied"] },
      { method: "POST", route: "/api/owner/v1/cv/versions/{versionId}/commands/activate", operation: "activateOwnerCvVersion",
        application: "dispatchOwnerCvHttp(activateOwnerCvVersion) -> OwnerCvApplicationService.activateOwnerCvVersion",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / executes all five CV operations over built HTTP with accepted PDF bytes and rejects invalid CV states",
        assertions: ["200 generated response schema", "private no-store and non-indexable headers", "atomic current pointer reflected in Owner portfolio"] },
      { method: "GET", route: "/api/v1/cv/current", operation: "getCurrentCv",
        application: "dispatchCurrentCvHttp(getCurrentCv) -> CurrentCvDeliveryService.downloadCurrentCv",
        executedTest: "tests/runtime/owner-configuration-network.integration.test.ts :: Phase 9 #294 production-built Owner configuration network acceptance / executes all five CV operations over built HTTP with accepted PDF bytes and rejects invalid CV states",
        assertions: ["200 PDF or 307 no-store response", "short-lived private Storage target constrained to configured Storage origin and processed bucket when redirecting", "delivered PDF header, exact stored hash and bounded size", "signed target omitted from diagnostics and evidence"] },
    ] } : {}),
    operationExamples: ticket === 305 ? [
      { operation: "postProjectFeedback", httpStatus: 201, responseSchemaValid: true, pendingOnly: true,
        noFunctionalCookie: true, noMeasurementSubject: true, privateTextConfinedToRow: true, exactReplayVerified: true },
      { operation: "postProjectFeedback", httpStatus: 409, changedKeyPayloadConflict: true },
      { operation: "postProjectFeedback", httpStatus: 404, unavailableProjectOrLocale: true, noNewEffects: true },
      { operation: "postProjectFeedback", httpStatus: 429, positiveRetryAfter: true, sharedPortfolioLimiter: true },
      { operation: "postProjectFeedback", httpStatus: 503, limiterOutageFailsClosed: true, noEffects: true },
    ] : ticket === 304 ? [
      { operation: "putProjectRating", httpStatus: 200, responseSchemaValid: true, secureFunctionalCookie: true,
        noStore: true, noIndex: true, sameSubjectCurrentRow: true, exactReplayVerified: true },
      { operation: "putProjectRating", httpStatus: 429, positiveRetryAfter: true, sharedPostgresLimiter: true },
      { operation: "putProjectRating", httpStatus: 503, limiterOutageFailsClosed: true, noCookieReleased: true },
    ] : ticket === 303 ? [
      { operation: "putProjectReaction", httpStatus: 200, responseSchemaValid: true, secureFunctionalCookie: true,
        noStore: true, noIndex: true, sameSubjectCurrentRow: true, exactReplayVerified: true },
      { operation: "putProjectReaction", httpStatus: 429, positiveRetryAfter: true, sharedPostgresLimiter: true },
      { operation: "putProjectReaction", httpStatus: 503, limiterOutageFailsClosed: true, noCookieReleased: true },
    ] : [
      { operation: "updateOwnerProfileConfiguration", httpStatus: 200, receiptSchemaValid: true, oneLedgerAndOutboxRecord: true },
      { operation: "updateOwnerContactChannels", httpStatus: 200, receiptSchemaValid: true, oneLedgerAndOutboxRecord: true },
      { operation: "updateOwnerGlobalProjectCta", httpStatus: 200, receiptSchemaValid: true, oneLedgerAndOutboxRecord: true },
      ...(ticket === 295 ? [
        { operation: "createOwnerContent", httpStatus: 201, responseSchemaValid: true, privateHeaders: true, exactReplayVerified: true },
        { operation: "getOwnerContentAggregate", httpStatus: 200, responseSchemaValid: true, privateHeaders: true },
        { operation: "saveOwnerContentRevision", httpStatus: 201, responseSchemaValid: true, privateHeaders: true, exactReplayVerified: true },
        { operation: "previewOwnerContentRevision", httpStatus: 200, responseSchemaValid: true, privateHeaders: true },
        { operation: "reviewOwnerContentRevision", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, exactReplayVerified: true },
        { operation: "getOwnerContentHistory", httpStatus: 200, responseSchemaValid: true, privateHeaders: true },
      ] : []),
      ...(ticket === 298 ? [
        { operation: "listOwnerProjectStatusValues", httpStatus: 200, responseSchemaValid: true, privateHeaders: true },
        { operation: "createOwnerProjectStatusValue", httpStatus: 201, responseSchemaValid: true, privateHeaders: true, exactReplayVerified: true },
        { operation: "renameOwnerProjectStatusValue", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, exactReplayVerified: true },
        { operation: "retireOwnerProjectStatusValue", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, exactReplayVerified: true },
      ] : []),
      ...(ticket === 299 ? [
        { operation: "getOwnerTaxonomyAggregate", httpStatus: 200, responseSchemaValid: true, privateHeaders: true },
        { operation: "createOwnerTaxonomyValue", httpStatus: 201, responseSchemaValid: true, privateHeaders: true },
        { operation: "renameOwnerTaxonomyValue", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, stableValueIdVerified: true },
        { operation: "retireOwnerTaxonomyValue", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, historicalAssignmentsRetained: true },
        { operation: "mergeOwnerTaxonomyValue", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, crossInstanceReplayVerified: true },
        { operation: "assignOwnerProjectTaxonomyValue", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, crossInstanceReplayVerified: true },
      ] : []),
      ...(ticket === 302 ? [
        { operation: "getOwnerCvPortfolio", httpStatus: 200, responseSchemaValid: true, privateHeaders: true },
        { operation: "registerOwnerCvVersion", httpStatus: 201, responseSchemaValid: true, privateHeaders: true, acceptedMediaPdf: true },
        { operation: "acceptOwnerCvVersion", httpStatus: 200, responseSchemaValid: true, privateHeaders: true },
        { operation: "activateOwnerCvVersion", httpStatus: 200, responseSchemaValid: true, privateHeaders: true, currentPointerVerified: true },
        { operation: "getCurrentCv", httpStatuses: [200, 307], noStore: true, configuredStorageOrigin: true, exactStoredPdfHash: true, boundedPdfDelivered: true },
      ] : []),
    ],
    passed: passedTestCount, failed: 0, skipped: 0, productionBuild: true, isolatedLoopbackSupabase: true,
    execution: { command: ticket === 305 ? "npm run phase9:focus:feedback-http"
      : ticket === 304 ? "npm run phase9:focus:rating-http"
      : ticket === 303 ? "npm run phase9:focus:reaction-http"
      : ticket === 302 ? "npm run phase9:focus:cv-http"
      : ticket === 299 ? "npm run phase9:focus:taxonomy-http"
      : ticket === 298 ? "npm run phase9:focus:project-status-http"
      : ticket === 295 ? "npm run phase9:focus:content-authoring-http" : "npm run phase9:focus:owner-configuration-http", exitCode: 0,
      passed: executedTests.filter(({ status }) => status === "passed").length,
      failed: executedTests.filter(({ status }) => status === "failed").length, skipped: 0, tests: executedTests },
    cleanupVerified: true, credentialsRecorded: false, secretValuesRecorded: false,
  }, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "PHASE9_OWNER_HTTP_RUN_FAILED"); process.exitCode = 1; });
}
