#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readOptionalGitAlternates } from "./git-object-alternates.mjs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const mode = process.argv[2] ?? "phase6";
if (!["phase6", "gate", "media-cv-integration", "checks"].includes(mode)) {
  console.error("Usage: node scripts/docker-validation.mjs [phase6|gate|media-cv-integration|checks]");
  process.exit(2);
}
function capture(command, args, message) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (result.error || result.status !== 0) throw new Error(message);
  return result.stdout.trim();
}
try {
  const os = capture("docker", ["info", "--format", "{{.OSType}}"],
    "Docker engine is unavailable. Install/start Docker Desktop with Linux containers, or start Docker Engine on Linux. A Dockerfile cannot supply an engine to a restricted cloud runner.");
  if (os !== "linux") throw new Error("Switch Docker Desktop to Linux containers before running validation.");
  capture("docker", ["compose", "version"], "Docker Compose is unavailable. Install the Compose plugin or Docker Desktop.");
  const env = { ...process.env,
    PORTFOLIO_GIT_DIR: capture("git", ["rev-parse", "--absolute-git-dir"], "Run this command from a Git checkout."),
    PORTFOLIO_GIT_COMMON_DIR: capture("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], "Cannot locate Git common directory."),
  };
  const alternatesFile = join(env.PORTFOLIO_GIT_COMMON_DIR, "objects", "info", "alternates");
  const alternates = readOptionalGitAlternates(alternatesFile);
  if (alternates) {
    env.PORTFOLIO_MAIN_OBJECTS = resolve(root, alternates.replaceAll("\\", "/"));
    env.PORTFOLIO_USE_MAIN_OBJECTS = "1";
  } else {
    env.PORTFOLIO_MAIN_OBJECTS = env.PORTFOLIO_GIT_COMMON_DIR;
    env.PORTFOLIO_USE_MAIN_OBJECTS = "0";
  }
  mkdirSync(new URL("../evidence/", import.meta.url), { recursive: true });
  const prefix = ["compose", "--project-name", "portfolio-validation", "--file", "compose.validation.yaml"];
  // The fixed project name prevents two runs from sharing the cache daemon.
  const active = capture("docker", [...prefix, "ps", "--all", "--status", "running", "--quiet"], "Cannot inspect validation containers.");
  if (active) throw new Error("Portfolio Docker validation is already running. Wait for it to finish before starting another run.");
  const result = spawnSync("docker", [...prefix, "run", "--build", "--rm", "--name", "portfolio-validation-runner", "validation", mode], {
    cwd: root, env, stdio: "inherit", windowsHide: true,
  });
  process.exitCode = result.status ?? 1;
  if (result.error) console.error("Docker validation could not start or was interrupted.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
