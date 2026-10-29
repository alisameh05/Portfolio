/** Provider-neutral incident policy for bounded operational observations. */

export type IncidentOwner = "operations" | "content" | "measurement" | "backup" | "identity";

export interface IncidentRule {
  readonly key: string;
  readonly code: string;
  readonly severity: "warning" | "critical";
  readonly owner: IncidentOwner;
  readonly remediation: string;
  readonly threshold: number;
  readonly unit: "seconds" | "milliseconds" | "hours" | "percent" | "count";
  readonly windowSeconds: number;
}

export type IncidentMeasurement = Readonly<{
  readonly key: string;
  readonly value: number | null;
  readonly state: "measured" | "unknown";
  readonly lowerBound?: boolean;
}>;

export type IncidentDecision = Readonly<{
  readonly rule: IncidentRule;
  readonly value: number;
  readonly lowerBound?: boolean;
}>;

/** Fixed, validated defaults. Additional sustained rules must be supplied by validated config. */
export const CORE_INCIDENT_RULES: readonly IncidentRule[] = Object.freeze([
  { key: "outbox.oldest_eligible_age_seconds", code: "OUTBOX_ELIGIBLE_AGE", severity: "warning", owner: "operations", remediation: "runbook:operations/outbox", threshold: 900, unit: "seconds", windowSeconds: 0 },
  { key: "outbox.dead_depth", code: "OUTBOX_DEAD_WORK", severity: "critical", owner: "operations", remediation: "runbook:operations/outbox", threshold: 0, unit: "count", windowSeconds: 0 },
  { key: "jobs.dead_depth", code: "JOB_DEAD_WORK", severity: "critical", owner: "operations", remediation: "runbook:operations/jobs", threshold: 0, unit: "count", windowSeconds: 0 },
  { key: "publication.safe_failures", code: "PUBLICATION_FAILURE", severity: "critical", owner: "content", remediation: "runbook:content/publication", threshold: 0, unit: "count", windowSeconds: 900 },
  { key: "retention.failures", code: "PRIVACY_RETENTION_FAILURE", severity: "critical", owner: "measurement", remediation: "runbook:privacy/retention", threshold: 0, unit: "count", windowSeconds: 900 },
  { key: "withdrawal.failures", code: "PRIVACY_WITHDRAWAL_FAILURE", severity: "critical", owner: "measurement", remediation: "runbook:privacy/withdrawal", threshold: 0, unit: "count", windowSeconds: 900 },
  { key: "exports.integrity_failures", code: "EXPORT_INTEGRITY_FAILURE", severity: "critical", owner: "operations", remediation: "runbook:operations/owner-exports", threshold: 0, unit: "count", windowSeconds: 900 },
  { key: "backup.relational_source_watermark_age_hours", code: "RELATIONAL_BACKUP_STALE", severity: "critical", owner: "backup", remediation: "runbook:recovery/relational-backup", threshold: 24, unit: "hours", windowSeconds: 0 },
  { key: "backup.object_source_watermark_age_hours", code: "OBJECT_BACKUP_STALE", severity: "critical", owner: "backup", remediation: "runbook:recovery/object-backup", threshold: 168, unit: "hours", windowSeconds: 0 },
  { key: "recovery.outcome_failed", code: "RECOVERY_REHEARSAL_FAILED", severity: "critical", owner: "backup", remediation: "runbook:recovery/rehearsal", threshold: 0, unit: "count", windowSeconds: 0 },
  { key: "recovery.duration_ms", code: "RECOVERY_RTO_EXCEEDED", severity: "critical", owner: "backup", remediation: "runbook:recovery/rehearsal", threshold: 28_800_000, unit: "milliseconds", windowSeconds: 0 },
  { key: "capacity.used_percent", code: "CAPACITY_HIGH", severity: "warning", owner: "operations", remediation: "runbook:operations/capacity", threshold: 70, unit: "percent", windowSeconds: 0 },
]);

export interface ConfiguredIncidentRule extends IncidentRule {
  readonly sustained: true;
  readonly minimumSamples: number;
}

export const INCIDENT_REMEDIATION_POINTERS: ReadonlySet<string> = new Set([
  "runbook:operations/outbox", "runbook:operations/jobs", "runbook:content/publication",
  "runbook:privacy/retention", "runbook:privacy/withdrawal", "runbook:operations/owner-exports",
  "runbook:recovery/relational-backup", "runbook:recovery/object-backup", "runbook:recovery/rehearsal",
  "runbook:operations/capacity", "runbook:operations/burn-rate", "runbook:identity/auth",
  "runbook:operations/integration", "runbook:operations/downstream-gate",
]);

export function isKnownIncidentRemediationPointer(value: string): boolean {
  return INCIDENT_REMEDIATION_POINTERS.has(value);
}

/** Enforce explicit units, finite limits, windows, and accountable ownership for configured thresholds. */
export function validateConfiguredIncidentRule(value: unknown): ConfiguredIncidentRule | null {
  if (value === null || typeof value !== "object") return null;
  const rule = value as Partial<ConfiguredIncidentRule>;
  const owners: readonly string[] = ["operations", "content", "measurement", "backup", "identity"];
  const units: readonly string[] = ["seconds", "milliseconds", "hours", "percent", "count"];
  if (typeof rule.key !== "string" || !/^[a-z][a-z0-9._-]{2,95}$/u.test(rule.key) ||
      typeof rule.code !== "string" || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(rule.code) ||
      (rule.severity !== "warning" && rule.severity !== "critical") ||
      !owners.includes(rule.owner ?? "") || typeof rule.remediation !== "string" ||
      !isKnownIncidentRemediationPointer(rule.remediation) ||
      !Number.isFinite(rule.threshold) || (rule.threshold ?? -1) <= 0 || rule.threshold! > 1_000_000_000_000 ||
      !units.includes(rule.unit ?? "") || !Number.isSafeInteger(rule.windowSeconds) ||
      (rule.windowSeconds ?? 0) < 60 || (rule.windowSeconds ?? 0) > 604_800 ||
      rule.sustained !== true || !Number.isSafeInteger(rule.minimumSamples) ||
      (rule.minimumSamples ?? 0) < 2 || (rule.minimumSamples ?? 0) > 100) return null;
  return rule as ConfiguredIncidentRule;
}

/** Unknown, absent and future-only observations never become incidents. Thresholds are strict. */
export function evaluateIncidentMeasurements(
  measurements: readonly IncidentMeasurement[],
): readonly IncidentDecision[] {
  // Configured rules require their timestamped-window evaluator below. Keeping
  // this scalar path limited to fixed rules prevents a config rule from
  // bypassing its threshold, window, and minimum-sample requirements.
  const rules: readonly IncidentRule[] = CORE_INCIDENT_RULES;
  const byKey = new Map(measurements.map((measurement) => [measurement.key, measurement]));
  return rules.flatMap((rule) => {
    const measurement = byKey.get(rule.key);
    if (measurement === undefined || measurement.state !== "measured" || measurement.value === null ||
        !Number.isFinite(measurement.value) || measurement.value < 0) return [];
    const exceeded = rule.key === "outbox.oldest_eligible_age_seconds" || rule.key.endsWith("watermark_age_hours") ||
      rule.key === "capacity.used_percent" || rule.key === "recovery.duration_ms"
      ? measurement.value > rule.threshold
      : measurement.value > 0;
    return exceeded ? [{ rule, value: measurement.value, lowerBound: measurement.lowerBound ?? false }] : [];
  });
}

/** Evaluate configured sustained rules only from a complete time window of valid UTC samples. */
export function evaluateConfiguredSustainedRule(
  rule: ConfiguredIncidentRule,
  samples: readonly Readonly<{ value: number; observedAt: string }>[],
  asOf: string,
): Readonly<{ state: "unknown"; reason: "insufficient-window" | "malformed-sample" }> |
  Readonly<{ state: "measured"; decision: IncidentDecision | null; sampleCount: number }> {
  if (!validateConfiguredIncidentRule(rule) || !isUtcInstant(asOf) || !Array.isArray(samples) || samples.length > 100) {
    return { state: "unknown", reason: "malformed-sample" };
  }
  if (samples.some((sample) => sample === null || typeof sample !== "object" || !Number.isFinite(sample.value) || sample.value < 0 ||
      typeof sample.observedAt !== "string" || !isUtcInstant(sample.observedAt) ||
      Date.parse(sample.observedAt) > Date.parse(asOf)) ||
      new Set(samples.map((sample) => sample.observedAt)).size !== samples.length) {
    return { state: "unknown", reason: "malformed-sample" };
  }
  const ordered = [...samples].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
  const latestAt = ordered.at(-1);
  const earliestAt = ordered[0];
  const asOfMilliseconds = Date.parse(asOf);
  const windowStart = asOfMilliseconds - rule.windowSeconds * 1_000;
  const current = ordered.filter((sample) => Date.parse(sample.observedAt) >= windowStart);
  if (current.length < rule.minimumSamples || latestAt === undefined || earliestAt === undefined ||
      Date.parse(latestAt.observedAt) !== asOfMilliseconds || Date.parse(current[0]!.observedAt) !== windowStart) {
    return { state: "unknown", reason: "insufficient-window" };
  }
  const exceeded = current.every((sample) => sample.value > rule.threshold);
  return { state: "measured", sampleCount: current.length,
    decision: exceeded ? { rule, value: current.at(-1)!.value } : null };
}

function isUtcInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
