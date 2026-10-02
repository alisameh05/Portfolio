import { describe, expect, it } from "vitest";
import { err, ok, unsafeStableId, type IdempotencyKey, type Rejection, type Result } from "../../src/shared/domain/index.js";
import type { TransactionContext } from "../../src/runtime/ports.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/index.js";
import { createPortfolioGlobalCtaCommandService } from "../../src/modules/portfolio-configuration/index.js";
import { createPortfolioSettingsReader, type PortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../src/modules/portability-operations/index.js";

const portfolioId = unsafeStableId<"Portfolio">("018f4f7d-5000-7000-8000-000000000001");
const ownerId = unsafeStableId<"Owner">("018f4f7d-5000-7000-8000-000000000002");
const context = Object.freeze({ kind: "transaction" }) as TransactionContext;
const cta = {
  label: "Discuss a project",
  destination: "https://example.com/contact",
  unavailableFallback: "Contact details are currently unavailable.",
};

function settings(): PortfolioSettings {
  return {
    portfolioId,
    profile: { displayName: "Ali Sameh", headline: "AI product builder", bio: "A private biography stays unchanged." },
    contactChannels: [{ channel: "linkedin", label: "LinkedIn", destination: "https://linkedin.com/in/ali", availableLocales: ["en"] }],
    globalCta: { label: "Contact", destination: "https://example.com/old", unavailableFallback: "Please use the profile contact channels." },
    version: 1,
  };
}

function operationsFake() {
  const records = new Map<string, { readonly requestHash: string; readonly result: SafeResultEnvelope }>();
  const events: unknown[] = [];
  let executions = 0;
  const operations: OperationsPersistencePorts = {
    transactions: { run: async (callback) => await callback(context) as never },
    idempotency: {
      async execute(input, effect) {
        executions += 1;
        const key = `${input.operationScope}:${input.actorScope}:${input.key}`;
        const existing = records.get(key);
        if (existing !== undefined) {
          return existing.requestHash === input.requestHash
            ? { kind: "replayed", result: existing.result }
            : { kind: "conflict" };
        }
        const result = await effect(context);
        records.set(key, { requestHash: input.requestHash, result });
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

function fixture() {
  let stored = settings();
  const operations = operationsFake();
  const repository: Pick<PortfolioSettingsRepository, "getSettings" | "updateGlobalCta"> = {
    async getSettings(scope): Promise<Result<PortfolioSettings, Rejection>> {
      return scope.portfolioId === portfolioId && scope.ownerId === ownerId
        ? ok(stored)
        : err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
    },
    async updateGlobalCta(scope, nextCta, expectedVersion): Promise<Result<{ aggregateVersion: number; updatedAt: string }, Rejection>> {
      if (scope.portfolioId !== portfolioId) return err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
      if (expectedVersion !== stored.version) {
        return err({ kind: "precondition_failed", code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH", currentVersion: stored.version });
      }
      stored = { ...stored, globalCta: nextCta, version: stored.version + 1 };
      return ok({ aggregateVersion: stored.version, updatedAt: "2026-10-02T10:00:00.000Z" });
    },
  };
  const service = createPortfolioGlobalCtaCommandService({
    repository,
    operations: operations.operations,
    scope: { portfolioId, ownerId },
    clock: { now: () => "2026-10-02T10:00:00.000Z" },
    ids: { generate: () => "018f4f7d-5000-7000-8000-000000000005" },
  });
  return { service, repository, operations, get stored() { return stored; } };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    actor: { kind: "owner", ownerId, sessionId: "stable-owner-session" } as const,
    portfolioId,
    idempotencyKey: "cta-key-one" as IdempotencyKey,
    expectedVersion: 1,
    correlationId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2",
    globalCta: cta,
    ...overrides,
  };
}

describe("Owner Global project CTA command", () => {
  it("updates one CTA atomically and preserves unrelated settings in the query", async () => {
    const state = fixture();
    const updated = await state.service.updateGlobalCta(command());
    const reader = createPortfolioSettingsReader({
      repository: state.repository,
      transactions: state.operations.operations.transactions,
      scope: { portfolioId, ownerId },
    });
    const read = await reader.getSettings({ actor: command().actor, portfolioId });

    expect(updated).toEqual(ok({ aggregateId: portfolioId, aggregateVersion: 2, outcome: "configuration-updated" }));
    expect(read).toEqual(ok({ ...settings(), globalCta: cta, version: 2 }));
    expect(state.operations.events).toHaveLength(1);
    expect(state.operations.events[0]).toMatchObject({
      payload: {
        type: "portfolio_configuration.cta_updated.v1",
        version: 1,
        value: { changedFields: ["label", "destination", "unavailableFallback"], ownerScope: expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
      aggregateId: portfolioId,
      aggregateVersion: 2,
      correlationId: command().correlationId,
      occurredAt: "2026-10-02T10:00:00.000Z",
    });
    expect(JSON.stringify(state.operations.events)).not.toContain(cta.destination);
    expect(JSON.stringify(state.operations.events)).not.toContain(ownerId);
  });

  it("replays the original receipt, rejects changed hashes, and rejects a fresh stale version", async () => {
    const state = fixture();
    const first = await state.service.updateGlobalCta(command());
    const replay = await state.service.updateGlobalCta(command({
      actor: { kind: "owner", ownerId, sessionId: "refreshed-session" },
    }));
    const changed = await state.service.updateGlobalCta(command({ globalCta: { ...cta, label: "Changed" } }));
    const versionChanged = await state.service.updateGlobalCta(command({ expectedVersion: 2 }));
    const stale = await state.service.updateGlobalCta(command({ idempotencyKey: "cta-key-two" as IdempotencyKey }));

    expect(replay).toEqual(first);
    expect(changed).toEqual(err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" }));
    expect(versionChanged).toEqual(err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" }));
    expect(stale).toEqual(err({ kind: "precondition_failed", code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH", currentVersion: 2 }));
    expect(state.operations.events).toHaveLength(1);
  });

  it.each([
    ["executable protocol", { ...cta, destination: "javascript:alert(1)" }],
    ["credentials", { ...cta, destination: "https://user:secret@example.com/contact" }],
    ["local host", { ...cta, destination: "https://service.local/contact" }],
    ["private IP", { ...cta, destination: "https://127.0.0.1/contact" }],
    ["non-HTTPS scheme", { ...cta, destination: "http://example.com/contact" }],
    ["unsafe redirect form", { ...cta, destination: "https://example.com@evil.test/contact" }],
    ["malformed URL", { ...cta, destination: "not a URL" }],
    ["oversized label", { ...cta, label: "x".repeat(81) }],
    ["blank fallback", { ...cta, unavailableFallback: "   " }],
    ["executable fallback", { ...cta, unavailableFallback: "<img src=x>" }],
    ["oversized fallback", { ...cta, unavailableFallback: "x".repeat(161) }],
  ])("rejects unsafe or out-of-contract %s before replay", async (_name, globalCta) => {
    const state = fixture();
    const result = await state.service.updateGlobalCta(command({ globalCta }));

    expect(result).toEqual(err({ kind: "validation", code: "INVALID_GLOBAL_PROJECT_CTA" }));
    expect(state.operations.executions).toBe(0);
    expect(state.operations.events).toHaveLength(0);
    expect(state.stored.version).toBe(1);
  });

  it("authorizes before idempotency replay", async () => {
    const state = fixture();
    await state.service.updateGlobalCta(command());
    const denied = await state.service.updateGlobalCta(command({ actor: { kind: "visitor", consent: "unknown" } }));

    expect(denied).toEqual(err({ kind: "forbidden", code: "OWNER_REQUIRED" }));
    expect(state.operations.executions).toBe(1);
    expect(state.operations.events).toHaveLength(1);
  });
});
