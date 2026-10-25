import type { StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { pendingFeedbackExpiryAt, suppressedFeedbackExpiryAt } from "./retention.js";

export interface FeedbackOwnerExportDecisionSource {
  readonly sequence: number;
  readonly decision: "approved" | "rejected" | "suppressed";
  readonly reason: string | null;
  readonly decidedAt: string;
}

export interface FeedbackOwnerExportSourceRecord {
  readonly feedbackId: StableId<"Feedback">;
  readonly projectId: StableId<"Project">;
  readonly locale: "en" | "ar";
  readonly aggregateVersion: number;
  readonly state: "pending" | "approved" | "rejected" | "suppressed";
  readonly authorName: string | null;
  readonly paragraph: string | null;
  readonly submittedAt: string;
  readonly textErasedAt: string | null;
  readonly decisions: readonly FeedbackOwnerExportDecisionSource[];
}

export interface FeedbackOwnerExportSourceSnapshot {
  readonly capturedAt: string;
  readonly records: readonly FeedbackOwnerExportSourceRecord[];
}

export interface FeedbackOwnerExportValue {
  readonly feedbackId: string;
  readonly projectId: string;
  readonly locale: "en" | "ar";
  readonly aggregateVersion: number;
  readonly state: "pending" | "approved" | "rejected" | "suppressed";
  readonly textDisposition: "retained" | "erased";
  readonly authorName?: string;
  readonly paragraph?: string;
  readonly submittedAt: string;
  readonly decisionHistory: readonly {
    readonly sequence: number;
    readonly decision: "approved" | "rejected" | "suppressed";
    readonly reason?: string;
    readonly decidedAt: string;
  }[];
}

export interface FeedbackOwnerExportSnapshot {
  readonly capturedAt: string;
  readonly records: readonly { readonly feedbackId: string; readonly value: FeedbackOwnerExportValue }[];
  readonly policyExpiresAt?: string;
}

export interface FeedbackOwnerExportRepositoryPort {
  readOwnerExportSnapshot(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
  }, transaction: TransactionContext): Promise<FeedbackOwnerExportSourceSnapshot>;
}

function instant(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error("FEEDBACK_OWNER_EXPORT_INSTANT_INVALID");
  return result;
}

/** Applies retention at capture time, including stale rows the cleanup job has not processed. */
export function projectFeedbackOwnerExportSnapshot(source: FeedbackOwnerExportSourceSnapshot): FeedbackOwnerExportSnapshot {
  const asOf = instant(source.capturedAt);
  const records: { feedbackId: string; value: FeedbackOwnerExportValue }[] = [];
  let policyExpiresAt: string | undefined;
  for (const record of source.records) {
    instant(record.submittedAt);
    const pendingExpiry = record.state === "pending" || record.state === "rejected" ? pendingFeedbackExpiryAt(record.submittedAt) : undefined;
    if (pendingExpiry !== undefined && asOf >= instant(pendingExpiry)) continue;

    const suppression = [...record.decisions].reverse().find((decision) => decision.decision === "suppressed");
    if (record.state === "suppressed" && suppression === undefined) {
      throw new Error("FEEDBACK_OWNER_EXPORT_SUPPRESSION_FACT_MISSING");
    }
    const suppressedTextExpired = record.state === "suppressed" && suppression !== undefined &&
      asOf >= instant(suppressedFeedbackExpiryAt(suppression.decidedAt));
    const retainedText = !suppressedTextExpired && record.textErasedAt === null &&
      record.authorName !== null && record.paragraph !== null;
    const recordExpiry = pendingExpiry ?? (retainedText && record.state === "suppressed" && suppression !== undefined
      ? suppressedFeedbackExpiryAt(suppression.decidedAt) : undefined);
    if (recordExpiry !== undefined && (policyExpiresAt === undefined || instant(recordExpiry) < instant(policyExpiresAt))) policyExpiresAt = recordExpiry;
    if ((record.authorName === null) !== (record.paragraph === null) ||
        record.textErasedAt !== null && (record.authorName !== null || record.paragraph !== null)) {
      throw new Error("FEEDBACK_OWNER_EXPORT_TEXT_ERASURE_INCONSISTENT");
    }
    const decisionHistory = record.decisions.map((decision, index) => {
      if (!Number.isSafeInteger(decision.sequence) || decision.sequence !== index + 1) {
        throw new Error("FEEDBACK_OWNER_EXPORT_DECISION_HISTORY_INVALID");
      }
      return {
        sequence: decision.sequence,
        decision: decision.decision,
        ...(retainedText && decision.reason !== null ? { reason: decision.reason } : {}),
        decidedAt: decision.decidedAt,
      };
    });
    const value: FeedbackOwnerExportValue = {
      feedbackId: record.feedbackId,
      projectId: record.projectId,
      locale: record.locale,
      aggregateVersion: record.aggregateVersion,
      state: record.state,
      textDisposition: retainedText ? "retained" : "erased",
      ...(retainedText ? { authorName: record.authorName!, paragraph: record.paragraph! } : {}),
      submittedAt: record.submittedAt,
      decisionHistory,
    };
    records.push({ feedbackId: record.feedbackId, value });
  }
  records.sort((left, right) => left.feedbackId < right.feedbackId ? -1 : left.feedbackId > right.feedbackId ? 1 : 0);
  return { capturedAt: source.capturedAt, records, ...(policyExpiresAt === undefined ? {} : { policyExpiresAt }) };
}

/** Returns false when retention, deletion, or a source edit changed the portable facts after capture. */
export function matchesFeedbackOwnerExportSnapshot(
  expected: FeedbackOwnerExportSnapshot["records"],
  source: FeedbackOwnerExportSourceSnapshot,
): boolean {
  return JSON.stringify(projectFeedbackOwnerExportSnapshot(source).records) === JSON.stringify(expected);
}

export interface FeedbackOwnerExportSnapshotReaderPort {
  readOwnerExportSnapshot(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly ownerId: StableId<"Owner">;
  }, transaction: TransactionContext): Promise<FeedbackOwnerExportSourceSnapshot>;
}
