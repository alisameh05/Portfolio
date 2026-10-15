import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SealedUploadCapability, UploadCapabilityVaultPort } from "../ports/upload-intent.js";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

function parseKey(value: string | undefined): Buffer | undefined {
  if (value === undefined || !/^[A-Za-z0-9+/]{43}=$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.byteLength === 32 && decoded.toString("base64") === value ? decoded : undefined;
}
/** AES-256-GCM vault. The only persisted value is authenticated ciphertext. */
export function createUploadCapabilityVault(encodedKey: string | undefined): UploadCapabilityVaultPort {
  const key = parseKey(encodedKey);
  return {
    isAvailable(): boolean {
      return key !== undefined;
    },
    seal(plaintext: string, associatedData: string): SealedUploadCapability {
      if (key === undefined) throw new Error("MEDIA_REPLAY_KEY_UNAVAILABLE");
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, nonce);
      cipher.setAAD(Buffer.from(associatedData, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        version: 1,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authenticationTag: cipher.getAuthTag().toString("base64"),
      };
    },
    open(value, associatedData): string {
      if (key === undefined || value.version !== 1) throw new Error("MEDIA_REPLAY_KEY_UNAVAILABLE");
      const nonce = Buffer.from(value.nonce, "base64");
      const ciphertext = Buffer.from(value.ciphertext, "base64");
      const tag = Buffer.from(value.authenticationTag, "base64");
      if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== TAG_BYTES || ciphertext.byteLength < 1 || ciphertext.byteLength > 8192) {
        throw new Error("MEDIA_REPLAY_CIPHERTEXT_INVALID");
      }
      const decipher = createDecipheriv(ALGORITHM, key, nonce);
      decipher.setAAD(Buffer.from(associatedData, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    },
  };
}
