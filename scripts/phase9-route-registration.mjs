import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { PHASE_ROUTE_REGISTRATION_POLICY } from "./phase-contract-registry.mjs";
import { forbiddenSourceReasons } from "./runtime-source-policy.mjs";
import { evaluatePhase9EvidenceDescriptor } from "./phase9-route-evidence.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const HTTP_METHODS = new Set(["GET", "PUT", "POST", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const OPERATIONAL_ROUTES = PHASE_ROUTE_REGISTRATION_POLICY.operationalRouteFiles;
const PROTECTED_DUE_WORK = Object.freeze({
  ...PHASE_ROUTE_REGISTRATION_POLICY.protectedJobs[0],
  file: `src/app${PHASE_ROUTE_REGISTRATION_POLICY.protectedJobs[0].path}/route.ts`,
});

function posix(value) {
  return value.replaceAll("\\", "/");
}

function listFiles(root) {
  let entries;
  try {
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = join(root, entry);
    const stat = statSync(full);
    return stat.isDirectory() ? listFiles(full) : [full];
  });
}

function routePathFromFile(file) {
  const prefix = "src/app/";
  if (!file.startsWith(prefix) || !/(?:^|\/)route\.(?:ts|tsx|js|jsx|mjs)$/.test(file)) return null;
  const segments = file.slice(prefix.length).replace(/\/route\.(?:ts|tsx|js|jsx|mjs)$/, "").split("/");
  const pathSegments = [];
  for (const segment of segments) {
    const match = /^\[([A-Za-z][A-Za-z0-9]*)\]$/.exec(segment);
    if (match) pathSegments.push(`{${match[1]}}`);
    else if (segment.startsWith("[") || segment.endsWith("]")) return null;
    else pathSegments.push(segment);
  }
  return `/${pathSegments.join("/")}`;
}

function importsCanonicalRegistration(sourceFile, importedName) {
  return sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== "@/runtime/http/product-route-registration.js" ||
        !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) return false;
    return statement.importClause.namedBindings.elements.some((element) =>
      (element.propertyName?.text ?? element.name.text) === importedName);
  });
}

function exportedMethods(source) {
  const sourceFile = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hasCanonicalRegistration = importsCanonicalRegistration(sourceFile, PHASE_ROUTE_REGISTRATION_POLICY.phase9.registrationMarker);
  const declarations = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && HTTP_METHODS.has(statement.name.text.toUpperCase()) &&
        statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      declarations.push({ method: statement.name.text.toUpperCase(), operationId: null, registered: false });
      continue;
    }
    if (!ts.isVariableStatement(statement) ||
        !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      const method = declaration.name.text.toUpperCase();
      if (!HTTP_METHODS.has(method)) continue;
      const initializer = declaration.initializer;
      if (hasCanonicalRegistration && initializer && ts.isCallExpression(initializer) &&
          initializer.expression.getText(sourceFile) === PHASE_ROUTE_REGISTRATION_POLICY.phase9.registrationMarker &&
          initializer.arguments.length === 2 && ts.isStringLiteral(initializer.arguments[0])) {
        declarations.push({ method, operationId: initializer.arguments[0].text, registered: true });
      } else {
        declarations.push({ method, operationId: null, registered: false });
      }
    }
  }
  return declarations;
}

function hasProtectedDueWorkRegistration(source) {
  const sourceFile = ts.createSourceFile("route.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  return importsCanonicalRegistration(sourceFile, PROTECTED_DUE_WORK.registrationMarker) && sourceFile.statements.some((statement) => {
    if (!ts.isVariableStatement(statement) ||
        !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return false;
    return statement.declarationList.declarations.some((declaration) =>
      ts.isIdentifier(declaration.name) && declaration.name.text.toUpperCase() === PROTECTED_DUE_WORK.method &&
      declaration.initializer !== undefined && ts.isCallExpression(declaration.initializer) &&
      declaration.initializer.expression.getText(sourceFile) === PROTECTED_DUE_WORK.registrationMarker &&
      declaration.initializer.arguments.length === 1);
  });
}

export function canonicalPhase9Operations({ publicBundle, ownerBundle }) {
  const operations = [];
  for (const [surface, bundle] of [["public", publicBundle], ["owner", ownerBundle]]) {
    for (const [path, pathItem] of Object.entries(bundle?.paths ?? {})) {
      for (const [method, operation] of Object.entries(pathItem ?? {})) {
        if (!HTTP_METHODS.has(method.toUpperCase())) continue;
        operations.push({ surface, method: method.toUpperCase(), path, operationId: operation?.operationId ?? "" });
      }
    }
  }
  return operations.sort((left, right) => left.operationId.localeCompare(right.operationId));
}

export function discoverPhase9Registrations(root = DEFAULT_ROOT) {
  const sourceRoots = ["src", "app", "pages"].map((directory) => join(root, directory));
  const findings = sourceRoots.flatMap((sourceRoot) => listFiles(sourceRoot).map((file) => {
    const relativeFile = posix(relative(root, file));
    return forbiddenSourceReasons(relativeFile, readFileSync(file, "utf8")).map((code) => ({ code, file: relativeFile }));
  }).flat());
  const routes = listFiles(join(root, "src", "app"))
    .map((file) => posix(relative(root, file)))
    .filter((file) => /(?:^|\/)route\.(?:ts|tsx|js|jsx|mjs)$/.test(file))
    .sort();
  const registrations = [];
  const operationalRoutes = [];
  let protectedJobRegistered = false;

  for (const file of routes) {
    const source = readFileSync(join(root, file), "utf8");
    if (OPERATIONAL_ROUTES.includes(file)) {
      operationalRoutes.push({ file, path: routePathFromFile(file) });
      continue;
    }
    if (file === PROTECTED_DUE_WORK.file) {
      const declarations = exportedMethods(source);
      const valid = declarations.length === 1 && declarations[0].method === PROTECTED_DUE_WORK.method &&
        hasProtectedDueWorkRegistration(source);
      if (!valid) findings.push({ code: "protected-due-work-registration-invalid", file });
      protectedJobRegistered = valid;
      continue;
    }

    const path = routePathFromFile(file);
    const declarations = exportedMethods(source);
    if (!path || !path.startsWith("/api/")) {
      findings.push({ code: "unapproved-runtime-route", file });
      continue;
    }
    if (declarations.length === 0) {
      findings.push({ code: "route-file-without-approved-product-registration", file });
      continue;
    }
    for (const declaration of declarations) {
      if (!declaration.registered || !declaration.operationId) {
        findings.push({ code: "unregistered-handler-export", file, method: declaration.method });
        continue;
      }
      registrations.push({ method: declaration.method, path, operationId: declaration.operationId, file });
    }
  }

  for (const expected of OPERATIONAL_ROUTES) {
    if (!routes.includes(expected)) findings.push({ code: "operational-probe-missing", file: expected });
  }
  for (const file of routes) {
    if (file.includes("/api/") && OPERATIONAL_ROUTES.includes(file)) {
      findings.push({ code: "operational-route-in-product-path", file });
    }
  }

  return {
    registrations,
    findings,
    operationalRoutes: operationalRoutes.sort((left, right) => left.file.localeCompare(right.file)),
    protectedJob: {
      method: PROTECTED_DUE_WORK.method,
      path: PROTECTED_DUE_WORK.path,
      operationId: null,
      registrationPhase: PROTECTED_DUE_WORK.registrationPhase,
      installationPhase: PROTECTED_DUE_WORK.installationPhase,
      registered: protectedJobRegistered,
    },
  };
}

export function createPhase9RouteManifest({ operations, registrations, sourceFindings = [], mode = "development",
  expectedCounts = { public: PHASE_ROUTE_REGISTRATION_POLICY.phase9.publicOperationCount,
    owner: PHASE_ROUTE_REGISTRATION_POLICY.phase9.ownerOperationCount } }) {
  if (!PHASE_ROUTE_REGISTRATION_POLICY.phase9.modes.includes(mode)) throw new Error(`PHASE9_ROUTE_MODE_INVALID:${mode}`);
  const invalidRegistrations = [];
  const operationById = new Map();
  const operationByRoute = new Map();
  for (const operation of operations) {
    const routeKey = `${operation.method} ${operation.path}`;
    if (!operation.operationId || operationById.has(operation.operationId)) {
      invalidRegistrations.push({ code: "canonical-operation-id-missing-or-duplicate", operationId: operation.operationId || null });
    }
    if (operationByRoute.has(routeKey)) invalidRegistrations.push({ code: "canonical-method-path-duplicate", route: routeKey });
    operationById.set(operation.operationId, operation);
    operationByRoute.set(routeKey, operation);
  }
  const declaredPublic = operations.filter((operation) => operation.surface === "public").length;
  const declaredOwner = operations.filter((operation) => operation.surface === "owner").length;
  const contractValid = declaredPublic === expectedCounts.public && declaredOwner === expectedCounts.owner &&
    operations.length === expectedCounts.public + expectedCounts.owner;
  if (!contractValid) invalidRegistrations.push({ code: "canonical-operation-count-mismatch",
    expectedPublic: expectedCounts.public, declaredPublic, expectedOwner: expectedCounts.owner, declaredOwner });

  const seenRoutes = new Set();
  const seenIds = new Set();
  const accepted = [];
  for (const registration of registrations) {
    const routeKey = `${registration.method} ${registration.path}`;
    const routeDuplicate = seenRoutes.has(routeKey);
    const idDuplicate = seenIds.has(registration.operationId);
    seenRoutes.add(routeKey);
    seenIds.add(registration.operationId);
    if (routeDuplicate) invalidRegistrations.push({ code: "duplicate-method-path", route: routeKey, file: registration.file ?? null });
    if (idDuplicate) invalidRegistrations.push({ code: "duplicate-operation-id", operationId: registration.operationId, file: registration.file ?? null });
    const canonicalById = operationById.get(registration.operationId);
    const canonicalByRoute = operationByRoute.get(routeKey);
    if (canonicalById && canonicalById !== canonicalByRoute) {
      invalidRegistrations.push({ code: "method-path-operation-mismatch", route: routeKey, operationId: registration.operationId, file: registration.file ?? null });
    } else if (!canonicalById || !canonicalByRoute) {
      invalidRegistrations.push({ code: "unknown-operation", route: routeKey, operationId: registration.operationId, file: registration.file ?? null });
    } else if (!routeDuplicate && !idDuplicate) {
      accepted.push({ ...canonicalById, file: registration.file ?? null });
    }
  }

  for (const finding of sourceFindings) invalidRegistrations.push({ code: finding.code ?? "source-policy-failure", file: finding.file ?? null, method: finding.method ?? null });
  const registeredIds = new Set(accepted.map((entry) => entry.operationId));
  const pending = operations.filter((operation) => !registeredIds.has(operation.operationId));
  const phase9Complete = contractValid && invalidRegistrations.length === 0 && pending.length === 0;
  const developmentPassed = invalidRegistrations.length === 0;
  return {
    schemaVersion: 1,
    mode,
    declared: operations.map((operation) => ({ ...operation })),
    registered: accepted.sort((left, right) => left.operationId.localeCompare(right.operationId)),
    pending,
    invalidRegistrations,
    operationalRoutes: [],
    protectedJobs: [],
    developmentPassed,
    phase9Complete,
    verdict: phase9Complete ? "pass" : mode === "complete" ? "incomplete" : developmentPassed ? "development-pass-incomplete" : "fail",
    checks: [
      { name: "canonical-phase9-contract", passed: contractValid },
      { name: "registered-routes-approved-and-unique", passed: invalidRegistrations.length === 0 },
      { name: "all-53-product-routes-registered", passed: phase9Complete, declared: operations.length, registered: accepted.length, pending: pending.length },
    ],
  };
}

export function buildPhase9RouteManifest(root = DEFAULT_ROOT, { mode = "development" } = {}) {
  const publicBundle = JSON.parse(readFileSync(join(root, "openapi", "generated", "public-v1.json"), "utf8"));
  const ownerBundle = JSON.parse(readFileSync(join(root, "openapi", "generated", "owner-v1.json"), "utf8"));
  const operations = canonicalPhase9Operations({ publicBundle, ownerBundle });
  const discovered = discoverPhase9Registrations(root);
  const manifest = createPhase9RouteManifest({ operations, registrations: discovered.registrations,
    sourceFindings: discovered.findings, mode });
  manifest.operationalRoutes = discovered.operationalRoutes;
  manifest.protectedJobs = [discovered.protectedJob];
  return manifest;
}

export function main(argv = process.argv.slice(2)) {
  let mode = "development";
  let reportPath = "evidence/phase9-route-inventory-293.json";
  let writeReport = true;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--mode" && argv[index + 1]) mode = argv[++index];
    else if (argv[index] === "--report" && argv[index + 1]) reportPath = argv[++index];
    else if (argv[index] === "--no-write") writeReport = false;
  }
  try {
    const report = buildPhase9RouteManifest(DEFAULT_ROOT, { mode });
    let evidenceGate = null;
    if (mode === "complete") {
      const evidencePath = join(DEFAULT_ROOT, "evidence", "phase9-route-registration-293.json");
      try {
        const descriptor = JSON.parse(readFileSync(evidencePath, "utf8"));
        evidenceGate = evaluatePhase9EvidenceDescriptor(descriptor);
      } catch {
        evidenceGate = { accepted: false, errors: ["missing-or-malformed-evidence-descriptor"] };
      }
      report.checks.push({ name: "source-bound-phase9-evidence", passed: evidenceGate.accepted,
        detail: evidenceGate.accepted ? "current source, bundles, migrations, executions, cleanup, and predecessors accepted" : evidenceGate.errors.join(",") });
      report.phase9Complete = report.phase9Complete && evidenceGate.accepted;
      if (!report.phase9Complete) report.verdict = "incomplete";
    }
    if (writeReport) {
      const absolutePath = join(DEFAULT_ROOT, reportPath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify({ mode: report.mode, verdict: report.verdict,
      declared: report.declared.length, public: report.declared.filter((entry) => entry.surface === "public").length,
      owner: report.declared.filter((entry) => entry.surface === "owner").length,
      registered: report.registered.length, pending: report.pending.length,
      invalidRegistrations: report.invalidRegistrations, operationalRoutes: report.operationalRoutes,
      protectedJobs: report.protectedJobs, evidenceGate, checks: report.checks,
      evidence: writeReport ? reportPath : null }, null, 2));
    return mode === "complete" && !report.phase9Complete || !report.developmentPassed ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase9-route-registration.mjs")) {
  process.exitCode = main();
}
