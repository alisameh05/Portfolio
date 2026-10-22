import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Keep native socket names within PostgreSQL's 107-byte portable limit. */
export function createNativePostgresWorkspace(prefix, temporaryRoot = tmpdir()) {
  if (!/^p7-[a-z]+-$/u.test(prefix)) throw new Error("NATIVE_POSTGRES_TEMP_PREFIX_INVALID");
  const directory = mkdtempSync(join(resolve(temporaryRoot), prefix));
  const socket = join(directory, "socket");
  if (Buffer.byteLength(join(socket, ".s.PGSQL.65535")) > 107) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error("NATIVE_POSTGRES_SOCKET_PATH_TOO_LONG");
  }
  mkdirSync(socket);
  return { directory, data: join(directory, "data"), socket, serverLog: join(directory, "server.log") };
}

export function removeNativePostgresWorkspace(directory, prefix, temporaryRoot = tmpdir()) {
  const target = resolve(directory);
  if (!/^p7-[a-z]+-$/u.test(prefix) || dirname(target) !== resolve(temporaryRoot) || !basename(target).startsWith(prefix)) {
    throw new Error("NATIVE_POSTGRES_TEMP_CLEANUP_SCOPE_INVALID");
  }
  rmSync(target, { recursive: true, force: true });
}

/** Never expose startup logs or command output; retain only known failure categories. */
export function nativePostgresStartupFailure(result, serverLog) {
  let log = "";
  try { if (serverLog && existsSync(serverLog)) log = readFileSync(serverLog, "utf8").slice(-4_000); } catch { /* Preserve the original command failure if the log is unreadable. */ }
  const diagnostic = [result.stderr, result.stdout, result.error?.message, log].filter(Boolean).join("\n");
  if (/Unix-domain socket path[^\n]*too long/u.test(diagnostic)) return "NATIVE_POSTGRES_SOCKET_PATH_TOO_LONG";
  if (/No space left on device|\bENOSPC\b/u.test(diagnostic)) return "ENOSPC";
  if (/Permission denied|\bEACCES\b/u.test(diagnostic)) return "EACCES";
  if (/Address already in use|\bEADDRINUSE\b/u.test(diagnostic)) return "EADDRINUSE";
  if (/^(?:ENOENT|EPERM|ETIMEDOUT|ENOBUFS|EPIPE|ECONNREFUSED)$/u.test(result.error?.code ?? "")) return result.error.code;
  return "NATIVE_POSTGRES_STARTUP_FAILED";
}
