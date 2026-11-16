import {
  getReactionRuntimeServices,
  getRuntimeEnvironmentSnapshot,
  isDatabaseRuntimeInitialized,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import { createCorrelation } from "../ports.js";
import { handlePutProjectReaction } from "./reaction.js";

let initialization: Promise<unknown> | undefined;

async function ensureRuntime(): Promise<void> {
  if (isDatabaseRuntimeInitialized()) return;
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
  let instance = "/api/v1/projects/{projectId}/reaction";
  try { instance = new URL(request.url).pathname; } catch { /* Keep the safe canonical path. */ }
  return Response.json({
    type: "urn:shipwithali:problem:temporarily-unavailable",
    title: "Service Unavailable",
    status: 503,
    detail: "A required dependency is temporarily unavailable. Retry later.",
    instance,
    code: "temporarily_unavailable",
    traceId,
  }, { status: 503, headers: { "content-type": "application/problem+json", "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } });
}

/** Initializes required application services before dispatching public Reaction HTTP. */
export async function dispatchPutProjectReactionHttp(
  request: Request,
  params: { readonly projectId: string },
): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const services = await getReactionRuntimeServices();
    stage = "adapter";
    return await handlePutProjectReaction(request, params, services);
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("public.reaction.http.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
