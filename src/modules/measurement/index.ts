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
