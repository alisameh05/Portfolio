/**
 * Fixture: phase4-later-phase-activation
 *
 * Intentionally activates later-phase behavior in Phase 4 context: a forged
 * privileged actor bypass plus a business table write outside the operations
 * ledger. Expected to fail with rule: later-phase-activation-placeholder-bypass
 */

const PHASE2_OWNER_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0";

export function forgedOwnerActor() {
  return {
    kind: "owner",
    ownerId: PHASE2_OWNER_ID,
    sessionId: "phase2-owner-session",
    permission: "admin:all",
  };
}

export const LATER_PHASE_SQL = "INSERT INTO content.publications (id) VALUES (1)";
