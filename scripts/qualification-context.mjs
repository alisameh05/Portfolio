// Shared qualification context for the Phase 3–7 prerequisite qualification.
//
// `npm run phase8:qualify` runs the qualification DAG below in declared
// dependency order against one committed source tree. It records every
// completed node into `evidence/phase8-qualification-run.json`; nested gates
// reuse a predecessor from that shared context only when the record verifies
// against the current source identity and definition hash. Without an explicit
// `--resume` the recorded context is ignored entirely and every node reruns.

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { REQUIRED_PHASE3_CHECK_NAMES } from "./phase3-gate-support.mjs";
import { REQUIRED_PHASE4_CHECK_NAMES } from "./phase4-gate-support.mjs";
import { REQUIRED_PHASE5_GATE_CHECKS } from "./phase5-gate-support.mjs";
import { PHASE6_GATE_REQUIRED_CHECKS } from "./phase6-gate-support.mjs";
import { PHASE7_GATE_REQUIRED_CHECKS } from "./phase7-gate-support.mjs";
import { WINDOWS_PHASE2_NONREQUIRED_SKIP } from "./qualification-command.mjs";
import { evaluatePhase8Prerequisites } from "./phase8-prerequisite-qualification.mjs";

export const QUALIFICATION_CONTEXT_VARIABLE = "PHASE8_QUALIFICATION_CONTEXT";
export const QUALIFICATION_RUN_FILE = "evidence/phase8-qualification-run.json";
export const QUALIFICATION_CONTEXT_ALGORITHM = "phase8-qualification-run/v1";

/**
 * The authoritative qualification DAG: nodes must be listed in topological
 * order because execution is sequential and deterministic. `report` names the
 * commit evidence each gate publishes; it is hashed into the shared context so
 * nested gates can verify a reused predecessor byte-for-byte.
 */
export const QUALIFICATION_NODES = Object.freeze([
  { id: "validation-environment", label: "validation environment", script: "scripts/validation-environment.mjs", args: [], deps: [], report: null },
  { id: "phase1", label: "Phase 1", script: "scripts/phase1-gate.mjs", args: [], deps: ["validation-environment"], report: "evidence/phase-1-gate-report.json" },
  { id: "phase2", label: "Phase 2", script: "scripts/phase2-gate.mjs", args: [], deps: ["phase1"], report: "evidence/phase-2-gate-report.json" },
  { id: "phase3", label: "Phase 3", script: "scripts/phase3-gate.mjs", args: [], deps: ["phase2"], report: "evidence/phase-3-gate-report.json" },
  { id: "phase4", label: "Phase 4", script: "scripts/phase4-gate.mjs", args: [], deps: ["phase3"], report: "evidence/phase-4-gate-report.json" },
  { id: "phase5", label: "Phase 5", script: "scripts/phase5-gate.mjs", args: [], deps: ["phase4"], report: "evidence/phase-5-gate-report.json" },
  { id: "phase6", label: "Phase 6", script: "scripts/docker-validation.mjs", args: ["gate"], deps: ["phase5"], report: "evidence/phase6-gate-report.json" },
  { id: "phase7", label: "Phase 7", script: "scripts/phase7-gate.mjs", args: [], deps: ["phase6"], report: "evidence/phase7-gate-report.json" },
  { id: "evaluator", label: "prerequisite qualification", script: "scripts/phase8-prerequisite-qualification.mjs", args: [], deps: ["phase7"], report: "evidence/phase8-prerequisite-qualification.json" },
].map(Object.freeze));

const REQUIRED_REPORT_CHECKS = Object.freeze({
  // Codex is the sole AI reviewer; this required row records the no-CodeRabbit policy check.
  phase1: Object.freeze(["toolchain verification", "typechecking (tsc --noEmit)", "tests (vitest run, one-worker threads)",
    "contract lint public@v1", "contract lint owner@v1", "contract bundle public@v1 (canonical)",
    "contract bundle owner@v1 (canonical)", "generation + drift (byte-for-byte)", "compatibility (master baseline)",
    "architecture (dependency rules + fixtures)", "review policy (Codex sole AI reviewer)",
    "coderabbit inventory (no repo-controlled surface)", "route + source inventory (declared vs runtime)",
    "frontend + lab exclusion scan", "dependency/version manifest"]),
  phase2: Object.freeze(["phase1-toolchain", "phase1-contract-drift", "phase1-contract-compatibility",
    "phase1-contract-and-strict-validator-tests", "production-build", "strict-typecheck", "deterministic-lint",
    "architecture", "route-inventory", "contract-to-adapter-matrix", "configuration-negative-tests",
    "http-adapter-tests", "problem-details-tests", "health-lifecycle-tests"]),
  phase3: REQUIRED_PHASE3_CHECK_NAMES,
  phase4: REQUIRED_PHASE4_CHECK_NAMES,
  phase5: REQUIRED_PHASE5_GATE_CHECKS,
  phase6: PHASE6_GATE_REQUIRED_CHECKS,
  phase7: PHASE7_GATE_REQUIRED_CHECKS,
});

export function requiredQualificationCheckNames(nodeId) {
  return REQUIRED_REPORT_CHECKS[nodeId] ?? null;
}

export function qualificationNodeIds() {
  return QUALIFICATION_NODES.map((node) => node.id);
}

function definitionShape(nodes) {
  return nodes.map(({ id, label, script, args = [], deps = [], report }) => ({ id, label, script, args, deps, report }));
}

export function qualificationDefinitionSha256(nodes = QUALIFICATION_NODES) {
  return createHash("sha256")
    .update(JSON.stringify({ algorithm: QUALIFICATION_CONTEXT_ALGORITHM, nodes: definitionShape(nodes),
      requiredReportChecks: REQUIRED_REPORT_CHECKS }))
    .digest("hex");
}

export function qualificationDefinitionErrors(nodes = QUALIFICATION_NODES) {
  const errors = [];
  const seen = new Set();
  const positions = new Map(nodes.map((node, index) => [node.id ?? index, index]));
  for (const [index, node] of nodes.entries()) {
    if (typeof node.id !== "string" || !/^[a-z0-9-]+$/.test(node.id)) errors.push("QUALIFICATION_NODE_ID_INVALID");
    if (typeof node.script !== "string" || !node.script.startsWith("scripts/")) errors.push("QUALIFICATION_NODE_SCRIPT_INVALID");
    if (!Array.isArray(node.deps) || node.deps.some((dep) => {
      if (typeof dep !== "string" || !positions.has(dep)) return true;
      return positions.get(dep) >= index;
    })) errors.push(`QUALIFICATION_NODE_DEPENDENCY_NOT_BEFORE:${node.id ?? "unknown"}`);
    if (seen.has(node.id)) errors.push(`QUALIFICATION_NODE_DUPLICATE:${node.id ?? "unknown"}`);
    seen.add(node.id);
  }
  return [...new Set(errors)];
}

export function readQualificationRun(root, path = join(root, QUALIFICATION_RUN_FILE)) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Sha-256 of a repo-relative evidence file, or null when absent. */
export function evidenceFileSha256(root, file) {
  if (typeof file !== "string" || file.length === 0 || file.includes("\0")) return null;
  try {
    const base = resolve(root); const target = resolve(base, file); const rel = relative(base, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(target) === base) return null;
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  } catch {
    return null;
  }
}

export function emptyQualificationRun({ definitionHash, identity, startedAt }) {
  return {
    algorithm: QUALIFICATION_CONTEXT_ALGORITHM,
    runId: randomUUID(),
    definitionHash,
    identity: { revision: identity.revision, sourceTreeSha256: identity.tree, runtime: identity.runtime ?? null,
      migrations: identity.migrations ?? null, services: identity.services ?? null },
    startedAt,
    status: "running",
    nodes: {},
  };
}

export function recordQualificationNode(run, { id, report = null, artifacts = [] }) {
  run.nodes[id] = {
    completed: true,
    status: "succeeded",
    cleanupSucceeded: true,
    exitCode: 0,
    completedAt: new Date().toISOString(),
    report: report === null ? null : { file: report.file, sha256: report.sha256, artifacts },
  };
  return run;
}

export function invalidateNodeAndDescendants(run, nodeId, nodes = QUALIFICATION_NODES) {
  const invalid = new Set([nodeId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!invalid.has(node.id) && node.deps.some((dep) => invalid.has(dep))) {
        invalid.add(node.id); changed = true;
      }
    }
  }
  for (const id of invalid) delete run.nodes[id];
  return invalid;
}

export function setQualificationNodeState(run, id, status, exitCode = null) {
  run.nodes[id] = {
    completed: status === "succeeded",
    status,
    exitCode,
    cleanupSucceeded: status === "succeeded",
    startedAt: new Date().toISOString(),
    completedAt: status === "succeeded" ? new Date().toISOString() : null,
    report: null,
  };
  run.status = status === "failed" ? "failed" : "running";
  return run;
}

export function writeQualificationRun(run, root, path = join(root, QUALIFICATION_RUN_FILE)) {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(run, null, 2)}\n`;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, path);
  } catch (error) {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* leave cleanup to the OS */ }
    throw error;
  }
  return serialized;
}

export function contextIdentityErrors(context, { revision, sourceTreeSha256, definitionHash, migrations, services }) {
  const errors = [];
  if (!context || context.algorithm !== QUALIFICATION_CONTEXT_ALGORITHM) errors.push("QUALIFICATION_CONTEXT_UNRECOGNIZED");
  if (typeof context?.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(context.runId)) {
    errors.push("QUALIFICATION_CONTEXT_RUN_ID_INVALID");
  }
  if (context?.definitionHash !== definitionHash) errors.push("QUALIFICATION_CONTEXT_DEFINITION_DRIFTED");
  if (context?.identity?.revision !== revision || context?.identity?.sourceTreeSha256 !== sourceTreeSha256) {
    errors.push("QUALIFICATION_CONTEXT_SOURCE_CHANGED");
  }
  if (JSON.stringify(context?.identity?.runtime ?? null) !== JSON.stringify(currentRuntimeIdentity())) errors.push("QUALIFICATION_CONTEXT_TOOL_IDENTITY_CHANGED");
  if (migrations !== undefined && JSON.stringify(context?.identity?.migrations ?? null) !== JSON.stringify(migrations)) {
    errors.push("QUALIFICATION_CONTEXT_MIGRATIONS_CHANGED");
  }
  if (services !== undefined && JSON.stringify(context?.identity?.services ?? null) !== JSON.stringify(services)) {
    errors.push("QUALIFICATION_CONTEXT_SERVICE_IDENTITY_CHANGED");
  }
  if ((services ?? context?.identity?.services)?.unverifiedImages?.length > 0) errors.push("QUALIFICATION_CONTEXT_SERVICE_IMAGE_IDENTITY_UNVERIFIED");
  if (context?.status === "complete") {
    for (const [, node] of Object.entries(context?.nodes ?? {})) {
      if (node.exitCode !== 0 || node.completed !== true || node.status !== "succeeded" || node.cleanupSucceeded !== true) {
        errors.push("QUALIFICATION_CONTEXT_NODE_NOT_COMPLETED");
      }
    }
  }
  return [...new Set(errors)];
}

export function currentRuntimeIdentity() {
  return { node: process.version, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? null,
    platform: process.platform, architecture: process.arch,
    environmentSha256: createHash("sha256").update(JSON.stringify(Object.entries(process.env)
      .filter(([name]) => !/^(?:PHASE8_QUALIFICATION_CONTEXT|PHASE8_ACTIVE_RUN_ID|PHASE8_DEFINITION_HASH|SHIPWITHALI_PHASE|PHASE[34567]_GATE_RUN_ID)$/u.test(name))
      .sort(([a], [b]) => a.localeCompare(b)))).digest("hex") };
}

/** Node ids whose recorded completion still verifies against the working tree. */
export function reusableNodes(context, nodeIds, root, { allowIncomplete = false } = {}) {
  if (!context || typeof context !== "object") return new Set();
  if (context.status !== "complete" && !(allowIncomplete && ["running", "failed"].includes(context.status))) return new Set();
  const reusable = new Set();
  const validNode = (id) => {
    const node = context.nodes?.[id];
    const expected = QUALIFICATION_NODES.find((candidate) => candidate.id === id);
    if (!node || expected === undefined || node.completed !== true || node.exitCode !== 0 ||
        node.cleanupSucceeded !== true || node.status !== "succeeded") return false;
    const nodeCompleted = Date.parse(node.completedAt ?? "");
    if (!Number.isFinite(nodeCompleted) || nodeCompleted > Date.now() || Date.now() - nodeCompleted > 14 * 24 * 60 * 60 * 1000) return false;
    if (expected.report === null) return node.report === null;
    if (node.report?.file !== expected.report || typeof node.report.sha256 !== "string") return false;
    if (evidenceFileSha256(root, node.report.file) !== node.report.sha256) return false;
    const proof = readQualificationReport(root, node.report.file);
    if (!qualificationReportIsReusable(proof, context.identity, id, { root, reportPath: node.report.file })) return false;
    const expectedArtifacts = reportArtifactPaths(proof, root);
    if (JSON.stringify(expectedArtifacts) !== JSON.stringify((node.report.artifacts ?? []).map((item) => item.file))) return false;
    return (node.report.artifacts ?? []).every((item) => evidenceFileSha256(root, item.file) === item.sha256);
  };
  const closure = (id, found = new Set()) => {
    const expected = QUALIFICATION_NODES.find((candidate) => candidate.id === id);
    if (!expected) return found;
    for (const dep of expected.deps) { found.add(dep); closure(dep, found); }
    return found;
  };
  for (const id of nodeIds) {
    const expected = QUALIFICATION_NODES.find((candidate) => candidate.id === id);
    if (expected === undefined || ![...closure(id), id].every(validNode)) continue;
    reusable.add(id);
  }
  return reusable;
}

function readQualificationReport(root, file) {
  try { return JSON.parse(readFileSync(join(root, file), "utf8")); }
  catch { return null; }
}

export function qualificationReportIsReusable(report, identity, nodeId, { root, reportPath } = {}) {
  if (!report || report.verdict !== "pass") return false;
  if (!["phase1", "phase2", "phase3", "phase4", "phase5", "phase6", "phase7"].includes(nodeId)) return false;
  const requiredChecks = REQUIRED_REPORT_CHECKS[nodeId];
  if (["phase1", "phase2"].includes(nodeId)) {
    return validateSimplePhaseReport(report, identity, nodeId, requiredChecks);
  }
  if (!root || reportPath === undefined || !Array.isArray(identity.migrations)) return false;
  const persistedReport = readQualificationReport(root, reportPath);
  if (!persistedReport || !isDeepStrictEqual(persistedReport, report)) return false;
  const phase = Number(nodeId.slice("phase".length));
  const evaluation = evaluatePhase8Prerequisites({
    root, sourceRevision: identity.revision, sourceTreeSha256: identity.sourceTreeSha256,
    resolveSourceTree: () => identity.sourceTreeSha256,
    resolveMigrationInventory: () => identity.migrations,
    isAncestor: () => true,
  });
  return evaluation.phases.find((item) => item.phase === phase && item.path === reportPath)?.accepted === true;
}

function validateSimplePhaseReport(report, identity, nodeId, requiredChecks) {
  const names = Array.isArray(report.checks) ? report.checks.map((check) => check?.name) : [];
  const started = Date.parse(report.startedAt ?? "");
  const completed = Date.parse(report.completedAt ?? "");
  const now = Date.now();
  return report.sourceRevision === identity.revision && report.sourceTreeSha256 === identity.sourceTreeSha256 &&
    isDeepStrictEqual(report.toolVersions, identity.runtime) &&
    Number.isFinite(started) && Number.isFinite(completed) && started <= completed && completed <= now &&
    now - completed <= 14 * 24 * 60 * 60 * 1000 &&
    JSON.stringify([...names].sort()) === JSON.stringify([...requiredChecks].sort()) &&
    report.checks.length === requiredChecks.length && report.checks.every((check) =>
      (check.ok === true || check.passed === true) && (check.exitCode === undefined || check.exitCode === 0) &&
      Number(check.skipped ?? 0) === 0 && check.executed !== false && check.cancelled !== true &&
      (Number(check.observedSkipped ?? 0) === 0 || (nodeId === "phase2" && check.name === "http-adapter-tests" &&
        identity.runtime?.platform === "win32" && Number(check.observedSkipped) === 1 &&
        isDeepStrictEqual(check.nonRequiredSkips, [WINDOWS_PHASE2_NONREQUIRED_SKIP]))) &&
      (check.nonRequiredSkips === undefined || (Array.isArray(check.nonRequiredSkips) && check.nonRequiredSkips.length === 0) ||
        (nodeId === "phase2" && check.name === "http-adapter-tests" &&
        identity.runtime?.platform === "win32" && isDeepStrictEqual(check.nonRequiredSkips, [WINDOWS_PHASE2_NONREQUIRED_SKIP])))) &&
    (nodeId !== "phase2" || report.observedSkipped === report.checks.reduce((sum, check) => sum + Number(check.observedSkipped ?? 0), 0)) &&
    (nodeId !== "phase2" || isDeepStrictEqual(report.nonRequiredSkips, report.checks.flatMap((check) => check.nonRequiredSkips ?? []))) &&
    report.summary?.failed === 0 && report.summary?.total === requiredChecks.length &&
    report.required?.success === true && report.required?.failed === 0 && report.required?.skipped === 0 &&
    report.cleanup?.success === true;
}

export function reportArtifactPaths(report, root = null) {
  const files = new Set();
  const visitedJson = new Set();
  const visit = (value, pathField = false) => {
    if (typeof value === "string") {
      if (pathField && /^(?:evidence\/|openapi\/generated\/|docs\/|AGENTS\.md$)/u.test(value) &&
          !value.includes("\\") && !value.includes("\0") && !value.split("/").includes("..") && !value.split("/").includes(".")) {
        files.add(value);
        if (root !== null && value.endsWith(".json") && !visitedJson.has(value)) {
          visitedJson.add(value);
          const nested = readQualificationReport(root, value);
          if (nested) visitReportReferences(nested);
        }
      }
      return;
    }
    if (Array.isArray(value)) { for (const item of value) visit(item, pathField); return; }
    if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
      visit(item, ["file", "path", "evidence"].includes(key));
    }
  };
  const visitReportReferences = (value) => {
    for (const key of ["evidence", "evidenceArtifacts", "checks", "realServiceScope", "components", "serviceEvidence", "services", "artifacts"]) {
      visit(value?.[key], ["evidence", "evidenceArtifacts", "artifacts"].includes(key));
    }
  };
  visitReportReferences(report);
  return [...files].sort();
}

export function qualificationReportArtifacts(root, reportFile, identity) {
  const report = readQualificationReport(root, reportFile);
  const node = QUALIFICATION_NODES.find((candidate) => candidate.report === reportFile);
  if (!report || report.verdict !== "pass" || node === undefined) return null;
  if (node.id === "evaluator") {
    if (report.evaluator?.sourceRevision !== identity.revision || report.evaluator?.sourceTreeSha256 !== identity.sourceTreeSha256 ||
        report.mergeEligible !== true || report.acceptedPhases?.length !== 5 || report.blockers?.length !== 0) return null;
  } else if (!qualificationReportIsReusable(report, identity, node.id, { root, reportPath: reportFile })) return null;
  const files = reportArtifactPaths(report, root);
  const artifacts = files.map((file) => ({ file, sha256: evidenceFileSha256(root, file) }));
  if (artifacts.some((artifact) => artifact.sha256 === null)) return null;
  return { report, artifacts };
}

/**
 * Gate-side reuse of an orchestrated predecessor. A gate accepts the shared
 * context only when it was told about it, the context binds to this exact
 * committed source and gate definition, and the predecessor's recorded report
 * file still matches its recorded digest. Anything else fails closed.
 */
export function verifyGatePredecessors({
  context,
  nodeIds,
  root,
  revision,
  sourceTreeSha256,
  definitionHash,
  activeRunId = process.env.PHASE8_ACTIVE_RUN_ID,
  activeDefinitionHash = process.env.PHASE8_DEFINITION_HASH,
}) {
  if (typeof activeRunId !== "string" || activeRunId.length < 16 || activeRunId !== context?.runId ||
      activeDefinitionHash !== definitionHash || activeDefinitionHash !== context?.definitionHash || context?.status !== "running") {
    return { usable: false, reason: "QUALIFICATION_CONTEXT_NOT_ACTIVE_RUN", reuse: new Map() };
  }
  const identities = contextIdentityErrors(context, { revision, sourceTreeSha256, definitionHash });
  if (!(["complete", "running", "failed"].includes(context?.status))) identities.push("QUALIFICATION_CONTEXT_RUN_NOT_RESUMABLE");
  if (identities.length > 0) return { usable: false, reason: identities[0], reuse: new Map() };
  const reuse = new Map();
  for (const id of reusableNodes(context, nodeIds, root, { allowIncomplete: true })) {
    const node = context.nodes[id];
    reuse.set(id, { file: node.report.file, sha256: node.report.sha256, completedAt: node.completedAt });
  }
  return { usable: true, reason: null, reuse };
}
