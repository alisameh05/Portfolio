import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireQualificationDocker, qualifyPrerequisites } from "../../scripts/phase8-qualify.mjs";
import { contextIdentityErrors, evidenceFileSha256 } from "../../scripts/qualification-context.mjs";
import { collectQualificationArtifacts } from "../../scripts/prepare-qualification-artifact.mjs";
import { QUALIFICATION_NODES, currentRuntimeIdentity, qualificationDefinitionSha256, recordQualificationNode,
  requiredQualificationCheckNames, QUALIFICATION_CONTEXT_ALGORITHM, reportArtifactPaths }
  from "../../scripts/qualification-context.mjs";

const stable = { revision: "a".repeat(40), tree: "b".repeat(64), committedTree: "b".repeat(64), runtime: currentRuntimeIdentity() };
const checkEnvironment = () => ({ engine: "linux", compose: "v2" });
const tempRoot = (prefix = "phase8-test-") => mkdtempSync(join(tmpdir(), prefix));

function simulatedGateRun(root, identity = stable) {
  return async (node) => {
    if (node.report !== null) {
      const checks = requiredQualificationCheckNames(node.id)?.map((name) => ({ name, ok: true, passed: true, exitCode: 0, skipped: 0 })) ?? [];
      const report = { verdict: "pass", sourceRevision: identity.revision, sourceTreeSha256: identity.tree,
        toolVersions: identity.runtime, checks, summary: { total: checks.length, failed: 0 }, evidence: [],
        required: { success: true, failed: 0, skipped: 0 }, cleanup: { success: true },
        realServiceScope: { isolation: "isolated", cleanup: { success: true }, checks: [{ name: "synthetic" }] },
        migrations: identity.migrations ?? [], startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
      if (node.id === "phase2") Object.assign(report, { observedSkipped: 0, nonRequiredSkips: [] });
      const { writeFileSync, mkdirSync } = await import("node:fs");
      mkdirSync(join(root, "evidence"), { recursive: true });
      writeFileSync(join(root, node.report), `${JSON.stringify(report)}\n`);
    }
    return 0;
  };
}

function qualifySynthetic(options) {
  return qualifyPrerequisites({ ...options,
    collectArtifacts(root, reportFile) {
      try {
        const report = JSON.parse(readFileSync(join(root, reportFile), "utf8"));
        if (report.verdict !== "pass") return null;
        const artifacts = reportArtifactPaths(report, root).map((file) => ({ file, sha256: evidenceFileSha256(root, file) }));
        if (artifacts.some((artifact) => artifact.sha256 === null)) return null;
        return { report, artifacts };
      } catch { return null; }
    },
    findReusableNodes(context, ids) {
      return new Set(ids.filter((id) => context.nodes?.[id]?.status === "succeeded" && context.nodes[id].cleanupSucceeded === true));
    },
  });
}

test("the real CLI with no Docker exits before changing evidence", () => {
  const root = new URL("../../", import.meta.url);
  const reports = ["phase-3-gate-report.json", "phase-4-gate-report.json", "phase-5-gate-report.json",
    "phase6-gate-report.json", "phase7-gate-report.json", "phase8-prerequisite-qualification.json"];
  const before = reports.map((name) => {
    try { return readFileSync(new URL(`evidence/${name}`, root)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  });
  const emptyPath = tempRoot("phase8-no-docker-");
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("scripts/phase8-qualify.mjs", root))], {
      env: { ...process.env, PATH: emptyPath, Path: emptyPath }, encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /PHASE8_DOCKER_MISSING/u);
    assert.doesNotMatch(result.stdout, /Qualifying Phases|Running Phase/u);
    reports.forEach((name, index) => {
      let after = null;
      try { after = readFileSync(new URL(`evidence/${name}`, root)); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      assert.deepEqual(after, before[index]);
    });
  } finally { rmSync(emptyPath, { recursive: true, force: true }); }
});

test("Docker preflight distinguishes executable, access, OS, and Compose failures", () => {
  const linux = { status: 0, stdout: "linux|27.5.1|overlay2\n" };
  for (const [result, code] of [
    [{ error: { code: "ENOENT" } }, "PHASE8_DOCKER_MISSING"],
    [{ error: { code: "EPERM" } }, "PHASE8_DOCKER_UNAVAILABLE"],
    [{ status: 1 }, "PHASE8_DOCKER_UNAVAILABLE"],
    [{ status: 0, stdout: "windows|27.5.1|overlay2" }, "PHASE8_DOCKER_LINUX_REQUIRED"],
  ]) assert.throws(() => requireQualificationDocker(() => result), new RegExp(code));
  assert.throws(() => requireQualificationDocker((_, args) => args[0] === "info" ? linux : { status: 1 }), /PHASE8_DOCKER_COMPOSE_REQUIRED/u);
  const priorPostgresBin = process.env.PHASE7_POSTGRES_BIN;
  const priorRegistry = process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY, priorSlim = process.env.SUPABASE_USE_SLIM_IMAGES;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const nativeBin = tempRoot("phase8 postgres bin-");
  try {
    process.env.PHASE7_POSTGRES_BIN = nativeBin;
    for (const platform of ["win32", "linux"]) {
      Object.defineProperty(process, "platform", { value: platform });
      const nativeExecutable = join(nativeBin, platform === "win32" ? "postgres.exe" : "postgres");
      writeFileSync(nativeExecutable, "fixture: intercepted by the probe\n");
      const nativeProbes = [];
      let nativeVersion = "18.3";
      let imageRows = "clamav/clamav:<none>|sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|clamav/clamav@sha256:75fb5fd95fcbe1d7e6d240c369c1572b686ee2c95949d1042b5148de8eddebb4\njbarlow83/ocrmypdf-alpine:<none>|sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|jbarlow83/ocrmypdf-alpine@sha256:7f4055a0db3f6301a6d58d9ed0302f96d90ec06c038b065c6197d4d22ceae71c\n";
      const imageProofs = new Map(), inspections = [];
      const probe = (command, args) => {
        if (args[0] === "info") return linux;
        if (args[0] === "compose") return { status: 0, stdout: "2.40.3\n" };
        if (args[0] === "image" && args[1] === "ls") return {
          status: 0, stdout: imageRows,
        };
        if (args[0] === "image" && args[1] === "inspect") {
          inspections.push(...args.slice(4));
          return { status: 0, stdout: args.slice(4).map((reference) => imageProofs.get(reference) ?? "unverified|[]").join("\n") };
        }
        if (args[0] === "--version") {
          nativeProbes.push({ command, args });
          assert.equal(command, nativeExecutable);
          return { status: 0, stdout: `postgres (PostgreSQL) ${nativeVersion}\n` };
        }
        assert.equal(command, process.execPath, "the explicit bin directory must bypass discovery");
        return { status: 0, stdout: "2.117.0\n" };
      };
      const observed = requireQualificationDocker(probe);
      assert.deepEqual(nativeProbes, [{ command: nativeExecutable, args: ["--version"] }]);
      assert.deepEqual({ ...observed, unverifiedImages: observed.unverifiedImages.length },
        { docker: { operatingSystem: "linux", serverVersion: "27.5.1", storageDriver: "overlay2" }, composeVersion: "2.40.3",
          supabaseCliVersion: "2.117.0", nativePostgres: { executable: nativeExecutable.replaceAll("\\", "/"), version: "18.3" },
          validationImages: [], nestedToolScope: { daemon: "compose.validation nested Docker daemon", externallyVerified: false,
            definitions: { scanner: "clamav/clamav@sha256:75fb5fd95fcbe1d7e6d240c369c1572b686ee2c95949d1042b5148de8eddebb4",
              imageProcessor: "dpokidov/imagemagick:7.1.1-47", videoProcessor: "jrottenberg/ffmpeg:7.1-ubuntu2404",
              pdfProcessor: "jbarlow83/ocrmypdf-alpine@sha256:7f4055a0db3f6301a6d58d9ed0302f96d90ec06c038b065c6197d4d22ceae71c" } },
          unverifiedImages: 2 });
      nativeVersion = "17.9";
      assert.equal(requireQualificationDocker(probe).nativePostgres.version, "17.9");
      nativeVersion = "16.15";
      assert.throws(() => requireQualificationDocker(probe), /NATIVE_POSTGRES_VERSION_UNSUPPORTED/u);
      nativeVersion = "17.9";
      const aliases = ["ghcr.io/supabase/postgres:17.6.1.167", "ghcr.io/supabase/gotrue:v2.196.0"];
      for (const [index, reference] of aliases.entries()) {
        const repository = reference.slice(0, reference.lastIndexOf(":"));
        const id = `sha256:${String(index + 1).repeat(64)}`;
        imageProofs.set(reference, `${id}|${JSON.stringify([`${repository}@${id}`])}`);
      }
      imageRows = aliases.map((reference) => `${reference}|short-id|observed-digest`).join("\n");
      const fallback = requireQualificationDocker(probe);
      assert.deepEqual(fallback.unverifiedImages, [], "pinned CLI GHCR fallback images must retain immutable service proof");
      assert.deepEqual(inspections, [...aliases].sort());
      assert.equal(fallback.validationImages.length, 2);
      const observe = (references) => {
        imageProofs.clear();
        for (const [index, reference] of references.entries()) {
          const repository = reference.slice(0, reference.lastIndexOf(":")), id = `sha256:${index + 1}`.padEnd(71, String(index + 1));
          imageProofs.set(reference, `${id}|${JSON.stringify([`${repository}@${id}`])}`);
        }
        imageRows = references.map((reference) => `${reference}|short-id|observed-digest`).join("\n");
        return requireQualificationDocker(probe);
      };
      for (const references of [
        ["public.ecr.aws/supabase/postgres:17.6.1.167", "public.ecr.aws/supabase/gotrue:v2.196.0", "public.ecr.aws/supabase/storage-api:v1.72.1", "public.ecr.aws/supabase/postgrest:v16.2", "public.ecr.aws/supabase/kong:2.8.1"],
        [...aliases, "ghcr.io/supabase/storage-api:v1.72.1", "ghcr.io/supabase/postgrest:v16.2", "ghcr.io/supabase/kong:2.8.1"],
        ["supabase/postgres:17.6.1.167", "supabase/gotrue:v2.196.0", "supabase/storage-api:v1.72.1", "postgrest/postgrest:v16.2", "library/kong:2.8.1"],
        ["docker.io/supabase/postgres:17.6.1.167", "docker.io/supabase/gotrue:v2.196.0", "docker.io/supabase/storage-api:v1.72.1", "docker.io/postgrest/postgrest:v16.2", "docker.io/library/kong:2.8.1"],
      ]) {
        const supported = observe(references);
        assert.deepEqual(supported.unverifiedImages, []);
        assert.deepEqual(supported.validationImages.map((image) => image.reference), [...references].sort());
        assert.ok(supported.validationImages.every((image) => /^sha256:[a-f0-9]{64}$/u.test(image.imageId) && image.digest));
      }
      process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY = "mirror.example";
      process.env.SUPABASE_USE_SLIM_IMAGES = "true";
      // These ambient overrides are stripped by the actual Auth/settings gates;
      // their unrelated inventory must not certify the default service scope.
      for (const references of [
        ["ghcr.io/foreign/postgres:17.6.1.167", "ghcr.io/foreign/gotrue:v2.196.0"],
        ["mirror.example/supabase/postgres:17.6.1.167", "mirror.example/supabase/gotrue:v2.196.0"],
        ["ghcr.io/supabase/cli/postgres:17.6.1.167", "ghcr.io/supabase/cli/auth:v2.196.0"],
        ["postgres:17.6.1.167", "gotrue:v2.196.0"], [...aliases.map((reference) => reference.replace(/:[^:]+$/u, ":<none>"))],
      ]) {
        const count = inspections.length, unsupported = observe(references);
        assert.deepEqual(unsupported.unverifiedImages, ["postgres", "gotrue"]);
        assert.deepEqual(unsupported.validationImages, []);
        assert.equal(inspections.length, count, "unknown namespaces must never be inspected as approved services");
      }
      observe(aliases);
      const postgres = aliases[0], id = `sha256:${"1".repeat(64)}`;
      for (const proof of ["short-id|[]", "|[]", `${id}|[]`, `${id}|not-json`,
        `${id}|${JSON.stringify([`foreign/postgres@${id}`])}`, `${id}|${JSON.stringify(["ghcr.io/supabase/postgres@sha256:bad"])}`]) {
        imageProofs.set(postgres, proof);
        assert.deepEqual(requireQualificationDocker(probe).unverifiedImages, ["postgres"]);
      }
      const original = observe(aliases), changedId = `sha256:${"6".repeat(64)}`;
      imageProofs.set(postgres, `${changedId}|${JSON.stringify([`ghcr.io/supabase/postgres@${changedId}`])}`);
      const changed = requireQualificationDocker(probe), definitionHash = "c".repeat(64);
      const context = { algorithm: QUALIFICATION_CONTEXT_ALGORITHM, runId: "12345678-1234-4234-8234-123456789abc", definitionHash,
        identity: { revision: stable.revision, sourceTreeSha256: stable.tree, runtime: stable.runtime, services: original } };
      const identity = { revision: stable.revision, sourceTreeSha256: stable.tree, runtime: stable.runtime, definitionHash };
      assert.deepEqual(contextIdentityErrors(context, { ...identity, services: original }), []);
      assert.ok(contextIdentityErrors(context, { ...identity, services: changed }).includes("QUALIFICATION_CONTEXT_SERVICE_IDENTITY_CHANGED"));
      assert.ok(contextIdentityErrors(context, { ...identity, services: observe(["supabase/postgres:17.6.1.167", "supabase/gotrue:v2.196.0"]) })
        .includes("QUALIFICATION_CONTEXT_SERVICE_IDENTITY_CHANGED"));
    }
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (priorPostgresBin === undefined) delete process.env.PHASE7_POSTGRES_BIN;
    else process.env.PHASE7_POSTGRES_BIN = priorPostgresBin;
    if (priorRegistry === undefined) delete process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY; else process.env.SUPABASE_INTERNAL_IMAGE_REGISTRY = priorRegistry;
    if (priorSlim === undefined) delete process.env.SUPABASE_USE_SLIM_IMAGES; else process.env.SUPABASE_USE_SLIM_IMAGES = priorSlim;
    rmSync(nativeBin, { recursive: true, force: true });
  }
});

test("explicit resume reuses only verified completed evidence and reruns missing nodes", async () => {
  const root = tempRoot("phase8-resume-");
  try {
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(root, "evidence"), { recursive: true });
    const node = QUALIFICATION_NODES.find((entry) => entry.id === "phase1");
    const now = new Date().toISOString();
    const report = { verdict: "pass", sourceRevision: stable.revision, sourceTreeSha256: stable.tree, toolVersions: stable.runtime,
      startedAt: now, completedAt: now,
      checks: requiredQualificationCheckNames("phase1")
      .map((name) => ({ name, ok: true, passed: true, exitCode: 0, skipped: 0 })),
      summary: { total: requiredQualificationCheckNames("phase1").length, failed: 0 }, evidence: [],
      required: { success: true, failed: 0, skipped: 0 }, cleanup: { success: true } };
    writeFileSync(join(root, node.report), `${JSON.stringify(report)}\n`);
    const sha256 = (await import("node:crypto")).createHash("sha256").update(`${JSON.stringify(report)}\n`).digest("hex");
    const context = {
      algorithm: "phase8-qualification-run/v1", runId: "123e4567-e89b-42d3-a456-426614174000", definitionHash: qualificationDefinitionSha256(),
      identity: { revision: stable.revision, sourceTreeSha256: stable.tree, runtime: stable.runtime, services: checkEnvironment() }, startedAt: new Date().toISOString(),
      status: "failed", nodes: {},
    };
    recordQualificationNode(context, { id: "validation-environment" });
    recordQualificationNode(context, { id: "phase1", report: { file: node.report, sha256 } });
    const calls = [];
    const result = await qualifySynthetic({ checkEnvironment, getIdentity: () => stable, log() {}, root, resume: true,
      readRun: () => context, run: async (entry, childEnv) => {
        calls.push(entry.id);
        assert.equal(childEnv.PHASE8_ACTIVE_RUN_ID, context.runId);
        assert.equal(childEnv.PHASE8_DEFINITION_HASH, context.definitionHash);
        assert.equal(childEnv.PHASE8_QUALIFICATION_CONTEXT, join(root, "evidence/phase8-qualification-run.json"));
        return simulatedGateRun(root)(entry);
      } });
    assert.equal(result, 0);
    assert.deepEqual(calls, QUALIFICATION_NODES.filter((entry) => entry.id !== "phase1").map((entry) => entry.id));
  } finally { rmSync(root, { recursive: true, force: true }); }
  const nestedRoot = tempRoot("phase8-nested-tools-");
  try {
    const nestedScope = () => ({ ...checkEnvironment(), nestedToolScope: { daemon: "compose.validation nested Docker daemon", externallyVerified: false } });
    assert.equal(await qualifySynthetic({ checkEnvironment: nestedScope, getIdentity: () => stable, log() {}, root: nestedRoot,
      run: simulatedGateRun(nestedRoot) }), 0);
    const calls = [];
    assert.equal(await qualifySynthetic({ checkEnvironment: nestedScope, getIdentity: () => stable, log() {}, root: nestedRoot, resume: true,
      run: async (node) => { calls.push(node.id); return simulatedGateRun(nestedRoot)(node); } }), 0);
    assert.deepEqual(calls, ["validation-environment", "phase6", "phase7", "evaluator"]);
  } finally { rmSync(nestedRoot, { recursive: true, force: true }); }
});

test("drifted identity, tool, or definition context forces every node to rerun", async () => {
  for (const [field, value] of [["identity", { revision: "x".repeat(40), sourceTreeSha256: "y".repeat(64) }], ["definitionHash", "z".repeat(64)],
    ["services", { engine: "changed" }]]) {
    const root = tempRoot("phase8-drift-");
    try {
      const context = { algorithm: "phase8-qualification-run/v1", runId: "123e4567-e89b-42d3-a456-426614174000", definitionHash: qualificationDefinitionSha256(),
        identity: { revision: stable.revision, sourceTreeSha256: stable.tree, runtime: stable.runtime, services: checkEnvironment() }, status: "failed", nodes: {} };
      if (field === "services") context.identity.services = value;
      else context[field] = value;
      const calls = [], messages = [];
      const result = await qualifySynthetic({ checkEnvironment, getIdentity: () => stable, log: (message) => messages.push(message), root,
        resume: true, readRun: () => context, run: async (node) => { calls.push(node.id); return simulatedGateRun(root)(node); } });
      assert.equal(result, 0);
      assert.equal(calls.length, QUALIFICATION_NODES.length);
      assert.match(messages.join("\n"), /Shared qualification context unusable/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("qualification executes each node once in dependency order", async () => {
  const root = tempRoot("phase8-dag-");
  try {
    const calls = [];
    const result = await qualifySynthetic({ checkEnvironment, getIdentity: () => stable, log() {}, root,
      run: async (node) => { calls.push(node.id); return simulatedGateRun(root)(node); } });
    assert.equal(result, 0);
    assert.deepEqual(calls, QUALIFICATION_NODES.map((node) => node.id));
    // Hosted success packaging is bound to every completed node and its evidence.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const artifactRoot = tempRoot("phase8-artifact-source-");
    const outputDir = tempRoot("phase8-artifact-output-");
    try {
      mkdirSync(join(artifactRoot, "evidence"), { recursive: true });
      writeFileSync(join(artifactRoot, "evidence/phase8-qualification-run.json"), "{}\n");
      const now = new Date().toISOString();
      const context = { algorithm: QUALIFICATION_CONTEXT_ALGORITHM, status: "complete", runId: "123e4567-e89b-42d3-a456-426614174000",
        definitionHash: "c".repeat(64), startedAt: now, identity: { revision: stable.revision, sourceTreeSha256: stable.tree },
        nodes: { "validation-environment": { status: "succeeded", completed: true, exitCode: 0, cleanupSucceeded: true, completedAt: now, report: null } } };
      const manifest = collectQualificationArtifacts({ root: artifactRoot, outputDir, context,
        nodes: [QUALIFICATION_NODES[0]], headSha: stable.revision, sourceTreeSha256: stable.tree,
        metadata: { GITHUB_RUN_ID: "42", GITHUB_EVENT_NAME: "pull_request" } });
      assert.equal(manifest.github.GITHUB_RUN_ID, "42");
      assert.equal(manifest.qualificationCompletedAt, now);
      assert.equal(manifest.artifacts[0].file, "evidence/phase8-qualification-run.json");
      assert.throws(() => collectQualificationArtifacts({ root: artifactRoot, outputDir, context: { ...context,
        identity: { ...context.identity, sourceTreeSha256: "d".repeat(64) } }, nodes: [QUALIFICATION_NODES[0]],
        headSha: stable.revision, sourceTreeSha256: stable.tree }), /QUALIFICATION_ARTIFACT_SET_INCOMPLETE_OR_STALE/u);
      const phase1Node = QUALIFICATION_NODES.find((node) => node.id === "phase1");
      const phase1ReportPath = "evidence/phase-1-gate-report.json";
      const phase1Checks = requiredQualificationCheckNames("phase1").map((name) => ({ name, ok: true, passed: true, exitCode: 0, skipped: 0 }));
      const phase1Context = { ...context, identity: { ...context.identity, runtime: currentRuntimeIdentity() },
        nodes: { ...context.nodes, phase1: { status: "succeeded", completed: true, exitCode: 0, cleanupSucceeded: true,
          completedAt: now, report: { file: phase1ReportPath, sha256: "0".repeat(64), artifacts: [] } } } };
      writeFileSync(join(artifactRoot, phase1ReportPath), JSON.stringify({ verdict: "pass" }));
      phase1Context.nodes.phase1.report.sha256 = evidenceFileSha256(artifactRoot, phase1ReportPath);
      assert.throws(() => collectQualificationArtifacts({ root: artifactRoot, outputDir, context: phase1Context,
        nodes: [QUALIFICATION_NODES[0], phase1Node], headSha: stable.revision, sourceTreeSha256: stable.tree }),
      /QUALIFICATION_ARTIFACT_SET_INCOMPLETE_OR_STALE/u);
      const strictPhase1Report = { verdict: "pass", sourceRevision: stable.revision, sourceTreeSha256: stable.tree,
        toolVersions: currentRuntimeIdentity(), startedAt: now, completedAt: now, summary: { total: phase1Checks.length, failed: 0 },
        checks: phase1Checks, required: { success: true, failed: 0, skipped: 0 }, cleanup: { success: true }, evidence: [] };
      writeFileSync(join(artifactRoot, phase1ReportPath), `${JSON.stringify(strictPhase1Report)}\n`);
      phase1Context.nodes.phase1.report.sha256 = evidenceFileSha256(artifactRoot, phase1ReportPath);
      const strictManifest = collectQualificationArtifacts({ root: artifactRoot, outputDir, context: phase1Context,
        nodes: [QUALIFICATION_NODES[0], phase1Node], headSha: stable.revision, sourceTreeSha256: stable.tree });
      assert.ok(strictManifest.artifacts.some((artifact) => artifact.file === phase1ReportPath));
    } finally { rmSync(artifactRoot, { recursive: true, force: true }); rmSync(outputDir, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const nestedRoot = tempRoot("phase8-cold-nested-");
  const priorCi = process.env.CI;
  try {
    process.env.CI = "true";
    const normalized = { ...stable, runtime: currentRuntimeIdentity({ ...process.env, CI: "1" }) };
    let warmed = false;
    const retained = new Map();
    assert.equal(await qualifySynthetic({ root: nestedRoot, getIdentity: () => normalized, log() {},
      checkEnvironment: () => ({ ...checkEnvironment(), unverifiedImages: warmed ? [] : ["postgres", "gotrue"] }),
      run: async (node, childEnv) => {
        assert.equal(childEnv.CI, "1", "root and nested gates execute with the same explicit CI value");
        assert.deepEqual(currentRuntimeIdentity(childEnv), normalized.runtime);
        if (node.id === "phase3") {
          const script = `import { readQualificationRun, verifyGatePredecessors } from ${JSON.stringify(new URL("../../scripts/qualification-context.mjs", import.meta.url).href)};
            const root = ${JSON.stringify(nestedRoot)}, context = readQualificationRun(root);
            const proof = verifyGatePredecessors({ context, root, nodeIds: ["phase1", "phase2"], revision: context.identity.revision,
              sourceTreeSha256: context.identity.sourceTreeSha256, definitionHash: context.definitionHash });
            console.log(JSON.stringify({ usable: proof.usable, reused: [...proof.reuse.keys()] }));`;
          const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: childEnv, encoding: "utf8" });
          assert.equal(child.status, 0, child.stderr);
          assert.deepEqual(JSON.parse(child.stdout), { usable: true, reused: ["phase1", "phase2"] });
          warmed = true;
        }
        for (const [file, bytes] of retained) assert.deepEqual(readFileSync(join(nestedRoot, file)), bytes);
        const code = await simulatedGateRun(nestedRoot, normalized)(node);
        if (["phase1", "phase2"].includes(node.id)) retained.set(node.report, readFileSync(join(nestedRoot, node.report)));
        return code;
      } }), 0);
  } finally {
    if (priorCi === undefined) delete process.env.CI; else process.env.CI = priorCi;
    rmSync(nestedRoot, { recursive: true, force: true });
  }
  for (const target of ["report", "transitive-artifact"]) {
    const staleRoot = tempRoot("phase8-final-stale-");
    try {
      const messages = [];
      const code = await qualifySynthetic({ root: staleRoot, checkEnvironment, getIdentity: () => stable,
        log: (message) => messages.push(message), run: async (node) => {
          await simulatedGateRun(staleRoot)(node);
          if (node.id === "phase1") {
            writeFileSync(join(staleRoot, "evidence/retained-check.log"), "passed\n");
            writeFileSync(join(staleRoot, "evidence/component.json"), JSON.stringify({ evidence: ["evidence/retained-check.log"] }));
            const file = join(staleRoot, node.report), report = JSON.parse(readFileSync(file, "utf8"));
            report.evidence = ["evidence/component.json"];
            writeFileSync(file, JSON.stringify(report));
          }
          if (node.id === "evaluator") writeFileSync(join(staleRoot,
            target === "report" ? "evidence/phase-1-gate-report.json" : "evidence/retained-check.log"), "overwritten\n");
          return 0;
        } });
      assert.equal(code, 1, `final completion rejects a changed ${target} in an earlier successful node`);
      assert.equal(JSON.parse(readFileSync(join(staleRoot, "evidence/phase8-qualification-run.json"), "utf8")).status, "failed");
      assert.match(messages.join("\n"), /phase1/u);
    } finally { rmSync(staleRoot, { recursive: true, force: true }); }
  }
});

test("a failed later gate resumes after rechecking and retaining the clean successful prefix", async () => {
  const root = tempRoot("phase8-prefix-recovery-");
  try {
    const firstCalls = [];
    const first = await qualifySynthetic({ checkEnvironment, getIdentity: () => stable, log() {}, root,
      run: async (node) => {
        firstCalls.push(node.id);
        if (node.id === "phase2") return 1;
        return simulatedGateRun(root)(node);
      } });
    assert.equal(first, 1);
    assert.deepEqual(firstCalls, ["validation-environment", "phase1", "phase2"]);
    const interrupted = JSON.parse(readFileSync(join(root, "evidence/phase8-qualification-run.json"), "utf8"));
    assert.equal(interrupted.status, "failed");
    assert.equal(interrupted.nodes.phase1.status, "succeeded");
    assert.equal(interrupted.nodes.phase2.status, "failed");

    const resumedCalls = [];
    const resumed = await qualifySynthetic({ checkEnvironment, getIdentity: () => stable, log() {}, root, resume: true,
      run: async (node) => { resumedCalls.push(node.id); return simulatedGateRun(root)(node); } });
    assert.equal(resumed, 0);
    assert.deepEqual(resumedCalls, ["validation-environment", "phase2", "phase3", "phase4", "phase5", "phase6", "phase7", "evaluator"]);
    const complete = JSON.parse(readFileSync(join(root, "evidence/phase8-qualification-run.json"), "utf8"));
    assert.equal(complete.status, "complete");
    assert.equal(complete.nodes.phase1.status, "succeeded");
    assert.equal(complete.nodes.phase2.status, "succeeded");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a failed, interrupted, or cleanup-failed gate does not reach later nodes", async () => {
  for (const resultCode of [1, 2, null]) {
    const root = tempRoot("phase8-fail-");
    try {
      const calls = [];
      const result = await qualifySynthetic({ checkEnvironment, getIdentity: () => stable, log() {}, root,
        run: async (node) => { calls.push(node.id); return calls.length === 2 ? resultCode : simulatedGateRun(root)(node); } });
      assert.notEqual(result, 0);
      assert.equal(calls.length, 2);
      assert.equal(calls.includes("evaluator"), false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("uncommitted source and source edits during a gate are rejected", async () => {
  const root = tempRoot("phase8-uncommitted-");
  try {
    let calls = 0;
    assert.equal(await qualifySynthetic({ checkEnvironment, getIdentity: () => ({ ...stable, committedTree: "c".repeat(64) }), root,
      log() {}, run: async () => { calls++; return 0; } }), 1);
    assert.equal(calls, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
  for (const changedField of ["revision", "tree"]) for (let changedStep = 1; changedStep <= QUALIFICATION_NODES.length; changedStep++) {
    const root = tempRoot("phase8-source-drift-");
    try {
      let calls = 0;
      const result = await qualifySynthetic({ checkEnvironment, log() {}, root,
        getIdentity: () => calls === changedStep ? { ...stable, [changedField]: "changed" } : stable,
        run: async (node) => { calls++; return simulatedGateRun(root)(node); } });
      assert.equal(result, 1);
      assert.equal(calls, changedStep);
      const runRecord = JSON.parse(readFileSync(join(root, "evidence/phase8-qualification-run.json"), "utf8"));
      assert.equal(runRecord.status, "failed");
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
