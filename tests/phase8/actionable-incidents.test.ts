import { describe, expect, it, vi } from "vitest";
import { evaluateIncidentMeasurements, evaluateConfiguredSustainedRule, validateConfiguredIncidentRule, CORE_INCIDENT_RULES } from "../../src/modules/portability-operations/application/incident-policy.js";
import { createIncidentLifecycleService, INCIDENT_DELIVERY_BACKOFF_SECONDS, MAX_INCIDENT_DELIVERY_ATTEMPTS,
  type DurableIncidentInput, type DurableIncidentRecord, type IncidentLifecycleStore } from "../../src/modules/portability-operations/application/incident-lifecycle.js";
import { createOperationalIncidentPass } from "../../src/modules/portability-operations/application/incident-pass.js";
import type { StableId } from "../../src/shared/domain/index.js";

const at = "2026-10-29T12:00:00.000Z";

describe("Phase 8 #252 actionable incident policy", () => {
  it("#252 AC08 bounds summary collection and stops before observation on cancellation", async () => {
    const mutation = vi.fn(async () => { throw new Error("UNEXPECTED_INCIDENT_WRITE"); });
    const store: IncidentLifecycleStore = { upsert: mutation, claimDue: mutation, markDelivered: mutation,
      markDeliveryFailed: mutation, resolve: mutation, recoverWorkIncident: mutation, listOpen: mutation };
    const sink = { deliver: mutation };
    const pass = createOperationalIncidentPass({ store, sink, passBudgetMs: 50,
      readSummary: () => new Promise<never>(() => undefined), now: () => at,
      newIncidentId: () => "018b01f0-0000-7000-8000-000000000001" as StableId<"OperationsIncident"> });
    const scope = "018b01f0-0000-7000-8000-000000000003" as StableId<"Portfolio">;
    const shutdown = new AbortController();
    const pending = pass.run(scope, shutdown.signal);
    shutdown.abort();
    expect(await pending).toMatchObject({ stopped: true, incomplete: true, openOrUpdated: null, delivery: null });
    expect(await pass.run(scope)).toMatchObject({ stopped: true, incomplete: true });
    const immediateShutdown = new AbortController();
    const dependencies = { store, sink, passBudgetMs: 50, now: () => at,
      newIncidentId: () => "018b01f0-0000-7000-8000-000000000001" as StableId<"OperationsIncident">,
      readSummary: () => { immediateShutdown.abort(); return new Promise<never>(() => undefined); } };
    expect(await createOperationalIncidentPass(dependencies).run(scope, immediateShutdown.signal)).toMatchObject({ stopped: true, incomplete: true });
    const configured = { ...CORE_INCIDENT_RULES[0]!, key: "configured.rule", threshold: 1, windowSeconds: 60, sustained: true, minimumSamples: 2 };
    expect(() => createOperationalIncidentPass({ ...dependencies, configuredRules: [configured, configured] })).toThrow("Incident rule configuration is invalid.");
    expect(() => createOperationalIncidentPass({ ...dependencies, configuredRules: [{ ...configured, key: CORE_INCIDENT_RULES[0]!.key }] })).toThrow("Incident rule configuration is invalid.");
    expect(() => createOperationalIncidentPass({ ...dependencies, configuredRules: Array(100).fill(configured) })).toThrow("Incident rule configuration is invalid.");
    expect(mutation).not.toHaveBeenCalled();
  });
  it("#252 AC01 evaluates strict queue-age, backup, RTO, dead-work, privacy, and capacity threshold boundaries", () => {
    for (const [key, threshold] of [["outbox.oldest_eligible_age_seconds", 900],
      ["backup.relational_source_watermark_age_hours", 24], ["backup.object_source_watermark_age_hours", 168],
      ["recovery.duration_ms", 28_800_000], ["capacity.used_percent", 70]] as const) {
      expect(evaluateIncidentMeasurements([{ key, value: threshold - 0.01, state: "measured" }])).toEqual([]);
      expect(evaluateIncidentMeasurements([{ key, value: threshold, state: "measured" }])).toEqual([]);
      expect(evaluateIncidentMeasurements([{ key, value: threshold + 0.01, state: "measured" }])).toHaveLength(1);
    }
    for (const key of ["outbox.dead_depth", "jobs.dead_depth", "publication.safe_failures", "retention.failures", "withdrawal.failures",
      "exports.integrity_failures", "recovery.outcome_failed"]) {
      expect(evaluateIncidentMeasurements([{ key, value: 0, state: "measured" }])).toEqual([]);
      expect(evaluateIncidentMeasurements([{ key, value: 1, state: "measured" }])).toHaveLength(1);
    }
    expect(CORE_INCIDENT_RULES.map((rule) => [rule.key, rule.threshold, rule.unit])).toContainEqual(["outbox.oldest_eligible_age_seconds", 900, "seconds"]);
    const decisions = evaluateIncidentMeasurements([
      { key: "outbox.oldest_eligible_age_seconds", value: 901, state: "measured" },
      { key: "backup.relational_source_watermark_age_hours", value: 24, state: "measured" },
      { key: "backup.object_source_watermark_age_hours", value: 168.01, state: "measured" },
      { key: "recovery.duration_ms", value: 28_800_001, state: "measured" },
      { key: "capacity.used_percent", value: 70.01, state: "measured" },
      { key: "outbox.dead_depth", value: 1, state: "measured" },
      { key: "publication.safe_failures", value: 1, state: "measured" },
      { key: "retention.failures", value: 1, state: "measured" },
      { key: "recovery.outcome_failed", value: 1, state: "measured" },
    ]);
    expect(decisions.map(({ rule }) => rule.code)).toEqual([
      "OUTBOX_ELIGIBLE_AGE", "OUTBOX_DEAD_WORK", "PUBLICATION_FAILURE", "PRIVACY_RETENTION_FAILURE",
      "OBJECT_BACKUP_STALE", "RECOVERY_REHEARSAL_FAILED", "RECOVERY_RTO_EXCEEDED", "CAPACITY_HIGH",
    ]);
  });

  it("#252 AC02 excludes completed and future-delayed work and treats missing sources as unknown", () => {
    expect(evaluateIncidentMeasurements([
      { key: "outbox.oldest_eligible_age_seconds", value: null, state: "unknown" },
      { key: "backup.relational_source_watermark_age_hours", value: null, state: "unknown" },
      { key: "capacity.used_percent", value: 99, state: "unknown" },
      { key: "outbox.oldest_eligible_age_seconds", value: 900, state: "measured" },
      { key: "outbox.dead_depth", value: 0, state: "measured" },
    ])).toEqual([]);
  });

  it("#252 AC01 validates sustained rules and measures complete configured windows with owning role and units", () => {
    const rule = { key: "auth.failure_rate", code: "AUTH_FAILURE_RATE", severity: "critical", owner: "identity",
      remediation: "runbook:identity/auth", threshold: 10, unit: "percent", windowSeconds: 300, sustained: true, minimumSamples: 3 };
    expect(validateConfiguredIncidentRule(rule)).toMatchObject(rule);
    expect(validateConfiguredIncidentRule({ ...rule, unit: "mystery" })).toBeNull();
    expect(validateConfiguredIncidentRule({ ...rule, windowSeconds: 0 })).toBeNull();
    expect(validateConfiguredIncidentRule({ ...rule, owner: "" })).toBeNull();
    expect(validateConfiguredIncidentRule({ ...rule, minimumSamples: 1 })).toBeNull();
    const configured = validateConfiguredIncidentRule(rule)!;
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 11, observedAt: "2026-10-29T11:55:00.000Z" },
      { value: 12, observedAt: "2026-10-29T11:57:30.000Z" },
      { value: 13, observedAt: at },
    ], at)).toMatchObject({ state: "measured", decision: { rule: configured, value: 13 }, sampleCount: 3 });
    expect(evaluateConfiguredSustainedRule(configured, [{ value: 20, observedAt: at }], at)).toMatchObject({ state: "unknown", reason: "insufficient-window" });
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 11, observedAt: "2026-10-29T11:55:00.000Z" },
      { value: 12, observedAt: "2026-10-29T11:57:30.000Z" },
      { value: 9, observedAt: at },
    ], at)).toMatchObject({ state: "measured", decision: null });
    expect(evaluateIncidentMeasurements([{ key: configured.key, value: 1, state: "measured" }])).toEqual([]);
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 20, observedAt: "2026-10-29T10:00:00.000Z" },
      { value: 20, observedAt: "2026-10-29T11:58:00.000Z" },
      { value: 20, observedAt: "2026-10-29T11:59:00.000Z" },
      { value: 20, observedAt: at },
    ], at)).toMatchObject({ state: "unknown", reason: "insufficient-window" });
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 11, observedAt: "2026-10-29T11:55:00.000Z" },
      { value: 12, observedAt: "2026-10-29T11:57:30.000Z" },
      { value: 13, observedAt: at },
    ], at)).toMatchObject({ state: "measured", decision: { value: 13 } });
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 11, observedAt: "2026-10-29T11:56:00.000Z" },
      { value: 12, observedAt: "2026-10-29T11:58:00.000Z" },
      { value: 13, observedAt: at },
    ], at)).toMatchObject({ state: "unknown", reason: "insufficient-window" });
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 11, observedAt: "2026-10-29T11:55:00.000Z" },
      { value: 12, observedAt: "2026-10-29T11:57:30.000Z" },
      { value: 13, observedAt: at },
    ], "2026-10-29T11:59:59.000Z")).toMatchObject({ state: "unknown", reason: "malformed-sample" });
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 11, observedAt: "2026-10-29T11:55:00.000Z" },
      { value: 12, observedAt: "2026-10-29T11:55:00.000Z" },
      { value: 13, observedAt: at },
    ], at)).toMatchObject({ state: "unknown", reason: "malformed-sample" });
    expect(CORE_INCIDENT_RULES.some(({ key }) => key === "withdrawal.failures")).toBe(true);
    for (const [key, code] of [["burn.rate", "BURN_RATE"], ["auth.failure_rate", "AUTH_FAILURE_RATE"],
      ["integration.failures", "INTEGRATION_FAILURES"], ["gate.downstream_failures", "DOWNSTREAM_GATE_FAILURES"]] as const) {
      const familyRule = validateConfiguredIncidentRule({ ...rule, key, code, threshold: 10 })!;
      const fullWindow = [{ value: 11, observedAt: "2026-10-29T11:55:00.000Z" },
        { value: 11, observedAt: "2026-10-29T11:57:30.000Z" }, { value: 11, observedAt: at }];
      expect(evaluateConfiguredSustainedRule(familyRule, fullWindow, at)).toMatchObject({ state: "measured", decision: { value: 11 } });
      expect(evaluateConfiguredSustainedRule(familyRule, [{ ...fullWindow[0]!, value: 10 }, fullWindow[1]!, fullWindow[2]!], at))
        .toMatchObject({ state: "measured", decision: null });
    }
    expect(evaluateConfiguredSustainedRule(configured, [
      { value: 20, observedAt: "2026-10-29T11:55:00.000Z" }, { value: 20, observedAt: "2026-10-29T11:59:59.000Z" },
    ], at)).toMatchObject({ state: "unknown", reason: "insufficient-window" });
  });

  it("#252 AC03-04 persists bounded delivery failures without recursive notifications and resolves recovery once", async () => {
    let attempts = 0;
    let resolved = false;
    const input: DurableIncidentInput = { incidentId: "018b01f0-0000-7000-8000-000000000001" as DurableIncidentInput["incidentId"],
      scopeKey: "scope-a", rule: CORE_INCIDENT_RULES[0]!, value: 901, firstObservedAt: at, lastObservedAt: at };
    let record: DurableIncidentRecord = { ...input, occurrences: 3, state: "open", deliveryState: "pending", deliveryAttempts: 0,
      owner: input.rule.owner, remediation: input.rule.remediation };
    const store: IncidentLifecycleStore = {
      async upsert(next) { record = { ...record, ...next, occurrences: record.occurrences + 1 }; return record; },
      async claimDue() { attempts += 1; record = { ...record, deliveryAttempts: attempts }; return attempts > MAX_INCIDENT_DELIVERY_ATTEMPTS ? [] : [record]; },
      async markDelivered() { record = { ...record, deliveryState: "delivered" }; return true; },
      async markDeliveryFailed(_claim, _at, _code, nextAt) { record = { ...record, deliveryAttempts: attempts,
        deliveryState: nextAt === null ? "exhausted" : "pending" }; return true; },
      async resolve() { if (resolved) return false; resolved = true; record = { ...record, state: "resolved" }; return true; },
      async recoverWorkIncident() { return false; },
      async listOpen() { return []; },
    };
    const sink = { async deliver() { throw new Error("provider payload marker must not be logged"); } };
    const claim = { incidentId: input.incidentId, token: "00000000-0000-4000-8000-000000000001", generation: 1,
      leaseExpiresAt: "2026-10-29T12:05:00.000Z" };
    const claimedRecord = { ...record, deliveryClaim: claim };
    store.claimDue = async () => { if (attempts > 0) return []; attempts += 1; record = { ...record, deliveryAttempts: attempts };
      return [{ ...claimedRecord, deliveryAttempts: attempts }]; };
    store.markDelivered = async () => { record = { ...record, deliveryState: "delivered" }; return true; };
    store.markDeliveryFailed = async (_claim, _at, _code, nextAt) => { record = { ...record, deliveryAttempts: attempts,
      deliveryState: nextAt === null ? "exhausted" : "pending" }; return true; };
    const service = createIncidentLifecycleService({ store, sink });
    expect((await service.observe([input, input])).at(-1)?.occurrences).toBe(5);
    expect(await service.deliverDue(at)).toMatchObject({ attempted: 1, failed: 1 });
    expect(INCIDENT_DELIVERY_BACKOFF_SECONDS[0]).toBe(30);
    expect(await service.resolve(input.rule.key, input.scopeKey, at)).toBe(true);
    expect(await service.resolve(input.rule.key, input.scopeKey, at)).toBe(false);
    expect(JSON.stringify(record)).not.toContain("provider payload marker");
  });

  it("#252 AC04 bounds a never-settling isolated sink and persists the attempt as retryable", async () => {
    let failedNextAt: string | null | undefined;
    let claims = 0;
    const input: DurableIncidentInput = { incidentId: "018b01f0-0000-7000-8000-000000000002" as DurableIncidentInput["incidentId"],
      scopeKey: "scope-timeout", rule: CORE_INCIDENT_RULES[0]!, value: 901, firstObservedAt: at, lastObservedAt: at };
    const claim = { incidentId: input.incidentId, token: "00000000-0000-4000-8000-000000000002", generation: 1,
      leaseExpiresAt: "2026-10-29T12:05:00.000Z" };
    const record: DurableIncidentRecord = { ...input, occurrences: 1, state: "open", deliveryState: "pending", deliveryAttempts: 1,
      owner: input.rule.owner, remediation: input.rule.remediation, deliveryClaim: claim };
    const store: IncidentLifecycleStore = {
      async upsert(next) { return { ...record, ...next }; },
      async claimDue() { claims += 1; return claims === 1 ? [record] : []; },
      async markDelivered() { return false; },
      async markDeliveryFailed(_claim, _at, _code, nextAt) { failedNextAt = nextAt; return true; },
      async resolve() { return false; },
      async recoverWorkIncident() { return false; },
      async listOpen() { return []; },
    };
    const service = createIncidentLifecycleService({ store, deliveryTimeoutMs: 50, deliveryBudgetMs: 100,
      sink: { async deliver(_payload, context) { await new Promise<void>((_resolve) => {
        context.signal.addEventListener("abort", () => undefined, { once: true });
      }); } } });
    const started = Date.now();
    await expect(service.deliverDue(at)).resolves.toMatchObject({ attempted: 1, failed: 1 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(failedNextAt).toBe("2026-10-29T12:00:30.000Z");
    expect(claims).toBe(2);
  });
});
