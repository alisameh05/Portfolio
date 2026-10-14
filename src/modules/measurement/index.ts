/**
 * measurement module public interface.
 *
 * This barrel is the single public import surface for the Measurement module.
 * Other modules must never deep-import internal paths.
 */

export type {
  ConsentState,
  ConsentRecord,
  MeasurementEventType,
  PublicEventData,
  AnalyticsGoalVersion,
  DailyAggregate,
  AnalyticsGoalVersionActivatedEvent,
} from "./domain/index.js";

export type {
  RecordConsentCommand,
  IngestPublicEventCommand,
  ActivateAnalyticsGoalVersionCommand,
  ExpireMeasurementDetailCommand,
  GetAggregateReportQuery,
  MeasurementService,
} from "./application/index.js";

export type {
  MeasurementRepositoryPort,
  ClockPort,
  HashPort,
} from "./ports/index.js";

export type { AnalyticsEventAction, AnalyticsGoalStep, AnalyticsGoalDefinition, GetOwnerAnalyticsGoalQuery, CreateOwnerAnalyticsGoalVersionApplicationCommand, ActivateOwnerAnalyticsGoalVersionApplicationCommand, AnalyticsGoalVersionView, AnalyticsGoalActivationView, AnalyticsGoalAggregateView, AnalyticsGoalVersionReceipt, AnalyticsGoalActivationReceipt, OwnerAnalyticsApplicationService } from "./application/owner-analytics.js";

export type { MeasurementEventContext, PublicMeasurementEvent, EventReceipt } from "./domain/types.js";

export type { VerifiedMeasurementEvidence } from "./application/service.js";

export type { MeasurementWorkCommand, MeasurementWorkService } from "./application/work.js";

export type { SafeAggregateReport } from "./application/service.js";

export type { AggregateReportMetadata, SafeReportDimensions, AggregateReportRow } from "./application/service.js";
