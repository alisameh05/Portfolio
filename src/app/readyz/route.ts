/**
 * GET /readyz — Phase 2 #27 operational readiness probe.
 *
 * Returns 200 with a minimal ready status only while the runtime lifecycle
 * is ready. Starting, failed, and draining return safe 503 Problem Details
 * with the stable RUNTIME_NOT_READY code. Phase 2 performs no database,
 * Auth, storage, or external-provider check. Implemented against the
 * standard Web Response so the probe stays independent of framework types.
 */
import {
  getLifecycleCoordinator,
  getLifecycleState,
} from "../../runtime/lifecycle.js";
import { createCheckedReadyzResponse } from "../../runtime/readyz.js";

export async function GET(): Promise<Response> {
  return createCheckedReadyzResponse(getLifecycleState(), () =>
    getLifecycleCoordinator().checkReadiness(),
  );
}
