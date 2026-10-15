import { sql } from "kysely";
import type { PublicEventData } from "../domain/index.js";
import type { MeasurementEventRepositoryPort } from "../application/ingest-event.js";
import { resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";

/** Measurement-owned insert path; the application role cannot read raw subjects or event detail. */
export function createPostgresMeasurementEventRepository(): MeasurementEventRepositoryPort {
  return {
    async insert(row, transaction) {
      const db = resolvePostgresTransaction(transaction);
      await sql`select set_config('shipwithali.portfolio_id', ${row.portfolioId}, true)`.execute(db);
      const event = row.event;
      const projectId = event.action === "project-viewed" || event.action === "active-engagement-sampled"
        ? event.projectId ?? null : null;
      const activeMilliseconds = event.action === "active-engagement-sampled" ? event.activeMilliseconds : null;
      await sql`insert into measurement.public_events (
        event_id, portfolio_id, measurement_subject, action, occurred_at, accepted_at, effective_at,
        page_route_identity, project_id, locale, consent_version, journey_context,
        referrer_class, device_class, country_code, active_milliseconds
      ) values (
        ${row.eventId}::uuid, ${row.portfolioId}::uuid, ${row.measurementSubject}::uuid, ${event.action},
        ${event.context.occurredAt}::timestamptz, ${row.acceptedAt}::timestamptz, ${row.effectiveAt}::timestamptz,
        ${event.context.pageRouteIdentity}::uuid, ${projectId}::uuid, ${event.context.locale}, ${event.context.consentVersion},
        ${event.context.journeyContext ?? null}::uuid[], ${event.context.referrerClass ?? null}, ${event.context.deviceClass ?? null},
        ${event.context.countryCode ?? null}, ${activeMilliseconds}
      )`.execute(db);
    },
  };
}
