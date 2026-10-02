import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function fieldDefined(content: string, field: string): boolean {
  return new RegExp(`readonly\\s+${field}\\s*:`).test(content);
}

describe("Phase 4 #79: Identity and Configuration contract reconciliation", () => {
  it("uses handwritten provider-neutral profile DTOs matching transport", () => {
    const domain = src("src/modules/portfolio-configuration/domain/types.ts");
    expect(fieldDefined(domain, "displayName")).toBe(true);
    expect(fieldDefined(domain, "headline")).toBe(true);
    expect(fieldDefined(domain, "bio")).toBe(true);
    expect(fieldDefined(domain, "ownerName")).toBe(false);
    expect(fieldDefined(domain, "title")).toBe(false);
    expect(fieldDefined(domain, "supportedLocales")).toBe(false);
  });

  it("uses the committed channel enum and ordered locale-aware channel semantics", () => {
    const domain = src("src/modules/portfolio-configuration/domain/types.ts");
    for (const value of ['"linkedin"', '"whatsapp"', '"instagram"', '"phone"', '"email"', '"other"']) {
      expect(domain.includes(value)).toBe(true);
    }
    expect(domain.includes('"github"')).toBe(false);
    expect(domain.includes('"custom"')).toBe(false);
    expect(fieldDefined(domain, "channel")).toBe(true);
    expect(fieldDefined(domain, "availableLocales")).toBe(true);
    expect(fieldDefined(domain, "isPublic")).toBe(false);
    expect(domain).toMatch(/order/i);
  });

  it("keeps CTA label, destination, and unavailableFallback as text", () => {
    const domain = src("src/modules/portfolio-configuration/domain/types.ts");
    expect(fieldDefined(domain, "unavailableFallback")).toBe(true);
    expect(fieldDefined(domain, "fallbackDestination")).toBe(false);
    expect(fieldDefined(domain, "isEnabled")).toBe(false);
    expect(fieldDefined(domain, "fallbackUrl")).toBe(false);
  });

  it("matches transport schemas without losing contracted data", () => {
    const transport = src("openapi/owner-v1/components/configuration.yaml");
    const domain = src("src/modules/portfolio-configuration/domain/types.ts");
    for (const token of ["displayName", "headline", "bio", "availableLocales", "unavailableFallback"]) {
      expect(transport.includes(token)).toBe(true);
      expect(domain.includes(token)).toBe(true);
    }
    expect(transport).toMatch(/linkedin,\s*whatsapp,\s*instagram,\s*phone,\s*email,\s*other/);
  });

  it("carries expected version, idempotency, and safe correlation on commands", () => {
    const app = src("src/modules/portfolio-configuration/application/service.ts");
    for (const cmd of ["UpdatePortfolioProfileCommand", "UpdateContactChannelsCommand", "UpdateGlobalProjectCtaCommand"]) {
      expect(app.includes(cmd)).toBe(true);
    }
    expect(app.includes("expectedVersion")).toBe(true);
    expect(app.includes("idempotencyKey")).toBe(true);
    expect(app.includes("correlationId")).toBe(true);
    expect(app.includes("portfolioId")).toBe(true);
  });

  it("exposes Owner settings and narrow locale-aware public views, no generic patch", () => {
    const app = src("src/modules/portfolio-configuration/application/service.ts");
    const domain = src("src/modules/portfolio-configuration/domain/types.ts");
    expect(app.includes("GetPortfolioSettingsQuery")).toBe(true);
    expect(app.includes("GetPublicConfigurationQuery")).toBe(true);
    expect(domain.includes("PublicPortfolioConfigurationView")).toBe(true);
    expect(domain.includes("OwnerPortfolioSettingsView")).toBe(true);
    expect(app).not.toMatch(/GenericPatch|generic.*patch|PatchPortfolio/i);
  });

  it("accepts explicit provider-neutral transaction context and Portfolio scope", () => {
    const repo = src("src/modules/portfolio-configuration/ports/repository.ts");
    expect(repo.includes("TransactionContext")).toBe(true);
    expect(repo.includes("portfolioId")).toBe(true);
    expect(repo.includes("PortfolioScope")).toBe(true);
  });

  it("removes username/email authority; conveys stable Owner/session, purpose, consent", () => {
    const domain = src("src/modules/identity-access/domain/types.ts");
    expect(fieldDefined(domain, "githubUsername")).toBe(false);
    expect(fieldDefined(domain, "email")).toBe(false);
    expect(domain.includes("githubSubject")).toBe(true);
    expect(domain.includes("ownerId")).toBe(true);
    expect(domain.includes("sessionId")).toBe(true);
    const app = src("src/modules/identity-access/application/service.ts");
    expect(app.includes("expectedPurpose")).toBe(true);
    expect(app.includes("consent")).toBe(true);
    expect(app.includes("VerifiedPseudonymousIdentity")).toBe(true);
  });

  it("keeps functional identity in ActorContext independent of Measurement consent", () => {
    const actor = src("src/shared/domain/actor.ts");
    expect(actor).toMatch(/independent/i);
    expect(actor).not.toMatch(/granted consent and/);
  });

  it("keeps generated, provider, and database types out of domain/application", () => {
    const files = [
      "src/modules/portfolio-configuration/domain/types.ts",
      "src/modules/portfolio-configuration/application/service.ts",
      "src/modules/portfolio-configuration/ports/repository.ts",
      "src/modules/identity-access/domain/types.ts",
      "src/modules/identity-access/application/service.ts",
      "src/modules/identity-access/ports/auth.ts",
      "src/shared/domain/actor.ts",
    ];
    const forbidden = ["@supabase/", "kysely", "from \"pg", "from 'pg", "jsonwebtoken", "next/", "contracts/http", "database.generated", "cookies-next", "NextRequest"];
    for (const file of files) {
      const content = src(file);
      for (const token of forbidden) {
        expect(content.includes(token), `${file} must not contain ${token}`).toBe(false);
      }
    }
  });

  it("remains fail closed with no new HTTP operation", async () => {
    const { execFileSync } = await import("node:child_process");
    execFileSync(process.execPath, ["scripts/check-route-inventory.mjs"], { cwd: ROOT, stdio: "pipe" });
    const report = JSON.parse(readFileSync(join(ROOT, "evidence", "phase-1-route-inventory.json"), "utf8")) as {
      publicOperations: string[];
      ownerOperations: string[];
    };
    expect(report.publicOperations).toHaveLength(5);
    expect(report.ownerOperations).toHaveLength(39);
  });
});
