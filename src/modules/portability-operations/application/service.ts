import type { StableId, Result, Rejection, ActorContext } from "@shared/domain";
import type {
  ExportScope,
  OwnerExport,
  LeasedJob,
} from "../domain/index.js";

export interface ProduceOwnerExportCommand {
  readonly actor: ActorContext;
  readonly scope: ExportScope;
}

export interface GetOwnerExportQuery {
  readonly actor: ActorContext;
  readonly exportId: StableId<"OwnerExport">;
}

export interface ClaimJobCommand {
  readonly workerId: string;
  readonly leaseDurationSeconds: number;
}

export interface CompleteJobCommand {
  readonly jobId: StableId<"Job">;
}

export interface FailJobCommand {
  readonly jobId: StableId<"Job">;
  readonly reason: string;
}

export interface HealthCheckResult {
  readonly status: "healthy" | "degraded" | "unhealthy";
  readonly details: Readonly<Record<string, string>>;
}

export interface PortabilityOperationsService {
  produceOwnerExport(
    command: ProduceOwnerExportCommand,
  ): Promise<Result<OwnerExport, Rejection>>;

  getOwnerExport(
    query: GetOwnerExportQuery,
  ): Promise<Result<OwnerExport, Rejection>>;

  claimJob(
    command: ClaimJobCommand,
  ): Promise<Result<LeasedJob | null, Rejection>>;

  completeJob(
    command: CompleteJobCommand,
  ): Promise<Result<void, Rejection>>;

  failJob(
    command: FailJobCommand,
  ): Promise<Result<void, Rejection>>;

  performHealthCheck(): Promise<Result<HealthCheckResult, Rejection>>;
}
