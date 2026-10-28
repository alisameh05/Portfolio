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
  DailyAggregateDimensions,
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
export { createOwnerAnalyticsGoalService } from "./application/index.js";
export { createGoalConversionWorkService, advanceGoalConversionProgress, emptyGoalConversionProgress } from "./application/index.js";
export { createPostgresGoalConversionRepository } from "./adapters/postgres-goal-conversions.js";
export type { RecomputeGoalConversionsCommand, GoalConversionWorkService, GoalConversionWorkDependencies } from "./application/index.js";
export type { GoalConversionEvent, GoalConversionVersion, GoalConversionTimeline, GoalConversionProgress, GoalConversionProgressEntry, GoalConversionContribution } from "./application/index.js";
export type { GoalConversionCursor, GoalConversionCheckpoint, GoalConversionRepositoryPort } from "./ports/index.js";
export type { AnalyticsGoalScopeFactsPort, OwnerAnalyticsGoalServiceDependencies } from "./application/index.js";
export type { AnalyticsGoalRootRecord, AnalyticsGoalVersionRecord, AnalyticsGoalActivationRecord, OwnerAnalyticsGoalRepositoryPort } from "./ports/index.js";
export { createPostgresOwnerAnalyticsGoalRepository } from "./adapters/postgres-goals.js";
export { createOwnerAnalyticsExportSnapshotService } from "./application/owner-analytics-export.js";
export type { OwnerAnalyticsExportSnapshot, OwnerAnalyticsExportSnapshotReaderPort, OwnerAnalyticsExportServiceDependencies } from "./application/owner-analytics-export.js";
export { createPostgresOwnerAnalyticsExportSnapshotReader } from "./adapters/postgres-owner-analytics-export.js";
export { createPostgresAnalyticsGoalScopeFacts } from "./adapters/postgres-goal-scope-facts.js";

export type { AnalyticsEventAction, AnalyticsGoalStep, AnalyticsGoalDefinition, GetOwnerAnalyticsGoalQuery, CreateOwnerAnalyticsGoalVersionApplicationCommand, ActivateOwnerAnalyticsGoalVersionApplicationCommand, AnalyticsGoalVersionView, AnalyticsGoalActivationView, AnalyticsGoalAggregateView, AnalyticsGoalVersionReceipt, AnalyticsGoalActivationReceipt, OwnerAnalyticsApplicationService } from "./application/owner-analytics.js";

export type { MeasurementEventContext, PublicMeasurementEvent, EventReceipt } from "./domain/types.js";

export type { VerifiedMeasurementEvidence } from "./application/service.js";

export type { MeasurementWorkCommand, MeasurementWorkService } from "./application/work.js";

export type { SafeAggregateReport } from "./application/service.js";

export type { AggregateReportMetadata, SafeReportDimensions, AggregateReportRow } from "./application/service.js";
export { createDailyAggregateWorkService, createOwnerAggregateReportService } from "./application/daily-aggregates.js";
export type { DailyAggregateWorkDependencies, OwnerAggregateReportDependencies } from "./application/daily-aggregates.js";
export type { DailyAggregatePage, DailyAggregateRebuildResult, DailyAggregateRepositoryPort, DailyAggregateReportRecord } from "./ports/daily-aggregates.js";
export { createPostgresDailyAggregateRepository } from "./adapters/postgres-daily-aggregates.js";
export { createPostgresMeasurementRetentionRepository } from "./adapters/postgres-retention.js";

export { createConsentApplicationService } from "./application/consent.js";
export type { ConsentApplicationService, ConsentServiceDependencies, ConsentChoiceReceipt, RecordConsentChoiceCommand, VerifyConsentQuery, CurrentConsent, ConsentRepositoryPort } from "./application/consent.js";

export { createMeasurementEventService } from "./application/ingest-event.js";
export type { MeasurementEventApplicationDeps, MeasurementEventRepositoryPort, MeasurementMediaPublicFactsPort } from "./application/ingest-event.js";
export { createMeasurementRetentionWorkService } from "./application/retention.js";
export { measurementAggregateExpiryAt, measurementDetailExpiryAt } from "./application/retention.js";
export type { MeasurementRetentionWorkDependencies } from "./application/retention.js";
export type { MeasurementRetentionKind, MeasurementRetentionBatch, MeasurementRetentionRepositoryPort } from "./ports/retention.js";
