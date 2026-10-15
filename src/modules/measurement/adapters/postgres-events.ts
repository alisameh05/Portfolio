import { sql } from "kysely";
import type { PublicEventData } from "../domain/index.js";
import type { MeasurementEventRepositoryPort, MeasurementEventRetentionRepositoryPort } from "../application/ingest-event.js";
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

/** Bounded, portfolio-scoped cleanup for the purpose-authorized Measurement retention worker. */
export function createPostgresMeasurementEventRetentionRepository(): MeasurementEventRetentionRepositoryPort {
  return {
    async expireAcceptedEvents(input, transaction) {
      const db = resolvePostgresTransaction(transaction);
      await sql`set local role shipwithali_worker`.execute(db);
      await sql`select set_config('shipwithali.portfolio_id', ${input.portfolioId}, true)`.execute(db);
      const result = await sql<{ readonly event_id: string }>`
        with expired as (
          select event_id
          from measurement.public_events
          where portfolio_id = ${input.portfolioId}::uuid
            and accepted_at <= ${input.acceptedBefore}::timestamptz
          order by accepted_at, event_id
          limit ${input.limit}
        )
        delete from measurement.public_events as events
        using expired
        where events.event_id = expired.event_id
        returning events.event_id::text
      `.execute(db);
      return result.rows.length;
    },
  };
}
