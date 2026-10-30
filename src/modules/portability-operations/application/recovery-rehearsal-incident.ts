import type { StableId } from "@shared/domain";
import type { IncidentEnvironment, IncidentLifecycleStore } from "./incident-lifecycle.js";
import { CORE_INCIDENT_RULES } from "./incident-policy.js";

/** Bind one rehearsal's failures to the existing deduplicated Operations incident store. */
export function createRecoveryRehearsalIncidentRecorder(input: {
  store: Pick<IncidentLifecycleStore, "upsert">;
  rehearsalId: StableId<"RecoveryRehearsal">;
  incidentId: StableId<"OperationsIncident">;
  environment: Exclude<IncidentEnvironment, "unknown">;
  now(): string;
}): (safeFailureCode: string) => Promise<void> {
  const rule = CORE_INCIDENT_RULES.find(candidate => candidate.key === "recovery.outcome_failed");
  if (!rule) throw new Error("RECOVERY_INCIDENT_RULE_MISSING");
  return async safeFailureCode => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(safeFailureCode)) throw new TypeError("RECOVERY_INCIDENT_CODE_INVALID");
    const observedAt = input.now();
    await input.store.upsert({
      environment: input.environment,
      incidentId: input.incidentId,
      scopeKey: input.rehearsalId,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      rule,
      value: 1,
    });
  };
}
