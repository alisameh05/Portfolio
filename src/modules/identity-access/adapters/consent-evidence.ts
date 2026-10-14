import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { err, ok, parseStableId, type Result, type Rejection } from "@shared/domain";
import type { ConsentEvidenceCryptoPort, ConsentEvidencePayload } from "../ports/consent.js";
import { createPseudonymousIdentityConfig, type PseudonymousIdentityConfig } from "./pseudonymous-config.js";

export const MAX_CONSENT_EVIDENCE_MS = 30 * 24 * 60 * 60 * 1000;
const forbidden = () => err<Rejection>({ kind: "forbidden", code: "MEASUREMENT_CONSENT_REQUIRED" });
const aad = (version: number) => Buffer.from(`shipwithali:measurement-consent:c1:key-${version}`);
function canonical(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}
function valid(value: unknown, now: string): value is ConsentEvidencePayload {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "consentId,expiresAt,issuedAt,noticeVersion,portfolioId,purpose,revision,state,subject") return false;
  if (p["purpose"] !== "measurement-consent" || p["state"] !== "granted" ||
      typeof p["noticeVersion"] !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(p["noticeVersion"]) ||
      !Number.isSafeInteger(p["revision"]) || Number(p["revision"]) < 1) return false;
  for (const [field, kind] of [["consentId", "Consent"], ["portfolioId", "Portfolio"], ["subject", "MeasurementVisitor"]]) {
    if (typeof p[field!] !== "string" || !parseStableId(kind!, p[field!] as string).ok) return false;
  }
  if (typeof p["issuedAt"] !== "string" || typeof p["expiresAt"] !== "string") return false;
  const issued = Date.parse(p["issuedAt"]), expiry = Date.parse(p["expiresAt"]), clock = Date.parse(now);
  return Number.isFinite(clock) && Number.isFinite(issued) && Number.isFinite(expiry) &&
    new Date(issued).toISOString() === p["issuedAt"] && new Date(expiry).toISOString() === p["expiresAt"] &&
    issued <= clock && expiry > clock && expiry > issued && expiry - issued <= MAX_CONSENT_EVIDENCE_MS;
}

/** AES-GCM authenticates all facts, hides subjects, and reuses the reviewed rotation configuration. */
export class AesGcmConsentEvidenceAdapter implements ConsentEvidenceCryptoPort {
  private readonly config: PseudonymousIdentityConfig;
  constructor(config: PseudonymousIdentityConfig, private readonly now: () => string) {
    // Validate separation even for direct composition callers, then detach from mutable input.
    this.config = createPseudonymousIdentityConfig({
      FUNCTIONAL_ID_HASH_KEY: config.functional.active.secret,
      FUNCTIONAL_ID_HASH_KEY_VERSION: String(config.functional.active.version),
      FUNCTIONAL_ID_HASH_PREVIOUS_KEYS: config.functional.previous.map(k => `${k.version}:${k.secret}`).join(","),
      MEASUREMENT_ID_HASH_KEY: config.measurement.active.secret,
      MEASUREMENT_ID_HASH_KEY_VERSION: String(config.measurement.active.version),
      MEASUREMENT_ID_HASH_PREVIOUS_KEYS: config.measurement.previous.map(k => `${k.version}:${k.secret}`).join(","),
    });
  }
  private key(secret: string): Buffer {
    return createHmac("sha256", Buffer.from(secret, "base64url")).update("shipwithali:measurement-consent:c1").digest();
  }
  async issue(payload: ConsentEvidencePayload): Promise<Result<string, Rejection>> {
    if (!valid(payload, this.now())) return forbidden();
    try {
      const key = this.config.measurement.active, nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key(key.secret), nonce);
      cipher.setAAD(aad(key.version));
      const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
      return ok(["c1", key.version, nonce.toString("base64url"), data.toString("base64url"), cipher.getAuthTag().toString("base64url")].join("."));
    } catch { return err({ kind: "temporarily_unavailable", code: "CONSENT_CRYPTO_UNAVAILABLE" }); }
  }
  async verify(token: string): Promise<Result<ConsentEvidencePayload, Rejection>> {
    if (token.length > 2048) return forbidden();
    const parts = token.split(".");
    if (parts.length !== 5 || parts[0] !== "c1" || !/^[1-9]\d{0,4}$/.test(parts[1] ?? "")) return forbidden();
    const version = Number(parts[1]);
    const key = [this.config.measurement.active, ...this.config.measurement.previous].find(k => k.version === version);
    if (!key || !parts.slice(2).every(canonical)) return forbidden();
    const nonce = Buffer.from(parts[2]!, "base64url"), tag = Buffer.from(parts[4]!, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) return forbidden();
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key(key.secret), nonce);
      decipher.setAAD(aad(version)); decipher.setAuthTag(tag);
      const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(parts[3]!, "base64url")), decipher.final()]).toString("utf8"));
      return valid(value, this.now()) ? ok(value) : forbidden();
    } catch { return forbidden(); }
  }
}
