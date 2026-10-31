/**
 * Contract-driven Phase 2 runtime boundary check (#33).
 *
 * Reads both canonical OpenAPI bundles, derives the expected handwritten
 * adapter export from each operationId, and proves active operations resolve
 * exactly once while explicitly deferred Owner operations have no adapter.
 * Every exported product adapter must still be declared.
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
import ts from "typescript";
import { PHASE_ROUTE_REGISTRATION_POLICY } from "./phase-contract-registry.mjs";
import { buildPhase9RouteManifest } from "./phase9-route-registration.mjs";

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
const EXPECTED_OPERATIONAL_ROUTES = PHASE_ROUTE_REGISTRATION_POLICY.operationalRouteFiles;

// Phase 5 contracts are visible before their vertical slices are active.
// Keep only unfinished contracts explicitly allowlisted and adapter-free.
export const FAIL_CLOSED_OWNER_OPERATION_IDS = Object.freeze([
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
  const sourceFile = ts.createSourceFile(
    "runtime-adapter.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const hasModifier = (node, kind) =>
    node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;

  for (const statement of sourceFile.statements) {
    const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (
      isExported &&
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text.startsWith("handle")
    ) {
      names.add(statement.name.text);
    }
    if (isExported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text.startsWith("handle")) {
          names.add(declaration.name.text);
        }
      }
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text.startsWith("handle")) names.add(element.name.text);
      }
    }
  }
  return [...names].sort();
}

export function discoverRuntimeAdapterExports(root) {
  const adapterRoot = join(root, "src", "runtime", "http");
  const files = listFiles(adapterRoot).filter((candidate) => candidate.endsWith(".ts"));
  const program = ts.createProgram(files, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const handlerExports = [];

  for (const file of files) {
    const sourceFile = program.getSourceFile(file);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!sourceFile || !moduleSymbol) continue;
    for (const exportedSymbol of checker.getExportsOfModule(moduleSymbol)) {
      const target =
        exportedSymbol.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exportedSymbol)
          : exportedSymbol;
      const declaration =
        target.valueDeclaration ?? target.declarations?.[0] ?? sourceFile;
      let exportName = exportedSymbol.getName();
      if (
        exportName === "default" &&
        "name" in declaration &&
        declaration.name !== undefined &&
        ts.isIdentifier(declaration.name)
      ) {
        exportName = declaration.name.text;
      }
      if (!exportName.startsWith("handle")) continue;
      const type = checker.getTypeOfSymbolAtLocation(target, declaration);
      const callable =
        (target.flags & ts.SymbolFlags.Value) !== 0 &&
        checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0;
      handlerExports.push({
        exportName,
        file: toPosix(relative(root, file)),
        callable,
      });
    }
  }
  return handlerExports.sort((left, right) =>
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

export function evaluateRuntimeRouteBoundary(root = DEFAULT_ROOT, { mode = "development" } = {}) {
  const phase9RouteManifest = buildPhase9RouteManifest(root, { mode: mode === "complete" ? "complete" : "development" });
  const routeFiles = discoverRouteFiles(root);
  const operationalRoutes = routeFiles.filter((file) => EXPECTED_OPERATIONAL_ROUTES.includes(file));
  const registeredProductRouteFiles = new Set(phase9RouteManifest.registered.map((entry) => entry.file));
  const protectedDueWorkFile = `src/app${PHASE_ROUTE_REGISTRATION_POLICY.protectedJobs[0].path}/route.ts`;
  const protectedDueWorkRegistered = phase9RouteManifest.protectedJobs[0]?.registered === true;
  const unexpectedRouteFiles = routeFiles.filter((file) =>
    !EXPECTED_OPERATIONAL_ROUTES.includes(file) &&
    !(mode !== "foundation" && registeredProductRouteFiles.has(file)) &&
    !(mode !== "foundation" && protectedDueWorkRegistered && file === protectedDueWorkFile));
  const missingOperationalRoutes = EXPECTED_OPERATIONAL_ROUTES.filter((file) => !routeFiles.includes(file));
  const routeRegistrationValid = mode === "foundation"
    ? unexpectedRouteFiles.length === 0 && missingOperationalRoutes.length === 0 && phase9RouteManifest.registered.length === 0
    : phase9RouteManifest.developmentPassed && unexpectedRouteFiles.length === 0 && missingOperationalRoutes.length === 0;
  return { phase9RouteManifest, routeFiles, operationalRoutes, unexpectedRouteFiles, missingOperationalRoutes,
    routeRegistrationValid };
}

export function buildRuntimeBoundary(root = DEFAULT_ROOT, { mode = "development" } = {}) {
  if (!["development", "foundation", "complete"].includes(mode)) throw new Error(`RUNTIME_BOUNDARY_MODE_INVALID:${mode}`);
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
  const routeBoundary = evaluateRuntimeRouteBoundary(root, { mode });
  const { phase9RouteManifest } = routeBoundary;
  const handlerExports = discoverRuntimeAdapterExports(root);
  const adapters = handlerExports.filter((adapter) => adapter.callable);
  const invalidAdapters = handlerExports.filter((adapter) => !adapter.callable);
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
    const failClosed =
      operation.surface === "owner" &&
      FAIL_CLOSED_OWNER_OPERATION_IDS.includes(operation.operationId);
    return {
      ...operation,
      expectedExport,
      activation: failClosed ? "fail-closed" : "active",
      matches: adapters.filter((adapter) => adapter.exportName === expectedExport),
    };
  });
  const declaredExports = new Set(matrix.map((entry) => entry.expectedExport));
  const undeclaredAdapters = handlerExports.filter(
    (adapter) => !declaredExports.has(adapter.exportName),
  );
  const { operationalRoutes, unexpectedRouteFiles, missingOperationalRoutes, routeRegistrationValid } = routeBoundary;
  const failClosedOwnerOperations = matrix.filter(
    (entry) => entry.activation === "fail-closed",
  );
  const activeOperations = matrix.filter((entry) => entry.activation === "active");

  const checks = [
    {
      name: "public-operation-count",
      passed: matrix.filter((entry) => entry.surface === "public").length === 5,
      detail: "exactly five public operations",
    },
    {
      name: "owner-operation-count",
      passed:
        matrix.filter((entry) => entry.surface === "owner").length === 48 &&
        activeOperations.filter((entry) => entry.surface === "owner").length === 48 &&
        failClosedOwnerOperations.length === FAIL_CLOSED_OWNER_OPERATION_IDS.length,
      detail: "48 active Owner operations and 0 explicitly fail-closed Phase 5 contracts",
    },
    {
      name: "unique-operation-identifiers",
      passed: duplicateOperationIds.length === 0,
      detail: `${operations.length} unique operation identifiers`,
    },
    {
      name: "one-adapter-per-operation",
      passed:
        activeOperations.every((entry) => entry.matches.length === 1) &&
        failClosedOwnerOperations.every((entry) => entry.matches.length === 0),
      detail: `${activeOperations.filter((entry) => entry.matches.length === 1).length}/${activeOperations.length} active operations resolve once; deferred operations have no adapter`,
    },
    {
      name: "unfinished-owner-operations-fail-closed",
      passed:
        failClosedOwnerOperations.length === FAIL_CLOSED_OWNER_OPERATION_IDS.length &&
        failClosedOwnerOperations.every((entry) => entry.matches.length === 0),
      detail: `${failClosedOwnerOperations.length} declared Phase 5 operations have no runtime adapter`,
    },
    {
      name: "no-undeclared-product-adapters",
      passed: undeclaredAdapters.length === 0,
      detail: `${adapters.length} adapter exports declared by a contract`,
    },
    {
      name: "only-callable-runtime-adapters",
      passed: invalidAdapters.length === 0,
      detail: `${adapters.length}/${handlerExports.length} handler exports are callable runtime values`,
    },
    {
      name: mode === "foundation" ? "foundation-only-operational-routes" : "approved-incremental-product-routes",
      passed: routeRegistrationValid,
      detail: routeRegistrationValid
        ? `${operationalRoutes.length} operational probes, ${phase9RouteManifest.registered.length} approved product routes, ${phase9RouteManifest.pending.length} pending`
        : "unexpected, missing, or unapproved runtime route detected",
    },
    {
      name: "phase9-completeness-verdict",
      passed: mode !== "complete" || phase9RouteManifest.phase9Complete,
      detail: phase9RouteManifest.phase9Complete
        ? "all 53 product operations registered"
        : `${phase9RouteManifest.pending.length} declared product operation(s) remain pending`,
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
    invalidAdapters,
    duplicateOperationIds,
    undeclaredAdapters,
    operationalRoutes,
    unexpectedRouteFiles,
    missingOperationalRoutes,
    phase9RouteManifest,
    mode,
  };
}

export function writeRuntimeBoundaryReport(report, root = DEFAULT_ROOT) {
  const reportPath = join(root, "evidence", "phase-2-runtime-boundary.json");
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

export function main(root = DEFAULT_ROOT, mode = "development") {
  let report;
  try {
    report = buildRuntimeBoundary(root, { mode });
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
  console.log("✓ runtime boundary: 5 public + 48 active Owner operations resolve exactly once; 0 Phase 5 contracts fail closed");
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  toPosix(process.argv[1]).endsWith("scripts/check-runtime-boundary.mjs");
if (invokedDirectly) {
  const modeIndex = process.argv.indexOf("--mode");
  const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "development";
  process.exitCode = main(DEFAULT_ROOT, mode);
}
