#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QUALIFICATION_NODES, evidenceFileSha256, qualificationReportArtifacts, readQualificationRun, reportArtifactPaths } from "./qualification-context.mjs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hashFile = (root, file) => evidenceFileSha256(root, file);

export function collectQualificationArtifacts({ root, outputDir, context, nodes = QUALIFICATION_NODES,
  headSha, sourceTreeSha256, metadata = {}, validateReport = qualificationReportArtifacts }) {
  if (!context || context.status !== "complete" || context.algorithm !== "phase8-qualification-run/v1" ||
      typeof context.runId !== "string" || !/^[a-f0-9-]{36}$/iu.test(context.runId) ||
      context.identity?.revision !== headSha || context.identity?.sourceTreeSha256 !== sourceTreeSha256 ||
      nodes.some((expected) => {
        const record = context.nodes?.[expected.id];
        if (!record || record.status !== "succeeded" || record.completed !== true || record.exitCode !== 0 ||
            record.cleanupSucceeded !== true || !Number.isFinite(Date.parse(record.completedAt ?? ""))) return true;
        if (expected.report === null) return record.report !== null;
        if (record.report?.file !== expected.report || hashFile(root, expected.report) !== record.report.sha256) return true;
        let report;
        try { report = JSON.parse(readFileSync(join(root, expected.report), "utf8")); } catch { return true; }
        if (report?.verdict !== "pass") return true;
        const strictProof = validateReport(root, expected.report, context.identity);
        if (!strictProof || JSON.stringify(strictProof.report) !== JSON.stringify(report)) return true;
        const artifactPaths = reportArtifactPaths(report, root);
        const recorded = (record.report.artifacts ?? []).map((item) => item.file);
        return JSON.stringify(artifactPaths) !== JSON.stringify(recorded) ||
          (record.report.artifacts ?? []).some((item) => hashFile(root, item.file) !== item.sha256 ||
            strictProof.artifacts.find((artifact) => artifact.file === item.file)?.sha256 !== item.sha256);
      })) {
    throw new Error("QUALIFICATION_ARTIFACT_SET_INCOMPLETE_OR_STALE");
  }
  const output = resolve(outputDir);
  const rootPath = resolve(root);
  const toCopy = new Set(["evidence/phase8-qualification-run.json"]);
  const manifestRows = [];
  for (const node of nodes) {
    const record = context.nodes[node.id];
    if (record.report === null) continue;
    toCopy.add(record.report.file);
    for (const artifact of record.report.artifacts ?? []) toCopy.add(artifact.file);
  }
  mkdirSync(output, { recursive: true });
  for (const file of [...toCopy].sort()) {
    const target = resolve(rootPath, file);
    const rel = relative(rootPath, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || !/^(?:evidence\/|openapi\/generated\/|docs\/|AGENTS\.md$)/u.test(file)) {
      throw new Error("QUALIFICATION_ARTIFACT_PATH_INVALID");
    }
    const destination = join(output, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(target, destination);
    const sha256 = hashFile(rootPath, file);
    if (sha256 === null) throw new Error("QUALIFICATION_ARTIFACT_COPY_FAILED");
    manifestRows.push({ file, sha256 });
  }
  const github = Object.fromEntries(["GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "GITHUB_SHA", "GITHUB_REF",
    "GITHUB_EVENT_NAME"].map((key) => [key, metadata[key] ?? null]));
  const completedAt = nodes.map((node) => context.nodes[node.id].completedAt).sort().at(-1);
  const manifest = { schemaVersion: 1, headSha, sourceTreeSha256, runId: context.runId,
    definitionHash: context.definitionHash, startedAt: context.startedAt, qualificationCompletedAt: completedAt,
    preparedAt: new Date().toISOString(),
    github, artifacts: manifestRows };
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

export function main() {
  const outputArg = process.argv.find((argument) => argument.startsWith("--output="));
  if (!outputArg) throw new Error("QUALIFICATION_ARTIFACT_OUTPUT_REQUIRED");
  const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const sourceTreeSha256 = workingTreeSourceSha256();
  const context = readQualificationRun(ROOT);
  return collectQualificationArtifacts({ root: ROOT, outputDir: outputArg.slice("--output=".length), context,
    headSha, sourceTreeSha256, metadata: process.env });
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/prepare-qualification-artifact.mjs")) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "QUALIFICATION_ARTIFACT_PREPARATION_FAILED"); process.exitCode = 1; }
}
