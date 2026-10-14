import type { SystemActor, Result, Rejection } from "@shared/domain";
import type { ApplicationRequestContext, WorkBatchSize, BoundedWorkResult } from "@shared/application";
export interface FeedbackWorkCommand extends ApplicationRequestContext {
 readonly actor: SystemActor & { readonly purpose: "feedback.retention" };
 readonly batchSize: WorkBatchSize;
 readonly cursor?: string;
 readonly now: string;
}
export interface FeedbackWorkService {
 expireFeedback(command: FeedbackWorkCommand): Promise<Result<BoundedWorkResult, Rejection>>;
}
