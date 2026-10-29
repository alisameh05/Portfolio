import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { StableId } from "@shared/domain";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import { parseStableId } from "@shared/domain";
import { PostgresInfrastructureError, postgresFailureCategory } from "../../../shared/adapters/postgres/runtime.js";
import { isDeliverySafeIncidentInput, type DurableIncidentInput, type DurableIncidentRecord, type IncidentLifecycleStore } from "../application/incident-lifecycle.js";
import { MAX_INCIDENT_DELIVERY_BATCH } from "../application/incident-lifecycle.js";
import type { IncidentOwner } from "../application/incident-policy.js";

interface IncidentRow {
  environment: NonNullable<DurableIncidentInput["environment"]>;
  incident_id: string;
  first_observed_at: Date | string;
  last_observed_at: Date | string;
  occurrences: number;
  resolved_at: Date | string | null;
  owner_role: DurableIncidentRecord["owner"];
  remediation_pointer: string;
  delivery_state: DurableIncidentRecord["deliveryState"];
  delivery_attempts: number;
  delivery_lease_token: string | null;
  delivery_lease_generation: number | string;
  delivery_lease_expires_at: Date | string | null;
  measured_value: number | string | null;
  threshold_value: number | string | null;
  measurement_unit: DurableIncidentRecord["rule"]["unit"];
  measurement_window_seconds: number | null;
}

/** PostgreSQL-only persistence adapter. Public DTOs never contain internal scope or source identifiers. */
export function createPostgresIncidentLifecycleStore(database: Kysely<DB>): IncidentLifecycleStore {
  const map = (input: DurableIncidentInput, row: IncidentRow): DurableIncidentRecord => ({
    ...input,
    environment: row.environment,
    rule: { ...input.rule, threshold: row.threshold_value === null ? null : Number(row.threshold_value),
      unit: row.measurement_unit, windowSeconds: row.measurement_window_seconds },
    value: row.measured_value === null ? null : Number(row.measured_value),
    incidentId: row.incident_id as StableId<"OperationsIncident">,
    firstObservedAt: instant(row.first_observed_at),
    lastObservedAt: instant(row.last_observed_at),
    occurrences: row.occurrences,
    state: row.resolved_at === null ? "open" : "resolved",
    deliveryState: row.delivery_state,
    deliveryAttempts: row.delivery_attempts,
    owner: row.owner_role,
    remediation: row.remediation_pointer,
    ...(row.delivery_lease_token === null || row.delivery_lease_expires_at === null ? {} : {
      deliveryClaim: { incidentId: row.incident_id as StableId<"OperationsIncident">,
        token: row.delivery_lease_token, generation: Number(row.delivery_lease_generation),
        leaseExpiresAt: instant(row.delivery_lease_expires_at) },
    }),
  });
  const execute = async <T>(work: (executor: Kysely<DB>) => Promise<T>): Promise<T> => {
    try {
      return await database.transaction().execute(async (transaction) => {
        await sql`set local lock_timeout = '250ms'`.execute(transaction);
        await sql`set local statement_timeout = '2s'`.execute(transaction);
        return work(transaction);
      });
    } catch (error) { throw new PostgresInfrastructureError(postgresFailureCategory(error)); }
  };
  return {
    async upsert(input) {
      if (!parseStableId("OperationsIncident", input.incidentId).ok || !isDeliverySafeIncidentInput(input) ||
          !/^[a-zA-Z0-9._:-]{1,128}$/u.test(input.scopeKey) || !validInstant(input.firstObservedAt) || !validInstant(input.lastObservedAt) ||
          Date.parse(input.firstObservedAt) > Date.parse(input.lastObservedAt)) {
        throw new TypeError("Incident input is invalid.");
      }
      const incidentKey = `${input.rule.key}:${createHash("sha256").update(input.scopeKey).digest("hex")}`;
      return execute(async (executor) => {
        const result = await sql<IncidentRow>`
          insert into operations.incidents
            (incident_id, incident_key, environment, category, source_id, safe_error_code, severity, first_observed_at,
             last_observed_at, occurrences, measured_value, threshold_value, measurement_unit, measurement_window_seconds,
             owner_role, remediation_pointer, delivery_state, next_delivery_at)
          values (${input.incidentId}::uuid, ${incidentKey}, ${input.environment ?? "unknown"}, ${categoryForCode(input.rule.owner, input.rule.code)}, null, ${input.rule.code}, ${input.rule.severity},
                  ${input.firstObservedAt}::timestamptz, ${input.lastObservedAt}::timestamptz, 1, ${input.value},
                  ${input.rule.threshold}, ${input.rule.unit}, ${input.rule.windowSeconds}, ${input.rule.owner},
                  ${input.rule.remediation}, 'pending', ${input.lastObservedAt}::timestamptz)
          on conflict (incident_key) do update set
            safe_error_code = excluded.safe_error_code,
            severity = excluded.severity,
            environment = excluded.environment,
            last_observed_at = greatest(operations.incidents.last_observed_at, excluded.last_observed_at),
            occurrences = case when operations.incidents.resolved_at is not null then 1 else operations.incidents.occurrences + 1 end,
            measured_value = excluded.measured_value,
            threshold_value = excluded.threshold_value,
            measurement_unit = excluded.measurement_unit,
            measurement_window_seconds = excluded.measurement_window_seconds,
            owner_role = excluded.owner_role,
            remediation_pointer = excluded.remediation_pointer,
            resolved_at = null,
            recovery_recorded_at = null,
            delivery_state = case when operations.incidents.resolved_at is not null then 'pending' else operations.incidents.delivery_state end,
            delivery_attempts = case when operations.incidents.resolved_at is not null then 0 else operations.incidents.delivery_attempts end,
            delivery_error_code = case when operations.incidents.resolved_at is not null then null else operations.incidents.delivery_error_code end,
            first_observed_at = case when operations.incidents.resolved_at is not null then excluded.first_observed_at else operations.incidents.first_observed_at end,
            delivery_lease_token = case when operations.incidents.resolved_at is not null then null else operations.incidents.delivery_lease_token end,
            delivery_lease_expires_at = case when operations.incidents.resolved_at is not null then null else operations.incidents.delivery_lease_expires_at end,
            next_delivery_at = case when operations.incidents.resolved_at is not null then excluded.last_observed_at else operations.incidents.next_delivery_at end
          where (operations.incidents.resolved_at is null and excluded.last_observed_at >= operations.incidents.last_observed_at)
             or (operations.incidents.resolved_at is not null and excluded.last_observed_at > operations.incidents.resolved_at)
          returning environment, incident_id::text, first_observed_at, last_observed_at, occurrences, resolved_at,
                    owner_role, remediation_pointer, delivery_state, delivery_attempts,
                    delivery_lease_token, delivery_lease_generation, delivery_lease_expires_at,
                    measured_value, threshold_value, measurement_unit, measurement_window_seconds
        `.execute(executor);
        const row = result.rows[0];
        if (!row) {
          // A stale observation cannot reopen a recovered episode or move the
          // current observation timestamp backwards. Return the durable row.
          const current = await sql<IncidentRow>`select environment, incident_id::text, first_observed_at, last_observed_at,
            occurrences, resolved_at, owner_role, remediation_pointer, delivery_state, delivery_attempts,
            delivery_lease_token, delivery_lease_generation, delivery_lease_expires_at,
            measured_value, threshold_value, measurement_unit, measurement_window_seconds
            from operations.incidents where incident_key=${incidentKey}`.execute(executor);
          if (!current.rows[0]) throw new PostgresInfrastructureError();
          return map(input, current.rows[0]);
        }
        return map(input, row);
      });
    },
    async claimDue(limit, observedAt) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_INCIDENT_DELIVERY_BATCH || !validInstant(observedAt)) throw new TypeError("Incident delivery query is invalid.");
      return execute(async (executor) => {
        const result = await sql<IncidentRow & { incident_key: string; safe_error_code: string; severity: "warning" | "critical" }>`
          with terminal_claims as (
            select incident_id from operations.incidents
             where resolved_at is null and delivery_state='pending' and delivery_attempts >= 8
               and next_delivery_at <= clock_timestamp()
               and (delivery_lease_expires_at is null or delivery_lease_expires_at <= clock_timestamp())
             order by next_delivery_at, incident_id limit ${limit} for update skip locked
          ), expired as (
            update operations.incidents set delivery_state='exhausted', next_delivery_at=null,
              delivery_lease_token=null, delivery_lease_expires_at=null
             where incident_id in (select incident_id from terminal_claims)
             returning incident_id
          ), picked as (
            select incident_id from operations.incidents
             where resolved_at is null and delivery_state = 'pending' and next_delivery_at <= clock_timestamp()
               and delivery_attempts < 8
               and (delivery_lease_expires_at is null or delivery_lease_expires_at <= clock_timestamp())
             order by next_delivery_at, incident_id
             limit ${limit}
             for update skip locked
          )
          update operations.incidents incident set delivery_attempts = incident.delivery_attempts + 1,
            delivery_lease_token = gen_random_uuid(),
            delivery_lease_generation = incident.delivery_lease_generation + 1,
            delivery_lease_expires_at = clock_timestamp() + interval '5 minutes'
            from picked where incident.incident_id = picked.incident_id
          returning incident.environment, incident.incident_id::text, incident.incident_key, incident.safe_error_code, incident.severity,
            incident.first_observed_at, incident.last_observed_at, incident.occurrences, incident.resolved_at,
            incident.owner_role, incident.remediation_pointer, incident.delivery_state, incident.delivery_attempts,
            incident.delivery_lease_token, incident.delivery_lease_generation, incident.delivery_lease_expires_at,
            incident.measured_value, incident.threshold_value, incident.measurement_unit, incident.measurement_window_seconds
        `.execute(executor);
        return result.rows.flatMap((row) => {
          const rule = {
            key: row.incident_key.split(":")[0] ?? "incident.unknown", code: row.safe_error_code,
            severity: row.severity, owner: row.owner_role as IncidentOwner, remediation: row.remediation_pointer,
            threshold: row.threshold_value === null ? null : Number(row.threshold_value),
            unit: row.measurement_unit, windowSeconds: row.measurement_window_seconds,
          };
          return [{
            incidentId: row.incident_id as StableId<"OperationsIncident">,
            scopeKey: "redacted", environment: row.environment, rule, value: row.measured_value === null ? null : Number(row.measured_value),
            firstObservedAt: instant(row.first_observed_at), lastObservedAt: instant(row.last_observed_at),
            occurrences: row.occurrences, state: "open" as const, deliveryState: row.delivery_state,
            deliveryAttempts: row.delivery_attempts, owner: row.owner_role, remediation: row.remediation_pointer,
            deliveryClaim: { incidentId: row.incident_id as StableId<"OperationsIncident">,
              token: row.delivery_lease_token!, generation: Number(row.delivery_lease_generation),
              leaseExpiresAt: instant(row.delivery_lease_expires_at!) },
          }];
        });
      });
    },
    async markDelivered(claim, at) {
      if (!validClaim(claim) || !validInstant(at)) throw new TypeError("Incident delivery outcome is invalid.");
      return execute(async (executor) => {
        const result = await sql`update operations.incidents set delivery_state='delivered', next_delivery_at=null,
          delivery_error_code=null, delivery_lease_token=null, delivery_lease_expires_at=null
          where incident_id=${claim.incidentId}::uuid and resolved_at is null and delivery_state='pending'
            and delivery_lease_token=${claim.token}::uuid and delivery_lease_generation=${claim.generation}
            and delivery_lease_expires_at > clock_timestamp() returning incident_id`.execute(executor);
        return result.rows.length === 1;
      });
    },
    async markDeliveryFailed(claim, at, safeCode, nextAttemptAt) {
      if (!validClaim(claim) || !validInstant(at) || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(safeCode) ||
          (nextAttemptAt !== null && !validInstant(nextAttemptAt))) throw new TypeError("Incident delivery outcome is invalid.");
      return execute(async (executor) => {
        const result = await sql`update operations.incidents set
          delivery_state=case when ${nextAttemptAt === null} or delivery_attempts >= 8 then 'exhausted' else 'pending' end,
          next_delivery_at=${nextAttemptAt}::timestamptz, delivery_error_code=${safeCode},
          delivery_lease_token=null, delivery_lease_expires_at=null
          where incident_id=${claim.incidentId}::uuid and resolved_at is null and delivery_state='pending'
            and delivery_lease_token=${claim.token}::uuid and delivery_lease_generation=${claim.generation}
            and delivery_lease_expires_at > clock_timestamp() returning incident_id`.execute(executor);
        return result.rows.length === 1;
      });
    },
    async resolve(ruleKey, scopeKey, at) {
      if (!/^[a-z][a-z0-9._-]{2,95}$/u.test(ruleKey) || !/^[a-zA-Z0-9._:-]{1,128}$/u.test(scopeKey) || !validInstant(at)) throw new TypeError("Incident recovery input is invalid.");
      const incidentKey = `${ruleKey}:${createHash("sha256").update(scopeKey).digest("hex")}`;
      return execute(async (executor) => {
        const result = await sql<{ incident_id: string }>`update operations.incidents
          set resolved_at=${at}::timestamptz, recovery_recorded_at=${at}::timestamptz, delivery_state='not-required', next_delivery_at=null,
            delivery_lease_token=null, delivery_lease_expires_at=null
          where incident_key=${incidentKey} and resolved_at is null and recovery_recorded_at is null
            and last_observed_at <= ${at}::timestamptz
          returning incident_id::text`.execute(executor);
        return result.rows.length === 1;
      });
    },
    async listOpen(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError("Incident inspection limit is invalid.");
      return execute(async (executor) => {
        const result = await sql<IncidentRow & { safe_error_code: string; severity: "warning" | "critical";
          measured_value: number | string | null; threshold_value: number | string | null; measurement_unit: string | null; measurement_window_seconds: number | null }>`
          select environment, safe_error_code, severity, first_observed_at, last_observed_at, occurrences, owner_role,
            measured_value, threshold_value, measurement_unit, measurement_window_seconds,
            remediation_pointer, delivery_state, delivery_attempts, incident_id::text, resolved_at
            from operations.incidents where resolved_at is null order by last_observed_at desc, incident_id limit ${limit}
        `.execute(executor);
        return result.rows.map((row) => ({ environment: row.environment, code: row.safe_error_code, severity: row.severity, owner: row.owner_role,
          remediation: row.remediation_pointer, firstObservedAt: instant(row.first_observed_at),
          lastObservedAt: instant(row.last_observed_at), occurrences: row.occurrences, deliveryState: row.delivery_state,
          value: row.measured_value === null ? null : Number(row.measured_value),
          threshold: row.threshold_value === null ? null : Number(row.threshold_value), unit: row.measurement_unit,
          windowSeconds: row.measurement_window_seconds }));
      });
    },
  };
}

function validInstant(value: string): boolean { const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value; }
function instant(value: Date | string): string { return new Date(value).toISOString(); }
function validClaim(value: unknown): value is { incidentId: StableId<"OperationsIncident">; token: string; generation: number } {
  if (value === null || typeof value !== "object") return false;
  const claim = value as { incidentId?: unknown; token?: unknown; generation?: unknown };
  // Historical terminal-work producers use PostgreSQL gen_random_uuid().
  // These internal durable identities are UUIDv4; new observations use UUIDv7.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  return typeof claim.incidentId === "string" && uuid.test(claim.incidentId) &&
    typeof claim.token === "string" && uuid.test(claim.token) &&
    typeof claim.generation === "number" && Number.isSafeInteger(claim.generation) && claim.generation > 0;
}

function categoryForCode(owner: string, code: string): "job" | "outbox" | "export" | "publication" | "retention" | "backup" | "recovery" {
  if (code.startsWith("OUTBOX_")) return "outbox";
  if (code.startsWith("JOB_")) return "job";
  if (code.startsWith("PUBLICATION_")) return "publication";
  if (code.startsWith("PRIVACY_")) return "retention";
  if (code.startsWith("BACKUP_") || code.startsWith("RELATIONAL_BACKUP_") || code.startsWith("OBJECT_BACKUP_")) return "backup";
  if (code.startsWith("RECOVERY_")) return "recovery";
  if (owner === "identity") return "export";
  return "export";
}
