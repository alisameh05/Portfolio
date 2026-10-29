import type { StableId } from "@shared/domain";
import type { OperationsSummary } from "./operations-observability.js";
import { CORE_INCIDENT_RULES, evaluateConfiguredSustainedRule, evaluateIncidentMeasurements, validateConfiguredIncidentRule,
  type ConfiguredIncidentRule, type IncidentMeasurement } from "./incident-policy.js";
import type { IncidentLifecycleStore, IncidentDeliverySink, IncidentEnvironment } from "./incident-lifecycle.js";
import { createIncidentLifecycleService } from "./incident-lifecycle.js";

/** A bounded system observation pass; providers remain behind the supplied summary reader and sink. */
export function createOperationalIncidentPass(dependencies: {
  readonly readSummary: (signal?: AbortSignal) => Promise<OperationsSummary>;
  readonly store: IncidentLifecycleStore;
  readonly sink: IncidentDeliverySink;
  readonly newIncidentId: () => StableId<"OperationsIncident">;
  readonly now: () => string;
  readonly environment?: IncidentEnvironment;
  readonly configuredRules?: readonly unknown[];
  readonly readConfiguredSamples?: (rule: ConfiguredIncidentRule, summary: OperationsSummary) => Promise<readonly Readonly<{ value: number; observedAt: string }>[]>;
  readonly deliveryTimeoutMs?: number;
  readonly deliveryBudgetMs?: number;
  readonly passBudgetMs?: number;
}) {
  const candidates = dependencies.configuredRules ?? [];
  if (candidates.length + CORE_INCIDENT_RULES.length > 100) throw new TypeError("Incident rule configuration is invalid.");
  const configuredRules = candidates.map(validateConfiguredIncidentRule);
  const keys = new Set(CORE_INCIDENT_RULES.map((rule) => rule.key));
  if (configuredRules.length + keys.size > 100 || configuredRules.some((rule) => {
    if (rule === null || keys.has(rule.key)) return true;
    keys.add(rule.key); return false;
  })) throw new TypeError("Incident rule configuration is invalid.");
  const lifecycle = createIncidentLifecycleService({ store: dependencies.store, sink: dependencies.sink,
    ...(dependencies.deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: dependencies.deliveryTimeoutMs }),
    ...(dependencies.deliveryBudgetMs === undefined ? {} : { deliveryBudgetMs: dependencies.deliveryBudgetMs }) });

  const stopped = () => ({ stopped: true, incomplete: true, openOrUpdated: null, delivery: null } as const);
  async function execute(portfolioId: StableId<"Portfolio">, signal: AbortSignal) {
      if (signal.aborted) return stopped();
      const summary = await dependencies.readSummary(signal);
      if (signal.aborted) return stopped();
      const environment = dependencies.environment ?? "unknown";
      const scopeKey = `${environment}:${portfolioId}`;
      const observedAt = summary.generatedAt;
      const measurements = summaryMeasurements(summary);
      const decisions = [...evaluateIncidentMeasurements(measurements)];
      const configuredMeasurements = new Map<string, "measured" | "unknown">();
      for (const rule of configuredRules) {
        if (signal.aborted) return stopped();
        if (!rule || dependencies.readConfiguredSamples === undefined) continue;
        const result = evaluateConfiguredSustainedRule(rule, await dependencies.readConfiguredSamples(rule, summary), observedAt);
        configuredMeasurements.set(rule.key, result.state);
        if (result.state === "measured" && result.decision !== null) decisions.push(result.decision);
      }
      const active = new Set(decisions.map(({ rule }) => rule.key));
      const inputs = decisions.map((decision) => ({ incidentId: dependencies.newIncidentId(), scopeKey, environment,
        rule: decision.rule, value: decision.value, lowerBound: decision.lowerBound ?? false, firstObservedAt: observedAt, lastObservedAt: observedAt }));
      const observed = await lifecycle.observe(inputs, signal);
      for (const measurement of measurements) {
        if (signal.aborted) return stopped();
        if (measurement.state === "measured" && !measurement.lowerBound && !active.has(measurement.key)) {
          await lifecycle.resolve(measurement.key, scopeKey, observedAt);
        }
      }
      for (const [key, state] of configuredMeasurements) {
        if (signal.aborted) return stopped();
        if (state === "measured" && !active.has(key)) await lifecycle.resolve(key, scopeKey, observedAt);
      }
      const delivery = await lifecycle.deliverDue(dependencies.now(), signal);
      return { stopped: signal.aborted, incomplete: signal.aborted, observedAt, measurements: measurements.length, openOrUpdated: observed.length, delivery } as const;
  }
  return {
    async run(portfolioId: StableId<"Portfolio">, signal?: AbortSignal) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
      const budget = Number.isSafeInteger(dependencies.passBudgetMs) && dependencies.passBudgetMs! >= 50 && dependencies.passBudgetMs! <= 30_000
        ? dependencies.passBudgetMs! : 10_000;
      const timer = setTimeout(abort, budget);
      try {
        if (controller.signal.aborted) return stopped();
        return await Promise.race([execute(portfolioId, controller.signal), new Promise<ReturnType<typeof stopped>>((resolve) => {
          if (controller.signal.aborted) { resolve(stopped()); return; }
          controller.signal.addEventListener("abort", () => resolve(stopped()), { once: true });
        })]);
      } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
    },
  };
}

/** Positive bounded samples prove failure; capped totals cannot certify recovery. */
export function summaryMeasurements(summary: OperationsSummary): readonly IncidentMeasurement[] {
  const values: IncidentMeasurement[] = [];
  const count = (key: string, item: { value: number; capped: boolean }) => {
    values.push(item.capped && item.value <= 0 ? { key, value: null, state: "unknown" }
      : { key, value: item.value, state: "measured", lowerBound: item.capped });
  };
  const age = summary.outbox.oldestEligibleAgeSeconds;
  values.push(age.state === "measured" && (age.value === null || Number.isFinite(age.value))
    ? { key: "outbox.oldest_eligible_age_seconds", value: age.value ?? 0, state: "measured" }
    : { key: "outbox.oldest_eligible_age_seconds", value: null, state: "unknown" });
  count("outbox.dead_depth", summary.outbox.deadDepth);
  count("jobs.dead_depth", summary.jobs.deadDepth);
  if (summary.retention.failures.state === "measured") count("retention.failures", summary.retention.failures.value);
  else values.push({ key: "retention.failures", value: null, state: "unknown" });
  if (summary.exports.integrityFailures.state === "measured") count("exports.integrity_failures", summary.exports.integrityFailures.value);
  else values.push({ key: "exports.integrity_failures", value: null, state: "unknown" });
  const scalar = (key: string, item: { state: string; value?: number }) => {
    values.push(item.state === "measured" && typeof item.value === "number" && Number.isFinite(item.value)
      ? { key, value: item.value, state: "measured" } : { key, value: null, state: "unknown" });
  };
  // The owning backup/recovery slices may register these observations later.
  // Uninstalled producers remain unknown; measured sources must not be discarded.
  values.push({ key: "withdrawal.failures", value: null, state: "unknown" });
  scalar("backup.relational_source_watermark_age_hours", summary.backup.relationalSourceWatermarkAgeHours);
  scalar("backup.object_source_watermark_age_hours", summary.backup.objectSourceWatermarkAgeHours);
  values.push({ key: "recovery.outcome_failed", value: null, state: "unknown" });
  scalar("recovery.duration_ms", summary.recovery.durationMs);
  scalar("capacity.used_percent", summary.capacity.usedPercent);
  if (summary.publication.safeFailures.state === "measured") count("publication.safe_failures", summary.publication.safeFailures.value);
  else values.push({ key: "publication.safe_failures", value: null, state: "unknown" });
  return values;
}
