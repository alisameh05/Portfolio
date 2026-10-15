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
      const projectId = event.action === "project-viewed" || event.action === "active-engagement-sampled" || event.action === "media-engaged" || event.action === "testimonial-engaged" || event.action === "contact-channel-opened" || event.action === "external-project-link-opened" || event.action === "global-project-cta-opened"
        ? event.projectId ?? null : null;
      const activeMilliseconds = event.action === "active-engagement-sampled" ? event.activeMilliseconds : null;
      const mediaAssetId = event.action === "media-engaged" ? event.mediaAssetId : null;
      const mediaEngagement = event.action === "media-engaged" ? event.engagement : null;
      const sourceProjectId = event.action === "related-project-opened" ? event.sourceProjectId : null;
      const targetProjectId = event.action === "related-project-opened" ? event.targetProjectId : null;
      const testimonialId = event.action === "testimonial-engaged" ? event.testimonialId : null;
      const contactChannel = event.action === "contact-channel-opened" ? event.channel : null;
      const externalDestination = event.action === "external-project-link-opened" ? event.destination : null;
      await sql`insert into measurement.public_events (
        event_id, portfolio_id, measurement_subject, action, occurred_at, accepted_at, effective_at,
        page_route_identity, project_id, locale, consent_version, journey_context,
        referrer_class, device_class, country_code, active_milliseconds, media_asset_id, media_engagement,
        source_project_id, target_project_id, testimonial_id, contact_channel, external_destination
      ) values (
        ${row.eventId}::uuid, ${row.portfolioId}::uuid, ${row.measurementSubject}::uuid, ${event.action},
        ${event.context.occurredAt}::timestamptz, ${row.acceptedAt}::timestamptz, ${row.effectiveAt}::timestamptz,
        ${event.context.pageRouteIdentity}::uuid, ${projectId}::uuid, ${event.context.locale}, ${event.context.consentVersion},
        ${event.context.journeyContext ?? null}::uuid[], ${event.context.referrerClass ?? null}, ${event.context.deviceClass ?? null},
        ${event.context.countryCode ?? null}, ${activeMilliseconds}, ${mediaAssetId}::uuid, ${mediaEngagement},
        ${sourceProjectId}::uuid, ${targetProjectId}::uuid, ${testimonialId}::uuid, ${contactChannel}, ${externalDestination}
      )`.execute(db);
    },
  };
}
