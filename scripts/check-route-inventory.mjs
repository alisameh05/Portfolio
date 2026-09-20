#!/usr/bin/env node
/**
 * check-route-inventory.mjs
 *
 * Phase 1 route and source inventory (#11).
 *
 * Reconciles the declared public and Owner OpenAPI operations against the
 * canonical bundles, then scans the repository for any undeclared runtime
 * HTTP surface or forbidden Phase 1 scope (Lab entry, React/frontend,
 * browser state, generated server stubs, working Route Handlers, and
 * provider/generated-transport leakage into domain/application code).
 *
 * The audit distinguishes allowed OpenAPI contract paths (transport source
 * of truth) from forbidden implemented runtime routes. It emits a
 * deterministic JSON report suitable for the Phase 1 evidence package and
 * exits non-zero when any seam fails.
 *
 * No network, database, credentials, or running application required.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const PUBLIC_BUNDLE = join(ROOT, "openapi", "generated", "public-v1.json");
const OWNER_BUNDLE = join(ROOT, "openapi", "generated", "owner-v1.json");
const DEFAULT_REPORT = join(ROOT, "evidence", "phase-1-route-inventory.json");

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export const EXPECTED_PUBLIC_OPERATIONS = [
  "GET /api/v1/cv/current",
  "POST /api/v1/events",
  "POST /api/v1/projects/{projectId}/feedback",
  "PUT /api/v1/projects/{projectId}/rating",
  "PUT /api/v1/projects/{projectId}/reaction",
];

export const EXPECTED_OWNER_OPERATIONS = [
  "PUT /api/owner/v1/configuration/profile",
  "PUT /api/owner/v1/configuration/contact-channels",
  "PUT /api/owner/v1/configuration/project-cta",
  "GET /api/owner/v1/content/{contentId}",
  "POST /api/owner/v1/content/{contentId}/revisions",
  "POST /api/owner/v1/content/{contentId}/commands/publish-language",
  "POST /api/owner/v1/content/{contentId}/commands/hide",
  "POST /api/owner/v1/content/{contentId}/commands/archive",
  "POST /api/owner/v1/content/{contentId}/commands/restore",
  "GET /api/owner/v1/projects/{projectId}",
  "POST /api/owner/v1/projects/{projectId}/commands/change-status",
  "POST /api/owner/v1/projects/{projectId}/commands/set-featured",
  "POST /api/owner/v1/projects/{projectId}/commands/change-slug",
  "POST /api/owner/v1/projects/{projectId}/commands/relate-project",
  "GET /api/owner/v1/taxonomies/{taxonomyId}",
  "POST /api/owner/v1/taxonomies/{taxonomyId}/values",
  "POST /api/owner/v1/taxonomy-values/{valueId}/commands/rename",
  "POST /api/owner/v1/taxonomy-values/{valueId}/commands/retire",
  "POST /api/owner/v1/taxonomy-values/{valueId}/commands/merge",
  "POST /api/owner/v1/projects/{projectId}/commands/assign-taxonomy-value",
  "GET /api/owner/v1/media/{mediaId}",
  "POST /api/owner/v1/media/upload-intents",
  "POST /api/owner/v1/media/{mediaId}/commands/record-processing",
  "POST /api/owner/v1/media/{mediaId}/commands/accept",
  "POST /api/owner/v1/media/{mediaId}/commands/reject",
  "GET /api/owner/v1/cv",
  "POST /api/owner/v1/cv/versions",
  "POST /api/owner/v1/cv/versions/{versionId}/commands/accept",
  "POST /api/owner/v1/cv/versions/{versionId}/commands/activate",
  "GET /api/owner/v1/feedback/{feedbackId}",
  "POST /api/owner/v1/feedback/{feedbackId}/commands/approve",
  "POST /api/owner/v1/feedback/{feedbackId}/commands/reject",
  "POST /api/owner/v1/feedback/{feedbackId}/commands/suppress",
  "GET /api/owner/v1/analytics-goals/{goalId}",
  "POST /api/owner/v1/analytics-goals/{goalId}/versions",
  "POST /api/owner/v1/analytics-goals/{goalId}/commands/activate-version",
  "POST /api/owner/v1/exports",
  "GET /api/owner/v1/exports/{exportId}",
  "GET /api/owner/v1/exports/{exportId}/download",
];

function toPosix(path) {
  return path.split("\\").join("/");
}

function repoRelative(path) {
  return toPosix(relative(ROOT, path));
}

function listFilesRecursive(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  const sorted = [...entries].sort();
  for (const entry of sorted) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry === ".git" || entry === "dist" || entry === "coverage") continue;
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function listOperations(bundle) {
  return Object.entries(bundle.paths ?? {})
    .flatMap(([path, item]) =>
      Object.keys(item ?? {})
        .filter((method) => HTTP_METHODS.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    .sort();
}

function scanSourceFiles() {
  const roots = [join(ROOT, "src"), join(ROOT, "app"), join(ROOT, "pages")];
  const files = [];
  for (const root of roots) {
    if (existsSync(root)) files.push(...listFilesRecursive(root));
  }
  return files.sort();
}

const PROVIDER_SPEC = "(?:next\\/|@supabase\\/|kysely(?:\\/|\"|')|@vercel\\/|vercel(?:\\/|\"|'))";
const GENERATED_SPEC = "(?:src\\/contracts\\/http\\/|@hey-api\\/openapi-ts|@redocly\\/|openapi-typescript|(?:\\.\\.?\\/)+contracts\\/http\\/)";
const PROVIDER_IMPORT = new RegExp(`(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)["']${PROVIDER_SPEC}`, "i");
const PROVIDER_EXPORT_FROM = new RegExp(`export\\s+[^;]*?\\bfrom\\s+["']${PROVIDER_SPEC}`, "i");
const GENERATED_IMPORT = new RegExp(`(?:from\\s+|require\\s*\\(\\s*|import\\s*\\(\\s*)["']${GENERATED_SPEC}`);
const GENERATED_EXPORT_FROM = new RegExp(`export\\s+[^;]*?\\bfrom\\s+["']${GENERATED_SPEC}`);
const SHARED_VALIDATOR_IMPORT = /from\s+["'](?:zod|valibot|@supabase\/|kysely|next\/|@vercel\/|@hey-api\/openapi-ts|@redocly\/|openapi-typescript)/i;
const ROUTE_HANDLER_EXPORT =
  /export\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\b|export\s+(?:const|let|var)\s+(?:GET|POST|PUT|PATCH|DELETE)\b/;
const NEXT_HANDLER_IMPORT = /from\s+["']next\/server["']/;
const API_PATH_LITERAL = /["'`](?:\/api\/(?:v1|owner\/v1)\/[^"'`\s]*)/;
const LAB_ENTRY_DEF = /\b(?:class|function|interface|type)\s+LabEntry\b/i;
const LAB_ENTRY_LITERAL = /\blab[-_ ]?entry\b/i;
const LAB_PATH = /\/lab(?:\/|$)/i;
const REACT_IMPORT = /from\s+["']react["']/;
const BROWSER_STATE = /\b(?:localStorage|sessionStorage|indexedDB)\b|document\s*\.\s*cookie/;
const SERVER_STUB_HINT = /generated[\s_-]*server[\s_-]*stub|server[\s_-]*stub|openapi-generator/i;

function isDomainOrApplicationFile(relativePath) {
  return /^src\/modules\/[^/]+\/(?:domain|application)\//.test(relativePath);
}

function isSharedDomainFile(relativePath) {
  return /^src\/shared\/domain\//.test(relativePath);
}

function isGeneratedTransportFile(relativePath) {
  return /^src\/contracts\/http\//.test(relativePath);
}

function isAllowedContractPath(literal, allowedContractPaths) {
  const path = literal.slice(1).split(/[?#]/)[0];
  for (const template of allowedContractPaths) {
    const pattern = `^${template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[^}]*\\\}/g, "[^/]+")}$`;
    if (new RegExp(pattern).test(path)) return true;
  }
  return false;
}

export function buildInventory() {
  const publicBundle = JSON.parse(readFileSync(PUBLIC_BUNDLE, "utf8"));
  const ownerBundle = JSON.parse(readFileSync(OWNER_BUNDLE, "utf8"));
  const publicOperations = listOperations(publicBundle);
  const ownerOperations = listOperations(ownerBundle);

  const sourceFiles = scanSourceFiles();
  const runtimeRoutes = [];
  const operationalRoutes = [];
  const declaredContractReferences = [];
  const undeclaredHttpSurface = [];
  const forbiddenFindings = [];

  // Phase 2 #27: operational probes outside both OpenAPI product surfaces.
  // /livez and /readyz are the only allowed runtime routes; product adapters
  // arrive later. Product operation counts stay exact.
  const ALLOWED_OPERATIONAL_ROUTE_FILES = new Set([
    "src/app/livez/route.ts",
    "src/app/readyz/route.ts",
  ]);

  const allowedContractPaths = new Set([
    ...Object.keys(publicBundle.paths ?? {}),
    ...Object.keys(ownerBundle.paths ?? {}),
  ]);

  for (const file of sourceFiles) {
    const relativePath = repoRelative(file);
    const base = file.split(/[\\/]/).at(-1) ?? "";

    // ── Allowlisted operational probes (Phase 2): not product surface ──
    if (ALLOWED_OPERATIONAL_ROUTE_FILES.has(relativePath)) {
      operationalRoutes.push({ file: relativePath, reason: "operational-probe" });
      continue;
    }

    // ── Runtime route files (Next.js App Router / pages) are otherwise forbidden ──
    if (/^route\.(?:ts|tsx|js|jsx|mjs)$/.test(base)) {
      runtimeRoutes.push({ file: relativePath, reason: "route-handler-file" });
      forbiddenFindings.push({ file: relativePath, reason: "working-route-handler-file" });
      continue;
    }
    if (
      /(?:^|\/)(?:app|pages)\//.test(`/${relativePath}`) &&
      /\.(?:ts|js|mjs)$/.test(base)
    ) {
      runtimeRoutes.push({ file: relativePath, reason: "app-or-pages-router-file" });
      forbiddenFindings.push({ file: relativePath, reason: "runtime-router-file" });
    }

    // Generated transport dirs may only contain the three committed artifacts.
    if (isGeneratedTransportFile(relativePath)) {
      if (!/(?:^|\/)(?:index\.ts|types\.gen\.ts|zod\.gen\.ts)$/.test(relativePath)) {
        forbiddenFindings.push({ file: relativePath, reason: "generated-server-stub-or-extra-artifact" });
      }
    }

    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }

    // Working Route Handler implementations.
    if ((ROUTE_HANDLER_EXPORT.test(content) && NEXT_HANDLER_IMPORT.test(content)) || (ROUTE_HANDLER_EXPORT.test(content) && /NextResponse|NextRequest/.test(content))) {
      runtimeRoutes.push({ file: relativePath, reason: "exported-http-method-handler" });
      forbiddenFindings.push({ file: relativePath, reason: "working-route-handler" });
    }

    // Undeclared HTTP surface: contract path literals in source, reconciled
    // against the allowed OpenAPI contract paths (declared) vs everything
    // else (undeclared runtime surface, forbidden in Phase 1).
    if (API_PATH_LITERAL.test(content) && !isGeneratedTransportFile(relativePath)) {
      const match = content.match(API_PATH_LITERAL)?.[0] ?? "api-path-literal";
      const literal = match.slice(1);
      if (isAllowedContractPath(match, allowedContractPaths)) {
        declaredContractReferences.push({ file: relativePath, reason: `declared-contract-path-literal:${match.slice(0, 80)}` });
      } else {
        runtimeRoutes.push({ file: relativePath, reason: `api-path-literal:${match.slice(0, 80)}` });
        undeclaredHttpSurface.push({ file: relativePath, reason: `undeclared-contract-path:${literal.slice(0, 80)}` });
        forbiddenFindings.push({ file: relativePath, reason: "undeclared-http-surface" });
      }
    }

    // Lab entry surface (deferred after v1).
    if (LAB_ENTRY_DEF.test(content) || LAB_ENTRY_LITERAL.test(content) || (LAB_PATH.test(relativePath) && !/openapi\//.test(relativePath))) {
      forbiddenFindings.push({ file: relativePath, reason: "lab-entry-surface" });
    }

    // React presentation / JSX-TSX / browser state.
    if (/\.(?:tsx|jsx)$/.test(base)) {
      forbiddenFindings.push({ file: relativePath, reason: "jsx-tsx-surface" });
    }
    if (REACT_IMPORT.test(content)) {
      forbiddenFindings.push({ file: relativePath, reason: "react-presentation-import" });
    }
    if (BROWSER_STATE.test(content)) {
      forbiddenFindings.push({ file: relativePath, reason: "browser-state" });
    }
    if (SERVER_STUB_HINT.test(content)) {
      forbiddenFindings.push({ file: relativePath, reason: "generated-server-stub" });
    }

    // Provider / generated-transport leakage into domain and application layers.
    // Mirrors .dependency-cruiser.cjs (no-provider-in-domain,
    // no-provider-in-application, no-generated-code-leakage) as a
    // deterministic content scan: static, dynamic, and re-export forms.
    if (isDomainOrApplicationFile(relativePath)) {
      if (PROVIDER_IMPORT.test(content) || PROVIDER_EXPORT_FROM.test(content)) {
        forbiddenFindings.push({ file: relativePath, reason: "provider-import-in-domain-or-application" });
      }
      if (GENERATED_IMPORT.test(content) || GENERATED_EXPORT_FROM.test(content)) {
        forbiddenFindings.push({ file: relativePath, reason: "generated-transport-import-in-domain-or-application" });
      }
    }
    if (isSharedDomainFile(relativePath) && SHARED_VALIDATOR_IMPORT.test(content)) {
      forbiddenFindings.push({ file: relativePath, reason: "provider-or-validator-import-in-shared-domain" });
    }
  }

  const sortByFile = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.reason < b.reason ? -1 : 1);
  operationalRoutes.sort(sortByFile);
  runtimeRoutes.sort(sortByFile);
  declaredContractReferences.sort(sortByFile);
  undeclaredHttpSurface.sort(sortByFile);
  forbiddenFindings.sort(sortByFile);

  // ── Contract reconciliation checks ──
  const checks = [];
  const publicOk = JSON.stringify(publicOperations) === JSON.stringify(EXPECTED_PUBLIC_OPERATIONS);
  checks.push({
    name: "public-exactly-five-operations",
    passed: publicOk,
    detail: publicOk ? "5/5 public operations reconciled" : `expected ${EXPECTED_PUBLIC_OPERATIONS.length}, found ${publicOperations.length}`,
  });

  const publicSurface = JSON.stringify(publicBundle.paths ?? {});
  // The exact-five-operations check above is the primary guard: any extra
  // operation (broad read, owner CRUD, Lab) fails reconciliation. This regex
  // is defense-in-depth for forbidden families anywhere in the bundle text.
  const publicForbidden =
    /\/api\/(?:owner|admin)|lab[-_ ]?entry|supabase|vercel|kysely|server stub/i.test(publicSurface) ||
    /\/api\/v1\/(?:projects(?!\/\{)|content|taxonom|media|feedback|cv(?!\/current))/i.test(publicSurface);
  checks.push({
    name: "public-no-forbidden-surface",
    passed: !publicForbidden,
    detail: publicForbidden ? "forbidden public surface detected" : "no owner CRUD, broad reads, Lab, or provider surface",
  });

  const ownerOk = JSON.stringify(ownerOperations) === JSON.stringify([...EXPECTED_OWNER_OPERATIONS].sort());
  checks.push({
    name: "owner-exact-surface",
    passed: ownerOk,
    detail: ownerOk ? `${ownerOperations.length}/${EXPECTED_OWNER_OPERATIONS.length} owner operations reconciled` : `expected ${EXPECTED_OWNER_OPERATIONS.length}, found ${ownerOperations.length}`,
  });

  const ownerSurface = JSON.stringify(ownerBundle.paths ?? {});
  const ownerForbidden =
    /\blab\b/i.test(ownerSurface) ||
    Object.keys(ownerBundle.paths ?? {}).some((path) => /\/patch\b/i.test(path)) ||
    ownerOperations.some((op) => op.startsWith("PATCH "));
  checks.push({
    name: "owner-no-generic-patch-or-lab",
    passed: !ownerForbidden,
    detail: ownerForbidden ? "generic patch or Lab entry detected in owner contract" : "command-oriented, no generic patch or Lab entry",
  });

  const runtimeOk = runtimeRoutes.length === 0 && undeclaredHttpSurface.length === 0;
  checks.push({
    name: "no-undeclared-runtime-http-surface",
    passed: runtimeOk,
    detail: runtimeOk ? `allowed OpenAPI paths only; ${operationalRoutes.length} operational probe(s), 0 product runtime routes` : `${runtimeRoutes.length} runtime route(s) detected`,
  });

  const operationalOk =
    operationalRoutes.length <= ALLOWED_OPERATIONAL_ROUTE_FILES.size &&
    operationalRoutes.every((route) => ALLOWED_OPERATIONAL_ROUTE_FILES.has(route.file));
  checks.push({
    name: "operational-probes-allowlisted",
    passed: operationalOk,
    detail: operationalOk ? `${operationalRoutes.length} operational probe(s) within allowlist` : "unexpected operational route detected",
  });

  const forbiddenOk = forbiddenFindings.length === 0;
  checks.push({
    name: "no-forbidden-source-surface",
    passed: forbiddenOk,
    detail: forbiddenOk ? "no Lab, frontend, stub, handler, or leakage surface" : `${forbiddenFindings.length} forbidden finding(s)`,
  });

  return {
    ticket: 11,
    parent: 1,
    scope: "phase-1-route-and-source-boundary",
    publicOperations,
    ownerOperations,
    allowedContractPaths: [...allowedContractPaths].sort(),
    operationalRoutes,
    runtimeRoutes,
    declaredContractReferences,
    undeclaredHttpSurface,
    forbiddenFindings,
    checks,
  };
}

export function writeReport(report, reportPath = DEFAULT_REPORT) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

function parseArgs(argv) {
  const options = { report: DEFAULT_REPORT, write: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--report" && argv[i + 1]) {
      options.report = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--no-write") {
      options.write = false;
    }
  }
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let report;
  try {
    report = buildInventory();
  } catch (error) {
    console.error(`✗ route inventory failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (options.write) writeReport(report, options.report);

  const failed = report.checks.filter((check) => !check.passed);
  for (const check of report.checks) {
    console.log(`${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  if (report.forbiddenFindings.length > 0) {
    for (const finding of report.forbiddenFindings) {
      console.error(`  ✗ forbidden: ${finding.file} (${finding.reason})`);
    }
  }
  if (report.runtimeRoutes.length > 0) {
    for (const route of report.runtimeRoutes) {
      console.error(`  ✗ runtime route: ${route.file} (${route.reason})`);
    }
  }

  if (failed.length > 0) {
    console.error(`✗ route inventory: ${failed.length} of ${report.checks.length} checks FAILED`);
    return 1;
  }
  console.log(`✓ route inventory: all ${report.checks.length} checks passed (${report.publicOperations.length} public, ${report.ownerOperations.length} owner, ${report.operationalRoutes?.length ?? 0} operational, 0 product runtime routes)`);
  return 0;
}

const invokedDirectly = process.argv[1] !== undefined && toPosix(process.argv[1]).endsWith("scripts/check-route-inventory.mjs");
if (invokedDirectly) {
  process.exitCode = main();
}
