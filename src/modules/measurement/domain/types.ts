import type { StableId, DomainEvent } from "@shared/domain";

export type ConsentState = "granted" | "denied" | "unknown";

export interface ConsentRecord {
  readonly visitorId: StableId<"MeasurementVisitor">;
  readonly state: ConsentState;
  readonly recordedAt: string;
}

export type MeasurementEventType =
  | "page_view"
  | "case_study_read"
  | "cta_click"
  | "cv_download"
  | "external_link_click";

export interface PublicEventData {
  readonly eventId: StableId<"PublicEvent">;
  readonly eventType: MeasurementEventType;
  readonly timestamp: string;
  readonly routeIdentity: StableId<"PublicRoute">;
  readonly coarseCountry?: string;
  readonly coarseDevice?: "desktop" | "mobile" | "tablet";
}

export interface AnalyticsGoalVersion {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly version: number;
  readonly name: string;
  readonly targetAction: MeasurementEventType;
  readonly activatedAt: string;
}

export interface DailyAggregate {
  readonly date: string;
  readonly metricName: string;
  readonly dimensionKey: string;
  readonly count: number;
  readonly isLowSample: boolean;
}

// Domain events
export type AnalyticsGoalVersionActivatedEvent = DomainEvent<
  "measurement.goal_version_activated.v1",
  {
    readonly goalId: StableId<"AnalyticsGoal">;
    readonly version: number;
  }
>;
