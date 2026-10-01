#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "node_modules/supabase/dist/supabase.js");

export function requireDocker(run = spawnSync) {
  const result = run("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("LOCAL_AUTH_DOCKER_MISSING: install Docker with a running Linux engine, or use the Local Auth real-token CI check.");
  }
  if (result.error || result.status !== 0) {
    throw new Error("LOCAL_AUTH_DOCKER_UNAVAILABLE: start the Linux Docker engine and grant this runner engine access, or use the Local Auth real-token CI check.");
  }
}

export function requireExecutedTests(report) {
  if (report.success !== true || report.numPassedTests < 1 || report.numFailedTests !== 0 ||
      report.numPendingTests !== 0 || report.numTodoTests !== 0 ||
      report.testResults?.length !== 1 || report.testResults[0].status !== "passed") {
    throw new Error("LOCAL_AUTH_TEST_FAILED: the real-token suite must execute and pass with zero skipped tests.");
  }
}

export function isolatedConfig(source, id) {
  return source
    .replace(/^project_id = .*$/m, `project_id = "${id}"`)
    .replace(/(\[api\]\s*)enabled = false/, "$1enabled = true")
    .replace(/(\[auth\]\s*)enabled = false/, "$1enabled = true")
    .replace(/^port = 54321$/m, "port = 56321")
    .replace(/^port = 54322$/m, "port = 56322")
    .replace(/^shadow_port = 54320$/m, "shadow_port = 56320");
}

export function localEnvironment(source = process.env) {
  const env = { ...source, CI: "1" };
  for (const key of Object.keys(env)) {
    if (/^(?:SUPABASE_|PHASE4_|DATABASE_|OWNER_GITHUB_)/.test(key)) delete env[key];
  }
  return env;
}

export function main() {
  requireDocker();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const installed = JSON.parse(readFileSync(join(ROOT, "node_modules/supabase/package.json"), "utf8"));
  if (installed.version !== pkg.devDependencies.supabase) throw new Error("LOCAL_AUTH_CLI_PIN_MISMATCH");
  const workdir = mkdtempSync(join(tmpdir(), "shipwithali-auth-"));
  const id = `shipwithali-auth-${randomUUID()}`;
  const env = localEnvironment();
  const network = `${id}-loopback`;
  let networkCreated = false;
  let attemptedStart = false;
  let failure;
  const invoke = (args, timeout = 600_000) => {
    const result = spawnSync(process.execPath, [CLI, "--workdir", workdir, ...args], {
      cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout,
    });
    if (result.error || result.status !== 0) throw new Error(`LOCAL_AUTH_CLI_FAILED:${args[0]} (raw output suppressed to protect credentials)`);
    return result.stdout;
  };
  try {
    const dir = join(workdir, "supabase");
    mkdirSync(dir);
    writeFileSync(join(dir, "config.toml"), isolatedConfig(readFileSync(join(ROOT, "supabase/config.toml"), "utf8"), id));
    cpSync(join(ROOT, "supabase/migrations"), join(dir, "migrations"), { recursive: true });
    copyFileSync(join(ROOT, "supabase/seed.sql"), join(dir, "seed.sql"));
    const created = spawnSync("docker", ["network", "create", "-o", "com.docker.network.bridge.host_binding_ipv4=127.0.0.1", network], {
      env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (created.error || created.status !== 0) throw new Error("LOCAL_AUTH_NETWORK_FAILED");
    networkCreated = true;
    attemptedStart = true;
    console.log("Starting isolated loopback Supabase Auth; first run may download container images.");
    invoke(["start", "--network-id", network]);
    const status = JSON.parse(invoke(["status", "-o", "json"], 30_000));
    const url = new URL(status.API_URL);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "56321") {
      throw new Error("LOCAL_AUTH_ENDPOINT_NOT_ISOLATED");
    }
    for (const key of ["ANON_KEY", "SERVICE_ROLE_KEY"]) {
      if (typeof status[key] !== "string" || !status[key]) throw new Error(`LOCAL_AUTH_STATUS_MISSING:${key}`);
    }
    const reportPath = join(workdir, "test-report.json");
    const result = spawnSync(process.execPath, [join(ROOT, "node_modules/vitest/vitest.mjs"), "run",
      "tests/phase4/local-auth-token.integration.test.ts", "--reporter=json", `--outputFile=${reportPath}`], {
      cwd: ROOT, env: { ...env, PHASE4_REQUIRE_LOCAL_AUTH: "1", PHASE4_LOCAL_AUTH_URL: status.API_URL,
        PHASE4_LOCAL_AUTH_ANON_KEY: status.ANON_KEY, PHASE4_LOCAL_AUTH_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY },
      encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"],
    });
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    if (result.error || result.status !== 0) {
      const messages = report.testResults?.flatMap((suite) => suite.assertionResults?.flatMap((test) => test.failureMessages ?? []) ?? []).join("\n") ?? "";
      const safeCode = messages.match(/LOCAL_AUTH_[A-Z_]+(?::[a-z0-9_:]+)?/)?.[0] ?? "assertion";
      const location = messages.match(/local-auth-token\.integration\.test\.ts:\d+/)?.[0] ?? "unknown line";
      throw new Error(`LOCAL_AUTH_TEST_FAILED:${safeCode}:${location} (raw output suppressed to protect credentials)`);
    }
    requireExecutedTests(report);
    console.log(`Local Auth real-token integration: ${report.numPassedTests} passed, 0 skipped.`);
  } catch (error) {
    failure = error;
  } finally {
    let cleanupFailed = false;
    if (attemptedStart) {
      try { invoke(["stop", "--no-backup"], 90_000); } catch { cleanupFailed = true; }
    }
    if (networkCreated) {
      const result = spawnSync("docker", ["network", "rm", network], { env, stdio: "ignore", timeout: 20_000 });
      if (result.error || result.status !== 0) cleanupFailed = true;
    }
    // Only remove the absolute directory created by this invocation under tmpdir.
    if (resolve(workdir).startsWith(`${resolve(tmpdir())}\\`) || resolve(workdir).startsWith(`${resolve(tmpdir())}/`)) {
      rmSync(workdir, { recursive: true, force: true });
    }
    if (cleanupFailed) failure = new Error("LOCAL_AUTH_CLEANUP_FAILED: isolated containers/network require cleanup; validation failed.");
  }
  if (failure) throw failure;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error && error.message.startsWith("LOCAL_AUTH_") ? error.message : "LOCAL_AUTH_RUNNER_FAILED: raw diagnostics suppressed to protect credentials.");
    process.exitCode = 1;
  }
}
