import type { SystemActor, Result, Rejection } from "@shared/domain";
import type { ApplicationRequestContext, WorkBatchSize, BoundedWorkResult } from "@shared/application";
export interface MeasurementWorkCommand extends ApplicationRequestContext {
 readonly actor: SystemActor & { readonly purpose: "measurement.aggregate" | "measurement.retention" | "measurement.withdrawal" };
 readonly batchSize: WorkBatchSize;
 readonly cursor?: string;
 readonly now: string;
}
export interface MeasurementWorkService {
 aggregateDay(command: MeasurementWorkCommand & { readonly utcDay: string }): Promise<Result<BoundedWorkResult, Rejection>>;
 expireDetail(command: MeasurementWorkCommand): Promise<Result<BoundedWorkResult, Rejection>>;
 expireAggregates(command: MeasurementWorkCommand): Promise<Result<BoundedWorkResult, Rejection>>;
 cleanWithdrawnConsent(command: MeasurementWorkCommand): Promise<Result<BoundedWorkResult, Rejection>>;
}
