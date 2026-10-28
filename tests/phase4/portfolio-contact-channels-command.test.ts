import { describe, expect, it } from "vitest";
import { err, ok, unsafeStableId, type IdempotencyKey, type Rejection, type Result } from "../../src/shared/domain/index.js";
import type { TransactionContext } from "../../src/runtime/ports.js";
import type { ContactChannel, PortfolioSettings } from "../../src/modules/portfolio-configuration/index.js";
import { createPortfolioContactChannelsCommandService } from "../../src/modules/portfolio-configuration/index.js";
import type { PortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../src/modules/portability-operations/index.js";

const portfolioId = unsafeStableId<"Portfolio">("018f4f7d-5000-7000-8000-000000000001");
const ownerId = unsafeStableId<"Owner">("018f4f7d-5000-7000-8000-000000000002");
const context = Object.freeze({ kind: "transaction" }) as TransactionContext;
const channels: readonly ContactChannel[] = [
  { channel: "email", label: "Email", destination: "mailto:ali@example.com", availableLocales: ["en"] },
  { channel: "linkedin", label: "LinkedIn", destination: "https://www.linkedin.com/in/ali", availableLocales: ["en", "ar"] },
];

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
      scheduleRetry: async () => false,
    },
    jobs: {
      enqueue: async () => true, claimDue: async () => [], complete: async () => false,
      fail: async () => false, scheduleRetry: async () => false, getDeadForRedrive: async () => null,
      getPhase7ScheduleStatus: async () => ({ jobs: [], oldestOverduePeriod: null, oldestUnfinishedPeriod: null,
        oldestCoverageIncompletePeriod: null, failedCount: 0, firstPolicyPeriod: "2026-01-01", requiredThroughPeriod: "2026-01-01",
        retentionScheduledThrough: "2025-12-31", retentionCompleteThrough: "2025-12-31", aggregateScheduledThrough: "2025-12-31",
        lastCompletePolicyPeriod: null, phase: "retention" }),
      getPhase7ScheduleStatusAtDatabaseCurrentPeriod: async input => operations.jobs.getPhase7ScheduleStatus(input),
      advancePhase7RetentionSchedule: async () => false, advancePhase7AggregateSchedule: async () => false,
      redriveDead: async () => null, release: async () => false, admitPhase7DependentWork: async () => false,
    },
  };
  return { operations, events, get executions() { return executions; } };
}

function fixture() {
  let stored: PortfolioSettings = {
    portfolioId,
    profile: { displayName: "Ali Sameh", headline: "AI product builder", bio: "Evidence-led work." },
    contactChannels: [{ channel: "other", label: "Old", destination: "https://example.com/old", availableLocales: ["en"] }],
    globalCta: { label: "Discuss", destination: "https://example.com/contact", unavailableFallback: "Use another channel." },
    version: 1,
  };
  const repository: Pick<PortfolioSettingsRepository, "getSettings" | "updateContactChannels"> = {
    async getSettings(scope): Promise<Result<PortfolioSettings, Rejection>> {
      if (scope.portfolioId !== stored.portfolioId || scope.ownerId !== ownerId) {
        return err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
      }
      return ok(stored);
    },
    async updateContactChannels(scope, next, expectedVersion) {
      if (scope.portfolioId !== stored.portfolioId) return err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
      if (expectedVersion !== stored.version) {
        return err({ kind: "precondition_failed", code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH", currentVersion: stored.version });
      }
      stored = { ...stored, contactChannels: next, version: stored.version + 1 };
      return ok({ aggregateVersion: stored.version, updatedAt: "2026-10-02T10:00:00.000Z" });
    },
  };
  const operations = operationsFake();
  const service = createPortfolioContactChannelsCommandService({
    repository,
    operations: operations.operations,
    scope: { portfolioId, ownerId },
    clock: { now: () => "2026-10-02T10:00:00.000Z" },
    ids: { generate: () => "018f4f7d-5000-7000-8000-000000000005" },
  });
  return { service, operations, get stored() { return stored; } };
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    actor: { kind: "owner", ownerId, sessionId: "session-one" } as const,
    portfolioId,
    idempotencyKey: "channels-key-one" as IdempotencyKey,
    expectedVersion: 1,
    correlationId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea2",
    contactChannels: channels,
    ...overrides,
  };
}

describe("Owner Contact channels command orchestration", () => {
  it("replaces the ordered channel list and emits one minimal versioned event", async () => {
    const state = fixture();
    const result = await state.service.updateContactChannels(command());

    expect(result).toEqual(ok({ aggregateId: portfolioId, aggregateVersion: 2, outcome: "configuration-updated" }));
    expect(state.stored.contactChannels).toEqual(channels);
    expect(state.stored.profile.bio).toBe("Evidence-led work.");
    expect(state.stored.globalCta.label).toBe("Discuss");
    expect(state.stored.version).toBe(2);
    expect(state.operations.events).toHaveLength(1);
    expect(state.operations.events[0]).toMatchObject({
      payload: {
        type: "portfolio_configuration.channels_updated.v1",
        value: { channelCount: 2, channelTypes: ["email", "linkedin"], ownerScope: expect.stringMatching(/^[0-9a-f]{64}$/) },
      },
      aggregateId: portfolioId,
      aggregateVersion: 2,
      occurredAt: "2026-10-02T10:00:00.000Z",
    });
    expect(JSON.stringify(state.operations.events[0])).not.toContain("mailto:ali@example.com");
    expect(JSON.stringify(state.operations.events[0])).not.toContain(ownerId);
  });

  it("supports every channel kind, preserving input and locale order", async () => {
    const state = fixture();
    const everyKind: readonly ContactChannel[] = [
      { channel: "linkedin", label: "LinkedIn", destination: "https://www.linkedin.com/in/ali", availableLocales: ["ar", "en"] },
      { channel: "whatsapp", label: "WhatsApp", destination: "https://wa.me/201234567890", availableLocales: ["ar"] },
      { channel: "instagram", label: "Instagram", destination: "https://www.instagram.com/ali", availableLocales: ["en"] },
      { channel: "phone", label: "Phone", destination: "tel:+201234567890", availableLocales: ["ar", "en"] },
      { channel: "email", label: "Email", destination: "mailto:ali@example.com", availableLocales: ["en"] },
      { channel: "other", label: "Website", destination: "https://example.org/contact", availableLocales: ["ar"] },
    ];

    const result = await state.service.updateContactChannels(command({ contactChannels: everyKind }));

    expect(result).toEqual(ok({ aggregateId: portfolioId, aggregateVersion: 2, outcome: "configuration-updated" }));
    expect(state.stored.contactChannels).toEqual(everyKind);
  });

  it.each([
    ["empty", []],
    ["maximum", Array.from({ length: 20 }, (_, index) => ({
      channel: "other" as const,
      label: `Website ${index + 1}`,
      destination: `https://example.org/${index + 1}`,
      availableLocales: ["en"] as const,
    }))],
  ])("accepts an %s replacement", async (_name, replacement) => {
    const state = fixture();
    const result = await state.service.updateContactChannels(command({ contactChannels: replacement }));

    expect(result.ok).toBe(true);
    expect(state.stored.contactChannels).toEqual(replacement);
    expect(state.stored.version).toBe(2);
  });

  it.each([
    ["oversized list", Array.from({ length: 21 }, (_, index) => ({ ...channels[0]!, label: `Email ${index}` }))],
    ["blank label", [{ ...channels[0]!, label: "  " }]],
    ["oversized label", [{ ...channels[0]!, label: "x".repeat(81) }]],
    ["duplicate locales", [{ ...channels[0]!, availableLocales: ["en", "en"] }]],
    ["unsupported locale", [{ ...channels[0]!, availableLocales: ["fr"] }]],
    ["empty locale list", [{ ...channels[0]!, availableLocales: [] }]],
    ["unsafe scheme", [{ ...channels[0]!, channel: "other", destination: "javascript:alert(1)" }]],
    ["credential-bearing URL", [{ ...channels[0]!, channel: "linkedin", destination: "https://user:pass@linkedin.com/ali" }]],
    ["lookalike host", [{ ...channels[0]!, channel: "linkedin", destination: "https://linkedin.com.attacker.example/ali" }]],
    ["wrong mail protocol", [{ ...channels[0]!, channel: "email", destination: "https://example.com" }]],
    ["malformed mail domain", [{ ...channels[0]!, channel: "email", destination: "mailto:ali@bad..com" }]],
    ["hyphen-leading mail domain", [{ ...channels[0]!, channel: "email", destination: "mailto:ali@-bad.com" }]],
    ["consecutive local-part dots", [{ ...channels[0]!, channel: "email", destination: "mailto:a..b@example.com" }]],
    ["wrong phone protocol", [{ ...channels[0]!, channel: "phone", destination: "mailto:ali@example.com" }]],
    ["oversized destination", [{ ...channels[0]!, channel: "other", destination: `https://example.org/${"x".repeat(2048)}` }]],
  ])("rejects %s before persistence", async (_name, invalid) => {
    const state = fixture();
    const result = await state.service.updateContactChannels(command({ contactChannels: invalid as never }));

    expect(result).toEqual(err({ kind: "validation", code: "INVALID_CONTACT_CHANNELS" }));
    expect(state.stored.version).toBe(1);
    expect(state.operations.executions).toBe(0);
    expect(state.operations.events).toHaveLength(0);
  });

  it("replays the original receipt after advancing the version and rejects changed requests", async () => {
    const state = fixture();
    const first = await state.service.updateContactChannels(command());
    const retry = await state.service.updateContactChannels(command({
      actor: { kind: "owner", ownerId, sessionId: "refreshed-session" },
    }));
    const changedOrder = await state.service.updateContactChannels(command({
      contactChannels: [...channels].reverse(),
    }));
    const changedVersion = await state.service.updateContactChannels(command({ expectedVersion: 2 }));

    expect(retry).toEqual(first);
    expect(changedOrder).toEqual(err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" }));
    expect(changedVersion).toEqual(err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" }));
    expect(state.stored.version).toBe(2);
    expect(state.operations.events).toHaveLength(1);
  });

  it("authorizes before ledger replay and rejects a fresh stale version", async () => {
    const state = fixture();
    const first = await state.service.updateContactChannels(command());
    const denied = await state.service.updateContactChannels(command({ actor: { kind: "visitor", consent: "unknown" } }));
    const stale = await state.service.updateContactChannels(command({ idempotencyKey: "channels-key-two" as IdempotencyKey }));

    expect(first.ok).toBe(true);
    expect(denied).toEqual(err({ kind: "forbidden", code: "OWNER_REQUIRED" }));
    expect(stale).toEqual(err({ kind: "precondition_failed", code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH", currentVersion: 2 }));
    expect(state.operations.executions).toBe(2);
    expect(state.operations.events).toHaveLength(1);
  });
});
