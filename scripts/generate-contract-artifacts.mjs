#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const redoclyCli = resolve(ROOT, "node_modules/@redocly/cli/bin/cli.js");
const openapiTsCli = resolve(ROOT, "node_modules/@hey-api/openapi-ts/bin/run.js");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const outputRoot = resolve(option("--output-root", ROOT));
const publicBundle = resolve(outputRoot, "openapi/generated/public-v1.json");
const ownerBundle = resolve(outputRoot, "openapi/generated/owner-v1.json");
const publicGenerated = resolve(outputRoot, "src/contracts/http/v1/generated");
const ownerGenerated = resolve(outputRoot, "src/contracts/http/owner/v1/generated");

mkdirSync(resolve(outputRoot, "openapi/generated"), { recursive: true });
mkdirSync(publicGenerated, { recursive: true });
mkdirSync(ownerGenerated, { recursive: true });

function runNode(script, arguments_, environment = {}) {
  execFileSync(process.execPath, [script, ...arguments_], {
    cwd: ROOT,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
}

console.log(`Building public-v1 artifacts in ${outputRoot}`);
runNode(redoclyCli, ["bundle", "public@v1", "--output", publicBundle, "--ext", "json"]);
runNode(openapiTsCli, [], {
  CONTRACT_PUBLIC_INPUT: publicBundle,
  CONTRACT_PUBLIC_OUTPUT: publicGenerated,
});

console.log(`Building owner-v1 artifacts in ${outputRoot}`);
runNode(redoclyCli, ["bundle", "owner@v1", "--output", ownerBundle, "--ext", "json"]);
runNode(openapiTsCli, ["--file", "openapi-owner-ts.config.ts"], {
  CONTRACT_OWNER_INPUT: ownerBundle,
  CONTRACT_OWNER_OUTPUT: ownerGenerated,
});

execFileSync(process.execPath, ["scripts/strictify-generated-zod.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    CONTRACT_PUBLIC_ZOD: resolve(publicGenerated, "zod.gen.ts"),
    CONTRACT_OWNER_ZOD: resolve(ownerGenerated, "zod.gen.ts"),
  },
  stdio: "inherit",
});

console.log(`Contract artifacts generated successfully in ${outputRoot}`);
