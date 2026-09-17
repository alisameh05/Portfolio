import type { StableId, Result, Rejection } from "@shared/domain";
import type {
  OwnerExport,
  OutboxRecord,
  LeasedJob,
  OperationalAlert,
} from "../domain/index.js";

export interface ExportRepositoryPort {
  getExportById(
    id: StableId<"OwnerExport">,
  ): Promise<Result<OwnerExport, Rejection>>;

  saveExport(
    exportRecord: OwnerExport,
  ): Promise<Result<OwnerExport, Rejection>>;
}

export interface OutboxRepositoryPort {
  saveRecord(
    record: OutboxRecord,
  ): Promise<Result<OutboxRecord, Rejection>>;

  getPendingRecords(
    limit: number,
  ): Promise<Result<readonly OutboxRecord[], Rejection>>;

  markDispatched(
    id: StableId<"Outbox">,
  ): Promise<Result<void, Rejection>>;
}

export interface JobRepositoryPort {
  claimJob(
    workerId: string,
    leaseDurationSeconds: number,
  ): Promise<Result<LeasedJob | null, Rejection>>;

  completeJob(
    id: StableId<"Job">,
  ): Promise<Result<void, Rejection>>;

  failJob(
    id: StableId<"Job">,
    reason: string,
  ): Promise<Result<void, Rejection>>;
}

export interface ModuleDataReaderPort {
  readModuleSnapshot(
    moduleName: string,
  ): Promise<Result<Record<string, unknown>, Rejection>>;
}
