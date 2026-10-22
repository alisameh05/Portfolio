#!/usr/bin/env node
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { workingTreeSourceSha256 } from "./phase5-source-identity.mjs";
import { sourceMetadataAtRevision } from "./phase8-prerequisite-qualification.mjs";
import { PHASE6_TOOL_DEFINITIONS } from "./phase6-verification-support.mjs";
import {
  QUALIFICATION_CONTEXT_VARIABLE,
  QUALIFICATION_NODES,
  QUALIFICATION_RUN_FILE,
  currentRuntimeIdentity,
  contextIdentityErrors,
  emptyQualificationRun,
  evidenceFileSha256,
  invalidateNodeAndDescendants,
  qualificationReportArtifacts,
  qualificationDefinitionSha256,
  qualificationNodeIds,
  readQualificationRun,
  recordQualificationNode,
  setQualificationNodeState,
  reusableNodes,
  writeQualificationRun,
} from "./qualification-context.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export { QUALIFICATION_NODES as QUALIFICATION_STEPS };

/** Check the real Linux engine before any gate can overwrite acceptance evidence. */
export function requireQualificationDocker(probe = spawnSync) {
  const options = { cwd: ROOT, encoding: "utf8", timeout: 15_000, maxBuffer: 16 * 1024, windowsHide: true };
  const engine = probe("docker", ["info", "--format", "{{.OSType}}|{{.ServerVersion}}|{{.Driver}}"], options);
  if (engine.error?.code === "ENOENT") {
    throw new Error("PHASE8_DOCKER_MISSING: Docker is not on PATH. Run qualification on a Docker-capable host; a Node-only cloud runner cannot run real-service gates.");
  }
  if (engine.error || engine.status !== 0) {
    throw new Error("PHASE8_DOCKER_UNAVAILABLE: Start the Linux Docker engine and allow this process to access it, then rerun qualification.");
  }
  const [operatingSystem, serverVersion, storageDriver] = String(engine.stdout ?? "").trim().split("|");
  if (operatingSystem !== "linux") {
    throw new Error("PHASE8_DOCKER_LINUX_REQUIRED: Switch Docker Desktop to Linux containers before qualification.");
  }
  const compose = probe("docker", ["compose", "version", "--short"], options);
  if (compose.error || compose.status !== 0) {
    throw new Error("PHASE8_DOCKER_COMPOSE_REQUIRED: Install the Docker Compose plugin or Docker Desktop before qualification.");
  }
  const composeVersion = String(compose.stdout ?? "").trim().replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(serverVersion ?? "") ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(composeVersion) || typeof storageDriver !== "string" || storageDriver.length === 0) {
    throw new Error("PHASE8_DOCKER_IDENTITY_UNVERIFIED: Docker engine and Compose must report stable version identities before qualification.");
  }
  const supabaseCli = probe(process.execPath, [join(ROOT, "node_modules", "supabase", "dist", "supabase.js"), "--version"], options);
  if (supabaseCli.error || supabaseCli.status !== 0) {
    throw new Error("PHASE8_SUPABASE_CLI_IDENTITY_UNVERIFIED: The installed pinned Supabase CLI must report its actual version before qualification.");
  }
  const supabaseCliVersion = String(supabaseCli.stdout ?? "").split(/\r?\n/u).map((line) => line.trim())
    .find((line) => /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(line));
  if (!supabaseCliVersion) {
    throw new Error("PHASE8_SUPABASE_CLI_IDENTITY_UNVERIFIED: The installed pinned Supabase CLI must report its actual version before qualification.");
  }
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (packageJson.devDependencies?.supabase !== supabaseCliVersion) {
    throw new Error("PHASE8_SUPABASE_CLI_PIN_MISMATCH: The installed Supabase CLI version does not match the locked package version.");
  }
  const imageInventory = probe("docker", ["image", "ls", "--digests", "--format", "{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Digest}}"], options);
  if (imageInventory.error || imageInventory.status !== 0) {
    throw new Error("PHASE8_DOCKER_IMAGE_IDENTITY_UNVERIFIED: Docker must report locally available validation image identities before qualification.");
  }
  const references = String(imageInventory.stdout ?? "").split(/\r?\n/u).flatMap((line) => {
    const [reference, imageId] = line.trim().split("|");
    if (!reference || !imageId || imageId === "<none>:<none>") return [];
    const expected = /^(?:public\.ecr\.aws\/supabase\/(?:postgres|gotrue|storage-api|postgrest|kong):)/u.test(reference);
    return expected ? [reference] : [];
  }).sort();
  const inspected = references.length === 0 ? { status: 0, stdout: "" } :
    probe("docker", ["image", "inspect", "--format", "{{.Id}}|{{json .RepoDigests}}", ...references], options);
  if (inspected.error || inspected.status !== 0) {
    throw new Error("PHASE8_DOCKER_IMAGE_IDENTITY_UNVERIFIED: Docker could not verify the immutable IDs of locally available validation images.");
  }
  const inspectedRows = String(inspected.stdout ?? "").split(/\r?\n/u).filter(Boolean);
  const installed = references.flatMap((reference, index) => {
    const [imageId, digestsJson = "[]"] = (inspectedRows[index] ?? "").split("|");
    if (!/^sha256:[a-f0-9]{64}$/iu.test(imageId ?? "")) return [];
    let digests = [];
    try { digests = JSON.parse(digestsJson); } catch { /* no digest is recorded for locally built images */ }
    const digest = Array.isArray(digests) ? digests.find((value) => typeof value === "string" && /^.+@sha256:[a-f0-9]{64}$/iu.test(value)) ?? null : null;
    return [{ reference, imageId, digest }];
  });
  const availablePrefixes = ["postgres", "gotrue"].map((service) =>
    `public.ecr.aws/supabase/${service}:`).filter((prefix) => !installed.some((image) => image.reference.startsWith(prefix)));
  const unverifiedImages = availablePrefixes;
  const nativePostgresBin = process.env.PHASE7_POSTGRES_BIN?.trim();
  let nativePostgresPath = nativePostgresBin ? join(nativePostgresBin, process.platform === "win32" ? "postgres.exe" : "postgres") : null;
  if (nativePostgresPath === null && process.platform === "win32") {
    const windowsPostgres = "C:/Program Files/PostgreSQL/18/bin/postgres.exe";
    if (existsSync(windowsPostgres)) nativePostgresPath = windowsPostgres;
  }
  if (nativePostgresPath === null) {
    const bindir = probe("pg_config", ["--bindir"], options);
    if (!bindir.error && bindir.status === 0) {
      const directory = String(bindir.stdout ?? "").trim();
      if (directory) nativePostgresPath = join(directory, process.platform === "win32" ? "postgres.exe" : "postgres");
    }
  }
  if (!nativePostgresPath || !existsSync(nativePostgresPath)) {
    throw new Error("PHASE8_NATIVE_POSTGRES_IDENTITY_UNVERIFIED: Phase 7 native PostgreSQL must be available before qualification.");
  }
  const nativePostgresProbe = probe(nativePostgresPath, ["--version"], options);
  const nativePostgresVersion = String(nativePostgresProbe.stdout ?? "").trim().match(/PostgreSQL\)\s+(\d+\.\d+(?:\.\d+)?)/u)?.[1] ?? null;
  if (nativePostgresProbe.error || nativePostgresProbe.status !== 0 || !nativePostgresVersion) {
    throw new Error("PHASE8_NATIVE_POSTGRES_IDENTITY_UNVERIFIED: Phase 7 native PostgreSQL must report its actual version.");
  }
  return { docker: { operatingSystem, serverVersion, storageDriver }, composeVersion, supabaseCliVersion,
    nativePostgres: { executable: nativePostgresPath.replaceAll("\\", "/"), version: nativePostgresVersion },
    validationImages: installed, nestedToolScope: { daemon: "compose.validation nested Docker daemon", externallyVerified: false,
      definitions: { ...PHASE6_TOOL_DEFINITIONS } }, unverifiedImages };
}

function identity() {
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const metadata = sourceMetadataAtRevision(ROOT, revision);
  return { revision, tree: workingTreeSourceSha256(), committedTree: metadata.sourceTreeSha256, migrations: metadata.migrations,
    runtime: currentRuntimeIdentity() };
}

function execute(node, childEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [node.script, ...node.args], {
      cwd: ROOT, stdio: "inherit", windowsHide: true, env: childEnv,
    });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * Regenerate all evidence on one committed source tree; never reuse a failed
 * gate. Context reuse happens only for an explicit `--resume` and only while
 * the recorded run still matches this source and gate definition; anything
 * else fails closed to a complete fresh run.
 */
export async function qualifyPrerequisites({
  checkEnvironment = requireQualificationDocker,
  getIdentity = identity,
  run = execute,
  log = console.log,
  root = ROOT,
  resume = process.argv.includes("--resume"),
  readRun = (contextRoot) => readQualificationRun(contextRoot),
  findReusableNodes = reusableNodes,
  collectArtifacts = qualificationReportArtifacts,
} = {}) {
  let observedServices;
  try { observedServices = checkEnvironment(); }
  catch (error) { log(error.message); return 1; }
  let expected = { ...getIdentity(), services: observedServices };
  if (expected.tree !== expected.committedTree) {
    log("Commit the final source changes before qualification. Evidence files may remain uncommitted.");
    return 1;
  }
  log(`Qualifying Phases 3–7 at ${expected.revision}; source ${expected.tree}.`);
  const definitionHash = qualificationDefinitionSha256();
  let shared = null;
  if (resume) {
    const recorded = readRun(root);
    if (recorded === null) {
      log(`No shared qualification context at ${QUALIFICATION_RUN_FILE}; running every node fresh.`);
    } else {
      const identityErrors = contextIdentityErrors(recorded, {
        revision: expected.revision, sourceTreeSha256: expected.tree, definitionHash, migrations: expected.migrations,
        services: expected.services,
      });
      if (identityErrors.length > 0) {
        shared = null;
        log(`Shared qualification context unusable (${identityErrors.join(", ")}); running every node fresh.`);
      } else {
        shared = recorded;
      }
    }
  }
  const reusable = shared === null ? new Set() : findReusableNodes(shared, qualificationNodeIds(), root, { allowIncomplete: true });
  if (observedServices.nestedToolScope?.externallyVerified !== true) {
    for (const id of ["phase6", "phase7", "evaluator"]) reusable.delete(id);
    if (resume && shared !== null) log("Nested Phase 6 tool-image IDs are not visible to the host daemon; rerunning Phase 6 and its dependent checks.");
  }
  const contextPath = join(root, QUALIFICATION_RUN_FILE);
  let runRecord = shared ?? emptyQualificationRun({ definitionHash, identity: expected, startedAt: new Date().toISOString() });
  const childEnv = { ...process.env, [QUALIFICATION_CONTEXT_VARIABLE]: contextPath,
    PHASE8_ACTIVE_RUN_ID: runRecord.runId, PHASE8_DEFINITION_HASH: definitionHash };
  runRecord.status = "running";
  writeQualificationRun(runRecord, root);
  for (const node of QUALIFICATION_NODES) {
    const before = { ...getIdentity(), services: observedServices };
    if (before.revision !== expected.revision || before.tree !== expected.tree) {
      runRecord.status = "failed";
      writeQualificationRun(runRecord, root);
      log("Source changed during qualification. Restart npm run phase8:qualify after committing the final source.");
      return 1;
    }
    if (reusable.has(node.id) && node.id !== "validation-environment") {
      log(`Reusing ${node.label} from the shared qualification context.`);
      continue;
    }
    // Revalidate this inexpensive live preflight on every invocation. A
    // successful check under the same immutable identity leaves already
    // verified downstream evidence intact; a failure prevents its reuse via
    // the dependency closure on the next invocation.
    if (node.id !== "validation-environment") invalidateNodeAndDescendants(runRecord, node.id);
    setQualificationNodeState(runRecord, node.id, "running");
    writeQualificationRun(runRecord, root);
    log(`Running ${node.label}.`);
    const result = await run(node, childEnv);
    if (result !== 0) {
      setQualificationNodeState(runRecord, node.id, "failed", result);
      writeQualificationRun(runRecord, root);
      runRecord.status = "failed";
      writeQualificationRun(runRecord, root);
      log(`${node.label} failed. Resolve its reported failure, then rerun npm run phase8:qualify.`);
      return Number.isInteger(result) && result > 0 && result < 256 ? result : 1;
    }
    if (node.report !== null) {
      const proof = collectArtifacts(root, node.report, { revision: expected.revision, sourceTreeSha256: expected.tree,
        runtime: expected.runtime, migrations: expected.migrations, services: expected.services });
      const sha256 = evidenceFileSha256(root, node.report);
      if (sha256 === null || proof === null) {
        setQualificationNodeState(runRecord, node.id, "failed", 1);
        writeQualificationRun(runRecord, root);
        runRecord.status = "failed";
        writeQualificationRun(runRecord, root);
        log(`${node.label} completed without a successful, source-current report and complete evidence artifacts at ${node.report}.`);
        return 1;
      }
      recordQualificationNode(runRecord, { id: node.id, report: { file: node.report, sha256 }, artifacts: proof.artifacts });
      writeQualificationRun(runRecord, root);
    } else {
      recordQualificationNode(runRecord, { id: node.id });
      writeQualificationRun(runRecord, root);
    }
    let refreshedServices;
    try { refreshedServices = checkEnvironment(); }
    catch (error) {
      runRecord.status = "failed";
      writeQualificationRun(runRecord, root);
      log(`Service identity refresh failed after ${node.label}: ${error.message}`);
      return 1;
    }
    const previousImages = new Map((observedServices.validationImages ?? []).map((image) => [image.reference, image.imageId]));
    const refreshedImages = new Map((refreshedServices.validationImages ?? []).map((image) => [image.reference, image.imageId]));
    const changedImage = [...previousImages].some(([reference, imageId]) => refreshedImages.get(reference) !== imageId);
    const stableServiceTools = JSON.stringify({ docker: observedServices.docker, composeVersion: observedServices.composeVersion,
      supabaseCliVersion: observedServices.supabaseCliVersion, nativePostgres: observedServices.nativePostgres,
      nestedToolScope: observedServices.nestedToolScope }) === JSON.stringify({ docker: refreshedServices.docker,
      composeVersion: refreshedServices.composeVersion, supabaseCliVersion: refreshedServices.supabaseCliVersion,
      nativePostgres: refreshedServices.nativePostgres, nestedToolScope: refreshedServices.nestedToolScope });
    if (changedImage || !stableServiceTools) {
      runRecord.status = "failed";
      writeQualificationRun(runRecord, root);
      log(`Service identity changed during ${node.label}; later checks must start with a fresh qualification.`);
      return 1;
    }
    observedServices = refreshedServices;
    expected = { ...expected, services: refreshedServices };
    runRecord.identity.services = refreshedServices;
    writeQualificationRun(runRecord, root);
    const after = { ...getIdentity(), services: observedServices };
    if (after.revision !== expected.revision || after.tree !== expected.tree) {
      runRecord.status = "failed";
      writeQualificationRun(runRecord, root);
      log("Source changed during qualification. Restart npm run phase8:qualify after committing the final source.");
      return 1;
    }
  }
  if (observedServices.unverifiedImages?.length > 0) {
    runRecord.status = "failed";
    writeQualificationRun(runRecord, root);
    log(`Qualification completed without immutable IDs for required service images: ${observedServices.unverifiedImages.join(", ")}.`);
    return 1;
  }
  runRecord.status = "complete";
  writeQualificationRun(runRecord, root);
  return 0;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/phase8-qualify.mjs")) {
  try { process.exitCode = await qualifyPrerequisites(); }
  catch (error) { console.error(`Qualification could not run: ${error.message}`); process.exitCode = 1; }
}
