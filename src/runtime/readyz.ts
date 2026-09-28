/**
 * readyz.ts — Phase 2 #27 readiness probe logic.
 *
 * Returns 200 with a minimal ready status only while the lifecycle state is
 * ready. Every other state returns safe 503 Problem Details with the stable
 * RUNTIME_NOT_READY code and no configuration or dependency details.
 *
 * Phase 2 readiness performs no database, Auth, storage, or
 * external-provider check. Uses only standard Web Responses and
 * provider-neutral correlation — no Next.js, Supabase, Kysely, or generated
 * transport imports.
 */

import { createCorrelation, type LifecycleState } from "./ports.js";

export function createReadyzResponse(state: LifecycleState): Response {
  if (state === "ready") {
    return Response.json({ status: "ready" }, { status: 200 });
  }
  const { traceId } = createCorrelation();
  return new Response(
    JSON.stringify({
      type: "urn:shipwithali:problem:not-ready",
      title: "Service Unavailable",
      status: 503,
      detail: "The runtime is not ready to accept traffic.",
      instance: "/readyz",
      code: "RUNTIME_NOT_READY",
      traceId,
    }),
    {
      status: 503,
      headers: { "content-type": "application/problem+json" },
    },
  );
}

export async function createCheckedReadyzResponse(
  state: LifecycleState,
  check: () => Promise<boolean>,
): Promise<Response> {
  if (state === "ready" && !(await check())) {
    return createReadyzResponse("failed");
  }
  return createReadyzResponse(state);
}
