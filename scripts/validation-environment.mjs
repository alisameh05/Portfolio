#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../", import.meta.url));
const STAMP = ".shipwithali-validation.json";
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export function fingerprint(root) {
  return createHash("sha256")
    .update(readFileSync(join(root, "package.json")))
    .update("\0")
    .update(readFileSync(join(root, "package-lock.json")))
    .digest("hex");
}

export function writeInstallStamp(root) {
  writeFileSync(join(root, "node_modules", STAMP), JSON.stringify({ fingerprint: fingerprint(root) }) + "\n");
}

export function removeInstallStamp(root) {
  rmSync(join(root, "node_modules", STAMP), { force: true });
}

export function observeRuntime() {
  // npm supplies its own CLI path, avoiding npm.cmd spawning and PATH ambiguity on Windows.
  const cli = process.env.npm_execpath;
  const result = cli ? spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" }) : undefined;
  return { node: process.versions.node, npm: result?.status === 0 ? result.stdout.trim() : "unknown" };
}

export function verifyEnvironment(root, runtime, { runtimeOnly = false, requireStamp = true } = {}) {
  const pkg = json(join(root, "package.json"));
  const errors = [];
  if (readFileSync(join(root, ".nvmrc"), "utf8").trim() !== pkg.engines.node || pkg.packageManager !== `npm@${pkg.engines.npm}`) {
    errors.push("VALIDATION_PIN_DRIFT: .nvmrc, engines and packageManager must agree");
  }
  if (runtime.node !== pkg.engines.node) errors.push(`VALIDATION_NODE_MISMATCH: use Node ${pkg.engines.node}; found ${runtime.node}`);
  if (runtime.npm !== pkg.engines.npm) errors.push(`VALIDATION_NPM_MISMATCH: use npm ${pkg.engines.npm}; found ${runtime.npm}`);
  if (runtimeOnly) return errors;
  for (const [name, expected] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
    let actual;
    try { actual = json(join(root, "node_modules", name, "package.json")).version; } catch { /* missing or invalid installation */ }
    if (actual !== expected) errors.push(`VALIDATION_DEPENDENCY_MISMATCH: ${name} needs ${expected}; found ${actual ?? "missing"}`);
  }
  if (requireStamp) {
    let stamp;
    try { stamp = json(join(root, "node_modules", STAMP)); } catch { /* setup has not completed */ }
    if (stamp?.fingerprint !== fingerprint(root)) errors.push("VALIDATION_INSTALL_STALE: run npm run setup:validation in the network-enabled setup phase");
  }
  return errors;
}

export function main() {
  const errors = verifyEnvironment(ROOT, observeRuntime(), { runtimeOnly: process.argv.includes("--runtime-only") });
  errors.forEach((error) => console.error(error));
  if (!errors.length) console.log("Validation environment ready: exact Node/npm and locked dependencies verified.");
  return errors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
