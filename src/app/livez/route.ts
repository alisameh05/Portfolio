/**
 * GET /livez — Phase 2 #25 operational liveness probe.
 *
 * Returns 200 with a minimal live status whenever the process can answer.
 * It does not inspect configuration, application fakes, databases, or
 * external dependencies. Implemented against the standard Web Response so
 * the probe stays independent of framework types.
 */
export async function GET(): Promise<Response> {
  return Response.json({ status: "live" }, { status: 200 });
}
