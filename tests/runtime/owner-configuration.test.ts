/**
 * owner-configuration.test.ts — Phase 2 #29
 *
 * Seam under test (pre-agreed): the Owner Configuration HTTP adapter observed
 * through standard Request and Response objects with an injected application
 * fake.
 *
 * Acceptance (issue #29, configuration slice):
 * - Exactly one handwritten adapter covers profile, Contact channels, and
 *   Global project CTA updates; each validates Idempotency-Key, If-Match,
 *   and body with generated strict validators before dispatch.
 * - Each handler constructs one operation-specific command and invokes one
 *   injected application interface exactly once.
 * - Deterministic fakes exercise contract-valid successes and every declared
 *   rejection without real identity, authorization, persistence, or domain
 *   behavior; structurally invalid input is 400 before dispatch while typed
 *   business validation is 422 via the shared rejection mapper.
 * - Owner unauthenticated and forbidden are exercised through fakes; no
 *   Supabase session, cookie, or allowlist implementation exists.
 * - Production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED.
 */

import { describe, expect, it } from "vitest";

import { zProblem } from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import {
  zUpdateOwnerContactChannelsResponse,
  zUpdateOwnerGlobalProjectCtaResponse,
  zUpdateOwnerProfileConfigurationResponse,
} from "../../src/contracts/http/owner/v1/generated/zod.gen.js";
import { createTestLogger } from "../../src/runtime/ports.js";
import {
  createOwnerConfigurationTestFake,
  createProductionOwnerConfigurationService,
} from "../../src/runtime/fakes/owner-configuration.js";
import {
  handleUpdateOwnerContactChannels,
  handleUpdateOwnerGlobalProjectCta,
  handleUpdateOwnerProfileConfiguration,
} from "../../src/runtime/http/owner-configuration.js";
import {
  ownerTestSecurity,
  withOwnerTestAuth,
} from "./owner-test-auth.js";

const IDEMPOTENCY_KEY = "test-key-123";
const IF_MATCH = '"3"';
const CONFIG_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1";

const PROFILE_BODY = {
  displayName: "Ali Sameh",
  headline: "AI and ML product engineer",
  bio: "I build evidence-led AI products.",
};

const CHANNELS_BODY = {
  channels: [
    {
      channel: "linkedin",
      label: "LinkedIn",
      destination: "https://www.linkedin.com/in/example",
      availableLocales: ["en"],
    },
  ],
};

const CTA_BODY = {
  label: "Discuss this project",
  destination: "https://example.com/contact",
  unavailableFallback: "Use another Contact channel.",
};

function putRequest(
  path: string,
  options?: {
    idempotencyKey?: string | null;
    ifMatch?: string | null;
    body?: unknown;
    rawBody?: string;
    inboundTrace?: string;
  },
): Request {
  const headers: Record<string, string> = withOwnerTestAuth({
    "content-type": "application/json",
  });
  if (options?.idempotencyKey !== null) {
    headers["Idempotency-Key"] = options?.idempotencyKey ?? IDEMPOTENCY_KEY;
  }
  if (options?.ifMatch !== null) {
    headers["If-Match"] = options?.ifMatch ?? IF_MATCH;
  }
  if (options?.inboundTrace !== undefined) {
    headers["x-request-id"] = options.inboundTrace;
  }
  const init: RequestInit = { method: "PUT", headers };
  if (options?.rawBody !== undefined) {
    init.body = options.rawBody;
  } else {
    init.body = JSON.stringify(options?.body ?? PROFILE_BODY);
  }
  return new Request(`https://example.com${path}`, init);
}

const PROFILE_PATH = "/api/owner/v1/configuration/profile";
const CHANNELS_PATH = "/api/owner/v1/configuration/contact-channels";
const CTA_PATH = "/api/owner/v1/configuration/project-cta";

describe("Owner Configuration adapter (#29)", () => {
  it("updates the Owner profile once and returns the declared receipt", async () => {
    const fake = createOwnerConfigurationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleUpdateOwnerProfileConfiguration(
      putRequest(PROFILE_PATH, { body: PROFILE_BODY }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.updateOwnerProfile).toHaveLength(1);
    expect(fake.calls.updateOwnerContactChannels).toHaveLength(0);
    expect(fake.calls.updateOwnerGlobalProjectCta).toHaveLength(0);
    const command = fake.calls.updateOwnerProfile[0] as {
      expectedVersion: number;
      idempotencyKey: string;
      displayName: string;
    };
    expect(command.expectedVersion).toBe(3);
    expect(command.idempotencyKey).toBe(IDEMPOTENCY_KEY);
    expect(command.displayName).toBe("Ali Sameh");
    const body = (await response.json()) as unknown;
    expect(zUpdateOwnerProfileConfigurationResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: CONFIG_ID,
      aggregateVersion: 4,
      outcome: "configuration-updated",
    });
  });

  it("replaces Contact channels once and returns the declared receipt", async () => {
    const fake = createOwnerConfigurationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleUpdateOwnerContactChannels(
      putRequest(CHANNELS_PATH, { body: CHANNELS_BODY }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.updateOwnerContactChannels).toHaveLength(1);
    const body = (await response.json()) as unknown;
    expect(zUpdateOwnerContactChannelsResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      aggregateId: CONFIG_ID,
      aggregateVersion: 4,
      outcome: "configuration-updated",
    });
  });

  it("updates the Global project CTA once and returns the declared receipt", async () => {
    const fake = createOwnerConfigurationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleUpdateOwnerGlobalProjectCta(
      putRequest(CTA_PATH, { body: CTA_BODY }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(200);
    expect(fake.calls.updateOwnerGlobalProjectCta).toHaveLength(1);
    const command = fake.calls.updateOwnerGlobalProjectCta[0] as { label: string };
    expect(command.label).toBe("Discuss this project");
    const body = (await response.json()) as unknown;
    expect(zUpdateOwnerGlobalProjectCtaResponse.safeParse(body).success).toBe(true);
  });

  it.each([
    ["malformed JSON", { rawBody: "{not-json" }],
    ["missing Idempotency-Key", { idempotencyKey: null }],
    ["missing If-Match", { ifMatch: null }],
    ["invalid If-Match", { ifMatch: '"0"' }],
    ["absent body fields", { body: {} }],
    ["empty displayName", { body: { ...PROFILE_BODY, displayName: "" } }],
    ["out-of-shape body", { body: [] }],
    ["unknown closed-shape property", { body: { ...PROFILE_BODY, extra: "nope" } }],
  ])("rejects profile %s as 400 before dispatch", async (_label, options) => {
    const fake = createOwnerConfigurationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleUpdateOwnerProfileConfiguration(
      putRequest(PROFILE_PATH, options),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.updateOwnerProfile).toHaveLength(0);
    const body = (await response.json()) as Record<string, unknown>;
    expect(zProblem.safeParse(body).success).toBe(true);
    expect(body["code"]).toBe("validation");
  });

  it.each([
    ["missing Idempotency-Key", { idempotencyKey: null, body: CHANNELS_BODY }],
    ["missing If-Match", { ifMatch: null, body: CHANNELS_BODY }],
    ["invalid channel enum", { body: { channels: [{ ...CHANNELS_BODY.channels[0], channel: "fax" }] } }],
    ["unknown closed-shape property", { body: { channels: [], extra: "nope" } }],
  ])("rejects contact-channels %s as 400 before dispatch", async (_label, options) => {
    const fake = createOwnerConfigurationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleUpdateOwnerContactChannels(
      putRequest(CHANNELS_PATH, options),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.updateOwnerContactChannels).toHaveLength(0);
  });

  it.each([
    ["missing If-Match", { ifMatch: null, body: CTA_BODY }],
    ["invalid destination", { body: { ...CTA_BODY, destination: "not-a-url" } }],
  ])("rejects project-cta %s as 400 before dispatch", async (_label, options) => {
    const fake = createOwnerConfigurationTestFake({ type: "success" });
    const logger = createTestLogger();
    const response = await handleUpdateOwnerGlobalProjectCta(
      putRequest(CTA_PATH, options),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(400);
    expect(fake.calls.updateOwnerGlobalProjectCta).toHaveLength(0);
  });

  it.each([
    ["unauthenticated", { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" }, 401, "unauthenticated"],
    ["forbidden", { kind: "forbidden", code: "OWNER_FORBIDDEN" }, 403, "forbidden"],
    ["not_found", { kind: "not_found", code: "CONFIG_NOT_FOUND" }, 404, "not_found"],
    ["conflict", { kind: "conflict", code: "IDEMPOTENCY_CONFLICT" }, 409, "conflict"],
    ["precondition_failed", { kind: "precondition_failed", code: "VERSION_MISMATCH" }, 412, "failed_precondition"],
    ["validation", { kind: "validation", code: "PROFILE_REJECTED" }, 422, "unprocessable"],
    [
      "rate_limited",
      { kind: "rate_limited", code: "RATE_LIMIT_EXCEEDED", retryAfterSeconds: 30 },
      429,
      "rate_limited",
    ],
    [
      "temporarily_unavailable",
      { kind: "temporarily_unavailable", code: "DEPENDENCY_DOWN" },
      503,
      "temporarily_unavailable",
    ],
  ] as const)(
    "translates profile %s rejection to %i",
    async (_label, rejection, status, problemCode) => {
      const fake = createOwnerConfigurationTestFake({ type: "rejection", rejection });
      const logger = createTestLogger();
      const response = await handleUpdateOwnerProfileConfiguration(
        putRequest(PROFILE_PATH, { body: PROFILE_BODY }),
        { service: fake, security: ownerTestSecurity(), logger },
      );
      expect(response.status).toBe(status);
      expect(fake.calls.updateOwnerProfile).toHaveLength(1);
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe(problemCode);
      if (status === 429) {
        expect(response.headers.get("retry-after")).toBe("30");
      }
    },
  );

  it("translates contact-channels forbidden and unauthenticated without provider auth", async () => {
    for (const rejection of [
      { kind: "unauthenticated", code: "OWNER_UNAUTHENTICATED" },
      { kind: "forbidden", code: "OWNER_FORBIDDEN" },
    ] as const) {
      const fake = createOwnerConfigurationTestFake({ type: "rejection", rejection });
      const response = await handleUpdateOwnerContactChannels(
        putRequest(CHANNELS_PATH, { body: CHANNELS_BODY }),
        { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
      );
      expect(response.status).toBe(rejection.kind === "unauthenticated" ? 401 : 403);
      expect(fake.calls.updateOwnerContactChannels).toHaveLength(1);
    }
  });

  it("translates project-cta validation to 422", async () => {
    const fake = createOwnerConfigurationTestFake({
      type: "rejection",
      rejection: { kind: "validation", code: "CTA_REJECTED" },
    });
    const response = await handleUpdateOwnerGlobalProjectCta(
      putRequest(CTA_PATH, { body: CTA_BODY }),
      { service: fake, security: ownerTestSecurity(), logger: createTestLogger() },
    );
    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("unprocessable");
  });

  it("fails safely when fake output is contract-invalid", async () => {
    const fake = createOwnerConfigurationTestFake({ type: "invalid-success" });
    const logger = createTestLogger();
    const response = await handleUpdateOwnerProfileConfiguration(
      putRequest(PROFILE_PATH, { body: PROFILE_BODY }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body["code"]).toBe("internal_error");
  });

  it("production composition fails closed with 503 RUNTIME_NOT_IMPLEMENTED for all three operations", async () => {
    const service = createProductionOwnerConfigurationService();
    const logger = createTestLogger();
    const profile = await handleUpdateOwnerProfileConfiguration(
      putRequest(PROFILE_PATH, { body: PROFILE_BODY }),
      { service, security: ownerTestSecurity(), logger },
    );
    expect(profile.status).toBe(503);
    const channels = await handleUpdateOwnerContactChannels(
      putRequest(CHANNELS_PATH, { body: CHANNELS_BODY }),
      { service, security: ownerTestSecurity(), logger },
    );
    expect(channels.status).toBe(503);
    const cta = await handleUpdateOwnerGlobalProjectCta(
      putRequest(CTA_PATH, { body: CTA_BODY }),
      { service, security: ownerTestSecurity(), logger },
    );
    expect(cta.status).toBe(503);
    for (const response of [profile, channels, cta]) {
      const body = (await response.json()) as Record<string, unknown>;
      expect(zProblem.safeParse(body).success).toBe(true);
      expect(body["code"]).toBe("temporarily_unavailable");
    }
    const owner = {
      kind: "owner",
      ownerId: "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0",
      sessionId: "s",
    } as const;
    const directCalls = [
      service.updateOwnerProfile({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 3,
        correlationId: "test-correlation",
        displayName: "Ali Sameh",
        headline: "AI and ML product engineer",
        bio: "I build evidence-led AI products.",
      }),
      service.updateOwnerContactChannels({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 3,
        channels: [],
      }),
      service.updateOwnerGlobalProjectCta({
        actor: owner as never,
        idempotencyKey: IDEMPOTENCY_KEY as never,
        expectedVersion: 3,
        label: "Discuss this project",
        destination: "https://example.com/contact",
        unavailableFallback: "Use another Contact channel.",
      }),
    ];
    for (const direct of await Promise.all(directCalls)) {
      expect(direct.ok).toBe(false);
      if (!direct.ok) {
        expect(direct.error.kind).toBe("temporarily_unavailable");
        expect(direct.error.code).toBe("RUNTIME_NOT_IMPLEMENTED");
      }
    }
  });

  it("uses a server-generated trace identifier shared by Problem Details and logs", async () => {
    const fake = createOwnerConfigurationTestFake({
      type: "rejection",
      rejection: { kind: "not_found", code: "CONFIG_NOT_FOUND" },
    });
    const logger = createTestLogger();
    const first = await handleUpdateOwnerProfileConfiguration(
      putRequest(PROFILE_PATH, { body: PROFILE_BODY, inboundTrace: "inbound-attacker-value" }),
      { service: fake, security: ownerTestSecurity(), logger },
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    expect(firstBody["traceId"]).not.toBe("inbound-attacker-value");
    const logged = (logger.records[0] as { fields: Record<string, unknown> }).fields;
    expect(logged["traceId"]).toBe(firstBody["traceId"]);

    const secondLogger = createTestLogger();
    const second = await handleUpdateOwnerProfileConfiguration(
      putRequest(PROFILE_PATH, { body: PROFILE_BODY }),
      { service: fake, security: ownerTestSecurity(), logger: secondLogger },
    );
    const secondBody = (await second.json()) as Record<string, unknown>;
    expect(secondBody["traceId"]).not.toBe(firstBody["traceId"]);
  });

  it("maps unexpected exceptions to generic 500 without leaking secrets", async () => {
    const logger = createTestLogger();
    const throwing = {
      async updateOwnerProfile(): Promise<never> {
        throw new Error("boom postgres://user:pass@host/db token=tok_123 /app/secret.ts");
      },
      async updateOwnerContactChannels(): Promise<never> {
        throw new Error("unreachable");
      },
      async updateOwnerGlobalProjectCta(): Promise<never> {
        throw new Error("unreachable");
      },
    };
    const response = await handleUpdateOwnerProfileConfiguration(
      putRequest(PROFILE_PATH, { body: PROFILE_BODY }),
      { service: throwing, security: ownerTestSecurity(), logger },
    );
    expect(response.status).toBe(500);
    const serialized = JSON.stringify(await response.json());
    for (const leak of ["postgres://", "tok_123", "/app/secret.ts", "boom"]) {
      expect(serialized).not.toContain(leak);
    }
    expect(JSON.stringify(logger.records)).not.toContain("postgres://");
  });
});
