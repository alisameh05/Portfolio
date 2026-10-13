import { createHash } from "node:crypto";

export interface CurrentCvRateLimitCheck {
  check(request: Request): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds?: number }>;
}

export interface BoundedCurrentCvRateLimitOptions {
  /** Extract a client key from a trusted hosting adapter or proxy boundary. */
  readonly clientKey: (request: Request) => string;
  readonly maxRequests: number;
  readonly windowSeconds: number;
  readonly maximumClients?: number;
  readonly now?: () => number;
}

interface ClientWindow {
  readonly startsAt: number;
  requests: number;
}

/** Fixed-window limiter with a hard entry cap; client keys are retained only as hashes. */
export function createBoundedCurrentCvRateLimit(options: BoundedCurrentCvRateLimitOptions): CurrentCvRateLimitCheck {
  const maximumClients = options.maximumClients ?? 10_000;
  if (!Number.isSafeInteger(options.maxRequests) || options.maxRequests < 1 ||
      !Number.isSafeInteger(options.windowSeconds) || options.windowSeconds < 1 ||
      !Number.isSafeInteger(maximumClients) || maximumClients < 1) {
    throw new TypeError("Invalid Current CV rate limit configuration.");
  }
  const windowMs = options.windowSeconds * 1_000;
  const now = options.now ?? Date.now;
  const clients = new Map<string, ClientWindow>();

  return {
    async check(request) {
      const client = options.clientKey(request).trim();
      if (client === "") throw new TypeError("Current CV rate limit client key is unavailable.");
      const key = createHash("sha256").update(client).digest("hex");
      const time = now();
      for (const [existingKey, value] of clients) {
        if (time - value.startsAt >= windowMs) clients.delete(existingKey);
      }
      const current = clients.get(key);
      if (current === undefined) {
        if (clients.size >= maximumClients) {
          const earliestExpiry = Math.min(...[...clients.values()].map((value) => value.startsAt + windowMs));
          return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((earliestExpiry - time) / 1_000)) };
        }
        clients.set(key, { startsAt: time, requests: 1 });
        return { allowed: true };
      }
      if (current.requests >= options.maxRequests) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((current.startsAt + windowMs - time) / 1_000)) };
      }
      current.requests += 1;
      return { allowed: true };
    },
  };
}
