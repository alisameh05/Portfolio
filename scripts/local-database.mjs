#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const PACKAGE_PATH = join(ROOT, "node_modules", "supabase", "package.json");
const CLI_ENTRY = join(ROOT, "node_modules", "supabase", "dist", "supabase.js");

const ACTIONS = Object.freeze({
  start: ["start"],
  status: ["status", "--output", "json"],
  reset: ["db", "reset", "--local"],
  reuse: ["start"],
  stop: ["stop"],
});

const SUCCESS = Object.freeze({
  start: "Local Supabase stack started; repository migrations and seed were applied.",
  status: "Local Supabase stack is running.",
  reset: "Local database reset from repository migrations and non-secret seed.",
  reuse: "Local Supabase stack is ready for reuse.",
  stop: "Local Supabase stack stopped; its local data volume was preserved.",
});

function localOnlyEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    "DATABASE_URL",
    "DATABASE_DIRECT_URL",
    "SUPABASE_ACCESS_TOKEN",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_DB_PASSWORD",
    "SUPABASE_PROJECT_ID",
  ]) {
    delete environment[name];
  }
  environment.CI = "1";
  return environment;
}

function installedSupabaseVersion() {
  if (!existsSync(PACKAGE_PATH) || !existsSync(CLI_ENTRY)) {
    throw new Error("LOCAL_SUPABASE_CLI_MISSING");
  }
  return JSON.parse(readFileSync(PACKAGE_PATH, "utf8")).version;
}

function plan(action) {
  const args = ACTIONS[action];
  if (!args) {
    throw new Error(`UNKNOWN_LOCAL_DATABASE_ACTION:${action ?? "missing"}`);
  }
  return {
    source: "project-local",
    package: `supabase@${installedSupabaseVersion()}`,
    args,
  };
}

function classifyFailure(output) {
  const normalized = output.toLowerCase();
  if (
    normalized.includes("docker") &&
    (normalized.includes("not running") ||
      normalized.includes("failed to connect") ||
      normalized.includes("cannot connect") ||
      normalized.includes("the system cannot find the file specified"))
  ) {
    return "LOCAL_DB_DOCKER_UNAVAILABLE: start Docker Desktop, then retry the same npm command.";
  }
  if (normalized.includes("not running") || normalized.includes("no such container")) {
    return "LOCAL_DB_NOT_RUNNING: run npm run db:start before inspecting or resetting the stack.";
  }
  return "LOCAL_DB_COMMAND_FAILED: inspect local Docker state; raw CLI output was suppressed to protect credentials.";
}

async function execute(action) {
  const invocation = plan(action);
  console.log(`… ${action}: running ${invocation.package} from this repository`);

  const child = spawn(process.execPath, [CLI_ENTRY, ...invocation.args], {
    cwd: ROOT,
    env: localOnlyEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk));
  child.stderr.on("data", (chunk) => chunks.push(chunk));

  const heartbeat = setInterval(() => {
    console.log(`… ${action}: waiting for the local Supabase command to finish`);
  }, 10_000);

  const exitCode = await new Promise((resolve) => {
    child.on("error", (error) => {
      chunks.push(Buffer.from(error.message));
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
  clearInterval(heartbeat);

  if (exitCode === 0) {
    console.log(`✓ ${SUCCESS[action]}`);
    return 0;
  }

  console.error(`✗ ${classifyFailure(Buffer.concat(chunks).toString("utf8"))}`);
  return exitCode;
}

const [action, option] = process.argv.slice(2);
try {
  if (option === "--plan") {
    console.log(JSON.stringify(plan(action)));
  } else {
    process.exitCode = await execute(action);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "LOCAL_DB_COMMAND_FAILED";
  console.error(`✗ ${message}`);
  process.exitCode = 1;
}
