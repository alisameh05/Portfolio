import type { StableId, Result, Rejection } from "@shared/domain";
import { err, ok } from "@shared/domain";
import type {
  ExportRepositoryPort,
  OutboxRepositoryPort,
  JobRepositoryPort,
  ModuleDataReaderPort,
} from "../ports/index.js";
import type {
  OwnerExport,
  OutboxRecord,
  LeasedJob,
} from "../domain/index.js";

/**
 * Stub repository adapters for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubExportRepository implements ExportRepositoryPort {
  async getExportById(
    _id: StableId<"OwnerExport">,
  ): Promise<Result<OwnerExport, Rejection>> {
    return err({ kind: "not_found", code: "EXPORT_NOT_FOUND" });
  }

  async saveExport(
    _exportRecord: OwnerExport,
  ): Promise<Result<OwnerExport, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }
}

export class StubOutboxRepository implements OutboxRepositoryPort {
  async saveRecord(
    _record: OutboxRecord,
  ): Promise<Result<OutboxRecord, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getPendingRecords(
    _limit: number,
  ): Promise<Result<readonly OutboxRecord[], Rejection>> {
    return ok([]);
  }

  async markDispatched(
    _id: StableId<"Outbox">,
  ): Promise<Result<void, Rejection>> {
    return ok(undefined);
  }
}

export class StubJobRepository implements JobRepositoryPort {
  async claimJob(
    _workerId: string,
    _leaseDurationSeconds: number,
  ): Promise<Result<LeasedJob | null, Rejection>> {
    return ok(null);
  }

  async completeJob(
    _id: StableId<"Job">,
  ): Promise<Result<void, Rejection>> {
    return ok(undefined);
  }

  async failJob(
    _id: StableId<"Job">,
    _reason: string,
  ): Promise<Result<void, Rejection>> {
    return ok(undefined);
  }
}

export class StubModuleDataReader implements ModuleDataReaderPort {
  async readModuleSnapshot(
    _moduleName: string,
  ): Promise<Result<Record<string, unknown>, Rejection>> {
    return ok({});
  }
}
