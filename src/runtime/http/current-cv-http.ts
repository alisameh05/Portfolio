import {
  getCurrentCvApplicationService,
  getPublicRateLimit,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import { handleGetCurrentCv } from "./current-cv.js";
import { createCorrelation } from "../ports.js";

let initialization: Promise<unknown> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= initializeDatabaseRuntime(getRuntimeEnvironmentSnapshot(), "application");
  const current = initialization;
  try {
    await current;
  } catch (error) {
    if (initialization === current) initialization = undefined;
    throw error;
  }
}

function unavailable(request: Request): Response {
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  return Response.json({
    type: "urn:shipwithali:problem:temporarily-unavailable",
    title: "Service Unavailable",
    status: 503,
    detail: "A required dependency is temporarily unavailable. Retry later.",
    instance: new URL(request.url).pathname,
    code: "temporarily_unavailable",
    traceId,
  }, { status: 503, headers: { "content-type": "application/problem+json", "cache-control": "no-store" } });
}

/** Dispatches public Current CV through the shared public abuse control and real delivery service. */
export async function dispatchCurrentCvHttp(request: Request): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const service = await getCurrentCvApplicationService();
    const storageUrl = getRuntimeEnvironmentSnapshot()["SUPABASE_URL"];
    let allowedRedirectOrigins: string[] = [];
    if (storageUrl) {
      try {
        const parsed = new URL(storageUrl);
        if (parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.pathname === "/" &&
            parsed.search === "" && parsed.hash === "") allowedRedirectOrigins = [parsed.origin];
      } catch { /* An invalid storage origin leaves redirects disabled. */ }
    }
    stage = "adapter";
    return await handleGetCurrentCv(request, {
      service,
      rateLimit: getPublicRateLimit(),
      allowedRedirectOrigins,
    });
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("public.current-cv.http.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
