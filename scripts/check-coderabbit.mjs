#!/usr/bin/env node
/**
 * check-coderabbit.mjs
 *
 * Phase 1 CodeRabbit inventory check (#10 evidence, #12 gate).
 *
 * Verifies:
 *   1. No repository-controlled CodeRabbit integration exists:
 *      - no `.github/workflows/*coderabbit*` or inline `coderabbit` job
 *      - no `.coderabbit.yaml` / `.coderabbit.yml`
 *      - no `coderabbit` secrets references in workflows
 *      - no source references to coderabbit outside docs/spec/evidence
 *   2. `evidence/phase-1-review-policy.md` exists and records either a
 *      complete removal or a named external blocker (responsible owner +
 *      required action).
 *   3. `scripts/check-review-policy.mjs` concerns remain satisfied
 *      (delegated to that script by the gate; reported here for evidence).
 *
 * Exits non-zero when repository-controlled CodeRabbit surface exists or
 * when the evidence checklist is missing/incomplete. External administrative
 * blockers recorded with a named owner and action do NOT fail this check;
 * they are surfaced in the report so the Phase 1 gate can retain them as
 * durable evidence (the gate verdict records them; unresolved
 * repository-controlled remediation fails the gate).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const EVIDENCE = join(ROOT, "evidence", "phase-1-review-policy.md");

function toPosix(p) {
  return p.split("\\").join("/");
}

function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of [...entries].sort()) {
    if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) out.push(...listFilesRecursive(full));
    else out.push(full);
  }
  return out;
}

export function buildCodeRabbitReport(root = ROOT) {
  const findings = [];

  // 1a. Workflow files referencing coderabbit.
  const workflowsDir = join(root, ".github", "workflows");
  if (existsSync(workflowsDir)) {
    for (const file of listFilesRecursive(workflowsDir)) {
      const base = file.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
      if (base.includes("coderabbit")) {
        findings.push({ file: toPosix(relative(root, file)), reason: "coderabbit-workflow-file" });
        continue;
      }
      try {
        const content = readFileSync(file, "utf8");
        if (/coderabbit/i.test(content)) {
          findings.push({ file: toPosix(relative(root, file)), reason: "coderabbit-workflow-reference" });
        }
        if (/secrets\s*\.\s*CODERABBIT/i.test(content)) {
          findings.push({ file: toPosix(relative(root, file)), reason: "coderabbit-secret-reference" });
        }
      } catch {
        // skip unreadable
      }
    }
  }

  // 1b. Repo-root CodeRabbit config.
  for (const name of [".coderabbit.yaml", ".coderabbit.yml", ".coderabbitai.yaml"]) {
    if (existsSync(join(root, name))) {
      findings.push({ file: name, reason: "coderabbit-config-file" });
    }
  }

  // 1c. Source references outside allowed docs/spec/evidence.
  const allowedPrefixes = ["docs/", "evidence/", "AGENTS.md", ".scratch/"];
  for (const file of listFilesRecursive(join(root, "src"))) {
    try {
      if (/coderabbit/i.test(readFileSync(file, "utf8"))) {
        findings.push({ file: toPosix(relative(root, file)), reason: "coderabbit-source-reference" });
      }
    } catch {
      // skip
    }
  }
  for (const file of [...listFilesRecursive(join(root, "scripts")), ...listFilesRecursive(join(root, "tests"))]) {
    try {
      const content = readFileSync(file, "utf8");
      if (/coderabbit/i.test(content)) {
        const rel = toPosix(relative(root, file));
        // Allowlist: the inventory seam itself, its gate wiring, the
        // review-policy check, and gate conformance tests legitimately mention
        // CodeRabbit to prohibit it (policy declaration, not integration).
        if (rel.endsWith("check-coderabbit.mjs")) continue;
        if (rel.endsWith("check-review-policy.mjs")) continue;
        if (rel.endsWith("phase1-gate.mjs")) continue;
        if (rel.startsWith("tests/phase1/")) continue;
        if (/CodeRabbit must not be added|Codex is the sole AI/i.test(content)) continue;
        findings.push({ file: rel, reason: "coderabbit-script-or-test-reference" });
      }
    } catch {
      // skip
    }
  }

  // 2. Evidence checklist.
  const evidenceChecks = [];
  if (!existsSync(EVIDENCE)) {
    evidenceChecks.push({ name: "coderabbit-evidence-present", passed: false, detail: "evidence/phase-1-review-policy.md missing" });
  } else {
    const content = readFileSync(EVIDENCE, "utf8");
    const hasInventory = /Search performed|inventory/i.test(content);
    const hasRemovalOrPlan =
      /No repository-controlled CodeRabbit|Removals \/ absences/i.test(content) &&
      (/Responsible owner|Required action|blocked/i.test(content) || /removed/i.test(content));
    evidenceChecks.push({
      name: "coderabbit-evidence-present",
      passed: true,
      detail: "evidence/phase-1-review-policy.md retained",
    });
    evidenceChecks.push({
      name: "coderabbit-inventory-recorded",
      passed: hasInventory,
      detail: hasInventory ? "inventory categories recorded" : "inventory section missing",
    });
    evidenceChecks.push({
      name: "coderabbit-removal-or-named-plan",
      passed: hasRemovalOrPlan,
      detail: hasRemovalOrPlan
        ? "removal result or named owner/action recorded"
        : "removal result and named plan missing",
    });
  }

  const repoControlledClean = findings.length === 0;
  const evidenceOk = evidenceChecks.every((c) => c.passed);
  return { findings, evidenceChecks, repoControlledClean, evidenceOk };
}

export function main() {
  const report = buildCodeRabbitReport();
  for (const check of report.evidenceChecks) {
    console.log(`${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  if (report.findings.length > 0) {
    for (const f of report.findings) console.error(`  ✗ coderabbit surface: ${f.file} (${f.reason})`);
    console.error(`✗ coderabbit check: ${report.findings.length} repository-controlled finding(s)`);
    return 1;
  }
  console.log("✓ coderabbit check: no repository-controlled CodeRabbit surface");
  if (!report.evidenceOk) {
    console.error("✗ coderabbit check: evidence checklist incomplete");
    return 1;
  }
  console.log("✓ coderabbit check: removal evidence retained with named plan where blocked");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  process.argv[1].split("\\").join("/").endsWith("scripts/check-coderabbit.mjs");
if (invokedDirectly) {
  process.exitCode = main();
}
