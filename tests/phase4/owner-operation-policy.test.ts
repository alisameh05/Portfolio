/**
 * owner-operation-policy.test.ts — Phase 4 #81
 *
 * Pre-agreed seam: the Identity and Access operation policy observed through
 * its provider-neutral application interface. No sessions, cookies, database,
 * or live provider required.
 *
 * Acceptance (issue #81, policy slice):
 * - Operation-specific Owner/Visitor/trusted System policy; `admin:all` is
 *   never a bypass; caller-forged privileged claims are ignored; unsupported
 *   System purposes and job triggering remain unavailable.
 * - `resolveActorContext` maps a verified Owner identity to a stable
 *   provider-neutral Owner actor; production crypto remains an injected port.
 */

import { describe, expect, it } from "vitest";

import type { ActorContext } from "../../src/shared/domain/index.js";
import {
  createIdentityAccessService,
  decideAuthorization,
  requiredPermissionForOwnerOperation,
} from "../../src/modules/identity-access/application/policy.js";
import { StubCryptoAdapter } from "../../src/modules/identity-access/adapters/index.js";

const OWNER: ActorContext = {
  kind: "owner",
  ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as never,
  sessionId: "session-opaque-001",
};

const VISITOR: ActorContext = {
  kind: "visitor",
  consent: "unknown",
};

const SYSTEM: ActorContext = {
  kind: "system",
  jobId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb0" as never,
  purpose: "operations-dispatch",
};

describe("Owner operation policy (#81)", () => {
  it("requires owner-scoped access for every Owner entrypoint operation", () => {
    for (const operation of [
      "updateOwnerProfileConfiguration",
      "getOwnerContentAggregate",
      "requestOwnerExport",
      "activateOwnerAnalyticsGoalVersion",
    ]) {
      expect(requiredPermissionForOwnerOperation(operation)).toBe("write:owner");
    }
  });

  it("authorizes the verified Owner for owner-scoped and public reads", () => {
    for (const permission of ["write:owner", "read:public"] as const) {
      const result = decideAuthorization({ actor: OWNER, requiredPermission: permission });
      expect(result.ok).toBe(true);
    }
  });

  it("never treats admin:all as a bypass for any actor", () => {
    for (const actor of [OWNER, VISITOR, SYSTEM]) {
      const result = decideAuthorization({ actor, requiredPermission: "admin:all" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe("forbidden");
        expect(result.error.code).toBe("ADMIN_BYPASS_DENIED");
      }
    }
  });

  it("denies Visitor actors owner-scoped access", () => {
    const result = decideAuthorization({ actor: VISITOR, requiredPermission: "write:owner" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("forbidden");
      expect(result.error.code).toBe("OWNER_REQUIRED");
    }
  });

  it("permits Visitor actors public reads only", () => {
    const result = decideAuthorization({ actor: VISITOR, requiredPermission: "read:public" });
    expect(result.ok).toBe(true);
  });

  it("keeps System job triggering unavailable for unsupported purposes", () => {
    const trigger = decideAuthorization({ actor: SYSTEM, requiredPermission: "job:execute" });
    expect(trigger.ok).toBe(false);
    if (!trigger.ok) {
      expect(trigger.error.kind).toBe("forbidden");
      expect(trigger.error.code).toBe("JOB_TRIGGER_UNAVAILABLE");
    }
    const ownerSurface = decideAuthorization({ actor: SYSTEM, requiredPermission: "write:owner" });
    expect(ownerSurface.ok).toBe(false);
    if (!ownerSurface.ok) {
      expect(ownerSurface.error.kind).toBe("forbidden");
    }
  });

  it("denies Owner actors job execution", () => {
    const result = decideAuthorization({ actor: OWNER, requiredPermission: "job:execute" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("forbidden");
      expect(result.error.code).toBe("OPERATION_NOT_PERMITTED");
    }
  });

  it("ignores caller-forged privileged claims on any actor", () => {
    const forgedVisitor = {
      kind: "visitor",
      consent: "granted",
      permissions: ["admin:all"],
      isAdmin: true,
      role: "owner",
    } as unknown as ActorContext;
    const visitorResult = decideAuthorization({
      actor: forgedVisitor,
      requiredPermission: "write:owner",
    });
    expect(visitorResult.ok).toBe(false);

    const forgedSystem = {
      kind: "system",
      jobId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb0",
      purpose: "trigger-jobs",
      permissions: ["admin:all"],
    } as unknown as ActorContext;
    const systemResult = decideAuthorization({
      actor: forgedSystem,
      requiredPermission: "job:execute",
    });
    expect(systemResult.ok).toBe(false);

    const forgedOwner = {
      kind: "owner",
      ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0",
      sessionId: "session-opaque-001",
      role: "admin",
    } as unknown as ActorContext;
    const ownerResult = decideAuthorization({
      actor: forgedOwner,
      requiredPermission: "write:owner",
    });
    expect(ownerResult.ok).toBe(true);
  });

  it("resolves verified Owner identities to stable provider-neutral actors", async () => {
    const service = createIdentityAccessService({
      crypto: new StubCryptoAdapter(),
      auth: {
        async verifyOwnerSession() {
          return {
            ok: true as const,
            value: {
              ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0" as never,
              githubSubject: "github-subject-immutable-001",
              sessionId: "session-opaque-001",
            },
          };
        },
        async getOwnerAllowlist() {
          return { ok: true as const, value: ["github-subject-immutable-001"] };
        },
      },
    });
    const resolved = await service.resolveActorContext({
      sessionToken: "opaque-session-token",
      expectedPurpose: "owner_session",
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value).toEqual({
      kind: "owner",
      ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0",
      sessionId: "session-opaque-001",
    });
    expect(JSON.stringify(resolved.value)).not.toMatch(/github|supabase|jwt|cookie|token/i);
  });

  it("propagates verification rejections without constructing an actor", async () => {
    const service = createIdentityAccessService({
      crypto: new StubCryptoAdapter(),
      auth: {
        async verifyOwnerSession() {
          return { ok: false as const, error: { kind: "forbidden" as const, code: "NOT_OWNER" } };
        },
        async getOwnerAllowlist() {
          return { ok: true as const, value: [] };
        },
      },
    });
    const resolved = await service.resolveActorContext({
      sessionToken: "non-owner-token",
      expectedPurpose: "owner_session",
    });
    expect(resolved.ok).toBe(false);
  });

  it("keeps an explicitly injected stub crypto adapter fail closed", async () => {
    const service = createIdentityAccessService({
      crypto: new StubCryptoAdapter(),
      auth: {
        async verifyOwnerSession() {
          return { ok: false as const, error: { kind: "unauthenticated" as const, code: "SESSION_NOT_FOUND" } };
        },
        async getOwnerAllowlist() {
          return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "AUTH_PROVIDER_UNAVAILABLE" } };
        },
      },
    });
    const issued = await service.issuePseudonymousToken({
      purpose: "visitor_functional",
      interaction: "reaction",
      ttlSeconds: 3600,
      consent: "unknown",
    });
    expect(issued.ok).toBe(false);
  });
});
