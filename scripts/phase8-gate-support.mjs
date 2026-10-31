import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const PHASE8_GATE_SCENARIOS = Object.freeze(Array.from({ length: 16 }, (_, i) => ({
  id: `S${String(i + 1).padStart(2, "0")}`,
  description: ["public journey", "project discovery", "case-study reading", "locale publication", "hidden/archive lifecycle",
    "taxonomy evolution", "durable routes", "accepted media", "current CV", "interaction dedup regression", "Feedback retention",
    "analytics privacy", "owner export scopes", "outbox lease recovery", "optional dependency degradation", "full export round trip"][i],
})));

const componentDefinitions = [
  ["outbox", ["evidence/phase8-retry-recovery-237.json"]],
  ["content-and-exports", ["evidence/phase8-owner-exports-241.json", "evidence/phase8-owner-export-media-243.json", "evidence/phase8-owner-export-cv-244.json", "evidence/phase8-owner-export-moderation-245.json", "evidence/phase8-owner-export-reconciliation-247.json"]],
  ["taxonomy", ["evidence/phase8-owner-export-taxonomy-242.json"]],
  ["analytics", ["evidence/phase8-owner-export-analytics-246.json"]],
  ["retention", ["evidence/phase8-retention-passes-248.json"]],
  ["trigger", ["evidence/phase8-protected-trigger-249.json"]],
  ["reference-import", ["evidence/phase8-owner-export-reference-import-250.json"]],
  ["operations", ["evidence/phase8-operations-observability-251.json"]],
  ["incidents", ["evidence/phase8-actionable-incidents-252.json"]],
  ["integrated", ["evidence/phase8-integrated-verification-256.json"]],
  ["prerequisites", ["evidence/phase8-prerequisite-qualification.json"], false],
];
export const PHASE8_GATE_COMPONENTS = Object.freeze(componentDefinitions.map(([id, paths, cleanupRequired = true]) => ({ id, paths, cleanupRequired })));
export const PHASE8_GATE_REQUIRED_CHECKS = Object.freeze(["validation-ready", "phase8-prerequisites", "integrated", "retry-recovery", "retention-passes", "protected-trigger", "owner-exports", "taxonomy", "analytics-export", "reference-import", "operations-observability", "incidents", "relational-backup", "object-backup", "recovery", "contract-verification", "architecture", "runtime-boundary", "lint", "typecheck", "production-build", "gate-negative-tests"]);
export function countReportedSkips(output) {
  const text = String(output);
  const matches = [...text.matchAll(/(?:\bskipped\b["']?\s*[:=]\s*["']?(\d+)|(\d+)\s+skipped\b|\bskipped\s+(\d+)\b)/giu)];
  if (matches.length) return Math.max(...matches.map((m) => Number(m[1] ?? m[2] ?? m[3])));
  const vitestSummaries = [...text.matchAll(/\bTests\s+(\d+)\s+passed(?:\s*\((\d+)\))?/giu)];
  if (vitestSummaries.length) return Math.max(...vitestSummaries.map((m) => Math.max(0, Number(m[2] ?? m[1]) - Number(m[1]))));
  return null;
}
const criterionComponents = [
  ["prerequisites", "integrated"], ["content-and-exports"], ["content-and-exports"], ["content-and-exports", "integrated"], ["content-and-exports"],
  ["content-and-exports"], ["content-and-exports"], ["content-and-exports", "integrated"], ["content-and-exports", "retention"], ["content-and-exports", "integrated"],
  ["content-and-exports", "integrated"], ["integrated"], ["content-and-exports"], ["content-and-exports"], ["content-and-exports", "reference-import"],
  ["taxonomy", "reference-import"], ["content-and-exports"], ["content-and-exports", "reference-import"], ["content-and-exports", "reference-import"], ["content-and-exports", "retention"],
  ["content-and-exports", "reference-import"], ["analytics", "reference-import"], ["content-and-exports"], ["content-and-exports", "integrated"], ["content-and-exports", "reference-import"],
  ["content-and-exports", "reference-import", "integrated"], ["reference-import", "integrated"], ["reference-import"], ["reference-import"], ["reference-import"],
  ["reference-import"], ["reference-import"], ["reference-import", "integrated"], ["integrated"], ["outbox", "integrated"],
  ["outbox", "integrated"], ["outbox", "retention"], ["outbox", "trigger"], ["outbox", "retention", "integrated"], ["outbox", "integrated"],
  ["outbox", "incidents"], ["outbox", "incidents"], ["outbox", "incidents"], ["outbox", "trigger"], ["trigger", "integrated"],
  ["trigger"], ["trigger", "retention"], ["trigger", "retention"], ["retention", "integrated"], ["retention", "integrated"],
  ["trigger", "integrated"], ["operations", "incidents"], ["operations", "incidents"], ["incidents"], ["operations", "integrated"],
  ["operations", "integrated"], ["integrated"], ["integrated"], ["integrated"], ["integrated"],
  ["integrated"], ["integrated"], ["integrated"], ["integrated"], ["integrated"],
  ["integrated"], ["integrated"], ["integrated", "prerequisites"], ["integrated", "prerequisites"], ["integrated", "prerequisites"],
];
const criterionEvidenceTerms = [
  /phase[ -]?(?:3|4|5|6|7)|prerequisite/u, /interface|request|download|snapshot/u, /scope|normaliz|duplicate|idempotency/u, /owner|portfolio|csrf|\borigin\b|forbidden|unauthor/u, /rollback|atomic|receipt|reservation/u,
  /replay|concurrent|idempotency|meaning change/u, /state|status|transition|failure code/u, /ready|partial|manifest|artifact|fenc/u, /expiry|expired|cleanup|deadline/u, /download|zip|stream|private|no.store/u,
  /missing|corrupt|unauthor|storage|protected existence/u, /contract|problem detail|operation|compatib/u, /content|revision|lifecycle|featured|relationship/u, /locale|translation|publication|revision/u, /route|redirect|canonical|slug/u,
  /taxonomy|rename|retir|merge/u, /media|accessibility|acceptance|variant/u, /object|bytes|digest|asset|missing required/u, /current cv|activation|accepted pdf/u, /feedback|retention|deadline|erasure/u,
  /redact|erased|audit|privacy/u, /analytics|suppression|low.sample|report/u, /setting|configuration|profile|contact|cta/u, /visitor|event|credential|secret|provider/u, /partial|scope|dependency|dangling/u,
  /snapshot|concurrent|capture|race|transaction/u, /stream|bounded|limit|buffer|resum/u, /offline|schema|format|encoding|independent importer/u, /sha.256|digest|corrupt|hash|count/u, /canonical|manifest|descriptor|self.reference/u,
  /traversal|symlink|duplicate|decompression|hostile|path/u, /version|legacy|major|minor/u, /reference import|independent importer|full.scope|all seven/u, /provider|ownership|foreign|module/u, /migration|queue|outbox|schema/u,
  /handler|unsupported|registry|acknowledg/u, /worker|claim|skip locked|independent/u, /fenc|stale.token|expired|database clock/u, /reclaim|restart|checkpoint|lease/u, /retry|attempt|jitter|backoff/u,
  /dead|terminal|incident|fifth/u, /dedup|idempotent|effect/u, /redrive|re.drive|authorized|audit/u, /rollback|publication|optional|post.commit/u,
  /bearer|secret|trigger|scheduler|credential/u, /schedule|portable worker|handoff|registered/u, /catch.up|due.period|checkpoint|overlap/u, /retention|daily|aggregation|completion/u, /utc|cutoff|boundary|fourteen|90.day/u,
  /feedback|withdrawal|privacy|approval/u, /sigterm|shutdown|budget|incomplete/u, /metric|log|dashboard|signal/u, /alert|capacity|burn|threshold/u, /incident|dedup|retry|storm/u,
  /redact|feedback|cv|credential|signed url|secret/u, /readiness|optional|degrad|probe/u, /relational|database|schema|watermark|migration/u, /object|media|cv|variant|backup|inventory/u,
  /encrypt|key|off.primary|tamper/u, /partial|upload|read.back|last.good|cleanup/u, /target|credential|production|source|restore/u, /restore|rehearsal|queue|outbound/u,
  /rls|readiness|domain|snapshot|restore/u, /quarantine|delete|retention|credential|reconcil/u, /rpo|rto|watermark|volume|elapsed/u, /runbook|nightly|weekly|monthly|handoff/u,
  /migration|rls|grant|policy|restricted/u, /architecture|provider|contract|build|lint/u, /criterion|scenario|coverage|cleanup|integrated/u, /stale|partial|skip|aggregate|cleanup|prerequisite/u,
];
export const PHASE8_GATE_CRITERION_MATRIX = Object.freeze(criterionComponents.map((components, i) => ({ id: `P8-${String(i + 1).padStart(2, "0")}`, components, evidencePattern: criterionEvidenceTerms[i] })));
export const PHASE8_GATE_SCENARIO_EVIDENCE = Object.freeze([
  /public|published|visitor/u, /discovery|route|redirect/u, /relationship|evidence|case study/u, /locale|localized|translation/u,
  /hidden|archived|lifecycle/u, /taxonomy|rename|retire/u, /canonical|redirect|slug/u, /accepted media|media bytes|object bytes/u,
  /current cv|activation|accepted pdf/u, /deduplicat|interaction/u, /feedback|retention|deadline/u, /analytics|suppression|low.sample/u,
  /seven.scope|single.scope|scope coverage|partial selection/u, /lease|stale.token|reclaim|checkpoint/u,
  /optional.*(?:outage|fail|degrad)|(?:outage|fail|degrad).*optional/u,
  /reference import|independent importer|full.scope|complete seven.scope/u,
]);

function executionOk(value) {
  if (!value || typeof value !== "object") return false;
  const req = value.required ?? value.acceptance ?? {};
  const counts = value.counts ?? value.testCounts ?? {};
  const executed = Number(req.executed ?? req.passed ?? value.executed ?? value.passed ?? counts.total ?? counts.passed ?? (value.mergeEligible === true ? 1 : 0));
  const failed = Number(req.failed ?? value.failed ?? counts.failed ?? 0);
  const skipped = Number(req.skipped ?? value.skipped ?? counts.skipped ?? 0);
  const todo = Number(req.todo ?? value.todo ?? counts.todo ?? 0);
  const failedSuites = Number(req.failedSuites ?? value.failedSuites ?? 0);
  const explicitFailure = req.success === false || value.success === false || value.verdict === "fail" || value.result === "failed";
  const summarizedPass = Number(req.passed ?? value.passed ?? counts.passed ?? 0) > 0 &&
    Number(req.failed ?? value.failed ?? counts.failed ?? 0) === 0 && Number(req.skipped ?? value.skipped ?? counts.skipped ?? 0) === 0 &&
    Number(req.todo ?? value.todo ?? counts.todo ?? 0) === 0 && Number(req.failedSuites ?? value.failedSuites ?? 0) === 0;
  const suitePass = Array.isArray(req.suites) && req.suites.length > 0 && req.suites.every((suite) => suite.status === "passed" && Number(suite.failed ?? 0) === 0 && Number(suite.skipped ?? 0) === 0);
  return !explicitFailure && (req.success === true || value.success === true || value.verdict === "pass" || value.result === "passed" || summarizedPass || suitePass) &&
    executed > 0 && failed === 0 && skipped === 0 && todo === 0 && failedSuites === 0 && req.partial !== true && value.partial !== true;
}

export function evaluatePhase8Gate({ runId, startedAt, sourceRevision, sourceTreeSha256, runtime, expectedRuntime, checks,
  artifacts, installEvidence, criterionMatrix = PHASE8_GATE_CRITERION_MATRIX, scenarios = PHASE8_GATE_SCENARIOS.map(({ id }) => id), integratedEvidence, prerequisiteEvidence, now = Date.now() }) {
  const failures = [];
  const revision = String(sourceRevision ?? "");
  if (!/^[0-9a-f]{40}$/iu.test(revision) || !/^[0-9a-f]{64}$/iu.test(String(sourceTreeSha256 ?? ""))) failures.push("source-binding-invalid");
  if (String(runtime?.node ?? "").replace(/^v/u, "") !== expectedRuntime?.node || runtime?.npm !== expectedRuntime?.npm) failures.push("runtime-pin-mismatch");
  if (!/^[0-9a-f]{64}$/iu.test(installEvidence?.expectedFingerprint ?? "") || installEvidence?.actualFingerprint !== installEvidence?.expectedFingerprint) failures.push("validation-install-stale-or-missing");
  for (const name of PHASE8_GATE_REQUIRED_CHECKS) {
    const c = checks.find((item) => item.name === name);
    if (!c || c.executed !== true || c.passed !== true || c.skipped !== 0 || c.aggregateSuccess === false) failures.push(`required-check-failed:${name}`);
  }
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  for (const item of PHASE8_GATE_COMPONENTS) {
    const a = byId.get(item.id);
    if (!a || a.sourceRevision !== revision || a.sourceTreeSha256 !== sourceTreeSha256 || a.gateRunId !== runId ||
      a.generatedThisRun !== true || a.fresh !== true || a.positiveExecution !== true || a.aggregateSuccess !== true ||
      (a.cleanupRequired !== false && a.cleanup !== true) || !Array.isArray(a.tests) || a.tests.length === 0 || !/^[0-9a-f]{64}$/iu.test(a.sha256 ?? "")) {
      failures.push(`required-evidence-invalid:${item.id}`);
    }
  }
  const expectedCriterionIds = PHASE8_GATE_CRITERION_MATRIX.map(({ id }) => id);
  if (criterionMatrix.length !== expectedCriterionIds.length || expectedCriterionIds.some((id, index) => criterionMatrix[index]?.id !== id)) failures.push("criterion-inventory-incomplete");
  const criterionEvidence = criterionMatrix.map((c) => {
    const candidates = [...new Set(c.components.flatMap((id) => byId.get(id)?.tests ?? []))].sort();
    const tests = candidates.filter((title) => c.evidencePattern?.test(title));
    return { id: c.id, componentIds: c.components,
      artifacts: [...new Set(c.components.flatMap((id) => byId.get(id)?.paths ?? [byId.get(id)?.path].filter(Boolean)))], tests };
  });
  for (const item of criterionEvidence) if (item.tests.length === 0 || item.componentIds.some((id) => !byId.has(id) || byId.get(id).positiveExecution !== true)) failures.push(`criterion-coverage-incomplete:${item.id}`);
  const scenarioEvidence = PHASE8_GATE_SCENARIOS.map(({ id }, index) => {
    const candidates = [...new Set(artifacts.flatMap((a) => a.tests ?? []))].sort();
    const tests = candidates.filter((title) => PHASE8_GATE_SCENARIO_EVIDENCE[index].test(title));
    return { id, tests, artifacts: [...new Set(artifacts.filter((artifact) => tests.some((title) => artifact.tests?.includes(title)))
      .flatMap((artifact) => artifact.paths ?? [artifact.path].filter(Boolean)))] };
  });
  for (const { id, tests } of scenarioEvidence) if (!scenarios.includes(id) || tests.length === 0) failures.push(`scenario-coverage-incomplete:${id}`);
  if (!executionOk(integratedEvidence)) failures.push("integrated-real-service-evidence-invalid");
  const integratedRevision = integratedEvidence?.source?.revision ?? integratedEvidence?.sourceRevision;
  const integratedTree = integratedEvidence?.source?.workingTreeSha256 ?? integratedEvidence?.sourceTreeSha256;
  if (integratedRevision !== revision || integratedTree !== sourceTreeSha256) failures.push("integrated-real-service-evidence-stale");
  const prerequisiteSource = prerequisiteEvidence?.evaluator ?? prerequisiteEvidence?.source ?? {};
  if (!executionOk(prerequisiteEvidence) || prerequisiteEvidence.acceptedPhases?.join(",") !== "3,4,5,6,7" ||
      prerequisiteSource.sourceRevision !== revision || prerequisiteSource.sourceTreeSha256 !== sourceTreeSha256) failures.push("failed-or-stale-prerequisite-evidence");
  if (Date.parse(startedAt) > now || now - Date.parse(startedAt) > 24 * 60 * 60 * 1000) failures.push("gate-run-stale");
  return { verdict: failures.length ? "fail" : "pass", failures: [...new Set(failures)], criterionEvidence, counts: {
    criteria: PHASE8_GATE_CRITERION_MATRIX.length, executedCriteria: criterionEvidence.filter((item) => item.tests.length > 0 && item.componentIds.every((id) => byId.get(id)?.positiveExecution === true)).length,
    scenarios: PHASE8_GATE_SCENARIOS.length, executedScenarios: scenarioEvidence.filter(({ tests }) => tests.length > 0).length,
    requiredChecks: PHASE8_GATE_REQUIRED_CHECKS.length, executedChecks: PHASE8_GATE_REQUIRED_CHECKS.filter((name) => {
      const check = checks.find((item) => item.name === name);
      return check?.executed === true && check.passed === true && check.skipped === 0;
    }).length,
  }, scenarioEvidence };
}

export function readBoundArtifact(root, component, { sourceRevision, sourceTreeSha256, gateRunId, gateStartedAt, generatedThisRun, scenarios, now = Date.now() }) {
  const paths = component.paths ?? [component.path];
  const reports = paths.map((path) => ({ path, bytes: readFileSync(`${root}/${path}`) })).map((entry) => ({ ...entry, report: JSON.parse(entry.bytes.toString("utf8")) }));
  const report = reports.length === 1 ? reports[0].report : reports.map(({ report: value }) => value);
  const reqs = reports.map(({ report: value }) => value.required ?? value.acceptance ?? {});
  const positiveExecution = reports.every(({ report: value }, i) => executionOk(value) || executionOk({ ...value, required: reqs[i]?.acceptance ?? reqs[i] }));
  const clean = (value) => value === true || value === "passed" || value?.success === true || value?.cleanupComplete === true ||
    typeof value === "object" && value !== null && Object.values(value).length > 0 && Object.values(value).every(clean);
  const cleanup = reports.every(({ report: value }) => clean(value.cleanup) || clean(value.cleanupDiagnostics?.result));
  const sourceRevisions = reports.map(({ report: value }) => value.sourceRevision ?? value.source?.revision ?? value.repository?.head ?? value.repository?.commit ?? value.evaluator?.sourceRevision);
  const sourceTrees = reports.map(({ report: value }) => value.sourceTreeSha256 ?? value.source?.workingTreeSha256 ?? value.repository?.sourceTreeSha256 ?? value.repository?.sourceTreeSha256After ?? value.evaluator?.sourceTreeSha256);
  const generatedTimes = reports.map(({ report: value }) => value.startedAt ?? value.evaluatedAt ?? value.evaluator?.startedAt ?? value.completedAt ?? value.endedAt);
  const tests = new Set();
  const collectTests = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectTests); return; }
    if (typeof value.title === "string" && ["passed", "pass", "success"].includes(value.status)) tests.add(value.title);
    if (typeof value.name === "string" && typeof value.suite === "string") tests.add(`${value.suite} :: ${value.name}`);
    for (const title of value.testNames ?? []) if (typeof title === "string" && title.trim()) tests.add(title.trim());
    for (const title of value.tests ?? []) if (typeof title === "string" && title.trim()) tests.add(title.trim());
    if (typeof value.title === "string" && value.status === "passed") tests.add(value.title);
    if (typeof value.title === "string" && value.status === undefined && /^(?:passed|✓|✔)\s/iu.test(value.title)) tests.add(value.title.replace(/^(?:passed|✓|✔)\s/iu, ""));
    for (const child of Object.values(value)) collectTests(child);
  };
  reports.forEach(({ report: value }) => {
    collectTests(value);
    if (component.id === "prerequisites" && executionOk(value) && value.acceptedPhases?.join(",") === "3,4,5,6,7") {
      for (const phase of value.phases ?? []) if (phase.aggregateSuccess === true || phase.required?.success === true) tests.add(`Phase ${phase.phase} prerequisite qualification passed`);
      tests.add("Phase 3–7 prerequisite qualification passed");
    }
  });
  const allSourceBound = sourceRevisions.every((value) => value === sourceRevision) && sourceTrees.every((value) => value === sourceTreeSha256);
  const allGeneratedDuringGate = generatedTimes.every((value) => {
    const at = Date.parse(value ?? "");
    return Number.isFinite(at) && at >= Date.parse(gateStartedAt ?? "") && at <= now;
  });
  const bytes = Buffer.concat(reports.map(({ bytes: value }) => value));
  const uniqueTests = [...tests].sort();
  return { id: component.id, paths, sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceRevision: allSourceBound ? sourceRevision : sourceRevisions.find((value) => value !== sourceRevision) ?? null,
    sourceTreeSha256: allSourceBound ? sourceTreeSha256 : sourceTrees.find((value) => value !== sourceTreeSha256) ?? null,
    gateRunId: generatedThisRun ? gateRunId : null, generatedThisRun,
    fresh: allSourceBound && allGeneratedDuringGate, generatedAt: generatedTimes,
    positiveExecution, aggregateSuccess: positiveExecution, cleanup, cleanupRequired: component.cleanupRequired !== false,
    tests: uniqueTests, scenarios: [] };
}
