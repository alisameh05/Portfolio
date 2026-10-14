import { describe, expect, it } from "vitest";
import { AesGcmConsentEvidenceAdapter } from "../../src/modules/identity-access/adapters/consent-evidence.js";
import { parseStableId } from "../../src/shared/domain/index.js";
import { AesGcmPseudonymousTokenAdapter } from "../../src/modules/identity-access/adapters/pseudonymous-token.js";

function id<K extends string>(kind: K, suffix: string) {
  const result = parseStableId(kind, `0196a1b2-7c3d-7e11-9f22-3a4b5c6d${suffix}`);
  if (!result.ok) throw new Error("fixture");
  return result.value;
}
const payload = {
  purpose: "measurement-consent" as const, state: "granted" as const,
  subject: id("MeasurementVisitor", "7e91"), consentId: id("Consent", "7e92"),
  portfolioId: id("Portfolio", "7e93"), noticeVersion: "2026-10",
  revision: 1, issuedAt: "2026-10-14T12:00:00.000Z", expiresAt: "2026-11-13T12:00:00.000Z",
};
const config = {
  functional: { active: { version: 1, secret: Buffer.alloc(32, 11).toString("base64url") }, previous: [] },
  measurement: { active: { version: 1, secret: Buffer.alloc(32, 22).toString("base64url") }, previous: [] },
};
describe("production consent evidence crypto", () => {
  it("authenticates the full consent envelope with independent purpose and bounded lifetime", async () => {
    const crypto = new AesGcmConsentEvidenceAdapter(config, () => payload.issuedAt);
    const issued = await crypto.issue(payload);
    expect(issued.ok).toBe(true);
    if (!issued.ok) throw new Error("issuance");
    expect(await crypto.verify(issued.value)).toEqual({ ok: true, value: payload });
    expect(issued.value).not.toContain(payload.subject);
    expect(await crypto.verify(issued.value + "x")).toMatchObject({ ok: false });
  });
  it("supports previous keys for remaining lifetime and rejects retired keys", async () => {
    const original = new AesGcmConsentEvidenceAdapter(config, () => payload.issuedAt);
    const token = await original.issue(payload); if (!token.ok) throw new Error("issuance");
    const rotated = { ...config, measurement: { active: { version: 2, secret: Buffer.alloc(32, 33).toString("base64url") }, previous: [config.measurement.active] } };
    expect(await new AesGcmConsentEvidenceAdapter(rotated, () => payload.issuedAt).verify(token.value)).toEqual({ ok: true, value: payload });
    expect(await new AesGcmConsentEvidenceAdapter({ ...rotated, measurement: { ...rotated.measurement, previous: [] } }, () => payload.issuedAt).verify(token.value)).toMatchObject({ ok: false });
  });
  it("rejects exactly at expiry and never issues evidence longer than thirty days", async () => {
    const token = await new AesGcmConsentEvidenceAdapter(config, () => payload.issuedAt).issue(payload);
    if (!token.ok) throw new Error("issuance");
    expect((await new AesGcmConsentEvidenceAdapter(config, () => "2026-11-13T11:59:59.999Z").verify(token.value)).ok).toBe(true);
    expect((await new AesGcmConsentEvidenceAdapter(config, () => payload.expiresAt).verify(token.value)).ok).toBe(false);
    expect((await new AesGcmConsentEvidenceAdapter(config, () => "2026-11-13T12:00:00.001Z").verify(token.value)).ok).toBe(false);
    expect((await new AesGcmConsentEvidenceAdapter(config, () => payload.issuedAt).issue({ ...payload, expiresAt: "2026-11-13T12:00:00.001Z" })).ok).toBe(false);
  });
  it("cannot substitute functional or Measurement identity envelopes for consent, or consent for identity", async () => {
    const identity = new AesGcmPseudonymousTokenAdapter({ config, nowSeconds: () => Date.parse(payload.issuedAt) / 1000 });
    const consent = new AesGcmConsentEvidenceAdapter(config, () => payload.issuedAt);
    const functional = await identity.issuePseudonymousToken({ purpose: "visitor_functional", interaction: "reaction", consent: "denied", ttlSeconds: 3600 });
    const measurement = await identity.issuePseudonymousToken({ purpose: "visitor_measurement", consent: "granted", ttlSeconds: 3600 });
    expect(functional.ok).toBe(true); expect(measurement.ok).toBe(true);
    if (!functional.ok || !measurement.ok) throw new Error("identity");
    expect((await consent.verify(functional.value.tokenString)).ok).toBe(false);
    expect((await consent.verify(measurement.value.tokenString)).ok).toBe(false);
    const f = await identity.verifyPseudonymousToken({ tokenString: functional.value.tokenString, expectedPurpose: "visitor_functional", consent: "denied" });
    const m = await identity.verifyPseudonymousToken({ tokenString: measurement.value.tokenString, expectedPurpose: "visitor_measurement", consent: "granted" });
    if (!f.ok || !m.ok) throw new Error("verification");
    expect(f.value.subject).not.toBe(m.value.subject); expect(m.value.subject).not.toBe(payload.subject);
    const evidence = await consent.issue(payload); if (!evidence.ok) throw new Error("issuance");
    expect((await identity.verifyPseudonymousToken({ tokenString: evidence.value, expectedPurpose: "visitor_measurement", consent: "granted" })).ok).toBe(false);
    expect((await identity.verifyPseudonymousToken({ tokenString: measurement.value.tokenString, expectedPurpose: "visitor_functional", consent: "granted" })).ok).toBe(false);
  });
  it("rejects shared key material including previous-key reuse and malformed evidence", async () => {
    expect(() => new AesGcmConsentEvidenceAdapter({ ...config, measurement: config.functional }, () => payload.issuedAt)).toThrow();
    expect(() => new AesGcmConsentEvidenceAdapter({ ...config, measurement: { active: { version: 2, secret: Buffer.alloc(32, 33).toString("base64url") }, previous: [config.functional.active] } }, () => payload.issuedAt)).toThrow();
    const consent = new AesGcmConsentEvidenceAdapter(config, () => payload.issuedAt);
    for (const token of ["", "granted", "c1.65536.A.A.A", "x".repeat(2049)]) expect((await consent.verify(token)).ok).toBe(false);
    expect((await consent.issue({ ...payload, state: "denied" } as never)).ok).toBe(false);
    expect((await consent.issue({ ...payload, purpose: "visitor_functional" } as never)).ok).toBe(false);
  });
});
