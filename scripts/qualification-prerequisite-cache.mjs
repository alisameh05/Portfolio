// Live-run-only reuse for explicitly reviewed, phase-neutral prerequisite commands.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const PRIMITIVE_CACHE_ALGORITHM = "qualification-prerequisite-cache/v1";

// These identities are reviewed as phase-neutral. Gate run IDs and SHIPWITHALI_PHASE
// only label the caller; they are not inputs consumed by these package commands.
export const CANONICAL_PRIMITIVES = Object.freeze({
  "contract:generate": Object.freeze({ id: "contracts-generate", args: [], artifacts: [
    "openapi/generated/public-v1.json", "openapi/generated/owner-v1.json",
    "src/contracts/http/v1/generated", "src/contracts/http/owner/v1/generated",
  ] }),
  "contract:verify": Object.freeze({ id: "contracts-verify", args: [], artifacts: [
    "openapi/generated/public-v1.json", "openapi/generated/owner-v1.json",
    "src/contracts/http/v1/generated", "src/contracts/http/owner/v1/generated",
  ] }),
  "direct:check-toolchain.mjs": Object.freeze({ id: "toolchain", args: [], entry: "scripts/check-toolchain.mjs", artifacts: ["evidence/phase-1-versions.json"] }),
  "direct:check-contract-drift.mjs": Object.freeze({ id: "contract-drift", args: [], entry: "scripts/check-contract-drift.mjs", artifacts: [] }),
  "direct:check-contract-compatibility.mjs": Object.freeze({ id: "contract-compatibility", args: [], entry: "scripts/check-contract-compatibility.mjs", artifacts: [] }),
  "direct:architecture-check.mjs": Object.freeze({ id: "architecture-tests", args: [], entry: "scripts/architecture-check.mjs", artifacts: [] }),
  "direct:check-route-inventory.mjs": Object.freeze({ id: "route-inventory", args: [], entry: "scripts/check-route-inventory.mjs", artifacts: ["evidence/phase-1-route-inventory.json"] }),
  "direct:check-runtime-boundary.mjs": Object.freeze({ id: "runtime-boundary", args: [], entry: "scripts/check-runtime-boundary.mjs", artifacts: ["evidence/phase-2-runtime-boundary.json"] }),
  "direct:check-runtime-architecture.mjs": Object.freeze({ id: "runtime-architecture", args: [], entry: "scripts/check-runtime-architecture.mjs", artifacts: ["evidence/phase-2-runtime-architecture.json"] }),
  "direct:typescript": Object.freeze({ id: "typecheck", args: ["--noEmit"], semanticArgs: ["--noEmit"], module: "typescript/bin/tsc", artifacts: [] }),
  "direct:eslint": Object.freeze({ id: "lint", args: ["."], semanticArgs: ["."], module: "eslint/bin/eslint.js", artifacts: [] }),
  "direct:next": Object.freeze({ id: "production-build", args: ["build"], semanticArgs: ["build"], module: "next/dist/bin/next", artifacts: [".next/BUILD_ID", ".next/required-server-files.json", ".next/server", ".next/static"] }),
  "direct:vitest-contract-tests": Object.freeze({ id: "contract-tests", args: ["run", "tests/contracts"], module: "vitest/vitest.mjs", artifacts: [] }),
  "test:setup": Object.freeze({ id: "tooling-tests", args: [], artifacts: [] }),
  "test:arch": Object.freeze({ id: "architecture-tests", args: [], artifacts: [] }),
  "route:inventory": Object.freeze({ id: "route-inventory", args: [], artifacts: ["evidence/phase-1-route-inventory.json"] }),
  "runtime:boundary": Object.freeze({ id: "runtime-boundary", args: [], artifacts: ["evidence/phase-2-runtime-boundary.json"] }),
  "runtime:architecture": Object.freeze({ id: "runtime-architecture", args: [], artifacts: ["evidence/phase-2-runtime-architecture.json"] }),
  lint: Object.freeze({ id: "lint", args: [], semanticArgs: ["."], artifacts: [] }),
  typecheck: Object.freeze({ id: "typecheck", args: [], semanticArgs: ["--noEmit"], artifacts: [] }),
  build: Object.freeze({ id: "production-build", args: [], semanticArgs: ["build"], artifacts: [
    ".next/BUILD_ID", ".next/required-server-files.json", ".next/server", ".next/static",
  ] }),
});

const EXPECTED_PACKAGE_SCRIPTS = Object.freeze({
  "contract:generate": "npm run contract:lint && node scripts/generate-contract-artifacts.mjs",
  "contract:verify": "npm run contract:generate && npm run contract:drift && npm run contract:compatibility",
  "test:setup": "node --test --test-isolation=none tests/tooling/*.test.mjs",
  "test:arch": "node scripts/architecture-check.mjs",
  "route:inventory": "node scripts/check-route-inventory.mjs",
  "runtime:boundary": "node scripts/check-runtime-boundary.mjs",
  "runtime:architecture": "node scripts/check-runtime-architecture.mjs",
  lint: "eslint .", typecheck: "tsc --noEmit", build: "next build",
});

const digest = (value) => createHash("sha256").update(value).digest("hex");
const json = (path) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

function inside(root, path) {
  const base = resolve(root); const target = resolve(path); const rel = relative(base, target);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && target !== base;
}

function fileHash(path) {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return digest(`symlink\0${readlinkSync(path)}`);
    if (stat.isFile()) return digest(readFileSync(path));
    if (!stat.isDirectory()) return null;
    const rows = [];
    const visit = (directory, prefix = "") => {
      for (const name of readdirSync(directory).sort()) {
        const absolute = join(directory, name); const key = prefix ? `${prefix}/${name}` : name;
        const child = lstatSync(absolute);
        if (child.isDirectory() && !child.isSymbolicLink()) visit(absolute, key);
        else {
          const content = child.isSymbolicLink() ? `symlink\0${readlinkSync(absolute)}` : readFileSync(absolute);
          rows.push([key, digest(content)]);
        }
      }
    };
    visit(path);
    return digest(JSON.stringify(rows));
  } catch { return null; }
}

function runtimeIdentity(runtime) {
  return { node: String(runtime.node ?? "").replace(/^v/u, ""), npm: String(runtime.npm ?? "").replace(/^npm\//u, ""), platform: runtime.platform, architecture: runtime.architecture };
}

function normalizedEnvironment(environment, platform) {
  const ignored = /^(?:SHIPWITHALI_PHASE|PHASE[34567]_GATE_RUN_ID|PHASE8_QUALIFICATION_CONTEXT|PHASE8_ACTIVE_RUN_ID|PHASE8_DEFINITION_HASH|npm_lifecycle_event|npm_lifecycle_script|npm_lifecycle_path|npm_package_json|npm_command|npm_execpath)$/u;
  return Object.fromEntries(Object.entries(environment ?? {}).filter(([key]) => !ignored.test(key))
    .map(([key, value]) => {
      // npm prepends its bin directories on every nesting level. Exact duplicate
      // entries do not change executable search order; every distinct entry does.
      const isPath = key === "PATH" || (platform === "win32" && key.toUpperCase() === "PATH");
      if (!isPath || typeof value !== "string") return [key, value];
      const delimiter = platform === "win32" ? ";" : ":";
      return [key, [...new Set(value.split(delimiter))].join(delimiter)];
    }).sort(([a], [b]) => a.localeCompare(b)));
}

function sidecarPath(root, runId) {
  return join(root, "evidence", ".phase8-prerequisite-cache", runId, "records");
}

function atomicWriteNew(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) return false;
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
    if (existsSync(path)) return false;
    renameSync(temporary, path);
    return true;
  } finally { try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best-effort temp cleanup */ } }
}

export function createQualificationPrerequisiteCache({ root, sourceRevision, sourceTreeSha256,
  runtime = { node: process.versions.node, npm: process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/u)?.[1] ?? "unknown",
    platform: process.platform, architecture: process.arch }, environment = process.env }) {
  const expectedRuntime = runtimeIdentity(runtime);
  const activeRunId = environment.PHASE8_ACTIVE_RUN_ID;
  const expectedDefinitionHash = environment.PHASE8_DEFINITION_HASH;
  const contextPath = environment.PHASE8_QUALIFICATION_CONTEXT;

  function activeContext() {
    if (typeof activeRunId !== "string" || activeRunId.length < 8 || !/^[a-f0-9-]{36}$/iu.test(activeRunId) ||
        typeof expectedDefinitionHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedDefinitionHash) ||
        typeof contextPath !== "string" || !inside(root, contextPath)) return null;
    const context = json(contextPath);
    if (context?.algorithm !== "phase8-qualification-run/v1" || context.status !== "running" || context.runId !== activeRunId ||
        context.definitionHash !== expectedDefinitionHash || context.identity?.revision !== sourceRevision ||
        context.identity?.sourceTreeSha256 !== sourceTreeSha256) return null;
    const contextRuntime = context.identity.runtime;
    if (!contextRuntime || JSON.stringify(runtimeIdentity(contextRuntime)) !== JSON.stringify(expectedRuntime)) return null;
    return context;
  }

  function run({ script, args = [], entry, environment: commandEnvironment = environment, artifactPaths, invoke, sanitizeOutput = (value) => String(value ?? "") }) {
    const canonical = CANONICAL_PRIMITIVES[script];
    const normalizedArgs = Array.isArray(args) ? args : [];
    let invocation = null;
    try { invocation = JSON.parse(String(entry ?? "")); } catch { /* untrusted command description */ }
    let isExpectedEntry = false;
    if (canonical?.entry) {
      isExpectedEntry = invocation?.entry === process.execPath && Array.isArray(invocation.args) &&
        invocation.args.length === 1 && resolve(invocation.args[0]) === resolve(root, canonical.entry);
    } else if (canonical?.module) {
      isExpectedEntry = invocation?.entry === process.execPath && Array.isArray(invocation.args) &&
        invocation.args.length === normalizedArgs.length + 1 &&
        resolve(invocation.args[0]) === resolve(root, "node_modules", canonical.module) &&
        JSON.stringify(invocation.args.slice(1)) === JSON.stringify(canonical.args);
    } else if (canonical && EXPECTED_PACKAGE_SCRIPTS[script]) {
      const packageJson = json(join(root, "package.json"));
      const expected = EXPECTED_PACKAGE_SCRIPTS[script];
      const argsMatch = JSON.stringify(normalizedArgs) === JSON.stringify(canonical.args);
      const actual = invocation?.args;
      const expectedSuffix = ["run", script, ...canonical.args];
      const markerMatch = entry === `npm:${script}`;
      const invocationMatch = Array.isArray(actual) && (actual[0] === "run" || actual[1] === "run") &&
        actual.slice(-expectedSuffix.length).join("\0") === expectedSuffix.join("\0");
      isExpectedEntry = packageJson?.scripts?.[script] === expected && argsMatch && (markerMatch || invocationMatch);
    }
    const isCanonical = canonical !== undefined && JSON.stringify(normalizedArgs) === JSON.stringify(canonical.args) && isExpectedEntry;
    const context = isCanonical ? activeContext() : null;
    const artifacts = Array.isArray(artifactPaths) ? artifactPaths : canonical?.artifacts ?? [];
    const artifactHashes = () => artifacts.map((file) => ({ file, sha256: inside(root, join(root, file)) ? fileHash(join(root, file)) : null }));
    const toolIdentity = {
      packageLockSha256: fileHash(join(root, "package-lock.json")),
      installStampSha256: fileHash(join(root, "node_modules", ".shipwithali-validation.json")),
    };
    const definition = { id: canonical?.id ?? null, args: canonical?.semanticArgs ?? normalizedArgs,
      environmentSha256: digest(JSON.stringify(normalizedEnvironment(commandEnvironment, expectedRuntime.platform))), toolIdentity,
      runtime: expectedRuntime, platformScope: `${expectedRuntime.platform}-${expectedRuntime.architecture}` };
    const definitionSha256 = digest(JSON.stringify(definition));
    const cachePath = context ? join(sidecarPath(root, activeRunId), `${definitionSha256}.json`) : null;

    if (cachePath && existsSync(cachePath)) {
      const record = json(cachePath);
      const currentArtifacts = artifactHashes();
      if (record?.algorithm === PRIMITIVE_CACHE_ALGORITHM && record.qualificationRunId === activeRunId &&
          record.definitionHash === expectedDefinitionHash && record.sourceRevision === sourceRevision &&
          record.sourceTreeSha256 === sourceTreeSha256 && record.definitionSha256 === definitionSha256 &&
          record.status === 0 && record.errorCode === null && record.timedOut === false && record.skipped === 0 &&
          typeof record.output === "string" && digest(record.output) === record.outputSha256 &&
          JSON.stringify(currentArtifacts) === JSON.stringify(record.artifacts) && currentArtifacts.every((item) => item.sha256 !== null)) {
        return { status: 0, errorCode: null, timedOut: false, skipped: 0, output: record.output,
          reused: true, reuseProof: { algorithm: PRIMITIVE_CACHE_ALGORITHM, canonicalId: canonical.id,
            qualificationRunId: activeRunId, executionId: record.executionId, definitionSha256,
            outputSha256: record.outputSha256, artifacts: record.artifacts } };
      }
    }

    const complete = (result) => {
      const output = sanitizeOutput(result?.output);
      const normalized = { status: Number.isInteger(result?.status) ? result.status : 1, errorCode: result?.errorCode ?? null,
        timedOut: result?.timedOut === true, skipped: Number.isInteger(result?.skipped) ? result.skipped : 0, output };
      if (cachePath && normalized.status === 0 && normalized.errorCode === null && !normalized.timedOut && normalized.skipped === 0) {
        const outputSha256 = digest(output);
        const artifacts = artifactHashes();
        if (artifacts.every((item) => item.sha256 !== null)) {
          const record = { algorithm: PRIMITIVE_CACHE_ALGORITHM, qualificationRunId: activeRunId, definitionHash: expectedDefinitionHash,
            sourceRevision, sourceTreeSha256, definitionSha256, definition, executionId: randomUUID(), executedAt: new Date().toISOString(),
            status: 0, errorCode: null, timedOut: false, skipped: 0, output, outputSha256, artifacts };
          try { atomicWriteNew(cachePath, `${JSON.stringify(record, null, 2)}\n`); } catch { /* cache failure causes fresh checks later */ }
        }
      }
      return { ...normalized, reused: false, reuseProof: null };
    };
    const result = invoke();
    return result && typeof result.then === "function" ? result.then(complete) : complete(result);
  }

  return Object.freeze({ run, runAsync: async (options) => await run(options), isActive: () => activeContext() !== null });
}
