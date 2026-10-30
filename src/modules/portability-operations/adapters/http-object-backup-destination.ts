import type { ObjectBackupDestinationPort } from "../application/object-backup.js";

export class ObjectBackupDestinationError extends Error {
  readonly safeCode: "OBJECT_BACKUP_DESTINATION_UNAVAILABLE" | "OBJECT_BACKUP_UPLOAD_FAILED" | "OBJECT_BACKUP_READBACK_FAILED" | "OBJECT_BACKUP_CLEANUP_FAILED";
  constructor(safeCode: ObjectBackupDestinationError["safeCode"]) {
    super("Object backup destination request failed (" + safeCode + ").");
    this.name = "ObjectBackupDestinationError";
    this.safeCode = safeCode;
  }
}

/** Private authenticated HTTP object store for encrypted SWOB envelopes. */
export function createHttpObjectBackupDestination(options: {
  readonly name: string;
  readonly baseUrl: string;
  readonly bearerToken: string;
  readonly allowLoopbackHttp?: boolean;
  readonly requestTimeoutMs?: number;
  readonly fetcher?: typeof fetch;
}): ObjectBackupDestinationPort {
  if (!/^[a-z][a-z0-9-]{2,47}$/u.test(options.name)) throw new TypeError("Object backup destination name is invalid.");
  if (!options.bearerToken.trim()) throw new TypeError("Object backup destination token is required.");
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { throw new TypeError("Object backup destination URL must be absolute."); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(base.hostname.toLowerCase());
  if (base.protocol !== "https:" && !(base.protocol === "http:" && loopback && options.allowLoopbackHttp === true)) {
    throw new TypeError("Object backup destination must use HTTPS outside explicit loopback tests.");
  }
  if (base.username || base.password || base.search || base.hash) throw new TypeError("Object backup destination URL must not contain credentials or query parameters.");
  const timeout = options.requestTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 300_000) throw new TypeError("Object backup destination timeout is invalid.");
  const fetcher = options.fetcher ?? fetch;
  const endpoint = (key: string): URL => {
    if (!/^objects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.swob|\/(?:catalog\.swob|items\/[0-9]{1,7}\.swob))$/u.test(key)) {
      throw new TypeError("Object backup object key is invalid.");
    }
    const url = new URL(base);
    url.pathname = url.pathname.replace(/\/$/u, "") + "/v1/objects/" + encodeURIComponent(options.name) + "/" +
      key.split("/").map(encodeURIComponent).join("/");
    return url;
  };
  const send = async (method: string, key: string, body?: Uint8Array, signal?: AbortSignal): Promise<Response> => {
    try {
      return await fetcher(endpoint(key), { method,
        headers: { authorization: "Bearer " + options.bearerToken, ...(body ? { "content-type": "application/octet-stream" } : {}) },
        ...(body ? { body: Buffer.from(body) } : {}), redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]) });
    } catch { throw new ObjectBackupDestinationError("OBJECT_BACKUP_DESTINATION_UNAVAILABLE"); }
  };
  const destination: ObjectBackupDestinationPort = {
    name: options.name,
    async put(key, bytes, signal) {
      const response = await send("PUT", key, bytes, signal);
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ObjectBackupDestinationError("OBJECT_BACKUP_UPLOAD_FAILED"); }
      await response.body?.cancel().catch(() => undefined);
    },
    async get(key, signal) {
      const response = await send("GET", key, undefined, signal);
      if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ObjectBackupDestinationError("OBJECT_BACKUP_READBACK_FAILED"); }
      return new Uint8Array(await response.arrayBuffer());
    },
    async delete(key, signal) {
      const response = await send("DELETE", key, undefined, signal);
      if (!response.ok && response.status !== 404) { await response.body?.cancel().catch(() => undefined); throw new ObjectBackupDestinationError("OBJECT_BACKUP_CLEANUP_FAILED"); }
      await response.body?.cancel().catch(() => undefined);
    },
  };
  return Object.freeze(destination);
}
