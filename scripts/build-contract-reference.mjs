#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const redoclyCli = resolve(ROOT, "node_modules/@redocly/cli/bin/cli.js");
const outputOption = process.argv.indexOf("--output-root");
const outputRoot = resolve(
  outputOption === -1 ? "artifacts/openapi-reference" : process.argv[outputOption + 1],
);

mkdirSync(outputRoot, { recursive: true });

for (const surface of ["public", "owner"]) {
  const api = `${surface}@v1`;
  const output = resolve(outputRoot, `${surface}-v1.html`);
  execFileSync(process.execPath, [redoclyCli, "build-docs", api, "--output", output], {
    cwd: ROOT,
    stdio: "inherit",
  });
}

console.log(`Local contract reference documentation written to ${outputRoot}`);
