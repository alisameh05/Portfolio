import type { OwnerAnalyticsApplicationService } from "./owner-analytics.js";
import type { MeasurementWorkService } from "./work.js";
import type { ApplicationRequestContext } from "@shared/application";
import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type {
  ConsentState,
  ConsentRecord,
  MeasurementEventType,
  PublicMeasurementEvent,
  EventReceipt,
} from "../domain/index.js";

export interface RecordConsentCommand extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly visitorId: StableId<"MeasurementVisitor">;
  readonly consent: ConsentState;
  readonly noticeVersion: string;
  readonly expectedRevision: number;
  readonly idempotencyKey: import("@shared/domain").IdempotencyKey;
}

export interface IngestPublicEventCommand extends ApplicationRequestContext {
  readonly actor: { readonly kind: "visitor"; readonly consent: ConsentState; readonly functionalId?: never };
  readonly idempotencyKey: import("@shared/domain").IdempotencyKey;
  readonly event: PublicMeasurementEvent;
  /** Only verified evidence may populate this; cookie presence cannot. */
  readonly measurement?: VerifiedMeasurementEvidence;
}

export type ActivateAnalyticsGoalVersionCommand = import("./owner-analytics.js").ActivateOwnerAnalyticsGoalVersionApplicationCommand;

export type ExpireMeasurementDetailCommand = import("./work.js").MeasurementWorkCommand;

export interface GetAggregateReportQuery extends ApplicationRequestContext {
  readonly actor: ActorContext;
  readonly action?: MeasurementEventType;
  readonly grouping: "daily-action" | "daily-goal";
  readonly startDate: string;
  readonly endDate: string;
}

export interface MeasurementService extends OwnerAnalyticsApplicationService, MeasurementWorkService {
  recordConsent(
    command: RecordConsentCommand,
  ): Promise<Result<ConsentRecord, Rejection>>;

  ingestEvent(
    command: IngestPublicEventCommand,
  ): Promise<Result<EventReceipt, Rejection>>;

  activateGoalVersion(
    command: ActivateAnalyticsGoalVersionCommand,
  ): Promise<Result<import("./owner-analytics.js").AnalyticsGoalActivationReceipt, Rejection>>;

  expireDetail(
    command: ExpireMeasurementDetailCommand,
  ): Promise<Result<import("@shared/application").BoundedWorkResult, Rejection>>;

  getAggregateReport(
    query: GetAggregateReportQuery,
  ): Promise<Result<SafeAggregateReport, Rejection>>;
}

/** Evidence is constructed only by the verified Identity/consent boundary (#189). */
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

/** Fixed report groupings prevent arbitrary small-cell combinations. No raw subject list. */
export type SafeAggregateReport = {
 readonly state: "no-data" | "low-sample";
 readonly observedSubjects: "zero" | "fewer-than-five";
 readonly asOf: string;
 readonly incomplete: boolean;
 readonly policyVersion: string;
} | {
 readonly state: "available";
 readonly rows: readonly { readonly utcDay: string; readonly action: MeasurementEventType; readonly count: number; readonly sum?: number; readonly goalVersionId?: StableId<"AnalyticsGoalVersion"> }[];
 readonly asOf: string;
 readonly incomplete: boolean;
 readonly policyVersion: string;
 readonly engagementMeaning: "approximate-active-attention";
 readonly journeyMeaning: "context-without-causation";
};
