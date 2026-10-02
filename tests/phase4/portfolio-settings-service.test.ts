import { describe, expect, it, vi } from "vitest";
import { err, ok, unsafeStableId, type ActorContext, type Rejection, type Result } from "../../src/shared/domain/index.js";
import type { TransactionContext, TransactionRollback, TransactionRunner } from "../../src/runtime/ports.js";
import type { PortfolioSettings } from "../../src/modules/portfolio-configuration/index.js";
import { createPortfolioSettingsReader } from "../../src/modules/portfolio-configuration/index.js";
import {
  createPortfolioSettingsService,
  type PortfolioSettingsRepository,
} from "../../src/modules/portfolio-configuration/application/settings-service.js";

const portfolioId = unsafeStableId<"Portfolio">("018f4f7d-5000-7000-8000-000000000001");
const ownerId = unsafeStableId<"Owner">("018f4f7d-5000-7000-8000-000000000002");
const otherOwnerId = unsafeStableId<"Owner">("018f4f7d-5000-7000-8000-000000000003");
const context = Object.freeze({ kind: "transaction" }) as TransactionContext;

const initialValues = {
  profile: { displayName: "Ali Sameh", headline: "AI product builder", bio: "Evidence-led work." },
  contactChannels: [
    { channel: "linkedin" as const, label: "LinkedIn", destination: "https://www.linkedin.com/in/ali", availableLocales: ["en", "ar"] as const },
  ],
  globalCta: { label: "Discuss a project", destination: "https://example.com/contact", unavailableFallback: "Contact details are currently unavailable." },
};

function fixture() {
  const transactions: TransactionRunner = {
    async run<T>(
      callback: (context: TransactionContext) => T | TransactionRollback<T> | Promise<T | TransactionRollback<T>>,
    ): Promise<T> {
      return await callback(context) as T;
    },
  };
  const notConfigured = async (): Promise<Result<PortfolioSettings, Rejection>> =>
    err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
  const repository: PortfolioSettingsRepository = {
    getSettings: vi.fn(notConfigured),
    provisionSettings: vi.fn(async (_scope, settings) => ok(settings)),
    updateProfile: vi.fn(async () => err({ kind: "temporarily_unavailable", code: "NOT_IMPLEMENTED" } as const)),
  };
  return {
    repository,
    transactions,
    service: createPortfolioSettingsService({ repository, transactions, scope: { portfolioId, ownerId } }),
  };
}

describe("Portfolio settings application service", () => {
  it("returns committed Owner state and version through the repository", async () => {
    const { repository, service } = fixture();
    const committed: PortfolioSettings = { portfolioId, ...initialValues, version: 1 };
    vi.mocked(repository.getSettings).mockResolvedValue(ok(committed));

    const result = await service.getSettings({
      actor: { kind: "owner", ownerId, sessionId: "opaque-session" },
      portfolioId,
    });

    expect(result).toEqual(ok(committed));
    expect(repository.getSettings).toHaveBeenCalledWith({ portfolioId, ownerId }, context);
  });

  it("exports the Owner settings query without exposing controlled provisioning", async () => {
    const { repository, transactions } = fixture();
    const reader = createPortfolioSettingsReader({
      repository,
      transactions,
      scope: { portfolioId, ownerId },
    });

    expect(reader).not.toHaveProperty("provision");
    expect(reader.getSettings).toBeTypeOf("function");
  });

  const deniedActors: readonly (readonly [string, ActorContext])[] = [
    ["visitor", { kind: "visitor", consent: "unknown" }],
    ["different Owner", { kind: "owner", ownerId: otherOwnerId, sessionId: "opaque-session" }],
  ];
  it.each(deniedActors)("rejects %s without reading settings", async (_name, actor) => {
    const { repository, service } = fixture();
    const result = await service.getSettings({ actor, portfolioId });

    expect(result).toEqual(err({ kind: "forbidden", code: "OWNER_REQUIRED" }));
    expect(repository.getSettings).not.toHaveBeenCalled();
  });

  it("rejects a request for a different Portfolio before reaching persistence", async () => {
    const { repository, service } = fixture();
    const result = await service.getSettings({
      actor: { kind: "owner", ownerId, sessionId: "opaque-session" },
      portfolioId: unsafeStableId<"Portfolio">("018f4f7d-5000-7000-8000-000000000004"),
    });

    expect(result).toEqual(err({ kind: "forbidden", code: "PORTFOLIO_SCOPE_MISMATCH" }));
    expect(repository.getSettings).not.toHaveBeenCalled();
  });

  it("provisions one version-one aggregate from explicit valid values", async () => {
    const { repository, service } = fixture();
    const result = await service.provision(initialValues);

    expect(result).toEqual(ok({ portfolioId, ...initialValues, version: 1 }));
    expect(repository.provisionSettings).toHaveBeenCalledWith(
      { portfolioId, ownerId },
      { portfolioId, ...initialValues, version: 1 },
      context,
    );
  });

  it.each([
    ["empty", []],
    ["maximum", Array.from({ length: 20 }, (_, index) => ({
      channel: "other" as const,
      label: `Destination ${index + 1}`,
      destination: `https://example.com/${index + 1}`,
      availableLocales: ["en"] as const,
    }))],
  ])("accepts an %s ordered channel list", async (_name, contactChannels) => {
    const { repository, service } = fixture();
    const result = await service.provision({ ...initialValues, contactChannels });

    expect(result.ok).toBe(true);
    expect(repository.provisionSettings).toHaveBeenCalledOnce();
  });

  it.each([
    ["blank profile", { ...initialValues, profile: { ...initialValues.profile, displayName: "   " } }],
    ["oversized profile", { ...initialValues, profile: { ...initialValues.profile, bio: "x".repeat(4001) } }],
    ["too many channels", { ...initialValues, contactChannels: Array.from({ length: 21 }, () => initialValues.contactChannels[0]!) }],
    ["duplicate locale", { ...initialValues, contactChannels: [{ ...initialValues.contactChannels[0]!, availableLocales: ["en", "en"] as const }] }],
    ["unsafe channel destination", { ...initialValues, contactChannels: [{ ...initialValues.contactChannels[0]!, destination: "javascript:alert(1)" }] }],
    ["wrong channel host", { ...initialValues, contactChannels: [{ ...initialValues.contactChannels[0]!, destination: "https://linkedin.com.attacker.example/profile" }] }],
    ["credential-bearing destination", { ...initialValues, contactChannels: [{ ...initialValues.contactChannels[0]!, destination: "https://user:password@linkedin.com/profile" }] }],
    ["non-HTTPS CTA", { ...initialValues, globalCta: { ...initialValues.globalCta, destination: "http://example.com/contact" } }],
    ["empty CTA fallback", { ...initialValues, globalCta: { ...initialValues.globalCta, unavailableFallback: "  " } }],
    ["executable CTA fallback", { ...initialValues, globalCta: { ...initialValues.globalCta, unavailableFallback: "<script>alert(1)</script>" } }],
  ])("rejects %s during provisioning before persistence", async (_name, values) => {
    const { repository, service } = fixture();
    const result = await service.provision(values);

    expect(result).toMatchObject({ ok: false, error: { kind: "validation" } });
    expect(repository.provisionSettings).not.toHaveBeenCalled();
  });
});
