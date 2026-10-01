/**
 * Fixture: phase4-uncontracted-route
 *
 * Intentionally implements a working product Route Handler outside the
 * allowlisted operational probes (/livez, /readyz) and references an
 * uncontracted product path. Expected to fail with rule:
 * uncontracted-route-handler
 */
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({ broad: "uncontracted /api/v1/broad-read literal" });
}

export const UNCONTRACTED_PATH = "/api/v1/broad-read";
