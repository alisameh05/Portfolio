/**
 * owner-test-auth.ts — Phase 4 #81 shared Owner adapter test harness.
 *
 * Supplies the verified-Owner security stub plus matching cookie/origin/CSRF
 * headers so existing Owner adapter tests exercise the authenticated path.
 * Negative authorization, origin, CSRF, and forwarded-host cases live in
 * `tests/phase4/owner-request-security.test.ts` and the authorization matrix.
 */

import type { ActorContext } from "../../src/shared/domain/index.js";
import {
  OWNER_CSRF_HEADER,
  OWNER_SESSION_COOKIE,
  createOwnerSecurityTestStub,
  type OwnerRequestSecurity,
} from "../../src/runtime/http/owner-security.js";

export const OWNER_TEST_ORIGIN = "https://example.com";
export const OWNER_TEST_SESSION_TOKEN = "opaque-session-token-for-tests-001";
export const OWNER_TEST_CSRF_TOKEN = "csrf-proof-token-for-tests-002";

export const OWNER_TEST_ACTOR: ActorContext = {
  kind: "owner",
  ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as never,
  sessionId: "owner-test-session-001",
};

/** Verified-Owner security stub wired to the real policy (allow path). */
export function ownerTestSecurity(): OwnerRequestSecurity {
  const stub = createOwnerSecurityTestStub({ type: "allow", actor: OWNER_TEST_ACTOR });
  return { ...stub, appOrigin: OWNER_TEST_ORIGIN };
}

/** Merge cookie-authenticated Owner headers (reads and mutations alike). */
export function withOwnerTestAuth(
  headers: Record<string, string>,
): Record<string, string> {
  return {
    ...headers,
    cookie: `${OWNER_SESSION_COOKIE}=${OWNER_TEST_SESSION_TOKEN}`,
    origin: OWNER_TEST_ORIGIN,
    [OWNER_CSRF_HEADER]: OWNER_TEST_CSRF_TOKEN,
  };
}
