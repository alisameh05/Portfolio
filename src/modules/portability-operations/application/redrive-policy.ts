import type { VersionedPayload } from "./persistence.js";

export const JOB_REDRIVE_POLICY_VERSION = "phase7-handlers-v1";

export type Phase7WorkKind =
  | "aggregate"
  | "detail-retention"
  | "aggregate-retention"
  | "withdrawal-cleanup"
  | "feedback-retention";

export interface Phase7WorkPayload {
  readonly kind: Phase7WorkKind;
  readonly utcDay?: string;
}

const EMPTY_TYPES: Readonly<Record<string, Phase7WorkKind>> = {
  "measurement.detail-retention.v1": "detail-retention",
  "measurement.aggregate-retention.v1": "aggregate-retention",
  "measurement.withdrawal-cleanup.v1": "withdrawal-cleanup",
  "interaction.feedback-retention.v1": "feedback-retention",
};

/** Current handler schema/policy allowlist used by both execution and re-drive. */
export function parsePhase7WorkPayload(payload: VersionedPayload): Phase7WorkPayload | null {
  if (payload.version !== 1) return null;
  const keys = Object.keys(payload.value);
  if (payload.type === "measurement.daily-aggregate.v1" && keys.length === 1 && keys[0] === "utcDay") {
    const utcDay = payload.value["utcDay"];
    if (typeof utcDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(utcDay)) return null;
    const parsed = new Date(`${utcDay}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== utcDay) return null;
    return { kind: "aggregate", utcDay };
  }
  const kind = EMPTY_TYPES[payload.type];
  return kind && keys.length === 0 ? { kind } : null;
}
