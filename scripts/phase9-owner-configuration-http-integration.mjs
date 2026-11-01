#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createServer, connect } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { initializeLocalMigrationProject } from "./local-migration-bootstrap.mjs";
import { isolatedConfig, localEnvironment, requireDocker } from "./local-auth-integration.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { safeAssertionDiagnostic } from "./validation-errors.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "node_modules/supabase/dist/supabase.js");
const NEXT = join(ROOT, "node_modules/next/dist/bin/next");
const REPORT = join(ROOT, "evidence/phase9-owner-configuration-http-294.json");

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
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const installed = JSON.parse(readFileSync(join(ROOT, "node_modules/supabase/package.json"), "utf8"));
  if (installed.version !== pkg.devDependencies.supabase) throw new Error("PHASE9_OWNER_HTTP_CLI_PIN_MISMATCH");
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
    writeFileSync(join(supabaseDir, "config.toml"), isolatedConfig(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"), projectId,
      { api: apiPort, db: dbPort, shadow: shadowPort }));
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
      SUPABASE_JWT_ISSUER: `${status.API_URL}/auth/v1`, SUPABASE_JWT_AUDIENCE: "authenticated",
      OWNER_GITHUB_SUBJECTS: "910294,910296", HOSTNAME: "127.0.0.1",
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
    };
    stage = "tests";
    // Keep draining the live servers' pipes while tests send HTTP requests.
    // Blocking this event loop can fill a server's stdout pipe on Linux and
    // stall its responses until the test's request deadline expires.
    const test = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run",
      "--config", "vitest.owner-configuration-network.config.ts",
      "tests/runtime/owner-configuration-network.integration.test.ts",
      "tests/runtime/owner-configuration-http-bootstrap.test.ts",
      "tests/runtime/owner-configuration.test.ts",
      "tests/phase4/owner-request-security.test.ts",
      "tests/phase4/owner-session-auth.test.ts",
      "tests/phase8/operations-observability.test.ts",
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
        report.testResults?.length !== 6 || report.testResults.some((suite) => suite.status !== "passed")) {
      const failedAssertions = report.testResults?.flatMap((suite) => suite.assertionResults ?? [])
        .filter((assertion) => assertion.status !== "passed")
        .map((assertion) => ({ ...safeAssertionDiagnostic(assertion),
          authCode: assertion.failureMessages?.join("\n").match(/PHASE9_AUTH_DIAGNOSTIC:(SESSION_MALFORMED|UNSUPPORTED_ALGORITHM|UNKNOWN_SIGNING_KEY|INVALID_SIGNATURE|SESSION_EXPIRED|INVALID_CLAIMS|SESSION_REVOKED|AUTH_PROVIDER_UNAVAILABLE|UNTRUSTED_PROVIDER_IDENTITY|NOT_OWNER)/u)?.[1] ?? null,
          httpStatus: assertion.failureMessages?.join("\n").match(/expected (200|400|401|403|409|429|500|503) to be (?:200|400|401|403|409|429|500|503)/u)?.[1] ?? null,
        })) ?? [];
      const diagnosticCodes = [...new Set((JSON.stringify(report) + test.stdout + test.stderr + logs.join("")).match(/\b(?:PHASE9_[A-Z_]+|OWNER_RATE_LIMIT_[A-Z_]+|INVALID_CLAIMS|INVALID_SIGNATURE|SESSION_REVOKED|AUTH_PROVIDER_UNAVAILABLE|UNKNOWN_SIGNING_KEY)\b/gu) ?? [])];
      console.error(JSON.stringify({ code: "PHASE9_OWNER_HTTP_ACCEPTANCE_TESTS_FAILED", assertions: failedAssertions, diagnosticCodes }));
      throw new Error("PHASE9_OWNER_HTTP_ACCEPTANCE_TESTS_FAILED");
    }
    executedTests = report.testResults.flatMap((suite) => (suite.assertionResults ?? []).map((assertion) => ({
      file: suite.name.replaceAll("\\", "/").split("/").slice(-3).join("/"),
      name: [...(assertion.ancestorTitles ?? []), assertion.title].join(" / "), status: assertion.status,
    })));
    passedTestCount = report.numPassedTests;
    postgresVersion = (await admin.query("select current_setting('server_version') as version")).rows[0]?.version ?? "unavailable";
    console.log(`Phase 9 Owner configuration acceptance passed: ${report.numPassedTests} passed, 0 skipped.`);
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
    if (/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|SERVICE_ROLE_KEY\s*[=:]\s*\S+|password\s*[=:]\s*\S+|SHOULD_NEVER_APPEAR_PHASE9_SECRET_7d0b0a/i.test(capturedLogs)) {
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
    ticket: 294, scope: "built-next-owner-configuration-http-real-auth-postgresql",
    runId: randomUUID(), githubRunId: process.env.GITHUB_RUN_ID ?? null, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    source: { commit: commit.status === 0 ? commit.stdout.trim() : "unavailable", treeSha256: workingTreeSourceSha256() },
    contractBundles, migrations,
    toolIdentity: { node: process.version, npm: npmVersion.status === 0 ? npmVersion.stdout.trim() : "unavailable",
      next: nextVersion, supabaseCli: supabaseVersion, postgres: postgresVersion },
    databaseRole: "restricted login granted shipwithali_application; bypassrls=false",
    fixtures: { owner: "synthetic linked GitHub test identity", portfolio: "synthetic configured test portfolio", session: "temporary Auth sessions" },
    verdict: "passed", namedChecks: ["all-three-configuration-operations", "valid-receipts-private-headers",
      "cross-instance-exact-replay-and-version-conflict", "csrf-origin-forwarded-host-and-non-owner-denials",
      "revoked-session-denial", "shared-database-rate-limit", "limiter-outage-fails-closed", "log-privacy"],
    operationExamples: [
      { operation: "updateOwnerProfileConfiguration", httpStatus: 200, receiptSchemaValid: true, oneLedgerAndOutboxRecord: true },
      { operation: "updateOwnerContactChannels", httpStatus: 200, receiptSchemaValid: true, oneLedgerAndOutboxRecord: true },
      { operation: "updateOwnerGlobalProjectCta", httpStatus: 200, receiptSchemaValid: true, oneLedgerAndOutboxRecord: true },
    ],
    passed: passedTestCount, failed: 0, skipped: 0, productionBuild: true, isolatedLoopbackSupabase: true,
    execution: { command: "npm run phase9:focus:owner-configuration-http", exitCode: 0,
      passed: executedTests.filter(({ status }) => status === "passed").length,
      failed: executedTests.filter(({ status }) => status === "failed").length, skipped: 0, tests: executedTests },
    cleanupVerified: true, credentialsRecorded: false, secretValuesRecorded: false,
  }, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "PHASE9_OWNER_HTTP_RUN_FAILED"); process.exitCode = 1; });
}
