/**
 * actor.test.ts
 *
 * Tests for the ActorContext shared domain contract.
 *
 * Covers (per spec §Testing Decisions):
 *   - Union exhaustiveness: all three kinds (owner, visitor, system) are handled
 *   - Type guards: isOwner, isVisitor, isSystem correctly narrow the union
 *   - assertNeverActor throws on unhandled kinds at runtime
 *   - No provider types (Next.js, Supabase, JWT, cookies) are imported or
 *     present in the module
 *   - Visitor consent field accepts exactly "granted" | "denied" | "unknown"
 *   - System actor purpose is a string, not a provider-specific type
 */

import { describe, it, expect } from "vitest";
import {
  isOwner,
  isVisitor,
  isSystem,
  assertNeverActor,
  type ActorContext,
  type OwnerActor,
  type VisitorActor,
  type SystemActor,
} from "../../src/shared/domain/actor.js";
import { createStableId } from "../../src/shared/domain/stable-id.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeOwner(): OwnerActor {
  return {
    kind: "owner",
    ownerId: createStableId("Owner"),
    sessionId: "opaque-session-ref",
  };
}

function makeVisitor(consent: VisitorActor["consent"] = "unknown"): VisitorActor {
  return {
    kind: "visitor",
    consent,
  };
}

function makeVisitorWithId(consent: VisitorActor["consent"] = "granted"): VisitorActor {
  return {
    kind: "visitor",
    functionalId: createStableId("FunctionalVisitor"),
    consent,
  };
}

function makeSystem(): SystemActor {
  return {
    kind: "system",
    jobId: createStableId("Job"),
    purpose: "nightly-retention-job",
  };
}

// ── Union discriminant ────────────────────────────────────────────────────────

describe("ActorContext union discriminant", () => {
  it("owner actor has kind 'owner'", () => {
    expect(makeOwner().kind).toBe("owner");
  });

  it("visitor actor has kind 'visitor'", () => {
    expect(makeVisitor().kind).toBe("visitor");
  });

  it("system actor has kind 'system'", () => {
    expect(makeSystem().kind).toBe("system");
  });
});

// ── isOwner guard ─────────────────────────────────────────────────────────────

describe("isOwner", () => {
  it("returns true for an owner actor", () => {
    expect(isOwner(makeOwner())).toBe(true);
  });

  it("returns false for a visitor actor", () => {
    expect(isOwner(makeVisitor())).toBe(false);
  });

  it("returns false for a system actor", () => {
    expect(isOwner(makeSystem())).toBe(false);
  });
});

// ── isVisitor guard ───────────────────────────────────────────────────────────

describe("isVisitor", () => {
  it("returns true for a visitor actor", () => {
    expect(isVisitor(makeVisitor())).toBe(true);
  });

  it("returns false for an owner actor", () => {
    expect(isVisitor(makeOwner())).toBe(false);
  });

  it("returns false for a system actor", () => {
    expect(isVisitor(makeSystem())).toBe(false);
  });
});

// ── isSystem guard ────────────────────────────────────────────────────────────

describe("isSystem", () => {
  it("returns true for a system actor", () => {
    expect(isSystem(makeSystem())).toBe(true);
  });

  it("returns false for an owner actor", () => {
    expect(isSystem(makeOwner())).toBe(false);
  });

  it("returns false for a visitor actor", () => {
    expect(isSystem(makeVisitor())).toBe(false);
  });
});

// ── Exhaustiveness: switch over all kinds ─────────────────────────────────────

describe("ActorContext switch exhaustiveness", () => {
  it("handles all three actor kinds without reaching default", () => {
    const actors: ActorContext[] = [makeOwner(), makeVisitor(), makeSystem()];

    for (const actor of actors) {
      let handled = false;
      switch (actor.kind) {
        case "owner":
          expect(actor.ownerId).toBeDefined();
          handled = true;
          break;
        case "visitor":
          expect(actor.consent).toMatch(/^(granted|denied|unknown)$/);
          handled = true;
          break;
        case "system":
          expect(typeof actor.purpose).toBe("string");
          handled = true;
          break;
        default:
          assertNeverActor(actor);
      }
      expect(handled).toBe(true);
    }
  });
});

// ── assertNeverActor ──────────────────────────────────────────────────────────

describe("assertNeverActor", () => {
  it("throws when called with an unknown actor kind", () => {
    const unknownActor = { kind: "lab-user" } as unknown as never;
    expect(() => assertNeverActor(unknownActor)).toThrow();
  });
});

// ── Visitor consent values ────────────────────────────────────────────────────

describe("VisitorActor consent", () => {
  it("accepts 'granted'", () => {
    const visitor = makeVisitor("granted");
    expect(visitor.consent).toBe("granted");
  });

  it("accepts 'denied'", () => {
    const visitor = makeVisitor("denied");
    expect(visitor.consent).toBe("denied");
  });

  it("accepts 'unknown'", () => {
    const visitor = makeVisitor("unknown");
    expect(visitor.consent).toBe("unknown");
  });

  it("optional functionalId is absent when not provided", () => {
    const visitor = makeVisitor();
    expect(visitor.functionalId).toBeUndefined();
  });

  it("optional functionalId is a StableId when provided", () => {
    const visitor = makeVisitorWithId();
    expect(typeof visitor.functionalId).toBe("string");
  });
});

// ── OwnerActor: sessionId is opaque ──────────────────────────────────────────

describe("OwnerActor sessionId", () => {
  it("sessionId is a string (opaque — domain must not parse it)", () => {
    const owner = makeOwner();
    expect(typeof owner.sessionId).toBe("string");
  });

  it("sessionId is present in the owner actor", () => {
    const owner = makeOwner();
    expect(owner.sessionId).toBeDefined();
  });
});

// ── SystemActor: purpose is a plain string ────────────────────────────────────

describe("SystemActor purpose", () => {
  it("purpose is a plain string, not a structured provider type", () => {
    const system = makeSystem();
    expect(typeof system.purpose).toBe("string");
    expect(system.purpose.length).toBeGreaterThan(0);
  });
});

// ── Provider import guard ─────────────────────────────────────────────────────

describe("provider import guard", () => {
  it("actor module exports only domain types", async () => {
    const mod = await import("../../src/shared/domain/actor.js");
    const keys = Object.keys(mod);

    // Expected exports from actor.ts
    const expected = ["isOwner", "isVisitor", "isSystem", "assertNeverActor"];
    for (const key of expected) {
      expect(keys).toContain(key);
    }

    // Must not export provider-named things
    const forbidden = ["supabase", "jwt", "cookie", "next", "vercel", "kysely"];
    for (const f of forbidden) {
      const hasProvider = keys.some((k) => k.toLowerCase().includes(f));
      expect(hasProvider).toBe(false);
    }
  });
});
