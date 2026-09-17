import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type {
  ConsentState,
  ConsentRecord,
  MeasurementEventType,
  PublicEventData,
  AnalyticsGoalVersion,
  DailyAggregate,
} from "../domain/index.js";

export interface RecordConsentCommand {
  readonly actor: ActorContext;
  readonly visitorId: StableId<"MeasurementVisitor">;
  readonly consent: ConsentState;
}

export interface IngestPublicEventCommand {
  readonly actor: ActorContext;
  readonly eventType: MeasurementEventType;
  readonly routeIdentity: StableId<"PublicRoute">;
  readonly coarseCountry?: string;
  readonly coarseDevice?: "desktop" | "mobile" | "tablet";
}

export interface ActivateAnalyticsGoalVersionCommand {
  readonly actor: ActorContext;
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly name: string;
  readonly targetAction: MeasurementEventType;
}

export interface ExpireMeasurementDetailCommand {
  readonly actor: ActorContext;
  readonly olderThanTimestamp: string;
}

export interface GetAggregateReportQuery {
  readonly actor: ActorContext;
  readonly metricName: string;
  readonly startDate: string;
  readonly endDate: string;
}

export interface MeasurementService {
  recordConsent(
    command: RecordConsentCommand,
  ): Promise<Result<ConsentRecord, Rejection>>;

  ingestEvent(
    command: IngestPublicEventCommand,
  ): Promise<Result<PublicEventData, Rejection>>;

  activateGoalVersion(
    command: ActivateAnalyticsGoalVersionCommand,
  ): Promise<Result<AnalyticsGoalVersion, Rejection>>;

  expireDetail(
    command: ExpireMeasurementDetailCommand,
  ): Promise<Result<{ expiredCount: number }, Rejection>>;

  getAggregateReport(
    query: GetAggregateReportQuery,
  ): Promise<Result<readonly DailyAggregate[], Rejection>>;
}
