import { err, ok, parseStableId, type Result, type Rejection, type StableId } from "@shared/domain";
import type { ApplicationRequestContext } from "@shared/application";
import { requestTransactionRollback, type Clock, type StableIdGenerator, type TransactionContext, type TransactionRunner } from "../../../runtime/ports.js";
import type { ConsentEvidenceCryptoPort } from "../../identity-access/index.js";
import type { ConsentState } from "../domain/index.js";
/** Constructed only after cryptographic verification and current locked-state agreement. */
export interface VerifiedMeasurementEvidence {
  readonly subject: StableId<"MeasurementVisitor">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly consentId: StableId<"Consent">;
  readonly noticeVersion: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly purpose: "measurement";
}

export interface CurrentConsent {
  readonly consentId: StableId<"Consent">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly subject: StableId<"MeasurementVisitor"> | null;
  readonly state: ConsentState;
  readonly noticeVersion: string;
  readonly revision: number;
  readonly recordedAt: string;
  readonly evidenceExpiresAt: string;
}
/** Trusted in-process choice; never constructed from event JSON or cookie presence. */
export interface RecordConsentChoiceCommand extends ApplicationRequestContext {
  readonly consentId?: StableId<"Consent">;
  readonly expectedRevision: number;
  readonly consent: ConsentState;
  readonly noticeVersion: string;
}
export interface ConsentChoiceReceipt {
  readonly consentId: StableId<"Consent">;
  readonly revision: number;
  readonly state: ConsentState;
  readonly recordedAt: string;
  readonly evidenceExpiresAt: string;
  /** Secret envelope for trusted presentation only; no plaintext subject. */
  readonly evidence?: string;
}
export interface ConsentRepositoryPort {
  lock(portfolioId: StableId<"Portfolio">, consentId: StableId<"Consent">, transaction: TransactionContext): Promise<CurrentConsent | null>;
  save(record: CurrentConsent, transaction: TransactionContext): Promise<void>;
}
export interface VerifyConsentQuery extends ApplicationRequestContext {
  readonly token?: string;
  readonly noticeVersion: string;
}
export interface ConsentApplicationService {
  recordConsent(command: RecordConsentChoiceCommand): Promise<Result<ConsentChoiceReceipt, Rejection>>;
  verifyEvidence(query: VerifyConsentQuery): Promise<Result<VerifiedMeasurementEvidence, Rejection>>;
  /** Intake must use this inside its own transaction, keeping the lock until event commit. */
  checkCurrentConsent(query: VerifyConsentQuery, transaction: TransactionContext): Promise<Result<VerifiedMeasurementEvidence, Rejection>>;
  /** Recheck edge-verified evidence against the current locked row inside the event transaction. */
  checkCurrentEvidence(evidence: VerifiedMeasurementEvidence, transaction: TransactionContext): Promise<Result<VerifiedMeasurementEvidence, Rejection>>;
}
export interface ConsentServiceDependencies {
  readonly transactions: TransactionRunner;
  readonly repository: ConsentRepositoryPort;
  readonly crypto: ConsentEvidenceCryptoPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
  readonly supportedNoticeVersions: readonly string[];
  readonly ttlSeconds: number;
}
const forbidden = () => err<Rejection>({ kind: "forbidden", code: "MEASUREMENT_CONSENT_REQUIRED" });
export function createConsentApplicationService(deps: ConsentServiceDependencies): ConsentApplicationService {
  if (!Number.isSafeInteger(deps.ttlSeconds) || deps.ttlSeconds < 1 || deps.ttlSeconds > 2_592_000 ||
      deps.supportedNoticeVersions.length === 0 || deps.supportedNoticeVersions.some(v => !/^[A-Za-z0-9._-]{1,64}$/.test(v))) throw new Error("INVALID_CONSENT_CONFIGURATION");
  const supported = new Set(deps.supportedNoticeVersions);
  function generate<K extends string>(kind: K): StableId<K> {
    const value = parseStableId(kind, deps.ids.generate(kind));
    if (!value.ok) throw new Error("CONSENT_ID_UNAVAILABLE");
    return value.value;
  }
  async function checkCurrentEvidence(evidence: VerifiedMeasurementEvidence, transaction: TransactionContext): Promise<Result<VerifiedMeasurementEvidence, Rejection>> {
    if (evidence.purpose !== "measurement" || !supported.has(evidence.noticeVersion) || !Number.isSafeInteger(evidence.revision) || evidence.revision < 1 ||
        !parseStableId("Portfolio", evidence.portfolioId).ok || !parseStableId("Consent", evidence.consentId).ok ||
        !parseStableId("MeasurementVisitor", evidence.subject).ok || !Number.isFinite(Date.parse(evidence.issuedAt)) ||
        !Number.isFinite(Date.parse(evidence.expiresAt))) return forbidden();
    const current = await deps.repository.lock(evidence.portfolioId, evidence.consentId, transaction);
    if (!current || current.state !== "granted" || current.revision !== evidence.revision || current.subject !== evidence.subject ||
        current.noticeVersion !== evidence.noticeVersion || current.recordedAt !== evidence.issuedAt || current.evidenceExpiresAt !== evidence.expiresAt ||
        Date.parse(evidence.expiresAt) <= Date.parse(deps.clock.now())) return forbidden();
    return ok(evidence);
  }
  async function checkCurrentConsent(query: VerifyConsentQuery, transaction: TransactionContext): Promise<Result<VerifiedMeasurementEvidence, Rejection>> {
    if (query.scope.kind !== "portfolio" || !query.token || !supported.has(query.noticeVersion)) return forbidden();
    const decoded = await deps.crypto.verify(query.token);
    if (!decoded.ok) return decoded;
    const p = decoded.value;
    if (p.portfolioId !== query.scope.portfolioId || p.noticeVersion !== query.noticeVersion) return forbidden();
    return checkCurrentEvidence({ purpose: "measurement", subject: p.subject, portfolioId: p.portfolioId,
      consentId: p.consentId, noticeVersion: p.noticeVersion, revision: p.revision, issuedAt: p.issuedAt, expiresAt: p.expiresAt }, transaction);
  }
  return {
    checkCurrentConsent,
    checkCurrentEvidence,
    async verifyEvidence(query) {
      try { return await deps.transactions.run(tx => checkCurrentConsent(query, tx)); }
      catch { return err({ kind: "temporarily_unavailable", code: "CONSENT_UNAVAILABLE" }); }
    },
    async recordConsent(command) {
      if (command.scope.kind !== "portfolio" || !supported.has(command.noticeVersion) ||
          !["granted", "denied", "unknown"].includes(command.consent) || !Number.isSafeInteger(command.expectedRevision) ||
          command.expectedRevision < 0 || (command.consentId === undefined && command.expectedRevision !== 0)) {
        return err({ kind: "validation", code: "INVALID_CONSENT_CHOICE" });
      }
      const portfolioId = command.scope.portfolioId;
      try {
        return await deps.transactions.run(async tx => {
          const consentId = command.consentId ?? generate("Consent");
          const existing = await deps.repository.lock(portfolioId, consentId, tx);
          if (command.consentId !== undefined && !existing) return forbidden();
          if ((existing?.revision ?? 0) !== command.expectedRevision) return err({ kind: "precondition_failed", code: "CONSENT_REVISION_CHANGED" });
          const now = deps.clock.now();
          if (!Number.isFinite(Date.parse(now))) throw new Error("CONSENT_CLOCK_UNAVAILABLE");
          const granted = command.consent === "granted";
          const record: CurrentConsent = {
            consentId, portfolioId, state: command.consent, noticeVersion: command.noticeVersion,
            subject: granted ? (existing?.state === "granted" && Date.parse(existing.evidenceExpiresAt) > Date.parse(now)
              ? existing.subject : generate("MeasurementVisitor")) : existing?.subject ?? null,
            revision: (existing?.revision ?? 0) + 1, recordedAt: now,
            evidenceExpiresAt: granted ? new Date(Date.parse(now) + deps.ttlSeconds * 1000).toISOString() : existing?.evidenceExpiresAt ?? now,
          };
          await deps.repository.save(record, tx);
          let evidence: string | undefined;
          if (granted && record.subject) {
            const issued = await deps.crypto.issue({ purpose: "measurement-consent", state: "granted", subject: record.subject,
              consentId, portfolioId, revision: record.revision, noticeVersion: record.noticeVersion, issuedAt: now, expiresAt: record.evidenceExpiresAt });
            if (!issued.ok) return requestTransactionRollback(issued);
            evidence = issued.value;
          }
          return ok({ consentId, revision: record.revision, state: record.state, recordedAt: now,
            evidenceExpiresAt: record.evidenceExpiresAt, ...(evidence === undefined ? {} : { evidence }) });
        });
      } catch { return err({ kind: "temporarily_unavailable", code: "CONSENT_UNAVAILABLE" }); }
    },
  };
}
