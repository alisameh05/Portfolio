import type { ReadinessCheck } from "../../../runtime/ports.js";
import type { OwnerAuthConfig } from "./auth-config.js";

/** Non-destructive Auth API health check; no session, response payload or secret is retained. */
export function createSupabaseIdentityReadiness(input: {
  readonly config: OwnerAuthConfig;
  readonly publicApiKey?: string;
  readonly request?: typeof fetch;
  readonly timeoutMs?: number;
}): ReadinessCheck {
  const url = new URL(input.config.supabaseUrl);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("IDENTITY_READINESS_CONFIGURATION_INVALID");
  }
  url.pathname = `${url.pathname.replace(/\/$/u, "")}/auth/v1/health`;
  const timeoutMs = Number.isSafeInteger(input.timeoutMs) && input.timeoutMs! >= 25 && input.timeoutMs! <= 1_000 ? input.timeoutMs! : 500;
  return { name: "identity", async check() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await Promise.race([
        (async () => {
          const response = await (input.request ?? fetch)(url, { method: "GET", signal: controller.signal,
            redirect: "error", cache: "no-store", credentials: "omit",
            headers: input.publicApiKey === undefined ? {} : { apikey: input.publicApiKey } });
          await response.body?.cancel();
          return response.status === 200;
        })(),
        new Promise<boolean>((resolve) => controller.signal.addEventListener("abort", () => resolve(false), { once: true })),
      ]);
    } catch { return false; }
    finally { clearTimeout(timer); controller.abort(); }
  } };
}
