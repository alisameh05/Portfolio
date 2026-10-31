/** Phase 2 runtime architecture enforcement (#33). */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPhase9RouteManifest } from "./phase9-route-registration.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const ROUTE_IMPORT_ALLOWLIST = new Map([
  ["src/app/livez/route.ts", new Set()],
  [
    "src/app/readyz/route.ts",
    new Set(["../../runtime/lifecycle.js", "../../runtime/readyz.js"]),
  ],
]);

function toPosix(path) {
  return path.split("\\").join("/");
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...listFiles(full));
    else files.push(full);
  }
  return files;
}

function importSpecifiers(content) {
  const specifiers = [];
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) specifiers.push(match[1]);
  for (const match of content.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

function isFramework(specifier) {
  return /^next(?:\/|$)/.test(specifier);
}

function isReactPresentation(specifier) {
  return /^(?:react|react-dom)(?:\/|$)/.test(specifier);
}

function isInfrastructureProvider(specifier) {
  return /^(?:@supabase\/|kysely(?:\/|$)|pg(?:\/|$)|@vercel\/|vercel(?:\/|$))/.test(
    specifier,
  );
}

function isGeneratedTransport(specifier) {
  return /(?:^|\/)contracts\/http\//.test(specifier);
}

function isHttpOrBootstrap(file) {
  return (
    /^src\/runtime\/http\//.test(file) ||
    /^src\/bootstrap\//.test(file) ||
    /^src\/app\//.test(file)
  );
}

function isProviderAdapterOrComposition(file) {
  return (
    /\/adapters\//.test(file) ||
    file === "src/bootstrap/composition-root.ts"
  );
}

export function inspectSourceRecords(records, { mode = "development", phase9Manifest = null } = {}) {
  const findings = [];
  const registeredProductFiles = new Set(phase9Manifest?.registered?.map((entry) => entry.file) ?? []);
  const protectedDueWork = phase9Manifest?.protectedJobs?.[0];
  const protectedDueWorkFile = protectedDueWork
    ? `src/app${protectedDueWork.path}/route.ts`
    : null;
  for (const record of records) {
    const file = toPosix(record.file);
    const content = record.content;
    const imports = importSpecifiers(content);
    const isRouteHandler = /(?:^|\/)route\.(?:ts|tsx|js|jsx|mjs)$/.test(file);

    if (isRouteHandler) {
      const hasHistoricalAllowlist = ROUTE_IMPORT_ALLOWLIST.has(file);
      const allowedImports = ROUTE_IMPORT_ALLOWLIST.get(file) ?? new Set();
      const isRegisteredProductRoute = mode !== "foundation" && phase9Manifest?.developmentPassed === true &&
        (mode !== "complete" || phase9Manifest.phase9Complete === true) &&
        (registeredProductFiles.has(file) ||
          (protectedDueWork?.registered === true && file === protectedDueWorkFile));
      if (hasHistoricalAllowlist) {
        if (imports.some((specifier) => !allowedImports.has(specifier))) {
          findings.push({ file, reason: "route-handler-import-outside-allowlist" });
        }
      } else if (!isRegisteredProductRoute || imports.some((specifier) =>
        !isFramework(specifier) && specifier !== "@/runtime/http/product-route-registration.js" &&
        !/^@\/runtime\/http\/[A-Za-z0-9._-]+$/.test(specifier) &&
        !/(?:^|\/)runtime\/http\/[A-Za-z0-9._-]+$/.test(specifier))) {
        findings.push({ file, reason: "route-handler-import-outside-allowlist" });
      }
    }

    if (imports.some(isReactPresentation)) {
      findings.push({ file, reason: "react-presentation-import" });
    }
    if (imports.some(isFramework) && !isHttpOrBootstrap(file)) {
      findings.push({ file, reason: "framework-import-outside-http-bootstrap" });
    }
    if (
      /\b(?:process\.env|Deno\.env|Bun\.env)\b/.test(content) &&
      !/^src\/bootstrap\/(?:configuration|composition-root)\.ts$/.test(file)
    ) {
      findings.push({
        file,
        reason: "environment-read-outside-configuration-bootstrap",
      });
    }
    if (
      imports.some(isGeneratedTransport) &&
      !/^src\/runtime\/http\//.test(file)
    ) {
      findings.push({ file, reason: "generated-validator-import-outside-transport" });
    }
    if (
      imports.some(isInfrastructureProvider) &&
      !isProviderAdapterOrComposition(file)
    ) {
      findings.push({
        file,
        reason: "provider-import-outside-adapter-composition",
      });
    }
    if (
      imports.some((specifier) => /database\.generated(?:\.js)?$/.test(specifier)) &&
      !/\/adapters\//.test(file)
    ) {
      findings.push({
        file,
        reason: "generated-database-types-outside-adapter",
      });
    }
    if (/\bAsyncLocalStorage\b/.test(content)) {
      findings.push({ file, reason: "hidden-ambient-transaction-state" });
    }
    if (
      /new\s+(?:Pool|Kysely)\s*\(/.test(content) &&
      !isProviderAdapterOrComposition(file)
    ) {
      findings.push({ file, reason: "direct-database-construction-outside-composition" });
    }
    if (
      imports.some((specifier) => /postgres\/runtime(?:\.js)?$/.test(specifier)) &&
      !isProviderAdapterOrComposition(file)
    ) {
      findings.push({ file, reason: "transaction-implementation-outside-adapter-composition" });
    }
    if (
      file === "src/bootstrap/composition-root.ts" &&
      /\b(?:PostgresRuntimeDatabase|getDatabaseRuntime)\b/.test(content)
    ) {
      findings.push({ file, reason: "provider-runtime-exported-from-composition" });
    }
    if (
      file === "src/bootstrap/configuration.ts" &&
      /\b(?:DatabaseRuntimeConfig|databaseUrl)\b/.test(content)
    ) {
      findings.push({ file, reason: "secret-database-config-exported" });
    }
    if (
      isRouteHandler &&
      (imports.some((specifier) =>
        /(?:^|\/)(?:modules|runtime\/fakes|contracts\/http)(?:\/|$)/.test(
          specifier,
        ),
      ) ||
        /\b(?:create[A-Z][A-Za-z]+Service|Promise\.all|\.execute\s*\()/.test(
          content,
        ))
    ) {
      findings.push({ file, reason: "business-orchestration-in-route-handler" });
    }
  }

  findings.sort((left, right) =>
    left.file === right.file
      ? left.reason.localeCompare(right.reason)
      : left.file.localeCompare(right.file),
  );
  return { verdict: findings.length === 0 ? "pass" : "fail", findings };
}

export function inspectRuntimeArchitecture(root = DEFAULT_ROOT, { mode = "development" } = {}) {
  const phase9RouteManifest = buildPhase9RouteManifest(root, { mode: mode === "complete" ? "complete" : "development" });
  const records = listFiles(join(root, "src"))
    .filter((file) => /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file))
    .map((file) => ({
      file: toPosix(relative(root, file)),
      content: readFileSync(file, "utf8"),
    }));
  const inspection = inspectSourceRecords(records, { mode, phase9Manifest: phase9RouteManifest });
  if (mode === "complete" && !phase9RouteManifest.phase9Complete) {
    inspection.findings.push({ file: "src/app", reason: "phase9-route-completeness-incomplete" });
  }
  for (const finding of phase9RouteManifest.invalidRegistrations) {
    inspection.findings.push({ file: finding.file ?? "openapi/generated", reason: `phase9-${finding.code}` });
  }
  inspection.findings.sort((left, right) => left.file.localeCompare(right.file) || left.reason.localeCompare(right.reason));
  inspection.verdict = inspection.findings.length === 0 ? "pass" : "fail";
  return {
    ticket: 33,
    parent: 24,
    scope: "phase-2-runtime-architecture",
    filesInspected: records.length,
    phase9RouteManifest,
    mode,
    ...inspection,
  };
}

export function writeRuntimeArchitectureReport(report, root = DEFAULT_ROOT) {
  const reportPath = join(root, "evidence", "phase-2-runtime-architecture.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

export function main(root = DEFAULT_ROOT, mode = "development") {
  const report = inspectRuntimeArchitecture(root, { mode });
  writeRuntimeArchitectureReport(report, root);
  if (report.verdict === "fail") {
    for (const finding of report.findings) {
      console.error(`✗ ${finding.file}: ${finding.reason}`);
    }
    return 1;
  }
  console.log(
    `✓ runtime architecture: ${report.filesInspected} source files preserve framework, environment, transport, provider, and Route Handler boundaries`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  toPosix(process.argv[1]).endsWith("scripts/check-runtime-architecture.mjs");
if (invokedDirectly) {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "development";
  process.exitCode = main(DEFAULT_ROOT, mode);
}
