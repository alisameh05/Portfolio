import type { RelationalBackupDestinationPort } from "../application/relational-backup.js";

export class RelationalBackupDestinationError extends Error {
  readonly safeCode: "BACKUP_DESTINATION_UNAVAILABLE" | "BACKUP_UPLOAD_FAILED" | "BACKUP_READBACK_FAILED" | "BACKUP_CLEANUP_FAILED";
  constructor(safeCode: RelationalBackupDestinationError["safeCode"]) {
    super("Relational backup destination request failed (" + safeCode + ").");
    this.name = "RelationalBackupDestinationError";
    this.safeCode = safeCode;
  }
}

export function createHttpRelationalBackupDestination(options: {
  readonly name: string;
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly allowLoopbackHttp?: boolean;
  readonly requestTimeoutMs?: number;
}): RelationalBackupDestinationPort {
  if (!/^[a-z][a-z0-9-]{2,47}$/u.test(options.name)) throw new TypeError("Backup destination name is invalid.");
  if (!options.bearerToken.trim()) throw new TypeError("Backup destination token is required.");
  let base: URL;
  try { base = new URL(options.baseUrl); }
  catch { throw new TypeError("Backup destination URL must be absolute."); }
  const loopback = ["localhost", "127.0.0.1", "::1"].includes(base.hostname.toLowerCase());
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback && options.allowLoopbackHttp === true)) {
    throw new TypeError("Backup destination must use HTTPS outside an explicit loopback test.");
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new TypeError("Backup destination URL must not contain credentials or query parameters.");
  }
  const timeout = options.requestTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new TypeError("Backup destination timeout is invalid.");
  }
  const endpoint = (key: string): URL => {
    if (!/^relational\/[0-9a-f-]{36}\.swab$/u.test(key)) throw new TypeError("Backup object key is invalid.");
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/$/u, "") + "/v1/objects/" + encodeURIComponent(options.name) + "/" +
      key.split("/").map(encodeURIComponent).join("/");
    return url;
  };
  const send = async (method: string, key: string, body?: Uint8Array, signal?: AbortSignal): Promise<Response> => {
    try {
      return await fetch(endpoint(key), {
        method,
        headers: {
          authorization: "Bearer " + options.bearerToken,
          ...(body ? { "content-type": "application/octet-stream" } : {}),
        },
        ...(body ? { body: Buffer.from(body) } : {}),
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(timeout),
      });
    } catch {
      throw new RelationalBackupDestinationError("BACKUP_DESTINATION_UNAVAILABLE");
    }
  };
  return Object.freeze<RelationalBackupDestinationPort>({
    name: options.name,
    async put(key, bytes, signal) {
      const response = await send("PUT", key, bytes, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RelationalBackupDestinationError("BACKUP_UPLOAD_FAILED");
      }
      await response.body?.cancel().catch(() => undefined);
    },
    async get(key, signal) {
      const response = await send("GET", key, undefined, signal);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new RelationalBackupDestinationError("BACKUP_READBACK_FAILED");
      }
      return new Uint8Array(await response.arrayBuffer());
    },
    async delete(key, signal) {
      const response = await send("DELETE", key, undefined, signal);
      if (!response.ok && response.status !== 404) {
        await response.body?.cancel().catch(() => undefined);
        throw new RelationalBackupDestinationError("BACKUP_CLEANUP_FAILED");
      }
      await response.body?.cancel().catch(() => undefined);
    },
  });
}
