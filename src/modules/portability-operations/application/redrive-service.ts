import { createHash } from "node:crypto";
import { err, InputValidationError, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { ScopedSystemActor } from "./service.js";
import type { LeasedJobStorePort } from "./persistence.js";
import { JOB_REDRIVE_POLICY_VERSION, parsePhase7WorkPayload } from "./redrive-policy.js";

export interface RedriveDeadJobCommand {
  readonly actor: ScopedSystemActor;
  readonly originalJobId: StableId<"Job">;
}

export interface RedriveDeadJobDependencies {
  readonly jobs: Pick<LeasedJobStorePort, "getDeadForRedrive" | "redriveDead">;
  /** Resolves only after the caller's operator authorization has succeeded. Returns a purpose-limited SHA-256 scope hash. */
  readonly authorizeOperator: (actor: ScopedSystemActor) => Promise<string | null>;
  readonly generateJobId: () => string;
}

export async function redriveDeadJob(
  deps: RedriveDeadJobDependencies,
  command: RedriveDeadJobCommand,
): Promise<Result<StableId<"Job">, Rejection>> {
  if (command.actor.kind !== "system" || command.actor.purpose !== "operations.redrive" ||
      !parseStableId("Job", command.actor.jobId).ok) {
    return err({ kind: "forbidden", code: "JOB_REDRIVE_UNAUTHORIZED" });
  }
  let scopeHash: string | null;
  try { scopeHash = await deps.authorizeOperator(command.actor); } catch {
    return err({ kind: "temporarily_unavailable", code: "JOB_REDRIVE_AUTHORIZATION_UNAVAILABLE" });
  }
  if (!scopeHash || !/^[0-9a-f]{64}$/.test(scopeHash)) {
    return err({ kind: "forbidden", code: "JOB_REDRIVE_UNAUTHORIZED" });
  }
  try {
    const dead = await deps.jobs.getDeadForRedrive(command.originalJobId);
    if (!dead) return err({ kind: "not_found", code: "DEAD_JOB_NOT_FOUND" });
    if (!parsePhase7WorkPayload(dead.payload)) {
      return err({ kind: "validation", code: "JOB_REDRIVE_POLICY_OBSOLETE" });
    }
    const replacementJobId = deps.generateJobId();
    if (!parseStableId("Job", replacementJobId).ok || replacementJobId === dead.jobId) {
      return err({ kind: "validation", code: "JOB_REDRIVE_ID_INVALID" });
    }
    const payloadSha256 = createHash("sha256")
      .update(JSON.stringify({ type: dead.payload.type, version: dead.payload.version, value: dead.payload.value }))
      .digest("hex");
    const replacement = await deps.jobs.redriveDead({
      originalJobId: dead.jobId,
      replacementJobId,
      operatorScopeHash: scopeHash,
      policyVersion: JOB_REDRIVE_POLICY_VERSION,
      payloadSha256,
    });
    if (!replacement) return err({ kind: "conflict", code: "DEAD_JOB_CHANGED" });
    return ok(replacement.jobId as StableId<"Job">);
  } catch (error) {
    if (error instanceof InputValidationError) {
      return err({ kind: "validation", code: "JOB_REDRIVE_PAYLOAD_UNSAFE" });
    }
    return err({ kind: "temporarily_unavailable", code: "JOB_REDRIVE_UNAVAILABLE" });
  }
}
