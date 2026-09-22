#!/usr/bin/env node
/**
 * Contract-driven Phase 2 runtime boundary check (#33).
 *
 * Reads both canonical OpenAPI bundles, derives the expected handwritten
 * adapter export from each operationId, and proves that every operation has
 * exactly one adapter while every exported product adapter is declared.
 */

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

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
const EXPECTED_OPERATIONAL_ROUTES = [
  "src/app/livez/route.ts",
  "src/app/readyz/route.ts",
];

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

export function contractOperations(bundle, surface) {
  return Object.entries(bundle.paths ?? {})
    .flatMap(([path, pathItem]) =>
      Object.entries(pathItem ?? {})
        .filter(([method]) => HTTP_METHODS.has(method))
        .map(([method, operation]) => ({
          surface,
          method: method.toUpperCase(),
          path,
          operationId:
            typeof operation?.operationId === "string" ? operation.operationId : "",
        })),
    )
    .sort((left, right) => left.operationId.localeCompare(right.operationId));
}

function handlerNameFor(operationId) {
  return operationId.length === 0
    ? ""
    : `handle${operationId[0].toUpperCase()}${operationId.slice(1)}`;
}

export function discoverExportedHandlerNames(content) {
  const names = new Set();
  const declarationPatterns = [
    /export\s+(?:default\s+)?(?:async\s+)?function\s+(handle[A-Za-z0-9_]+)\s*\(/g,
    /export\s+(?:const|let|var)\s+(handle[A-Za-z0-9_]+)\b/g,
  ];
  for (const pattern of declarationPatterns) {
    for (const match of content.matchAll(pattern)) names.add(match[1]);
  }
  for (const match of content.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const specifier of match[1].split(",")) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const exportedName = parts.at(-1)?.trim();
      if (exportedName?.startsWith("handle")) names.add(exportedName);
    }
  }
  return [...names].sort();
}

function discoverAdapters(root) {
  const adapterRoot = join(root, "src", "runtime", "http");
  const adapters = [];

  for (const file of listFiles(adapterRoot).filter((candidate) => candidate.endsWith(".ts"))) {
    const content = readFileSync(file, "utf8");
    for (const exportName of discoverExportedHandlerNames(content)) {
      adapters.push({
        exportName,
        file: toPosix(relative(root, file)),
      });
    }
  }
  return adapters.sort((left, right) =>
    left.exportName === right.exportName
      ? left.file.localeCompare(right.file)
      : left.exportName.localeCompare(right.exportName),
  );
}

function discoverRouteFiles(root) {
  return listFiles(join(root, "src", "app"))
    .map((file) => toPosix(relative(root, file)))
    .filter((file) => /(?:^|\/)route\.(?:ts|tsx|js|jsx|mjs)$/.test(file))
    .sort();
}

export function buildRuntimeBoundary(root = DEFAULT_ROOT) {
  const publicBundle = JSON.parse(
    readFileSync(join(root, "openapi", "generated", "public-v1.json"), "utf8"),
  );
  const ownerBundle = JSON.parse(
    readFileSync(join(root, "openapi", "generated", "owner-v1.json"), "utf8"),
  );
  const operations = [
    ...contractOperations(publicBundle, "public"),
    ...contractOperations(ownerBundle, "owner"),
  ];
  const adapters = discoverAdapters(root);
  const operationIdCounts = new Map();
  for (const operation of operations) {
    operationIdCounts.set(
      operation.operationId,
      (operationIdCounts.get(operation.operationId) ?? 0) + 1,
    );
  }

  const duplicateOperationIds = [...operationIdCounts.entries()]
    .filter(([operationId, count]) => operationId.length === 0 || count !== 1)
    .map(([operationId]) => operationId || "<missing>")
    .sort();
  const matrix = operations.map((operation) => {
    const expectedExport = handlerNameFor(operation.operationId);
    return {
      ...operation,
      expectedExport,
      matches: adapters.filter((adapter) => adapter.exportName === expectedExport),
    };
  });
  const declaredExports = new Set(matrix.map((entry) => entry.expectedExport));
  const undeclaredAdapters = adapters.filter(
    (adapter) => !declaredExports.has(adapter.exportName),
  );
  const routeFiles = discoverRouteFiles(root);
  const operationalRoutes = routeFiles.filter((file) =>
    EXPECTED_OPERATIONAL_ROUTES.includes(file),
  );
  const unexpectedRouteFiles = routeFiles.filter(
    (file) => !EXPECTED_OPERATIONAL_ROUTES.includes(file),
  );
  const missingOperationalRoutes = EXPECTED_OPERATIONAL_ROUTES.filter(
    (file) => !routeFiles.includes(file),
  );

  const checks = [
    {
      name: "public-operation-count",
      passed: matrix.filter((entry) => entry.surface === "public").length === 5,
      detail: "exactly five public operations",
    },
    {
      name: "owner-operation-count",
      passed: matrix.filter((entry) => entry.surface === "owner").length === 39,
      detail: "exactly thirty-nine Owner operations",
    },
    {
      name: "unique-operation-identifiers",
      passed: duplicateOperationIds.length === 0,
      detail: `${operations.length} unique operation identifiers`,
    },
    {
      name: "one-adapter-per-operation",
      passed: matrix.every((entry) => entry.matches.length === 1),
      detail: `${matrix.filter((entry) => entry.matches.length === 1).length}/${matrix.length} resolved exactly once`,
    },
    {
      name: "no-undeclared-product-adapters",
      passed: undeclaredAdapters.length === 0,
      detail: `${adapters.length} adapter exports declared by a contract`,
    },
    {
      name: "only-operational-routes",
      passed:
        unexpectedRouteFiles.length === 0 && missingOperationalRoutes.length === 0,
      detail: "/livez and /readyz are the only Route Handlers",
    },
  ];
  const verdict = checks.every((check) => check.passed) ? "pass" : "fail";

  return {
    ticket: 33,
    parent: 24,
    scope: "phase-2-runtime-boundary",
    verdict,
    checks,
    matrix,
    adapters,
    duplicateOperationIds,
    undeclaredAdapters,
    operationalRoutes,
    unexpectedRouteFiles,
    missingOperationalRoutes,
  };
}

export function writeRuntimeBoundaryReport(report, root = DEFAULT_ROOT) {
  const reportPath = join(root, "evidence", "phase-2-runtime-boundary.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

export function main(root = DEFAULT_ROOT) {
  let report;
  try {
    report = buildRuntimeBoundary(root);
    writeRuntimeBoundaryReport(report, root);
  } catch (error) {
    console.error(
      `✗ runtime boundary failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }

  for (const check of report.checks) {
    console.log(`${check.passed ? "✓" : "✗"} ${check.name}: ${check.detail}`);
  }
  if (report.verdict === "fail") {
    for (const entry of report.matrix.filter((item) => item.matches.length !== 1)) {
      console.error(
        `  ✗ ${entry.operationId || "<missing operationId>"}: expected ${entry.expectedExport}, found ${entry.matches.length}`,
      );
    }
    for (const adapter of report.undeclaredAdapters) {
      console.error(`  ✗ undeclared adapter: ${adapter.file}#${adapter.exportName}`);
    }
    return 1;
  }
  console.log("✓ runtime boundary: 5 public + 39 Owner operations resolve exactly once");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  toPosix(process.argv[1]).endsWith("scripts/check-runtime-boundary.mjs");
if (invokedDirectly) process.exitCode = main();
