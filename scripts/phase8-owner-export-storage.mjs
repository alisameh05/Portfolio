// Reuse the native PostgreSQL acceptance runner with real private Storage.
// Status credentials stay in memory and child environments, never artifacts.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initializeLocalMigrationProject } from "./local-migration-bootstrap.mjs";
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
  const config = isolatedConfig(readFileSync(join(root, 'supabase/config.toml'), 'utf8'), id)
    .replace(/(\[storage\]\s*)enabled = false/u, '$1enabled = true');
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
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '56321' ||
      typeof status.SERVICE_ROLE_KEY !== 'string' || !status.SERVICE_ROLE_KEY) throw new Error('PHASE8_EXPORT_STORAGE_STATUS_INVALID');
  const result = spawnSync(process.execPath, ['scripts/phase8-owner-export.mjs'], {
    cwd: root, env: { ...environment, PHASE8_OWNER_EXPORT_STORAGE_URL: url.origin,
      PHASE8_OWNER_EXPORT_STORAGE_KEY: status.SERVICE_ROLE_KEY }, stdio: 'inherit', timeout: 600_000, windowsHide: true,
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
  console.log(JSON.stringify({ storageCleanup: cleanup, acceptance: !failed }));
}
if (failed) process.exitCode = 1;
