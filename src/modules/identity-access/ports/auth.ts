import type { StableId, Result, Rejection } from "@shared/domain";
import type { OwnerIdentity, PseudonymousToken } from "../domain/index.js";

export interface AuthProviderPort {
  verifyOwnerSession(
    token: string,
  ): Promise<Result<OwnerIdentity, Rejection>>;

  getOwnerAllowlist(): Promise<Result<readonly string[], Rejection>>;
}

export interface CryptoPort {
  issuePseudonymousToken(
    subject: string,
    purpose: "visitor_functional" | "visitor_measurement",
    ttlSeconds: number,
  ): Promise<Result<PseudonymousToken, Rejection>>;

  verifyPseudonymousToken(
    tokenString: string,
  ): Promise<Result<{ subject: string; purpose: string }, Rejection>>;
}
