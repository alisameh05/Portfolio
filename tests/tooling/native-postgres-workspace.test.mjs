import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativePostgresWorkspace, nativePostgresStartupFailure, removeNativePostgresWorkspace }
  from "../../scripts/native-postgres-workspace.mjs";

test("native PostgreSQL workspaces keep socket paths short and cleanup confined to their owned temporary directory", () => {
  for (const prefix of ["p7-events-", "p7-goals-", "p7-integrated-"]) {
    const workspace = createNativePostgresWorkspace(prefix);
    try {
      assert.ok(Buffer.byteLength(join(workspace.socket, ".s.PGSQL.65535")) <= 107);
      assert.equal(existsSync(workspace.socket), true);
      assert.throws(() => removeNativePostgresWorkspace(workspace.directory, "p7-unrelated-"), /CLEANUP_SCOPE_INVALID/u);
      assert.equal(existsSync(workspace.directory), true);
    } finally { removeNativePostgresWorkspace(workspace.directory, prefix); }
    assert.equal(existsSync(workspace.directory), false);
  }
  const root = mkdtempSync(join(tmpdir(), "p7-path-"));
  const long = join(root, "long".repeat(30));
  try {
    mkdirSync(long);
    assert.throws(() => createNativePostgresWorkspace("p7-events-", long), /SOCKET_PATH_TOO_LONG/u);
    assert.deepEqual(readdirSync(long), []);
    const originalDirectory = process.cwd();
    try {
      process.chdir(long);
      assert.throws(() => createNativePostgresWorkspace("p7-events-", "."), /SOCKET_PATH_TOO_LONG/u);
      assert.deepEqual(readdirSync(long), []);
    } finally { process.chdir(originalDirectory); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("native PostgreSQL startup diagnostics retain known causes without raw logs or private values", () => {
  const workspace = createNativePostgresWorkspace("p7-diagnostic-");
  try {
    writeFileSync(workspace.serverLog, 'Unix-domain socket path "/private/sentinel-secret/socket" is too long (maximum 107 bytes)\n');
    assert.equal(nativePostgresStartupFailure({}, workspace.serverLog), "NATIVE_POSTGRES_SOCKET_PATH_TOO_LONG");
    writeFileSync(workspace.serverLog, "unclassified PRIVATE_PAYLOAD token=sentinel-secret\n");
    assert.equal(nativePostgresStartupFailure({ stderr: "No space left on device token=sentinel-secret" }, workspace.serverLog), "ENOSPC");
    assert.equal(nativePostgresStartupFailure({ stderr: "Permission denied" }, workspace.serverLog), "EACCES");
    assert.equal(nativePostgresStartupFailure({ stderr: "Address already in use" }, workspace.serverLog), "EADDRINUSE");
    assert.equal(nativePostgresStartupFailure({}, workspace.serverLog), "NATIVE_POSTGRES_STARTUP_FAILED");
    assert.match(readFileSync(workspace.serverLog, "utf8"), /PRIVATE_PAYLOAD/u);
  } finally { removeNativePostgresWorkspace(workspace.directory, "p7-diagnostic-"); }
});
