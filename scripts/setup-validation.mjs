#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { observeRuntime, removeInstallStamp, ROOT, verifyEnvironment, writeInstallStamp } from "./validation-environment.mjs";

const runtime = observeRuntime();
const errors = verifyEnvironment(ROOT, runtime, { runtimeOnly: true });
if (errors.length) {
  errors.forEach((error) => console.error(error));
  process.exitCode = 1;
} else {
  removeInstallStamp(ROOT);
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "ci", "--include=dev", "--include=optional", "--ignore-scripts=false", "--no-audit", "--no-fund"], {
    cwd: ROOT, stdio: "inherit", env: process.env,
  });
  if (result.error || result.status !== 0) {
    console.error("VALIDATION_INSTALL_FAILED: dependency installation did not complete. For HTTP 403, run this command in the cloud setup/maintenance phase with registry.npmjs.org accessible; preserve proxy and TLS policy.");
    process.exitCode = result.status || 1;
  } else {
    const installedErrors = verifyEnvironment(ROOT, runtime, { requireStamp: false });
    installedErrors.forEach((error) => console.error(error));
    if (installedErrors.length) process.exitCode = 1;
    else {
      writeInstallStamp(ROOT);
      console.log("Validation dependencies installed and stamped for this package.json/package-lock.json.");
    }
  }
}
