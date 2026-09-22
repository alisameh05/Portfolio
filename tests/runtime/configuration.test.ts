/**
 * configuration.test.ts — Phase 2 #25
 *
 * Focused configuration tests for the validated backend runtime.
 *
 * Acceptance (issue #25):
 * - Active configuration is parsed once when runtime composition initializes,
 *   not on module import; consumers never read the ambient environment directly.
 * - NODE_ENV accepts only development, test, or production.
 * - APP_BASE_URL accepts an absolute HTTP/HTTPS URL and requires HTTPS in
 *   production except for an explicit loopback test context.
 * - Missing, empty, malformed, unknown active-runtime, or
 *   environment-inappropriate values prevent bootstrap; diagnostics name the
 *   variable and violated rule without exposing its value.
 * - Future environment variables remain documented placeholders with no
 *   fabricated credentials and are neither read nor required in Phase 2.
 * - Tests run without production credentials, a database, provider access,
 *   a deployed service, or public-network access.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeEach } from "vitest";

import {
  createRuntimeConfig,
  type RuntimeConfigEnv,
} from "../../src/bootstrap/configuration.js";
import {
  getRuntimeConfig,
  initializeRuntime,
  isRuntimeInitialized,
  resetRuntimeForTests,
} from "../../src/bootstrap/composition-root.js";

const ROOT = process.cwd();

function envWith(overrides: RuntimeConfigEnv): RuntimeConfigEnv {
  return { ...overrides };
}

describe("runtime configuration (#25)", () => {
  beforeEach(() => {
    resetRuntimeForTests();
  });

  it("does not validate on module import (empty ambient env is safe until init)", async () => {
    // Importing must never throw, even when the ambient env has no valid config.
    // Validation runs only when the composition root initializes.
    await expect(import("../../src/bootstrap/configuration.js")).resolves.toBeDefined();
    await expect(
      import("../../src/bootstrap/composition-root.js"),
    ).resolves.toBeDefined();
    expect(isRuntimeInitialized()).toBe(false);
  });

  it("parses once on composition init and returns an immutable value", () => {
    const config = initializeRuntime(
      envWith({ NODE_ENV: "test", APP_BASE_URL: "http://localhost:3000" }),
    );
    expect(config.nodeEnv).toBe("test");
    expect(config.appBaseUrl).toBe("http://localhost:3000");
    expect(Object.isFrozen(config)).toBe(true);
    // Same reference on subsequent reads: parsed once, not re-read.
    expect(getRuntimeConfig()).toBe(config);
  });

  it("requires initialization before consumers can read configuration", () => {
    expect(() => getRuntimeConfig()).toThrow(/not initialized/i);
  });

  it.each([
    ["missing NODE_ENV", {}, "NODE_ENV"],
    ["empty NODE_ENV", { NODE_ENV: "", APP_BASE_URL: "http://localhost:3000" }, "NODE_ENV"],
    ["unknown NODE_ENV", { NODE_ENV: "staging", APP_BASE_URL: "http://localhost:3000" }, "NODE_ENV"],
    ["missing APP_BASE_URL", { NODE_ENV: "test" }, "APP_BASE_URL"],
    ["empty APP_BASE_URL", { NODE_ENV: "test", APP_BASE_URL: "" }, "APP_BASE_URL"],
    ["relative APP_BASE_URL", { NODE_ENV: "test", APP_BASE_URL: "/relative/path" }, "APP_BASE_URL"],
    ["non-http scheme", { NODE_ENV: "test", APP_BASE_URL: "ftp://example.com" }, "APP_BASE_URL"],
    ["malformed URL", { NODE_ENV: "test", APP_BASE_URL: "http://[::1" }, "APP_BASE_URL"],
    [
      "production HTTP to non-loopback",
      { NODE_ENV: "production", APP_BASE_URL: "http://example.com" },
      "APP_BASE_URL",
    ],
  ])("prevents bootstrap on %s", (_label, env, variable) => {
    expect(() => initializeRuntime(envWith(env))).toThrowError();
    try {
      initializeRuntime(envWith(env));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Diagnostics name the variable and the violated rule ...
      expect(message).toContain(variable);
      expect(message).toMatch(/required|must|invalid|unknown|https/i);
      return;
    }
    expect.unreachable("bootstrap must throw");
  });

  it("never exposes the configured value in diagnostics", () => {
    const secretLike = "http://example.com/s3cr3t-value-abc123";
    try {
      initializeRuntime(envWith({ NODE_ENV: "test", APP_BASE_URL: secretLike }));
    } catch {
      // This value is valid in test; force a failure path instead.
    }
    try {
      initializeRuntime(envWith({ NODE_ENV: "production", APP_BASE_URL: secretLike }));
      expect.unreachable("production HTTP must fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("s3cr3t-value-abc123");
      expect(message).toContain("APP_BASE_URL");
    }

    try {
      initializeRuntime(
        envWith({ NODE_ENV: "staging-marker-xyz", APP_BASE_URL: "http://localhost:3000" }),
      );
      expect.unreachable("unknown NODE_ENV must fail");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("staging-marker-xyz");
      expect(message).toContain("NODE_ENV");
    }
  });

  it("accepts HTTPS in production and HTTP loopback as the explicit test context", () => {
    expect(
      createRuntimeConfig(
        envWith({ NODE_ENV: "production", APP_BASE_URL: "https://example.com" }),
      ).appBaseUrl,
    ).toBe("https://example.com");
    expect(
      createRuntimeConfig(
        envWith({ NODE_ENV: "production", APP_BASE_URL: "http://localhost:3000" }),
      ).appBaseUrl,
    ).toBe("http://localhost:3000");
    expect(
      createRuntimeConfig(
        envWith({ NODE_ENV: "production", APP_BASE_URL: "http://127.0.0.1:3000" }),
      ).appBaseUrl,
    ).toBe("http://127.0.0.1:3000");
  });

  it("ignores future environment placeholders without requiring them", () => {
    // Phase 2 requires only NODE_ENV + APP_BASE_URL. Documented future
    // placeholders must neither be read nor required.
    const config = initializeRuntime(
      envWith({ NODE_ENV: "test", APP_BASE_URL: "http://localhost:3000" }),
    );
    expect(config.nodeEnv).toBe("test");

    const withFuturePlaceholders = initializeRuntime(
      envWith({
        NODE_ENV: "test",
        APP_BASE_URL: "http://localhost:3000",
        DATABASE_URL: "",
        SUPABASE_URL: "",
      }),
      );
    expect(withFuturePlaceholders.appBaseUrl).toBe("http://localhost:3000");
  });

  it("documents future variables as placeholders with no fabricated credentials", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    for (const name of ["DATABASE_URL", "SUPABASE_URL", "SUPABASE_ANON_KEY"]) {
      expect(example).toContain(name);
    }
    // No fabricated secrets: placeholder file must not contain credential-like material.
    expect(example).not.toMatch(/sk-live|ghp_[A-Za-z0-9]+|postgres:\/\/[^:\s]+:[^@\s]+@/);
  });

  it("never reads the ambient environment directly outside bootstrap", () => {
    // Consumers receive config through the composition root. Only the
    // composition root may forward the ambient environment exactly once.
    // Match real reads (`process.env[`, `process.env.`, `process.env as`)
    // rather than prose mentions in comments.
    const envRead = /process\s*\.\s*env\s*(?:\[|\.|as\b)/;
    for (const file of [
      "src/bootstrap/configuration.ts",
      "src/app/livez/route.ts",
    ]) {
      const content = readFileSync(join(ROOT, file), "utf8");
      expect(content, `${file} must not read process.env`).not.toMatch(envRead);
    }
    const root = readFileSync(join(ROOT, "src/bootstrap/composition-root.ts"), "utf8");
    // Composition root may forward the ambient environment exactly once via
    // the default init seam; it must not scatter direct reads.
    const directReads = root.match(/process\s*\.\s*env\s*(?:\[|\.|as\b)/g) ?? [];
    expect(directReads.length).toBeLessThanOrEqual(1);
  });
});
