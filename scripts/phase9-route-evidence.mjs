import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, "");
const SHA256 = /^[a-f0-9]{64}$/u;
const REVISION = /^[a-f0-9]{40}$/u;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function migrationInventory(root = ROOT) {
  const directory = join(root, "supabase", "migrations");
  return readdirSync(directory).filter((name) => statSync(join(directory, name)).isFile() && name.endsWith(".sql"))
    .sort().map((name) => ({ name, sha256: sha256(readFileSync(join(directory, name))) }));
}

function gitRevision(root = ROOT) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function isRevisionAncestor(root, olderRevision, newerRevision) {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", olderRevision, newerRevision], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function validatePhase9EvidenceDescriptor(descriptor, expected = {}) {
  const errors = [];
  const add = (code) => { if (!errors.includes(code)) errors.push(code); };
  if (!descriptor || typeof descriptor !== "object" || Array.isArray(descriptor)) return ["malformed-descriptor"];
  if (descriptor.schemaVersion !== 1) add("unsupported-schema-version");
  if (descriptor.ticket !== 293) add("missing-ticket");
  if (!REVISION.test(descriptor.source?.revision ?? "")) add("invalid-source-revision");
  if (!SHA256.test(descriptor.source?.treeSha256 ?? "")) add("invalid-source-tree");
  for (const bundle of ["public", "owner"]) {
    if (!SHA256.test(descriptor.contracts?.[bundle]?.sha256 ?? "")) add(`invalid-${bundle}-bundle-digest`);
  }
  if (!Array.isArray(descriptor.migrations) || descriptor.migrations.length === 0 ||
      descriptor.migrations.some((migration) => !migration || typeof migration.name !== "string" || migration.name.length === 0 || !SHA256.test(migration.sha256 ?? "")) ||
      new Set((descriptor.migrations ?? []).map((migration) => migration?.name)).size !== descriptor.migrations.length) {
    add("invalid-migration-inventory");
  }
  const run = descriptor.run;
  if (!run || typeof run.id !== "string" || run.id.length < 8 || !Array.isArray(run.executions) || run.executions.length === 0) {
    add("missing-execution-result");
  } else {
    const started = Date.parse(run.startedAt ?? "");
    const completed = Date.parse(run.completedAt ?? "");
    if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) add("invalid-run-window");
    if (run.toolVersions?.node !== "24.21.0" || run.toolVersions?.npm !== "11.19.0") add("wrong-runtime");
    for (const execution of run.executions) {
      if (!execution || typeof execution.name !== "string" || execution.name.length === 0 || execution.executed !== true ||
          !Number.isInteger(execution.exitCode) || !Number.isInteger(execution.passed) || execution.passed < 0 ||
          !Number.isInteger(execution.failed) || execution.failed < 0 || !Number.isInteger(execution.skipped) || execution.skipped < 0 ||
          typeof execution.artifact !== "string" || execution.artifact.length === 0 ||
          !SHA256.test(execution.artifactSha256 ?? "") ||
          !["passed", "failed", "blocked"].includes(execution.status)) add("invalid-named-execution");
      if (execution?.status === "passed" && (execution.exitCode !== 0 || execution.failed !== 0 || execution.skipped !== 0)) {
        add("execution-claims-unearned-pass");
      }
      if (execution?.status === "blocked" && execution.exitCode === 0) add("blocked-execution-claims-success");
    }
  }
  if (descriptor.predecessors?.verdict === "blocked" &&
      (!Array.isArray(descriptor.predecessors.blockers) || descriptor.predecessors.blockers.length === 0 ||
       descriptor.predecessors.blockers.some((blocker) => !Number.isInteger(blocker.phase) || !Array.isArray(blocker.reasons) || blocker.reasons.length === 0))) {
    add("blocked-prerequisites-not-named");
  } else if (!descriptor.predecessors || !["pass", "blocked"].includes(descriptor.predecessors.verdict)) {
    add("missing-prerequisite-verdict");
  }
  if (descriptor.cleanup?.verified !== true) add("cleanup-unverified");

  if (expected.source?.revision && descriptor.source?.revision !== expected.source.revision) add("stale-source-revision");
  if (expected.source?.treeSha256 && descriptor.source?.treeSha256 !== expected.source.treeSha256) add("stale-source-tree");
  for (const bundle of ["public", "owner"]) {
    if (expected.contracts?.[bundle]?.sha256 && descriptor.contracts?.[bundle]?.sha256 !== expected.contracts[bundle].sha256) add(`stale-${bundle}-bundle`);
  }
  if (expected.migrations && JSON.stringify(descriptor.migrations) !== JSON.stringify(expected.migrations)) add("stale-migrations");
  if (expected.run?.id && descriptor.run?.id !== expected.run.id) add("stale-run-identity");
  return errors;
}

export function createPhase9EvidenceDescriptor({ executions, predecessors, cleanupVerified, startedAt, completedAt,
  runId = randomUUID(), root = ROOT } = {}) {
  const sourceBoundExecutions = executions?.map((execution) => {
    const artifactPath = join(root, execution.artifact);
    const artifactRelative = relative(root, artifactPath);
    if (isAbsolute(execution.artifact) || artifactRelative.startsWith("..")) throw new Error("PHASE9_EVIDENCE_ARTIFACT_OUTSIDE_REPOSITORY");
    return { ...execution, artifactSha256: sha256(readFileSync(artifactPath)) };
  });
  const publicPath = "openapi/generated/public-v1.json";
  const ownerPath = "openapi/generated/owner-v1.json";
  const descriptor = {
    schemaVersion: 1,
    ticket: 293,
    source: { revision: gitRevision(root), treeSha256: workingTreeSourceSha256() },
    contracts: {
      public: { path: publicPath, sha256: sha256(readFileSync(join(root, publicPath))) },
      owner: { path: ownerPath, sha256: sha256(readFileSync(join(root, ownerPath))) },
    },
    migrations: migrationInventory(root),
    run: {
      id: runId,
      startedAt,
      completedAt,
      toolVersions: { node: process.versions.node, npm: process.env.npm_config_user_agent?.match(/npm\/(\S+)/u)?.[1] ?? null },
      executions: sourceBoundExecutions,
    },
    predecessors,
    cleanup: { verified: cleanupVerified === true },
  };
  const errors = validatePhase9EvidenceDescriptor(descriptor);
  if (errors.length > 0) throw new Error(`PHASE9_EVIDENCE_INVALID:${errors.join(",")}`);
  return descriptor;
}

export function writePhase9EvidenceDescriptor(descriptor, path = "evidence/phase9-route-registration-293.json", root = ROOT) {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
  return path;
}

export function evaluatePhase9EvidenceDescriptor(descriptor, { root = ROOT, sourceTreeSha256 = workingTreeSourceSha256() } = {}) {
  const publicPath = "openapi/generated/public-v1.json";
  const ownerPath = "openapi/generated/owner-v1.json";
  const expected = {
    source: { treeSha256: sourceTreeSha256 },
    contracts: {
      public: { sha256: sha256(readFileSync(join(root, publicPath))) },
      owner: { sha256: sha256(readFileSync(join(root, ownerPath))) },
    },
    migrations: migrationInventory(root),
  };
  const errors = validatePhase9EvidenceDescriptor(descriptor, expected);
  for (const execution of descriptor?.run?.executions ?? []) {
    if (typeof execution.artifact !== "string" || isAbsolute(execution.artifact) || relative(root, join(root, execution.artifact)).startsWith("..")) {
      errors.push("execution-artifact-path-invalid");
      continue;
    }
    const artifactPath = join(root, execution.artifact);
    if (!existsSync(artifactPath)) errors.push("execution-artifact-missing");
    else if (sha256(readFileSync(artifactPath)) !== execution.artifactSha256) errors.push("execution-artifact-digest-mismatch");
  }
  if (!isRevisionAncestor(root, descriptor?.source?.revision ?? "", gitRevision(root))) errors.push("stale-source-revision");
  if (descriptor?.predecessors?.verdict !== "pass") errors.push("predecessors-not-accepted");
  if (descriptor?.run?.executions?.some((execution) => execution.status !== "passed" || execution.failed !== 0 || execution.skipped !== 0)) {
    errors.push("required-execution-not-passing");
  }
  return { accepted: errors.length === 0, errors: [...new Set(errors)], expected };
}

export function recordPhase9Evidence({ root = ROOT, summaryPath = "evidence/phase9-route-run-summary.json",
  prerequisitePath = "evidence/phase8-prerequisite-qualification.json",
  outputPath = "evidence/phase9-route-registration-293.json" } = {}) {
  const summary = JSON.parse(readFileSync(join(root, summaryPath), "utf8"));
  const prerequisites = JSON.parse(readFileSync(join(root, prerequisitePath), "utf8"));
  const blockers = Array.isArray(prerequisites.blockers) ? prerequisites.blockers.map((blocker) => ({
    phase: blocker.phase,
    ticket: blocker.ticket,
    reasons: blocker.reasons,
    nextAction: blocker.nextAction,
  })) : [];
  const descriptor = createPhase9EvidenceDescriptor({
    executions: summary.executions,
    predecessors: { verdict: prerequisites.verdict, blockers },
    cleanupVerified: summary.cleanupVerified,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    runId: summary.runId,
    root,
  });
  writePhase9EvidenceDescriptor(descriptor, outputPath, root);
  return descriptor;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase9-route-evidence.mjs")) {
  if (process.argv.includes("--record")) {
    try {
      const descriptor = recordPhase9Evidence();
      console.log(JSON.stringify({ ticket: 293, sourceRevision: descriptor.source.revision,
        sourceTreeSha256: descriptor.source.treeSha256, runId: descriptor.run.id,
        executions: descriptor.run.executions.map(({ name, status, passed, failed, skipped }) => ({ name, status, passed, failed, skipped })),
        predecessorVerdict: descriptor.predecessors.verdict, blockerCount: descriptor.predecessors.blockers.length,
        cleanupVerified: descriptor.cleanup.verified,
        evidence: "evidence/phase9-route-registration-293.json" }, null, 2));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
