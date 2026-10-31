import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildPhase9RouteManifest,
  createPhase9RouteManifest,
  discoverPhase9Registrations,
} from "../../scripts/phase9-route-registration.mjs";
import { PHASE8_PROTECTED_DUE_WORK_HANDOFF } from "../../src/runtime/protected-due-work-trigger.js";
import { PHASE_ROUTE_REGISTRATION_POLICY } from "../../scripts/phase-contract-registry.mjs";
import { createPhase9EvidenceDescriptor, evaluatePhase9EvidenceDescriptor, validatePhase9EvidenceDescriptor } from "../../scripts/phase9-route-evidence.mjs";

const ROOT = process.cwd();
const operations = [
  { method: "PUT", path: "/api/v1/projects/{projectId}/reaction", operationId: "putProjectReaction", surface: "public" },
  { method: "GET", path: "/api/v1/cv/current", operationId: "getCurrentCv", surface: "public" },
];
const testContractCounts = { public: 2, owner: 0 };
const cleanups: string[] = [];
const evidenceFiles: string[] = [];
function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "phase9-routes-"));
  cleanups.push(root);
  mkdirSync(join(root, "openapi", "generated"), { recursive: true });
  for (const name of ["public-v1.json", "owner-v1.json"]) {
    copyFileSync(join(ROOT, "openapi", "generated", name), join(root, "openapi", "generated", name));
  }
  mkdirSync(join(root, "src", "app", "livez"), { recursive: true });
  mkdirSync(join(root, "src", "app", "readyz"), { recursive: true });
  for (const name of ["livez", "readyz"]) {
    copyFileSync(join(ROOT, "src", "app", name, "route.ts"), join(root, "src", "app", name, "route.ts"));
  }
  mkdirSync(join(root, "src", "app", "api", "v1", "projects", "[projectId]", "reaction"), { recursive: true });
  writeFileSync(join(root, "src", "app", "api", "v1", "projects", "[projectId]", "reaction", "route.ts"),
    'import { registerProductRoute } from "@/runtime/http/product-route-registration.js";\n' +
    'export const PUT = registerProductRoute("putProjectReaction", async (request: Request) => Response.json({ ok: true }));\n');
  return root;
}

afterEach(() => {
  for (const root of cleanups.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const file of evidenceFiles.splice(0)) rmSync(file, { force: true });
});

describe("Phase 9 guarded route registration (#293)", () => {
  it("derives the exact 53 operation identifiers and keeps pending declarations", () => {
    const report = buildPhase9RouteManifest(ROOT, { mode: "development" });
    expect(report.declared).toHaveLength(53);
    const expectedIds = ["public-v1.json", "owner-v1.json"].flatMap((name) =>
      Object.values(JSON.parse(readFileSync(join(ROOT, "openapi", "generated", name), "utf8")).paths)
        .flatMap((pathItem: Record<string, { operationId?: string }>) => Object.values(pathItem)
          .map((operation) => operation.operationId).filter((operationId): operationId is string => typeof operationId === "string")),
    ).sort();
    expect(report.declared.map((entry) => entry.operationId)).toEqual(expectedIds);
    expect(new Set(report.declared.map((entry) => entry.operationId)).size).toBe(53);
    expect(report.declared.filter((entry) => entry.surface === "public")).toHaveLength(5);
    expect(report.declared.filter((entry) => entry.surface === "owner")).toHaveLength(48);
    expect(report.registered).toEqual([]);
    expect(report.pending).toHaveLength(53);
    expect(report.developmentPassed).toBe(true);
    expect(report.phase9Complete).toBe(false);
  });

  it("allows one scoped development route while final completeness stays false", () => {
    const root = fixtureRoot();
    const report = buildPhase9RouteManifest(root, { mode: "development" });
    expect(report.declared).toHaveLength(53);
    expect(report.registered.map((entry) => entry.operationId)).toEqual(["putProjectReaction"]);
    expect(report.pending).toHaveLength(52);
    expect(report.developmentPassed).toBe(true);
    expect(report.phase9Complete).toBe(false);
    expect(report.invalidRegistrations).toEqual([]);
  });

  it("rejects missing final registrations, unknown routes, duplicate method/path, and duplicate operation IDs", () => {
    const missing = createPhase9RouteManifest({ operations, registrations: [], mode: "complete", expectedCounts: testContractCounts });
    expect(missing.developmentPassed).toBe(true);
    expect(missing.phase9Complete).toBe(false);
    expect(missing.verdict).toBe("incomplete");

    const duplicate = createPhase9RouteManifest({ operations, registrations: [
      { method: "PUT", path: "/api/v1/projects/{projectId}/reaction", operationId: "putProjectReaction", file: "a" },
      { method: "PUT", path: "/api/v1/projects/{projectId}/reaction", operationId: "putProjectReaction", file: "b" },
      { method: "GET", path: "/api/v1/not-approved", operationId: "inventedOperation", file: "c" },
    ], mode: "development", expectedCounts: testContractCounts });
    expect(duplicate.developmentPassed).toBe(false);
    expect(duplicate.invalidRegistrations.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "duplicate-method-path", "duplicate-operation-id", "unknown-operation",
    ]));
  });

  it("does not pass development mode when the canonical contract count drifts", () => {
    const report = createPhase9RouteManifest({ operations: operations.slice(0, 1), registrations: [], mode: "development" });
    expect(report.developmentPassed).toBe(false);
    expect(report.invalidRegistrations.map((entry) => entry.code)).toContain("canonical-operation-count-mismatch");
  });

  it("rejects operation IDs that do not match their canonical method and path", () => {
    const report = createPhase9RouteManifest({ operations, registrations: [
      { method: "POST", path: "/api/v1/projects/{projectId}/reaction", operationId: "putProjectReaction", file: "route.ts" },
    ], mode: "development", expectedCounts: testContractCounts });
    expect(report.invalidRegistrations.map((entry) => entry.code)).toContain("method-path-operation-mismatch");
  });

  it("rejects unwrapped handler exports, arbitrary operational routes, and forbidden source surfaces", () => {
    const root = fixtureRoot();
    const route = join(root, "src", "app", "api", "v1", "projects", "[projectId]", "reaction", "route.ts");
    writeFileSync(route, "export async function PUT(request: Request) { return Response.json({ ok: true }); }\n");
    const unwrapped = discoverPhase9Registrations(root);
    expect(unwrapped.findings.map((finding) => finding.code)).toContain("unregistered-handler-export");

    const arbitrary = createPhase9RouteManifest({ operations, registrations: [], mode: "development", expectedCounts: testContractCounts,
      sourceFindings: [{ code: "unapproved-runtime-route", file: "src/app/api/internal/admin/route.ts" }] });
    expect(arbitrary.developmentPassed).toBe(false);
    const forbidden = createPhase9RouteManifest({ operations, registrations: [], mode: "development", expectedCounts: testContractCounts,
      sourceFindings: [{ code: "lab-entry-surface", file: "src/app/lab/route.ts" }] });
    expect(forbidden.developmentPassed).toBe(false);
  });

  it("scans all source for provider and generated transport leakage from domain layers", () => {
    const root = fixtureRoot();
    const domain = join(root, "src", "modules", "reactions", "domain");
    mkdirSync(domain, { recursive: true });
    writeFileSync(join(domain, "value.ts"), 'import { sql } from "kysely"; export const value = sql;\n');
    writeFileSync(join(domain, "contract.ts"), 'export { schemas } from "../../contracts/http/zod.gen.js";\n');
    const lab = join(root, "src", "app", "lab");
    mkdirSync(lab, { recursive: true });
    writeFileSync(join(lab, "page.tsx"), 'import React from "react"; export default function Lab() { return <main />; }\n');
    const findings = discoverPhase9Registrations(root).findings.map((finding) => finding.code);
    expect(findings).toContain("provider-import-in-domain-or-application");
    expect(findings).toContain("generated-transport-import-in-domain-or-application");
    expect(findings).toContain("lab-entry-surface");
    expect(findings).toContain("jsx-tsx-surface");
    expect(findings).toContain("react-presentation-import");
  });

  it("counts probes and protected due work outside the 53 product contracts", () => {
    const report = buildPhase9RouteManifest(ROOT, { mode: "development" });
    expect(report.operationalRoutes.map((route) => route.file)).toEqual([
      "src/app/livez/route.ts", "src/app/readyz/route.ts",
    ]);
    expect(report.protectedJobs).toEqual([{ method: PHASE8_PROTECTED_DUE_WORK_HANDOFF.method,
      path: PHASE8_PROTECTED_DUE_WORK_HANDOFF.path, operationId: null, registrationPhase: 9,
      installationPhase: 10, registered: false }]);
    expect(report.declared).toHaveLength(53);
  });

  it("keeps the accepted foundation checkpoints at zero product routes", () => {
    expect(PHASE_ROUTE_REGISTRATION_POLICY.historical.phase1.productRouteCount).toBe(0);
    expect(PHASE_ROUTE_REGISTRATION_POLICY.historical.phase2.productRouteCount).toBe(0);
    expect(PHASE_ROUTE_REGISTRATION_POLICY.historical.phase2.operationalRouteFiles).toEqual([
      "src/app/livez/route.ts", "src/app/readyz/route.ts",
    ]);
  });

  it("rejects malformed evidence descriptors and descriptors bound to stale source", async () => {
    const execution = { name: "phase9 route fixture assertions", artifact: "evidence/phase9-route-registration-293.json",
      artifactSha256: "f".repeat(64), status: "passed", executed: true, exitCode: 0, passed: 1, failed: 0, skipped: 0 };
    const valid = { schemaVersion: 1, ticket: 293,
      source: { revision: "a".repeat(40), treeSha256: "b".repeat(64) },
      contracts: { public: { sha256: "c".repeat(64) }, owner: { sha256: "d".repeat(64) } },
      migrations: [{ name: "migration.sql", sha256: "e".repeat(64) }],
      run: { id: "run-123456", startedAt: "2026-10-31T00:00:00.000Z", completedAt: "2026-10-31T00:01:00.000Z",
        toolVersions: { node: "24.21.0", npm: "11.19.0" }, executions: [execution] },
      predecessors: { verdict: "blocked", blockers: [{ phase: 3, reasons: ["source-tree-mismatch"] }] },
      cleanup: { verified: true } };
    expect(validatePhase9EvidenceDescriptor({ schemaVersion: 1 }, valid)).toEqual(expect.arrayContaining([
      "missing-ticket", "missing-execution-result", "invalid-source-tree", "invalid-migration-inventory",
    ]));
    expect(validatePhase9EvidenceDescriptor(valid, valid)).toEqual([]);
    expect(validatePhase9EvidenceDescriptor(valid, { ...valid, source: { ...valid.source, treeSha256: "f".repeat(64) } }))
      .toContain("stale-source-tree");
    expect(validatePhase9EvidenceDescriptor({ ...valid, run: { ...valid.run,
      executions: [{ ...execution, status: "passed", failed: 1 }] } }, valid)).toContain("execution-claims-unearned-pass");
  });

  it("re-hashes named execution artifacts and fails if their bytes change", () => {
    const artifact = "evidence/phase9-evidence-descriptor-fixture.tmp";
    const artifactPath = join(ROOT, artifact);
    evidenceFiles.push(artifactPath);
    writeFileSync(artifactPath, "executed test output\n");
    const now = new Date().toISOString();
    const descriptor = createPhase9EvidenceDescriptor({
      executions: [{ name: "descriptor fixture validation", artifact, status: "passed", executed: true,
        exitCode: 0, passed: 1, failed: 0, skipped: 0 }],
      predecessors: { verdict: "pass", blockers: [] },
      cleanupVerified: true,
      startedAt: now,
      completedAt: now,
      runId: "phase9-descriptor-run-293",
    });
    expect(evaluatePhase9EvidenceDescriptor(descriptor).accepted).toBe(true);
    writeFileSync(artifactPath, "changed output\n");
    expect(evaluatePhase9EvidenceDescriptor(descriptor).errors).toContain("execution-artifact-digest-mismatch");
  });
});
