import type { OwnerAnalyticsApplicationService } from "./owner-analytics.js";
import type { MeasurementWorkService } from "./work.js";
import type { ConsentApplicationService, VerifiedMeasurementEvidence } from "./consent.js";
export type { VerifiedMeasurementEvidence } from "./consent.js";
import type { ApplicationRequestContext } from "@shared/application";
import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type {
  ConsentState,
  MeasurementEventType,
  PublicMeasurementEvent,
  EventReceipt,
} from "../domain/index.js";

export type RecordConsentCommand = import("./consent.js").RecordConsentChoiceCommand;

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

export interface MeasurementService extends OwnerAnalyticsApplicationService, MeasurementWorkService, ConsentApplicationService {

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


/** Reports expose fixed eligible cohorts, stable historical definitions, and no identity lists. */
export interface AggregateReportMetadata {
 readonly utcPeriod: { readonly startDay: string; readonly endDay: string };
 readonly asOf: string;
 readonly incomplete: boolean;
 readonly policyVersion: string;
 readonly grouping: "daily-action" | "daily-goal";
}
export interface SafeReportDimensions {
 readonly locale?: "en" | "ar";
 readonly countryCode?: string;
 readonly deviceClass?: "desktop" | "mobile" | "tablet" | "other" | "unknown";
 readonly referrerClass?: "direct" | "search" | "social" | "professional" | "referral" | "unknown";
 readonly projectId?: StableId<"Project">;
 readonly publicRouteId?: StableId<"PublicRoute">;
}
export type AggregateReportRow = {
 readonly utcDay: string;
 readonly count: number;
 readonly sum?: number;
 readonly dimensions: SafeReportDimensions;
} & (
 | { readonly metric: "action"; readonly action: MeasurementEventType; readonly goalId?: never; readonly goalVersionId?: never; readonly definitionSnapshot?: never }
 | { readonly metric: "goal"; readonly goalId: StableId<"AnalyticsGoal">; readonly goalVersionId: StableId<"AnalyticsGoalVersion">; readonly definitionSnapshot: import("./owner-analytics.js").AnalyticsGoalDefinition; readonly action?: never }
);
export type SafeAggregateReport = AggregateReportMetadata & (
 { readonly state: "no-data"; readonly observedSubjects: "zero"; readonly rows?: never } |
 { readonly state: "low-sample"; readonly observedSubjects: "fewer-than-five"; readonly rows?: never } |
 { readonly state: "available"; readonly rows: readonly AggregateReportRow[]; readonly engagementMeaning: "approximate-active-attention"; readonly journeyMeaning: "context-without-causation" }
);
