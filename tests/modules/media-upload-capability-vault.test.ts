import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createUploadCapabilityVault } from "../../src/modules/media/adapters/upload-capability-vault.js";

describe("encrypted Media upload replay capability", () => {
  it("encrypts the bearer target and authenticates its scoped associated data", () => {
    const vault = createUploadCapabilityVault(randomBytes(32).toString("base64"));
    const target = "https://storage.example.test/upload?token=private-bearer-value";
    const encrypted = vault.seal(target, "portfolio:owner:media:intent");
    expect(JSON.stringify(encrypted)).not.toContain("private-bearer-value");
    expect(vault.open(encrypted, "portfolio:owner:media:intent")).toBe(target);
    expect(() => vault.open(encrypted, "portfolio:other-owner:media:intent")).toThrow();
  });

  it("rejects missing or malformed key material without a fallback key", () => {
    for (const value of [undefined, "not-a-key", randomBytes(16).toString("base64")]) {
      const vault = createUploadCapabilityVault(value);
      expect(vault.isAvailable()).toBe(false);
      expect(() => vault.seal("https://storage.example.test/upload?token=opaque", "scope")).toThrow();
    }
  });
});
