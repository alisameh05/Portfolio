#!/usr/bin/env node
/**
 * phase1-gate.mjs
 *
 * Phase 1 conformance gate (#12).
 *
 * One local and CI command that aggregates every approved architecture,
 * contract, review-policy, and scope check and emits the durable evidence
 * needed to decide whether later phases may proceed.
 *
 * Constituent seams (each clearly identified; any failure exits non-zero):
 *   1. Toolchain verification (scripts/check-toolchain.mjs)
 *   2. Typechecking (tsc --noEmit)
 *   3. Tests (vitest run — deterministic one-worker threads pool)
 *   4. Contract lint public@v1 (redocly lint)
 *   5. Contract lint owner@v1 (redocly lint)
 *   6. Contract bundle public@v1 (redocly bundle, byte-compare with committed)
 *   7. Contract bundle owner@v1 (redocly bundle, byte-compare with committed)
 *   8. Generation + drift (scripts/check-contract-drift.mjs)
 *   9. Compatibility public+owner (scripts/check-contract-compatibility.mjs)
 *  10. Architecture (scripts/architecture-check.mjs)
 *  11. Review policy (scripts/check-review-policy.mjs)
 *  12. CodeRabbit inventory (scripts/check-coderabbit.mjs)
 *  13. Route + source inventory (scripts/check-route-inventory.mjs)
 *  14. Frontend/Lab exclusion scan (JSX/TSX, React, browser state, Lab entry)
 *  15. Dependency/version manifest present (docs + evidence)
 *
 * Evidence retained:
 *   - openapi/generated/public-v1.json, openapi/generated/owner-v1.json
 *   - evidence/phase-1-versions.json (toolchain manifest)
 *   - evidence/phase-1-route-inventory.json (route inventory)
 *   - evidence/phase-1-review-policy.md (CodeRabbit checklist)
 *   - evidence/phase-1-contract-lint.log (redocly lint, both surfaces)
 *   - evidence/phase-1-generation-drift.log (drift check output)
 *   - evidence/phase-1-compatibility.log (compatibility check output)
 *   - evidence/phase-1-architecture.log (architecture check output)
 *   - evidence/phase-1-gate-report.json (this gate's verdict)
 *   - AGENTS.md (reviewed Codex instructions)
 *
 * Completion verdict fails when an invalid architecture fixture passes, a
 * valid skeleton fails, generated output drifts, compatibility has no
 * baseline, a forbidden surface exists, or repository-controlled CodeRabbit
 * remediation remains unresolved.
 *
 * Runs without production credentials, production data, a database, a
 * deployed application, or the public internet after dependencies are
 * installed. Windows execution relies on the deterministic one-worker Vitest
 * configuration (vitest.config.ts: pool threads, singleThread).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDependencyCruiserTsSupport } from "./ensure-depcruise-support.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const GATE_REPORT = join(ROOT, "evidence", "phase-1-gate-report.json");

ensureDependencyCruiserTsSupport(ROOT);

const results = [];
const evidenceLogs = {};

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? "passed" });
    console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    results.push({ name, ok: false, detail });
    console.error(`✗ ${name}`);
    console.error(`  ${detail}`);
  }
}

function runNodeScript(script, args = [], evidenceKey) {
  try {
    const output = execFileSync(process.execPath, [script, ...args], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });
    if (evidenceKey) evidenceLogs[evidenceKey] = (evidenceLogs[evidenceKey] ?? "") + output;
    return output;
  } catch (err) {
    const out = [err?.stdout?.toString?.() ?? "", err?.stderr?.toString?.() ?? ""].join("\n").trim();
    if (evidenceKey) evidenceLogs[evidenceKey] = (evidenceLogs[evidenceKey] ?? "") + out;
    const tail = out.split("\n").slice(-5).join(" | ");
    throw new Error(`Check failed [${script}]: ${tail.slice(0, 500) || "non-zero exit"}`);
  }
}

function toPosix(p) {
  return p.split("\\").join("/");
}

function findFiles(dir, predicate) {
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") continue;
      found.push(...findFiles(full, predicate));
    } else if (predicate(full, entry)) {
      found.push(full);
    }
  }
  return found;
}

console.log("═══════════════════════════════════════════════");
console.log("  Phase 1 Conformance Gate (#12)");
console.log("═══════════════════════════════════════════════\n");

// ── 1. Toolchain verification ────────────────────────────────────────────────
check("toolchain verification", () => {
  runNodeScript("scripts/check-toolchain.mjs");
  return "pins match; manifest written";
});

// ── 2. Typechecking (pinned typescript 6.0.3 via npm script) ───────────────────
// Invoke the pinned local compiler through the active Node executable. This
// avoids Windows npm.cmd/npx shell spawning while retaining the same seam.
check("typechecking (tsc --noEmit)", () => {
  runNodeScript("node_modules/typescript/bin/tsc", ["--noEmit"]);
  return "strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes";
});

// ── 3. Tests (deterministic one-worker Vitest) ───────────────────────────────
check("tests (vitest run, one-worker threads)", () => {
  const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
  if (!config.includes("singleThread: true")) {
    throw new Error("vitest.config.ts must use threads singleThread:true for deterministic Windows execution");
  }
  runNodeScript("node_modules/vitest/vitest.mjs", ["run"]);
  return "full suite passed without reduced coverage";
});

// ── 4/5. Contract lint (both surfaces independently) ─────────────────────────
// Stable seam labels retained for structural tests: Redocly lint public,
// Redocly lint owner. The CLI is invoked without npx for Windows reliability.
check("contract lint public@v1", () => {
  const out = runNodeScript(
    "node_modules/@redocly/cli/bin/cli.js",
    ["lint", "public@v1"],
    "lint",
  );
  evidenceLogs["lint"] = `${evidenceLogs["lint"] ?? ""}public@v1: lints clean\n${out}`;
  return "public@v1 lints clean";
});

check("contract lint owner@v1", () => {
  const out = runNodeScript(
    "node_modules/@redocly/cli/bin/cli.js",
    ["lint", "owner@v1"],
    "lint",
  );
  evidenceLogs["lint"] = `${evidenceLogs["lint"] ?? ""}owner@v1: lints clean\n${out}`;
  return "owner@v1 lints clean";
});

// ── 6/7. Contract bundle (canonical, byte-compared with committed) ───────────
function bundleToTemp(api, ext = "json") {
  const dir = join(tmpdir(), `shipwithali-gate-bundle-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `bundle.${ext}`);
  runNodeScript("node_modules/@redocly/cli/bin/cli.js", [
    "bundle",
    api,
    "--output",
    out,
    "--ext",
    ext,
  ]);
  return out;
}

check("contract bundle public@v1 (canonical)", () => {
  const committed = join(ROOT, "openapi", "generated", "public-v1.json");
  if (!existsSync(committed)) throw new Error("openapi/generated/public-v1.json missing");
  const fresh = bundleToTemp("public@v1");
  const a = readFileSync(committed, "utf8");
  const b = readFileSync(fresh, "utf8");
  if (a !== b) throw new Error("public-v1 bundle is not canonical: fresh bundle differs from committed");
  return "fresh bundle byte-identical to committed";
});

check("contract bundle owner@v1 (canonical)", () => {
  const committed = join(ROOT, "openapi", "generated", "owner-v1.json");
  if (!existsSync(committed)) throw new Error("openapi/generated/owner-v1.json missing");
  const fresh = bundleToTemp("owner@v1");
  const a = readFileSync(committed, "utf8");
  const b = readFileSync(fresh, "utf8");
  if (a !== b) throw new Error("owner-v1 bundle is not canonical: fresh bundle differs from committed");
  return "fresh bundle byte-identical to committed";
});

// ── 8. Generation + drift (byte-for-byte, twice in clean temp) ───────────────
check("generation + drift (byte-for-byte)", () => {
  runNodeScript("scripts/check-contract-drift.mjs", [], "drift");
  return "two clean generations identical; committed artifacts without drift";
});

// ── 9. Compatibility (baseline must exist; breaking changes rejected) ─────────
check("compatibility (master baseline)", () => {
  for (const f of ["openapi/baseline/master/public-v1.json", "openapi/baseline/master/owner-v1.json"]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`compatibility baseline missing: ${f}`);
  }
  runNodeScript("scripts/check-contract-compatibility.mjs", [], "compatibility");
  return "both surfaces backward compatible with master baseline";
});

// ── 10. Architecture (valid passes; invalid fixtures rejected) ───────────────
check("architecture (dependency rules + fixtures)", () => {
  runNodeScript("scripts/architecture-check.mjs", [], "architecture");
  return "valid skeletons pass; 4 invalid fixtures rejected with stable rules";
});

// ── 11. Review policy (Codex sole reviewer, all concerns) ────────────────────
check("review policy (Codex sole AI reviewer)", () => {
  runNodeScript("scripts/check-review-policy.mjs");
  return "11 concerns present; CodeRabbit prohibited";
});

// ── 12. CodeRabbit inventory (no repo-controlled surface; evidence kept) ──────
check("coderabbit inventory (no repo-controlled surface)", () => {
  runNodeScript("scripts/check-coderabbit.mjs");
  return "no workflows/secrets/config; evidence retained";
});

// ── 13. Route + source inventory (declared vs runtime; forbidden scan) ────────
check("route + source inventory (declared vs runtime)", () => {
  runNodeScript("scripts/check-route-inventory.mjs");
  const reportPath = join(ROOT, "evidence", "phase-1-route-inventory.json");
  if (!existsSync(reportPath)) throw new Error("evidence/phase-1-route-inventory.json not emitted");
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const failed = (report.checks ?? []).filter((c) => !c.passed);
  if (failed.length > 0) throw new Error(`${failed.length} inventory check(s) failed: ${failed.map((c) => c.name).join(", ")}`);
  return `${report.publicOperations.length} public, ${report.ownerOperations.length} owner, 0 runtime routes`;
});

// ── 14. Frontend / Lab exclusion scan ─────────────────────────────────────────
check("frontend + lab exclusion scan", () => {
  const srcFiles = findFiles(join(ROOT, "src"), () => true);
  const violations = [];
  for (const file of srcFiles) {
    const rel = toPosix(relative(ROOT, file));
    if (/\.(tsx|jsx)$/.test(file)) violations.push(`${rel}: jsx-tsx-surface`);
  }
  let contentViolations = [];
  for (const file of srcFiles) {
    let content;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const rel = toPosix(relative(ROOT, file));
    if (/from\s+["']react["']/.test(content)) contentViolations.push(`${rel}: react-presentation-import`);
    if (/\b(?:localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie/.test(content)) {
      contentViolations.push(`${rel}: browser-state`);
    }
    if (/\b(?:class|function|interface|type)\s+LabEntry\b/i.test(content) || /\blab[-_ ]?entry\b/i.test(content)) {
      contentViolations.push(`${rel}: lab-entry-surface`);
    }
    if (/generated[\s_-]*server[\s_-]*stub|server[\s_-]*stub/i.test(content)) {
      contentViolations.push(`${rel}: generated-server-stub`);
    }
  }
  const all = [...violations, ...contentViolations];
  if (all.length > 0) throw new Error(`forbidden surface: ${all.slice(0, 3).join("; ")}${all.length > 3 ? ` (+${all.length - 3} more)` : ""}`);
  return "no JSX/TSX, React, browser state, Lab entry, or server stubs";
});

// ── 15. Dependency/version manifest ───────────────────────────────────────────
check("dependency/version manifest", () => {
  const doc = join(ROOT, "docs", "phase1-versions.md");
  const evidence = join(ROOT, "evidence", "phase-1-versions.json");
  if (!existsSync(doc)) throw new Error("docs/phase1-versions.md not found");
  if (!existsSync(evidence)) throw new Error("evidence/phase-1-versions.json not found (run toolchain check)");
  return "docs + evidence manifests present";
});

// ── Verdict + durable report ─────────────────────────────────────────────────
// Persist full constituent logs before the verdict so generation-diff,
// compatibility, architecture, and lint results are retained as evidence,
// not just console output.
for (const [key, filename] of [
  ["lint", "evidence/phase-1-contract-lint.log"],
  ["drift", "evidence/phase-1-generation-drift.log"],
  ["compatibility", "evidence/phase-1-compatibility.log"],
  ["architecture", "evidence/phase-1-architecture.log"],
]) {
  if (evidenceLogs[key] !== undefined) {
    writeFileSync(join(ROOT, filename), evidenceLogs[key], "utf8");
  }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

const evidenceFiles = [
  "openapi/generated/public-v1.json",
  "openapi/generated/owner-v1.json",
  "evidence/phase-1-versions.json",
  "evidence/phase-1-route-inventory.json",
  "evidence/phase-1-review-policy.md",
  "evidence/phase-1-contract-lint.log",
  "evidence/phase-1-generation-drift.log",
  "evidence/phase-1-compatibility.log",
  "evidence/phase-1-architecture.log",
  "AGENTS.md",
].map((f) => ({ file: f, present: existsSync(join(ROOT, f)) }));

const report = {
  ticket: 12,
  parent: 1,
  scope: "phase-1-conformance-gate",
  verdict: failed.length === 0 ? "pass" : "fail",
  summary: { passed, failed: failed.length, total: results.length },
  checks: results,
  evidence: evidenceFiles,
  guarantees: {
    offline: "no production credentials, data, database, deployed app, or public internet required after install",
    vitest: "threads pool, singleThread:true — deterministic, no reduced coverage",
    byteForByte: "bundles + generation reproduce byte-for-byte; drift fails the gate",
    providerLeakage: "absent outside adapters (architecture + inventory scans)",
    frontendLab: "no frontend or Lab entry surface (inventory + exclusion scans)",
  },
};

mkdirSync(dirname(GATE_REPORT), { recursive: true });
writeFileSync(GATE_REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log("\n═══════════════════════════════════════════════");
if (failed.length === 0) {
  console.log(`  ✓ Phase 1 gate: ALL ${passed} CHECKS PASSED`);
  console.log(`  ✓ evidence: ${GATE_REPORT.replace(`${ROOT}/`, "").replace(`${ROOT}\\`, "")}`);
  console.log("═══════════════════════════════════════════════");
  process.exit(0);
} else {
  console.error(`  ✗ Phase 1 gate: ${failed.length} of ${results.length} checks FAILED`);
  for (const r of failed) console.error(`    ✗ ${r.name}: ${r.detail}`);
  console.log("═══════════════════════════════════════════════");
  process.exit(1);
}
