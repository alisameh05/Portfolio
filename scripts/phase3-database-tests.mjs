#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const VITEST = `${ROOT}/node_modules/vitest/vitest.mjs`;
const TEST_FILES = process.argv.slice(2);

function databaseUrl() {
  const value = process.env.PHASE3_DATABASE_URL;
  if (!value) throw new Error("PHASE3_DATABASE_URL_REQUIRED");

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PHASE3_DATABASE_URL_INVALID");
  }
  if (!/^postgres(?:ql)?:$/.test(url.protocol)) {
    throw new Error("PHASE3_DATABASE_URL_INVALID");
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("PHASE3_DATABASE_NOT_LOOPBACK");
  }
  return value;
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-9;]*m/g, "");
}

function main() {
  if (TEST_FILES.length === 0) {
    console.error("✗ PHASE3_TEST_FILES_REQUIRED");
    process.exitCode = 1;
    return;
  }

  let connectionString;
  try {
    connectionString = databaseUrl();
  } catch (error) {
    console.error(`✗ ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const child = spawn(process.execPath, [VITEST, "run", ...TEST_FILES], {
    cwd: ROOT,
    env: {
      ...process.env,
      CI: "1",
      PHASE3_DATABASE_URL: connectionString,
      PHASE3_REQUIRE_DATABASE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => {
    output.push(chunk);
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.push(chunk);
    process.stderr.write(chunk);
  });
  child.on("error", () => {
    console.error("✗ PHASE3_TEST_RUNNER_FAILED");
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    const plain = stripAnsi(Buffer.concat(output).toString("utf8"));
    const skipped = /\b[1-9]\d*\s+skipped\b/i.test(plain);
    if (skipped) console.error("✗ skipped database suites are a failing verdict");
    process.exitCode = code === 0 && !skipped ? 0 : 1;
  });
}

main();
