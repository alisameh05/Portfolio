import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { Result, Rejection, StableId } from "@shared/domain";
import { err, ok } from "@shared/domain";
import type { PseudonymousPurpose, PseudonymousToken } from "../domain/index.js";
import { isFunctionalIdentityOperation } from "../domain/index.js";
import type {
  CryptoPort,
  IssuePseudonymousTokenInput,
  VerifyPseudonymousTokenInput,
  VerifiedPseudonymousToken,
} from "../ports/index.js";
import type { PseudonymousIdentityConfig, PseudonymousKey, PseudonymousKeyring } from "./pseudonymous-config.js";

const MAX_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;
const TOKEN_VERSION = "p1";

export interface PseudonymousTokenAdapterDeps {
  readonly config: PseudonymousIdentityConfig;
  readonly nowSeconds: () => number;
  /** Injectable for deterministic tests. Production defaults to node:crypto randomBytes. */
  readonly randomBytes?: (size: number) => Uint8Array;
}

interface TokenPayload {
  readonly subject: string;
  readonly purpose: PseudonymousPurpose;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly keyVersion: number;
}

function rejected(kind: Rejection["kind"], code: string): Rejection {
  return { kind, code } as Rejection;
}

function purposeKeyring(
  config: PseudonymousIdentityConfig,
  purpose: PseudonymousPurpose,
): PseudonymousKeyring {
  return purpose === "visitor_functional" ? config.functional : config.measurement;
}

function derivePurposeKey(secret: string, purpose: PseudonymousPurpose): Buffer {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(`shipwithali:pseudonymous-token:${TOKEN_VERSION}:${purpose}`)
    .digest();
}

function tokenAad(purpose: PseudonymousPurpose, version: number): Buffer {
  return Buffer.from(`shipwithali:pseudonymous-token:${TOKEN_VERSION}:${purpose}:key-${version}`);
}

function keyForVersion(
  keyring: PseudonymousKeyring,
  version: number,
): PseudonymousKey | undefined {
  if (keyring.active.version === version) return keyring.active;
  return keyring.previous.find((key) => key.version === version);
}

function uuidV7Subject(nowSeconds: number, random: Uint8Array): string | null {
  if (random.length < 10 || !Number.isFinite(nowSeconds) || nowSeconds < 0) return null;
  const milliseconds = Math.floor(nowSeconds * 1000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 0xffffffffffff) return null;
  const timestamp = milliseconds.toString(16).padStart(12, "0");
  const hex = Buffer.from(random).toString("hex");
  const randA = hex.slice(0, 3);
  const randB = hex.slice(3, 19);
  const variant = (8 | (Number.parseInt(randB[0] ?? "0", 16) & 3)).toString(16);
  const value = `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7${randA}-${variant}${randB.slice(1, 4)}-${randB.slice(4, 16)}`;
  return isUuidV7(value) ? value : null;
}

function isCanonicalBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value;
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function parsePayload(value: unknown): TokenPayload | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload).sort().join(",");
  if (keys !== "expiresAt,issuedAt,keyVersion,purpose,subject") return null;
  if (
    typeof payload["subject"] !== "string" ||
    typeof payload["purpose"] !== "string" ||
    (payload["purpose"] !== "visitor_functional" && payload["purpose"] !== "visitor_measurement") ||
    typeof payload["issuedAt"] !== "number" || !Number.isSafeInteger(payload["issuedAt"]) ||
    typeof payload["expiresAt"] !== "number" || !Number.isSafeInteger(payload["expiresAt"]) ||
    typeof payload["keyVersion"] !== "number" || !Number.isSafeInteger(payload["keyVersion"])
  ) return null;
  return payload as unknown as TokenPayload;
}

function consentAllows(input: { readonly purpose: PseudonymousPurpose; readonly consent: string }): boolean {
  return input.purpose !== "visitor_measurement" || input.consent === "granted";
}

export class AesGcmPseudonymousTokenAdapter implements CryptoPort {
  private readonly deps: PseudonymousTokenAdapterDeps;
  private readonly random: (size: number) => Uint8Array;

  constructor(deps: PseudonymousTokenAdapterDeps) {
    this.deps = deps;
    this.random = deps.randomBytes ?? randomBytes;
  }

  async issuePseudonymousToken(
    input: IssuePseudonymousTokenInput,
  ): Promise<Result<PseudonymousToken, Rejection>> {
    if (
      input.purpose === "visitor_functional" &&
      !isFunctionalIdentityOperation(input.interaction)
    ) {
      return err(rejected("forbidden", "FUNCTIONAL_IDENTITY_NOT_REQUIRED"));
    }
    if (!consentAllows(input)) {
      return err(rejected("forbidden", "MEASUREMENT_CONSENT_REQUIRED"));
    }
    const now = this.deps.nowSeconds();
    if (
      !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 ||
      input.ttlSeconds > MAX_TOKEN_TTL_SECONDS || !Number.isSafeInteger(now) || now < 0
    ) {
      return err(rejected("validation", "INVALID_TOKEN_LIFETIME"));
    }
    try {
      const keyring = purposeKeyring(this.deps.config, input.purpose);
      const subject = uuidV7Subject(now, this.random(10));
      const nonce = this.random(12);
      if (subject === null || nonce.length !== 12) {
        return err(rejected("temporarily_unavailable", "IDENTITY_RANDOMNESS_UNAVAILABLE"));
      }
      const key = derivePurposeKey(keyring.active.secret, input.purpose);
      const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(nonce));
      cipher.setAAD(tokenAad(input.purpose, keyring.active.version));
      const expiresAt = now + input.ttlSeconds;
      const payload: TokenPayload = {
        subject,
        purpose: input.purpose,
        issuedAt: now,
        expiresAt,
        keyVersion: keyring.active.version,
      };
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(payload), "utf8"),
        cipher.final(),
      ]);
      const tokenString = [
        TOKEN_VERSION,
        String(keyring.active.version),
        Buffer.from(nonce).toString("base64url"),
        ciphertext.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
      ].join(".");
      return ok({
        tokenString,
        expiresAt: new Date(expiresAt * 1000).toISOString(),
        purpose: input.purpose,
        keyVersion: keyring.active.version,
      });
    } catch {
      return err(rejected("temporarily_unavailable", "IDENTITY_ISSUANCE_UNAVAILABLE"));
    }
  }

  async verifyPseudonymousToken(
    input: VerifyPseudonymousTokenInput,
  ): Promise<Result<VerifiedPseudonymousToken, Rejection>> {
    if (!consentAllows({ purpose: input.expectedPurpose, consent: input.consent })) {
      return err(rejected("forbidden", "MEASUREMENT_CONSENT_REQUIRED"));
    }
    if (input.tokenString.length > 2048) {
      return err(rejected("unauthenticated", "INVALID_TOKEN"));
    }
    const parts = input.tokenString.split(".");
    if (parts.length !== 5 || parts[0] !== TOKEN_VERSION || !/^\d{1,5}$/.test(parts[1] ?? "")) {
      return err(rejected("unauthenticated", "INVALID_TOKEN"));
    }
    const version = Number(parts[1]);
    const [noncePart, ciphertextPart, tagPart] = parts.slice(2) as [string, string, string];
    if (
      !Number.isInteger(version) || version < 1 || version > 65535 ||
      !isCanonicalBase64Url(noncePart) || !isCanonicalBase64Url(ciphertextPart) ||
      !isCanonicalBase64Url(tagPart)
    ) {
      return err(rejected("unauthenticated", "INVALID_TOKEN"));
    }
    const nonce = Buffer.from(noncePart, "base64url");
    const ciphertext = Buffer.from(ciphertextPart, "base64url");
    const tag = Buffer.from(tagPart, "base64url");
    if (nonce.length !== 12 || ciphertext.length === 0 || tag.length !== 16) {
      return err(rejected("unauthenticated", "INVALID_TOKEN"));
    }
    const keyring = purposeKeyring(this.deps.config, input.expectedPurpose);
    const key = keyForVersion(keyring, version);
    if (key === undefined) {
      return err(rejected("unauthenticated", "UNKNOWN_TOKEN_KEY"));
    }
    let payload: TokenPayload | null = null;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        derivePurposeKey(key.secret, input.expectedPurpose),
        nonce,
      );
      decipher.setAAD(tokenAad(input.expectedPurpose, version));
      decipher.setAuthTag(tag);
      const cleartext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      payload = parsePayload(JSON.parse(cleartext) as unknown);
    } catch {
      return err(rejected("unauthenticated", "INVALID_TOKEN"));
    }
    const now = this.deps.nowSeconds();
    if (
      payload === null || payload.purpose !== input.expectedPurpose ||
      payload.keyVersion !== version ||
      !isUuidV7(payload.subject) ||
      !Number.isSafeInteger(now) || now < 0 ||
      payload.issuedAt > now + CLOCK_SKEW_SECONDS ||
      payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > MAX_TOKEN_TTL_SECONDS
    ) {
      return err(rejected("unauthenticated", "INVALID_TOKEN"));
    }
    const subject = payload.subject as StableId<string>;
    return ok({ subject, purpose: payload.purpose });
  }
}
