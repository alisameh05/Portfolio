import type { StableId, Result, Rejection } from "@shared/domain";

/** Authenticated evidence has its own purpose, separate from both identity envelopes. */
export interface ConsentEvidencePayload {
  readonly purpose: "measurement-consent";
  readonly state: "granted";
  readonly portfolioId: StableId<"Portfolio">;
  readonly consentId: StableId<"Consent">;
  readonly subject: StableId<"MeasurementVisitor">;
  readonly noticeVersion: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
}
export interface ConsentEvidenceCryptoPort {
  issue(payload: ConsentEvidencePayload): Promise<Result<string, Rejection>>;
  verify(token: string): Promise<Result<ConsentEvidencePayload, Rejection>>;
}
