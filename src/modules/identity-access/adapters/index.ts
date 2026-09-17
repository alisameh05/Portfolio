import type { StableId, Result, Rejection } from "@shared/domain";
import { err } from "@shared/domain";
import type { AuthProviderPort, CryptoPort } from "../ports/index.js";
import type { OwnerIdentity, PseudonymousToken } from "../domain/index.js";

/**
 * Stub adapters for Phase 1 skeleton.
 * Supabase Auth and crypto implementations are deferred to later phases.
 */
export class StubAuthProvider implements AuthProviderPort {
  async verifyOwnerSession(
    _token: string,
  ): Promise<Result<OwnerIdentity, Rejection>> {
    return err({ kind: "unauthenticated", code: "SESSION_NOT_FOUND" });
  }

  async getOwnerAllowlist(): Promise<Result<readonly string[], Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "AUTH_PROVIDER_UNAVAILABLE" });
  }
}

export class StubCryptoAdapter implements CryptoPort {
  async issuePseudonymousToken(
    _subject: string,
    _purpose: "visitor_functional" | "visitor_measurement",
    _ttlSeconds: number,
  ): Promise<Result<PseudonymousToken, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "CRYPTO_NOT_IMPLEMENTED" });
  }

  async verifyPseudonymousToken(
    _tokenString: string,
  ): Promise<Result<{ subject: string; purpose: string }, Rejection>> {
    return err({ kind: "unauthenticated", code: "INVALID_TOKEN" });
  }
}
