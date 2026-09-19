#!/usr/bin/env node
/**
 * check-review-policy.mjs
 *
 * Deterministic check that AGENTS.md contains the Codex review policy
 * covering all required concerns and does not designate a second AI reviewer.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\\/]$/, "");
const agents = readFileSync(join(ROOT, "../AGENTS.md"), "utf8");

const required = [
  "domain invariants",
  "illegal module dependencies",
  "provider-type leakage",
  "authorization and RLS",
  "secrets and privacy",
  "SQL/migration safety",
  "OpenAPI compatibility",
  "generated drift",
  "negative tests",
  "operational rollback",
  "backend-only scope",
];

const missing = required.filter((r) => !agents.toLowerCase().includes(r.toLowerCase()));

if (missing.length > 0) {
  console.error("✗ Missing required review concerns:", missing.join(", "));
  process.exit(1);
}

if (!agents.includes("Codex is the sole AI pull-request reviewer")) {
  console.error("✗ Codex sole AI reviewer declaration missing");
  process.exit(1);
}

if (!agents.includes("CodeRabbit must not be added")) {
  console.error("✗ CodeRabbit prohibition missing");
  process.exit(1);
}

if (agents.toLowerCase().includes("coderabbit") && !agents.includes("CodeRabbit must not be added")) {
  console.error("✗ Second AI reviewer referenced without prohibition");
  process.exit(1);
}

console.log("✓ Codex review policy check passed (all concerns present, no second AI reviewer)");
