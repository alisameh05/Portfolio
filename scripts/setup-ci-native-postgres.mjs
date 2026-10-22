#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { CI_NATIVE_POSTGRES_MAJOR, requireSupportedNativePostgres } from "./native-postgres-runtime.mjs";

/** Official signed PGDG setup; intentionally confined to the hosted Ubuntu job. */
export function setupCiNativePostgres({ platform = process.platform, env = process.env,
  readFile = readFileSync, appendFile = appendFileSync, run = spawnSync } = {}) {
  if (platform !== "linux" || env.GITHUB_ACTIONS !== "true" || !env.GITHUB_ENV) {
    throw new Error("CI_NATIVE_POSTGRES_HOST_REQUIRED");
  }
  const release = readFile("/etc/os-release", "utf8");
  if (!/^ID=ubuntu$/mu.test(release) || !/^VERSION_ID="24\.04"$/mu.test(release)) {
    throw new Error("CI_NATIVE_POSTGRES_HOST_REQUIRED");
  }
  function checked(command, args, { input, capture = false } = {}) {
    const result = run(command, args, { encoding: "utf8", timeout: 600_000,
      stdio: capture ? "pipe" : input ? ["pipe", "inherit", "inherit"] : "inherit", ...(input ? { input } : {}) });
    if (result.error || result.status !== 0) throw new Error("CI_NATIVE_POSTGRES_SETUP_COMMAND_FAILED");
    return String(result.stdout ?? "").trim();
  }
  const architecture = checked("dpkg", ["--print-architecture"], { capture: true });
  if (!["amd64", "arm64"].includes(architecture)) throw new Error("CI_NATIVE_POSTGRES_HOST_REQUIRED");
  // https://www.postgresql.org/download/linux/ubuntu/ (manual repository setup)
  checked("sudo", ["apt-get", "update"]);
  checked("sudo", ["apt-get", "install", "-y", "curl", "ca-certificates"]);
  checked("sudo", ["install", "-d", "/usr/share/postgresql-common/pgdg"]);
  checked("sudo", ["curl", "--fail", "--silent", "--show-error", "--location", "-o",
    "/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc", "https://www.postgresql.org/media/keys/ACCC4CF8.asc"]);
  checked("sudo", ["tee", "/etc/apt/sources.list.d/pgdg.sources"], { input:
    `Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: noble-pgdg\nArchitectures: ${architecture}\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n` });
  checked("sudo", ["apt-get", "update"]);
  checked("sudo", ["apt-get", "install", "-y", `postgresql-${CI_NATIVE_POSTGRES_MAJOR}`]);
  const bin = `/usr/lib/postgresql/${CI_NATIVE_POSTGRES_MAJOR}/bin`;
  const versionOutput = checked(`${bin}/postgres`, ["--version"], { capture: true });
  const version = requireSupportedNativePostgres(versionOutput.match(/PostgreSQL\)\s+(\d+\.\d+(?:\.\d+)?)/u)?.[1]);
  if (Number(version.split(".")[0]) !== CI_NATIVE_POSTGRES_MAJOR) throw new Error("CI_NATIVE_POSTGRES_SELECTED_MAJOR_MISMATCH");
  appendFile(env.GITHUB_ENV, `PHASE7_POSTGRES_BIN=${bin}\n`);
  return { bin, version };
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/setup-ci-native-postgres.mjs")) {
  console.log(JSON.stringify(setupCiNativePostgres()));
}
