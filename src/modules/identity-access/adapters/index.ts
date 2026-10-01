import type { Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type {
  AuthProviderPort,
  CryptoPort,
  VerifyOwnerSessionInput,
  IssuePseudonymousTokenInput,
  VerifyPseudonymousTokenInput,
  VerifiedPseudonymousToken,
} from "../ports/index.js";
import type { OwnerIdentity, PseudonymousToken } from "../domain/index.js";

/**
 * Stub adapters reconciled with Spec #77 contracts (#79).
 * Supabase Auth verification for Owner sessions is implemented in
 * `./supabase-auth.js` (#80); unrelated crypto behavior remains deferred and
 * fail closed with safe codes.
 */
export { SupabaseOwnerSessionAdapter } from "./supabase-auth.js";
export type { OwnerSessionAdapterDeps, TrustedProviderIdentity } from "./supabase-auth.js";
export { createOwnerAuthConfig } from "./auth-config.js";
export type { OwnerAuthConfig, OwnerAuthConfigEnv } from "./auth-config.js";
export { OwnerAuthConfigError } from "./auth-config.js";

export class StubAuthProvider implements AuthProviderPort {
  async verifyOwnerSession(
    _input: VerifyOwnerSessionInput,
  ): Promise<Result<OwnerIdentity, Rejection>> {
    return err({ kind: "unauthenticated", code: "SESSION_NOT_FOUND" });
  }

  async getOwnerAllowlist(): Promise<Result<readonly string[], Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "AUTH_PROVIDER_UNAVAILABLE" });
  }
}

export class StubCryptoAdapter implements CryptoPort {
  async issuePseudonymousToken(
    _input: IssuePseudonymousTokenInput,
  ): Promise<Result<PseudonymousToken, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "CRYPTO_NOT_IMPLEMENTED" });
  }

  async verifyPseudonymousToken(
    _input: VerifyPseudonymousTokenInput,
  ): Promise<Result<VerifiedPseudonymousToken, Rejection>> {
    return err({ kind: "unauthenticated", code: "INVALID_TOKEN" });
  }
}
