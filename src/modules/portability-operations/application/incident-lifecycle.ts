import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { IncidentDecision, IncidentRule } from "./incident-policy.js";
import { isKnownIncidentRemediationPointer } from "./incident-policy.js";

export const MAX_INCIDENT_DELIVERY_ATTEMPTS = 8;
export const INCIDENT_DELIVERY_BACKOFF_SECONDS = Object.freeze([30, 120, 600, 1_800, 7_200, 21_600, 43_200] as const);
export const MAX_INCIDENT_DELIVERY_BATCH = 25;
export type IncidentEnvironment = "unknown" | "local" | "test" | "staging" | "production";

export interface DurableIncidentInput extends IncidentDecision {
  readonly environment?: IncidentEnvironment;
  readonly incidentId: StableId<"OperationsIncident">;
  readonly scopeKey: string;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
}

export interface DurableIncidentRecord extends Omit<DurableIncidentInput, "rule" | "value"> {
  readonly rule: Omit<IncidentRule, "threshold" | "unit" | "windowSeconds"> & {
    readonly threshold: number | null;
    readonly unit: IncidentRule["unit"] | null;
    readonly windowSeconds: number | null;
  };
  readonly value: number | null;
  readonly occurrences: number;
  readonly state: "open" | "resolved";
  readonly deliveryState: "pending" | "delivered" | "exhausted" | "not-required";
  readonly deliveryAttempts: number;
  readonly owner: string;
  readonly remediation: string;
  readonly deliveryClaim?: Readonly<{ token: string; generation: number; leaseExpiresAt: string; incidentId: StableId<"OperationsIncident"> }>;
}

export interface IncidentDeliverySink {
  deliver(payload: Readonly<{
    environment: IncidentEnvironment;
    code: string;
    severity: "warning" | "critical";
    owner: string;
    remediation: string;
    firstObservedAt: string;
    lastObservedAt: string;
    occurrences: number;
  }>, context: Readonly<{ signal: AbortSignal; idempotencyKey: string }>): Promise<void>;
}

export interface IncidentDeliveryClaim {
  readonly incidentId: StableId<"OperationsIncident">;
  readonly token: string;
  readonly generation: number;
}

export interface IncidentLifecycleStore {
  upsert(input: DurableIncidentInput): Promise<DurableIncidentRecord>;
  claimDue(limit: number, observedAt: string): Promise<readonly DurableIncidentRecord[]>;
  markDelivered(claim: IncidentDeliveryClaim, at: string): Promise<boolean>;
  markDeliveryFailed(claim: IncidentDeliveryClaim, at: string, safeCode: string, nextAttemptAt: string | null): Promise<boolean>;
  resolve(ruleKey: string, scopeKey: string, at: string): Promise<boolean>;
  listOpen(limit: number): Promise<readonly Readonly<{
    environment: IncidentEnvironment; code: string; severity: "warning" | "critical"; owner: string; remediation: string;
    firstObservedAt: string; lastObservedAt: string; occurrences: number; deliveryState: string;
    value: number | null; threshold: number | null; unit: string | null; windowSeconds: number | null;
  }>[]>;
}

/** Persist observations first, then perform bounded isolated delivery; sink failures never recurse. */
export function createIncidentLifecycleService(dependencies: {
  readonly store: IncidentLifecycleStore;
  readonly sink: IncidentDeliverySink;
  readonly deliveryTimeoutMs?: number;
  readonly deliveryBudgetMs?: number;
}) {
  return {
    async observe(inputs: readonly DurableIncidentInput[]): Promise<readonly DurableIncidentRecord[]> {
      const result: DurableIncidentRecord[] = [];
      for (const input of inputs.slice(0, 100)) {
        if (!parseStableId("OperationsIncident", input.incidentId).ok || !isDeliverySafeIncidentInput(input)) {
          throw new TypeError("Incident observation is invalid.");
        }
        result.push(await dependencies.store.upsert(input));
      }
      return result;
    },
    async deliverDue(observedAt: string, signal?: AbortSignal): Promise<{ attempted: number; delivered: number; failed: number }> {
      let delivered = 0;
      let failed = 0;
      let attempted = 0;
      const timeoutMs = boundedDeliveryValue(dependencies.deliveryTimeoutMs, 2_000, 50, 10_000);
      const budgetMs = boundedDeliveryValue(dependencies.deliveryBudgetMs, 10_000, timeoutMs, 30_000);
      const deadline = Date.now() + budgetMs;
      while (attempted < MAX_INCIDENT_DELIVERY_BATCH && Date.now() < deadline && !signal?.aborted) {
        // Claim one item immediately before I/O. Shutdown therefore cannot
        // leave a batch of freshly leased incidents waiting behind a slow sink.
        const incident = (await dependencies.store.claimDue(1, observedAt))[0];
        if (!incident) break;
        attempted += 1;
        const claim = incident.deliveryClaim;
        if (!claim) {
          failed += 1;
          continue;
        }
        const controller = new AbortController();
        const abortFromWorker = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abortFromWorker, { once: true });
        if (signal?.aborted) controller.abort();
        const timer = setTimeout(() => controller.abort(new Error("INCIDENT_DELIVERY_DEADLINE")),
          Math.min(timeoutMs, Math.max(1, deadline - Date.now())));
        try {
          if (controller.signal.aborted) throw new Error("INCIDENT_DELIVERY_INTERRUPTED");
          const delivery = Promise.resolve().then(() => dependencies.sink.deliver({ environment: incident.environment ?? "unknown", code: incident.rule.code, severity: incident.rule.severity,
            owner: incident.owner, remediation: incident.remediation, firstObservedAt: incident.firstObservedAt,
            lastObservedAt: incident.lastObservedAt, occurrences: incident.occurrences },
          { signal: controller.signal, idempotencyKey: `${claim.incidentId}:${incident.firstObservedAt}` }));
          const interrupted = new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(new Error("INCIDENT_DELIVERY_INTERRUPTED")), { once: true });
          });
          await Promise.race([delivery, interrupted]);
          if (!controller.signal.aborted && await dependencies.store.markDelivered(claim, observedAt)) delivered += 1;
        } catch {
          // Claim acquisition durably increments the attempt count, so an
          // interrupted process consumes one bounded retry slot as well.
          const attempts = incident.deliveryAttempts;
          const next = attempts >= MAX_INCIDENT_DELIVERY_ATTEMPTS ? null : new Date(Date.parse(observedAt) +
            (INCIDENT_DELIVERY_BACKOFF_SECONDS[Math.min(attempts - 1, INCIDENT_DELIVERY_BACKOFF_SECONDS.length - 1)] ?? 43_200) * 1_000).toISOString();
          await dependencies.store.markDeliveryFailed(claim, observedAt, "INCIDENT_DELIVERY_FAILED", next);
          failed += 1;
        } finally {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abortFromWorker);
        }
      }
      return { attempted, delivered, failed };
    },
    resolve(ruleKey: string, scopeKey: string, at: string): Promise<boolean> {
      return dependencies.store.resolve(ruleKey, scopeKey, at);
    },
    async inspect(actor: Readonly<{ kind: string; jobId?: string; purpose: string }>, limit = 100): Promise<Result<readonly Readonly<{
      environment: IncidentEnvironment; code: string; severity: "warning" | "critical"; owner: string; remediation: string;
      firstObservedAt: string; lastObservedAt: string; occurrences: number; deliveryState: string;
      value: number | null; threshold: number | null; unit: string | null; windowSeconds: number | null;
    }>[], Rejection>> {
      if (actor.kind !== "system" || actor.purpose !== "operations.observability.read" || !parseStableId("Job", actor.jobId ?? "").ok ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return err({ kind: "forbidden", code: "OPERATIONS_INCIDENT_ACCESS_DENIED" });
      try { return ok(await dependencies.store.listOpen(limit)); }
      catch { return err({ kind: "temporarily_unavailable", code: "OPERATIONS_INCIDENTS_UNAVAILABLE" }); }
    },
  };
}

export function isDeliverySafeIncidentInput(input: DurableIncidentInput): boolean {
  if (input === null || typeof input !== "object" || input.rule === null || typeof input.rule !== "object") return false;
  return typeof input.scopeKey === "string" && /^[a-zA-Z0-9._:-]{1,128}$/u.test(input.scopeKey) &&
    ["unknown", "local", "test", "staging", "production"].includes(input.environment ?? "unknown") &&
    typeof input.rule.key === "string" && /^[a-z][a-z0-9._-]{2,95}$/u.test(input.rule.key) &&
    typeof input.rule.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(input.rule.code) &&
    (input.rule.severity === "warning" || input.rule.severity === "critical") &&
    ["operations", "content", "measurement", "backup", "identity"].includes(input.rule.owner) &&
    typeof input.rule.remediation === "string" && isKnownIncidentRemediationPointer(input.rule.remediation) &&
    Number.isFinite(input.value) && input.value >= 0 && input.value <= 1_000_000_000_000 &&
    Number.isFinite(input.rule.threshold) && input.rule.threshold >= 0 && input.rule.threshold <= 1_000_000_000_000 &&
    ["seconds", "milliseconds", "hours", "percent", "count"].includes(input.rule.unit) &&
    Number.isSafeInteger(input.rule.windowSeconds) && input.rule.windowSeconds >= 0 && input.rule.windowSeconds <= 604_800 &&
    validUtcInstant(input.firstObservedAt) && validUtcInstant(input.lastObservedAt) &&
    Date.parse(input.firstObservedAt) <= Date.parse(input.lastObservedAt);
}

function validUtcInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function boundedDeliveryValue(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! >= minimum && value! <= maximum ? value! : fallback;
}
