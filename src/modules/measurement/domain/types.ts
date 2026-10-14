import type { StableId, DomainEvent } from "@shared/domain";

export type ConsentState = "granted" | "denied" | "unknown";

export interface ConsentRecord {
  readonly visitorId: StableId<"MeasurementVisitor">;
  readonly state: ConsentState;
  readonly recordedAt: string;
  readonly consentId: StableId<"Consent">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly noticeVersion: string;
  readonly revision: number;
  readonly evidenceExpiresAt: string;
}

export interface MeasurementEventContext {
  readonly occurredAt: string;
  readonly locale: "en" | "ar";
  readonly consentVersion: string;
  readonly pageRouteIdentity: StableId<"PublicRoute">;
  readonly journeyContext?: readonly StableId<"PublicRoute">[];
  readonly referrerClass?: "direct" | "search" | "social" | "professional" | "referral" | "unknown";
  readonly deviceClass?: "desktop" | "mobile" | "tablet" | "other" | "unknown";
  readonly countryCode?: string;
}
/** Each action retains its own required facts. No functional actions or CV intake. */
type UnionKeys<T> = T extends unknown ? keyof T : never;
type StrictActionUnion<T, All = T> = T extends unknown ? T & { readonly [K in Exclude<UnionKeys<All>, keyof T>]?: never } : never;
export type PublicMeasurementEvent = StrictActionUnion<
  | { readonly action: "page-viewed"; readonly context: MeasurementEventContext }
  | { readonly action: "project-viewed"; readonly context: MeasurementEventContext; readonly projectId: StableId<"Project"> }
  | { readonly action: "active-engagement-sampled"; readonly context: MeasurementEventContext; readonly projectId?: StableId<"Project">; readonly activeMilliseconds: number }
  | { readonly action: "media-engaged"; readonly context: MeasurementEventContext; readonly projectId?: StableId<"Project">; readonly mediaAssetId: StableId<"MediaAsset">; readonly engagement: "opened" | "played" | "paused" | "completed" }
  | { readonly action: "related-project-opened"; readonly context: MeasurementEventContext; readonly sourceProjectId: StableId<"Project">; readonly targetProjectId: StableId<"Project"> }
  | { readonly action: "contact-channel-opened"; readonly context: MeasurementEventContext; readonly projectId?: StableId<"Project">; readonly channel: "linkedin" | "whatsapp" | "instagram" | "phone" }
  | { readonly action: "external-project-link-opened"; readonly context: MeasurementEventContext; readonly projectId: StableId<"Project">; readonly destination: "github-repository" | "live-demo" }
  | { readonly action: "testimonial-engaged"; readonly context: MeasurementEventContext; readonly testimonialId: StableId<"Testimonial">; readonly projectId?: StableId<"Project"> }
  | { readonly action: "global-project-cta-opened"; readonly context: MeasurementEventContext; readonly projectId: StableId<"Project"> }
>;
export type MeasurementEventType = PublicMeasurementEvent["action"];
/** Owned raw detail; never an ordinary intake receipt or report. */
export interface PublicEventData {
  readonly eventId: StableId<"PublicEvent">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly measurementSubject: StableId<"MeasurementVisitor">;
  readonly event: PublicMeasurementEvent;
  readonly acceptedAt: string;
  readonly effectiveAt: string;
}
export interface EventReceipt { readonly eventId: StableId<"PublicEvent">; readonly acceptedAt: string }
/** Definition is immutable at creation; activation is a separate fact. */
export interface AnalyticsGoalVersion {
  readonly goalId: StableId<"AnalyticsGoal">;
  readonly versionId: StableId<"AnalyticsGoalVersion">;
  readonly version: number;
  readonly definition: { readonly name: string; readonly steps: readonly { readonly action: MeasurementEventType; readonly publicRouteIds?: readonly StableId<"PublicRoute">[]; readonly projectIds?: readonly StableId<"Project">[] }[] };
  readonly createdAt: string;
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
