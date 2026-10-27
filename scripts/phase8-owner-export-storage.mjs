// Reuse the native PostgreSQL acceptance runner with real private Storage.
// Status credentials stay in memory and child environments, never artifacts.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { initializeLocalMigrationProject } from "./local-migration-bootstrap.mjs";
import { createOwnerExportStorageChildEnvironment } from "./phase8-owner-export-storage-env.mjs";
import { isolatedConfig, localEnvironment, requireDocker } from "./local-auth-integration.mjs";
import { observeRuntime, verifyEnvironment } from "./validation-environment.mjs";

const root = process.cwd();
const cli = join(root, "node_modules/supabase/dist/supabase.js");
const environment = localEnvironment();
let fixture, id, network, started = false, networkCreated = false, failed = false;
function invoke(args, env = environment) {
  const result = spawnSync(process.execPath, [cli, '--workdir', fixture, ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 600_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error(`PHASE8_EXPORT_STORAGE_CLI_FAILED:${args[0]} (raw output suppressed)`);
  return result.stdout;
}
async function freeLoopbackPort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") { server.close(); reject(new Error("PHASE8_EXPORT_STORAGE_PORT_INVALID")); return; }
      server.close((error) => error ? reject(error) : resolvePort(address.port));
    });
  });
}
try {
  const errors = verifyEnvironment(root, observeRuntime());
  if (errors.length) { console.error(errors.join('\n')); throw new Error('PHASE8_EXPORT_STORAGE_ENVIRONMENT_INVALID'); }
  requireDocker();
  fixture = mkdtempSync(join(tmpdir(), 'shipwithali-export-storage-'));
  id = `shipwithali-phase6-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  network = `${id}-loopback`;
  mkdirSync(join(fixture, 'supabase', 'migrations'), { recursive: true });
  // This disposable stack supplies Storage only. Source acceptance/migrations
  // use the native runner's separate restricted-role PostgreSQL cluster.
  const originalPorts = [56320, 56321, 56322, 54323, 54324, 54327, 54329];
  const chosenPorts = new Set();
  const ports = [];
  for (const _port of originalPorts) {
    let selected;
    do { selected = await freeLoopbackPort(); } while (chosenPorts.has(selected));
    chosenPorts.add(selected);
    ports.push(selected);
  }
  let config = isolatedConfig(readFileSync(join(root, 'supabase/config.toml'), 'utf8'), id)
    .replace(/(\[storage\]\s*)enabled = false/u, '$1enabled = true');
  for (let index = 0; index < originalPorts.length; index += 1) {
    const prior = originalPorts[index];
    const selected = ports[index];
    if (prior === 54320) config = config.replace(`shadow_port = ${prior}`, `shadow_port = ${selected}`);
    else config = config.replaceAll(`port = ${prior}`, `port = ${selected}`);
  }
  writeFileSync(join(fixture, 'supabase', 'config.toml'), config);
  writeFileSync(join(fixture, 'supabase', 'seed.sql'), '');
  const created = spawnSync('docker', ['network', 'create', '-o', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', network], {
    env: environment, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  if (created.error || created.status !== 0) throw new Error('PHASE8_EXPORT_STORAGE_NETWORK_FAILED');
  networkCreated = true;
  started = true;
  initializeLocalMigrationProject({ workdir: fixture, projectId: id, network }, {
    initialize: (_network, dockerEnvironment) => invoke(['start', '--network-id', network], { ...environment, ...dockerEnvironment }),
    migrate() {},
  });
  const status = JSON.parse(invoke(['status', '-o', 'json']));
  const url = new URL(status.API_URL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(ports[1]) ||
      typeof status.SERVICE_ROLE_KEY !== 'string' || !status.SERVICE_ROLE_KEY) throw new Error('PHASE8_EXPORT_STORAGE_STATUS_INVALID');
  const runner = process.argv.includes('--reference-import') ? 'scripts/phase8-owner-export-reference-import.mjs' : 'scripts/phase8-owner-export.mjs';
  const result = spawnSync(process.execPath, [runner], {
    cwd: root, env: createOwnerExportStorageChildEnvironment(environment, {
      apiUrl: url.origin, serviceRoleKey: status.SERVICE_ROLE_KEY, apiPort: ports[1],
    }), stdio: 'inherit', timeout: 600_000, windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('PHASE8_EXPORT_STORAGE_ACCEPTANCE_FAILED');
} catch (error) {
  failed = true;
  console.error(/^(?:PHASE8_EXPORT_STORAGE_|LOCAL_AUTH_DOCKER_)/u.test(error?.message ?? '') ? error.message : 'PHASE8_EXPORT_STORAGE_FAILED');
} finally {
  let cleanup = true;
  if (started) { try { invoke(['stop', '--project-id', id, '--no-backup']); } catch { cleanup = false; } }
  if (networkCreated) {
    const result = spawnSync('docker', ['network', 'rm', network], { env: environment, stdio: 'ignore', timeout: 20_000, windowsHide: true });
    if (result.error || result.status !== 0) cleanup = false;
  }
  if (cleanup && fixture && resolve(fixture).startsWith(`${resolve(tmpdir())}${process.platform === 'win32' ? '\\' : '/'}`)) {
    rmSync(fixture, { recursive: true, force: true });
  }
  if (!cleanup) { failed = true; console.error('PHASE8_EXPORT_STORAGE_CLEANUP_FAILED'); }
  const referenceEvidencePath = resolve('evidence/phase8-owner-export-reference-import-250.json');
  if (process.argv.includes('--reference-import') && existsSync(referenceEvidencePath)) {
    try {
      const evidence = JSON.parse(readFileSync(referenceEvidencePath, 'utf8'));
      evidence.cleanup.localStorageProjectStopped = cleanup;
      evidence.cleanup.storageNetworkRemoved = cleanup;
      evidence.cleanup.storageTempDirectoryRemoved = cleanup;
      evidence.cleanupComplete = evidence.cleanupComplete && cleanup;
      writeFileSync(referenceEvidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
      if (!evidence.cleanupComplete) failed = true;
    } catch { failed = true; console.error('PHASE8_EXPORT_STORAGE_EVIDENCE_UPDATE_FAILED'); }
  }
  console.log(JSON.stringify({ storageCleanup: cleanup, acceptance: !failed }));
}
if (failed) process.exitCode = 1;
