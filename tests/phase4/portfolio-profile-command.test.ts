import { describe, expect, it } from "vitest";
import { err, ok, unsafeStableId, type IdempotencyKey, type Rejection, type Result } from "../../src/shared/domain/index.js";
import type { TransactionContext } from "../../src/runtime/ports.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/index.js";
import { createPortfolioProfileCommandService } from "../../src/modules/portfolio-configuration/index.js";
import type { PortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../src/modules/portability-operations/index.js";

const portfolioId = unsafeStableId<"Portfolio">("018f4f7d-5000-7000-8000-000000000001");
const ownerId = unsafeStableId<"Owner">("018f4f7d-5000-7000-8000-000000000002");
const otherPortfolioId = unsafeStableId<"Portfolio">("018f4f7d-5000-7000-8000-000000000003");
const otherOwnerId = unsafeStableId<"Owner">("018f4f7d-5000-7000-8000-000000000004");
const context = Object.freeze({ kind: "transaction" }) as TransactionContext;
const profile = { displayName: "Ali Sameh", headline: "AI product builder", bio: "Reviewed portfolio bio." };
const settings = (id = portfolioId): PortfolioSettings => ({
  portfolioId: id,
  profile: { displayName: "Ali", headline: "Builder", bio: "Initial bio." },
  contactChannels: [{ channel: "linkedin", label: "LinkedIn", destination: "https://linkedin.com/in/ali", availableLocales: ["en"] }],
  globalCta: { label: "Contact", destination: "https://example.com/contact", unavailableFallback: "Unavailable." },
  version: 1,
});

function operationsFake() {
  const records = new Map<string, { readonly requestHash: string; readonly result: SafeResultEnvelope }>();
  const events: unknown[] = [];
  let executions = 0;
  const operations: OperationsPersistencePorts = {
    transactions: { run: async (callback) => await callback(context) as never },
    idempotency: {
      async execute(input, effect) {
        executions += 1;
        const scope = `${input.operationScope}:${input.actorScope}:${input.key}`;
        const existing = records.get(scope);
        if (existing !== undefined) {
          if (existing.requestHash !== input.requestHash) return { kind: "conflict" };
          return { kind: "replayed", result: existing.result };
        }
        const result = await effect(context);
        records.set(scope, { requestHash: input.requestHash, result });
        return { kind: "executed", result };
      },
    },
    outbox: {
      append: async (_context, event) => { events.push(event); },
      claimDue: async () => [], complete: async () => false,
      fail: async () => false, release: async () => false,
    },
    jobs: {
      enqueue: async () => undefined, claimDue: async () => [], complete: async () => false,
      fail: async () => false, release: async () => false,
    },
  };
  return { operations, events, get executions() { return executions; } };
}

function fixture(initial = settings(), operations = operationsFake()) {
  let stored = initial;
  const repository: Pick<PortfolioSettingsRepository, "getSettings" | "updateProfile"> = {
    async getSettings(scope): Promise<Result<PortfolioSettings, Rejection>> {
      if (scope.portfolioId !== stored.portfolioId || scope.ownerId !== ownerId) {
        return err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
      }
      return ok(stored);
    },
    async updateProfile(scope, nextProfile, expectedVersion): Promise<Result<{ aggregateVersion: number; updatedAt: string }, Rejection>> {
      if (scope.portfolioId !== stored.portfolioId) return err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
      if (expectedVersion !== stored.version) {
        return err({ kind: "precondition_failed", code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH", currentVersion: stored.version });
      }
      stored = { ...stored, profile: nextProfile, version: stored.version + 1 };
      return ok({ aggregateVersion: stored.version, updatedAt: "2026-10-02T10:00:00.000Z" });
    },
  };
  const service = createPortfolioProfileCommandService({
    repository,
    operations: operations.operations,
    scope: { portfolioId: initial.portfolioId, ownerId },
    clock: { now: () => "2026-10-02T10:00:00.000Z" },
    ids: { generate: () => "018f4f7d-5000-7000-8000-000000000005" },
  });
  return { service, repository, operations, get stored() { return stored; } };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    actor: { kind: "owner", ownerId, sessionId: "session-one" } as const,
    portfolioId,
    idempotencyKey: "profile-key-one" as IdempotencyKey,
    expectedVersion: 1,
    correlationId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2",
    profile,
    ...overrides,
  };
}

describe("Owner profile command orchestration", () => {
  it("updates once and replays the original receipt after the version advances", async () => {
    const fixtureState = fixture();
    const first = await fixtureState.service.updateProfile(command());
    const retry = await fixtureState.service.updateProfile(command({
      actor: { kind: "owner", ownerId, sessionId: "session-after-refresh" },
    }));

    expect(first).toEqual(ok({ aggregateId: portfolioId, aggregateVersion: 2, outcome: "configuration-updated" }));
    expect(retry).toEqual(first);
    expect(fixtureState.stored.version).toBe(2);
    expect(fixtureState.operations.events).toHaveLength(1);
    expect(fixtureState.operations.events[0]).toMatchObject({
      payload: {
        type: "portfolio_configuration.profile_updated.v1",
        value: { changedFields: ["displayName", "headline", "bio"], ownerScope: expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
      aggregateId: portfolioId,
      aggregateVersion: 2,
      occurredAt: "2026-10-02T10:00:00.000Z",
    });
    expect(JSON.stringify(fixtureState.operations.events[0])).not.toContain(ownerId);
  });

  it("conflicts when the same key carries a changed body or expected version", async () => {
    const fixtureState = fixture();
    await fixtureState.service.updateProfile(command());

    const bodyChange = await fixtureState.service.updateProfile(command({
      profile: { ...profile, bio: "Changed request." },
    }));
    const versionChange = await fixtureState.service.updateProfile(command({ expectedVersion: 2 }));

    expect(bodyChange).toEqual(err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" }));
    expect(versionChange).toEqual(err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" }));
    expect(fixtureState.operations.events).toHaveLength(1);
  });

  it("rejects an authorized request with a fresh stale version without emitting a new event", async () => {
    const fixtureState = fixture();
    await fixtureState.service.updateProfile(command());
    const stale = await fixtureState.service.updateProfile(command({
      idempotencyKey: "profile-key-two" as IdempotencyKey,
    }));

    expect(stale).toEqual(err({
      kind: "precondition_failed",
      code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH",
      currentVersion: 2,
    }));
    expect(fixtureState.operations.events).toHaveLength(1);
  });

  it("authorizes before ledger replay and mutation", async () => {
    const fixtureState = fixture();
    await fixtureState.service.updateProfile(command());
    const denied = await fixtureState.service.updateProfile(command({
      actor: { kind: "visitor", consent: "unknown" },
    }));

    expect(denied).toEqual(err({ kind: "forbidden", code: "OWNER_REQUIRED" }));
    expect(fixtureState.operations.executions).toBe(1);
    expect(fixtureState.operations.events).toHaveLength(1);
  });

  it("validates meaningful bounded profile text before persistence", async () => {
    const fixtureState = fixture();
    const rejected = await fixtureState.service.updateProfile(command({
      profile: { ...profile, bio: " ".repeat(4_001) },
    }));

    expect(rejected).toEqual(err({ kind: "validation", code: "INVALID_PORTFOLIO_PROFILE" }));
    expect(fixtureState.operations.executions).toBe(0);
    expect(fixtureState.operations.events).toHaveLength(0);
  });

  it("uses a stable Owner scope independent of session identity", async () => {
    const operations = operationsFake();
    const first = fixture(settings(), operations);
    const secondId = unsafeStableId<"Portfolio">(otherPortfolioId);
    const secondInitial = settings(secondId);
    let secondStored = secondInitial;
    const secondService = createPortfolioProfileCommandService({
      operations: operations.operations,
      scope: { portfolioId: secondId, ownerId: otherOwnerId },
      repository: {
        async getSettings() { return ok(secondStored); },
        async updateProfile(_scope, nextProfile, expectedVersion) {
          if (expectedVersion !== secondStored.version) return err({ kind: "precondition_failed", code: "VERSION", currentVersion: secondStored.version });
          secondStored = { ...secondStored, profile: nextProfile, version: secondStored.version + 1 };
          return ok({ aggregateVersion: secondStored.version, updatedAt: "2026-10-02T10:00:00.000Z" });
        },
      },
      clock: { now: () => "2026-10-02T10:00:00.000Z" },
      ids: { generate: () => "018f4f7d-5000-7000-8000-000000000006" },
    });

    const firstResult = await first.service.updateProfile(command());
    const secondResult = await secondService.updateProfile(command({
      actor: { kind: "owner", ownerId: otherOwnerId, sessionId: "another-provider-session" },
      portfolioId: secondId,
    }));
    expect(firstResult.ok).toBe(true);
    expect(secondResult).toEqual(ok({ aggregateId: secondId, aggregateVersion: 2, outcome: "configuration-updated" }));
    expect(operations.events).toHaveLength(2);
  });
});
