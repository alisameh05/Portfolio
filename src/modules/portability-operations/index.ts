/**
 * portability-operations module public interface.
 *
 * This barrel is the single public import surface for the Portability and Operations module.
 * Other modules must never deep-import internal paths.
 */

export type {
  ExportScope,
  ExportStatus,
  IntegrityManifest,
  OwnerExport,
  OutboxRecord,
  JobStatus,
  LeasedJob,
  AlertSeverity,
  OperationalAlert,
  OwnerExportProducedEvent,
} from "./domain/index.js";

export type {
  ProduceOwnerExportCommand,
  GetOwnerExportQuery,
  ClaimJobCommand,
  CompleteJobCommand,
  FailJobCommand,
  HealthCheckResult,
  PortabilityOperationsService,
  IdempotencyPort,
  IdempotentExecutionInput,
  IdempotentExecutionResult,
  JobInput,
  LeaseClaimInput,
  LeasedJobRecord,
  LeasedJobStorePort,
  LeasedOutboxEvent,
  OperationsPersistencePorts,
  OutboxEventInput,
  OutboxPersistencePort,
  SafeResultEnvelope,
  SafeErrorCode,
  VersionedPayload,
} from "./application/index.js";

export { parseSafeErrorCode } from "./application/index.js";

export type {
  ExportRepositoryPort,
  OutboxRepositoryPort,
  JobRepositoryPort,
  ModuleDataReaderPort,
} from "./ports/index.js";
