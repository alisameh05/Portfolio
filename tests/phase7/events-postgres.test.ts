import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, parseIdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createSystemIdGenerator, createTestLogger, type TransactionContext } from "../../src/runtime/ports.js";
import { createPostgresRuntimeDatabase, resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresConsentRepository } from "../../src/modules/measurement/adapters/postgres-consent.js";
import { createPostgresMeasurementEventRepository } from "../../src/modules/measurement/adapters/postgres-events.js";
import { createPostgresContentMeasurementPublicFacts } from "../../src/modules/content-publishing/adapters/postgres-interaction-facts.js";
import { createPostgresMeasurementConfigurationPublicFacts } from "../../src/modules/portfolio-configuration/adapters/postgres-measurement-public-facts.js";
import { createMediaAcceptanceApplicationService } from "../../src/modules/media/index.js";
import { createPostgresMediaAcceptanceRepository } from "../../src/modules/media/adapters/postgres-acceptance.js";
import { createPortfolioSettingsReader, type MeasurementConfigurationPublicFactsPort } from "../../src/modules/portfolio-configuration/index.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createConsentApplicationService, createMeasurementEventService, type PublicMeasurementEvent, type VerifiedMeasurementEvidence } from "../../src/modules/measurement/index.js";
import type { MeasurementEventRepositoryPort, MeasurementMediaPublicFactsPort } from "../../src/modules/measurement/application/ingest-event.js";
import type { ConsentApplicationService, ConsentRepositoryPort } from "../../src/modules/measurement/application/consent.js";
import { AesGcmConsentEvidenceAdapter } from "../../src/modules/identity-access/adapters/consent-evidence.js";
import { handlePostPublicEvent } from "../../src/runtime/http/public-event.js";
import { initializeDatabaseRuntime, getMeasurementEventIngestionService, getConsentApplicationService, resetRuntimeForTests } from "../../src/bootstrap/composition-root.js";

const url = process.env["PHASE7_EVENT_DATABASE_URL"];
describe.runIf(Boolean(url))("durable consented public-event ingestion", () => {
  const portfolioId = createStableId("Portfolio"), ownerId = createStableId("Owner");
  const scope = { kind: "portfolio" as const, portfolioId };
  let now = "2026-10-15T12:00:00.000Z";
  const config = {
    functional: { active: { version: 1, secret: Buffer.alloc(32, 11).toString("base64url") }, previous: [] },
    measurement: { active: { version: 1, secret: Buffer.alloc(32, 22).toString("base64url") }, previous: [] },
  };
  const database = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const otherDatabase = createPostgresRuntimeDatabase(url ?? "postgres://invalid");
  const admin = new Client({ connectionString: process.env["PHASE7_EVENT_ADMIN_URL"] });
  const operations = createPostgresOperationsPersistence(database.database, { now: () => now });
  const otherOperations = createPostgresOperationsPersistence(otherDatabase.database, { now: () => now });
  const consentRepository = createPostgresConsentRepository();
  const consent = createConsentApplicationService({ transactions: database.transactions, repository: consentRepository,
    crypto: new AesGcmConsentEvidenceAdapter(config, () => now), clock: { now: () => now }, ids: createSystemIdGenerator(),
    supportedNoticeVersions: ["2026-10"], ttlSeconds: 2_592_000 });
  const content = createPostgresContentMeasurementPublicFacts({ portfolioId, ownerId });
  const configuration = createPostgresMeasurementConfigurationPublicFacts({ portfolioId, ownerId });
  const repository = createPostgresMeasurementEventRepository();
  const makeService = (options: { operations?: typeof operations; repository?: MeasurementEventRepositoryPort; facts?: typeof content; media?: MeasurementMediaPublicFactsPort; configuration?: MeasurementConfigurationPublicFactsPort; omitConfiguration?: boolean; consentService?: ConsentApplicationService } = {}) => createMeasurementEventService({
    portfolioId, transactions: (options.operations ?? operations).transactions, operations: options.operations ?? operations,
    consent: options.consentService ?? consent, content: options.facts ?? content, ...(options.media ? { media: options.media } : {}),
    ...(options.omitConfiguration ? {} : { configuration: options.configuration ?? configuration }), repository: options.repository ?? repository,
    clock: { now: () => now }, ids: createSystemIdGenerator(),
  });
  const service = makeService();
  const key = (value: string = createStableId("Key")) => { const parsed = parseIdempotencyKey(value); if (!parsed.ok) throw new Error("KEY"); return parsed.value; };
  const context = (routeId: StableId<"PublicRoute">, overrides: Record<string, unknown> = {}) => ({
    occurredAt: now, locale: "en" as const, consentVersion: "2026-10", pageRouteIdentity: routeId,
    referrerClass: "professional" as const, deviceClass: "desktop" as const, countryCode: "EG", ...overrides,
  });
  const pageEvent = (routeId: StableId<"PublicRoute">, overrides: Record<string, unknown> = {}): PublicMeasurementEvent => ({ action: "page-viewed", context: context(routeId, overrides) as never });
  const command = (event: PublicMeasurementEvent, evidence: VerifiedMeasurementEvidence, keyValue = key()) => ({
    scope, correlationId: "event-integration", actor: { kind: "visitor" as const, consent: "granted" as const },
    measurement: evidence, idempotencyKey: keyValue, event,
  });
  async function issueEvidence() {
    const granted = await consent.recordConsent({ scope, correlationId: "event-consent", consent: "granted", noticeVersion: "2026-10", expectedRevision: 0 });
    expect(granted.ok).toBe(true); if (!granted.ok || !granted.value.evidence) throw new Error("CONSENT_GRANT_FAILED");
    const verified = await consent.verifyEvidence({ scope, correlationId: "event-consent", noticeVersion: "2026-10", token: granted.value.evidence });
    expect(verified.ok).toBe(true); if (!verified.ok) throw new Error("CONSENT_VERIFY_FAILED");
    return { ...granted.value, token: granted.value.evidence, verified: verified.value };
  }
  async function seedProject(options: { lifecycle?: string; locales?: readonly ("en" | "ar")[]; portfolio?: StableId<"Portfolio">; externalLinks?: readonly { readonly type?: "github-repository" | "live-demo"; readonly label: string; readonly destination: string; readonly availableInArabic?: boolean }[] } = {}) {
    const projectId = createStableId("Project"), routeId = createStableId("PublicRoute"), targetPortfolio = options.portfolio ?? portfolioId;
    const lifecycle = options.lifecycle ?? "published", locales = options.locales ?? ["en"];
    await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project',$3)", [projectId, targetPortfolio, lifecycle]);
    await admin.query("insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)", [routeId, projectId, targetPortfolio, "project-" + projectId, now]);
    for (const locale of locales) {
      const revision = createStableId("Revision"), review = createStableId("ContentReview");
      const payload = { contentType: "project", locale, title: "Private fixture title", summary: "Fixture summary", body: "Fixture body" };
      await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project',$4,1,1,'Private fixture title','Fixture summary','Fixture body',$5,$6)", [revision, projectId, targetPortfolio, locale, payload, now]);
      await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,$5,1,$6,1,$7,'accepted',$8)", [review, projectId, targetPortfolio, revision, locale, "a".repeat(64), ownerId, now]);
      await admin.query("insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project',$3,$4,$5,$6,1,$7)", [projectId, targetPortfolio, locale, revision, review, routeId, now]);
      if (options.externalLinks !== undefined) {
        const publicLinks = locale === "en" ? options.externalLinks : options.externalLinks.filter(link => link.availableInArabic === true);
        await admin.query(`insert into content.public_project_locales
          (content_id,portfolio_id,content_type,locale,revision_id,route_identity,title,summary,body,case_study,claims,external_links,first_published_at,published_at)
          values ($1,$2,'project',$3,$4,$5,'Private fixture title','Fixture summary','Fixture body','{}'::jsonb,'[]'::jsonb,$6::jsonb,$7,$7)
          on conflict (content_id,locale) do update set revision_id=excluded.revision_id, route_identity=excluded.route_identity,
            external_links=excluded.external_links, published_at=excluded.published_at`,
          [projectId, targetPortfolio, locale, revision, routeId, JSON.stringify(publicLinks.map(({ type, label, destination }) => ({ ...(type === undefined ? {} : { type }), label, destination }))), now]);
      }
    }
    return { projectId, routeId };
  }
  async function seedTestimonial(projectId?: StableId<"Project">) {
    const testimonialId = createStableId("Testimonial"), revision = createStableId("Revision"), review = createStableId("ContentReview");
    const payload = { contentType: "testimonial", locale: "en", authorName: "Fixture author", quote: "Private fixture quote", associationType: projectId ? "project" : "profile", projectId };
    await admin.query("insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'testimonial','published')", [testimonialId, portfolioId]);
    await admin.query("insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'testimonial','en',1,1,'Fixture testimonial','Fixture summary','Fixture body',$4,$5)", [revision, testimonialId, portfolioId, payload, now]);
    await admin.query("insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'testimonial',$4,'en',1,$5,1,$6,'accepted',$7)", [review, testimonialId, portfolioId, revision, "b".repeat(64), ownerId, now]);
    await admin.query("insert into content.testimonial_language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,publication_sequence,published_at) values ($1,$2,'testimonial','en',$3,$4,1,$5)", [testimonialId, portfolioId, revision, review, now]);
    await admin.query("insert into content.public_testimonial_locales (content_id,portfolio_id,content_type,locale,revision_id,author_name,quote,association_type,project_id,published_at) values ($1,$2,'testimonial','en',$3,'Fixture author','Private fixture quote',$4,$5,$6)", [testimonialId, portfolioId, revision, projectId ? "project" : "profile", projectId ?? null, now]);
    return testimonialId;
  }
  async function seedAcceptedProfileMedia(options: { setAsProfile?: boolean } = {}) {
    const mediaAssetId = createStableId("MediaAsset"), uploadIntentId = createStableId("MediaUploadIntent");
    const sourceObjectId = createStableId("MediaObject"), outputObjectId = createStableId("MediaObject");
    const attemptId = createStableId("MediaProcessingAttempt"), decisionId = createStableId("MediaDecision");
    const digest = "c".repeat(64), outputDigest = "d".repeat(64), byteLength = 25, timestamp = now;
    await admin.query("insert into media.assets (media_id,portfolio_id,owner_id,kind,original_file_name,declared_media_type,declared_byte_length,declared_sha256) values ($1,$2,$3,'document','event-evidence.pdf','application/pdf',$4,$5)", [mediaAssetId, portfolioId, ownerId, byteLength, digest]);
    await admin.query("insert into media.upload_intents (upload_intent_id,media_id,media_object_id,portfolio_id,owner_id,expires_at) values ($1,$2,$3,$4,$5,$6)", [uploadIntentId, mediaAssetId, sourceObjectId, portfolioId, ownerId, timestamp]);
    await admin.query("insert into media.processed_objects (object_id,portfolio_id,owner_id,media_id,source_object_id,sha256,byte_length,mime_type,object_version) values ($1,$2,$3,$4,$5,$6,$7,'application/pdf','fixture-v1')", [outputObjectId, portfolioId, ownerId, mediaAssetId, sourceObjectId, outputDigest, byteLength]);
    await admin.query("insert into media.processing_attempts (attempt_id,portfolio_id,owner_id,media_id,input_object_id,input_sha256,detected_mime_type,detected_byte_length,result,output_object_id,output_sha256,scanner_version,processor_version,policy_version,finding_codes,started_at,finished_at) values ($1,$2,$3,$4,$5,$6,'application/pdf',$7,'passed',$8,$9,'fixture-scanner-v1','fixture-processor-v1','pdf-active-content-deny-1','[]'::jsonb,$10,$10)", [attemptId, portfolioId, ownerId, mediaAssetId, sourceObjectId, digest, byteLength, outputObjectId, outputDigest, timestamp]);
    await admin.query("insert into media.processing_states (media_id,portfolio_id,owner_id,aggregate_version,latest_attempt_id) values ($1,$2,$3,3,$4)", [mediaAssetId, portfolioId, ownerId, attemptId]);
    await admin.query("insert into media.decision_history (decision_id,portfolio_id,owner_id,media_id,aggregate_version,decision,processing_attempt_id,input_object_id,input_sha256,detected_mime_type,detected_byte_length,scanner_version,processor_version,processing_policy_version,sealed_outputs,accessibility,ownership_attested_by,ownership_attested_at,public_suitability_attested_by,public_suitability_attested_at,decided_by,decided_at) values ($1,$2,$3,$4,3,'accepted',$5,$6,$7,'application/pdf',$8,'fixture-scanner-v1','fixture-processor-v1','pdf-active-content-deny-1',$9::jsonb,$10::jsonb,$3,$11,$3,$11,$3,$11)", [decisionId, portfolioId, ownerId, mediaAssetId, attemptId, sourceObjectId, digest, byteLength,
      JSON.stringify([{ objectId: outputObjectId, sha256: outputDigest, byteLength, mimeType: "application/pdf", objectVersion: "fixture-v1", variantName: "document" }]),
      JSON.stringify({ kind: "document", summary: "Public evidence document." }), timestamp]);
    if (options.setAsProfile !== false) {
      await admin.query("update portfolio_config.settings set profile_media_asset_id=$3 where portfolio_id=$1 and owner_id=$2", [portfolioId, ownerId, mediaAssetId]);
    }
    const mediaAcceptance = createMediaAcceptanceApplicationService({ scope: { portfolioId, ownerId }, repository: createPostgresMediaAcceptanceRepository({
      database: database.database, transactions: database.transactions, scope: { portfolioId, ownerId },
    }) });
    const profileSettings = createPortfolioSettingsReader({ repository: createPostgresPortfolioSettingsRepository(),
      transactions: database.transactions, scope: { portfolioId, ownerId } });
    const mediaFacts: MeasurementMediaPublicFactsPort = { async getPublicUseFact(query, transaction) {
      const acceptance = await mediaAcceptance.getAcceptanceFacts({ ownerId, mediaAssetIds: [query.mediaAssetId], intendedUse: "supporting-artifact" }, transaction);
      if (!acceptance.ok) return acceptance;
      const accepted = acceptance.value[0];
      if (!accepted || !accepted.accepted || !accepted.safe || !accepted.suitable || !accepted.accessible) return { ok: true, value: false };
      return profileSettings.isPublicProfileMediaUse({ mediaAssetId: query.mediaAssetId, locale: query.locale }, transaction);
    } };
    return { mediaAssetId, mediaFacts };
  }
  async function countEvents() { return Number((await admin.query("select count(*)::int as count from measurement.public_events where portfolio_id=$1", [portfolioId])).rows[0].count); }
  async function countJobs() { return Number((await admin.query("select count(*)::int as count from operations.jobs where job_type='measurement.public-event-received.v1'")).rows[0].count); }
  function request(token: string | undefined, event: unknown, keyValue = "http-event-key-01") {
    return new Request("https://example.com/api/v1/events", { method: "POST", headers: {
      "Idempotency-Key": keyValue, "content-type": "application/json", ...(token === undefined ? {} : { cookie: `sw_analytics_consent=${token}` }),
    }, body: JSON.stringify(event) });
  }
  beforeAll(async () => {
    await admin.connect();
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable')", [portfolioId, ownerId]);
    await admin.query("insert into portfolio_config.contact_channels(portfolio_id,position,channel,label,destination,available_locales) values ($1,0,'linkedin','Private channel label','https://linkedin.com/in/private','[\"en\"]'::jsonb)", [portfolioId]);
    await admin.query("insert into portfolio_config.contact_channels(portfolio_id,position,channel,label,destination,available_locales) values ($1,1,'whatsapp','Private alternate label','https://wa.me/15555550123','[\"en\"]'::jsonb)", [portfolioId]);
  });
  afterAll(async () => { await admin.end(); await database.resource.close(); await otherDatabase.resource.close(); resetRuntimeForTests(); });

  it("T09-01/T09-03 persists each first-slice action and round-trips the full safe context", async () => {
    const { projectId, routeId } = await seedProject();
    const evidence = await issueEvidence();
    const events: PublicMeasurementEvent[] = [
      { action: "page-viewed", context: context(routeId, { journeyContext: [routeId] }) },
      { action: "project-viewed", projectId, context: context(routeId, { journeyContext: [routeId], referrerClass: "search", deviceClass: "tablet" }) },
      { action: "active-engagement-sampled", projectId, activeMilliseconds: 12_500, context: context(routeId, { journeyContext: [routeId], countryCode: "EG" }) },
    ];
    const receipts = [];
    for (const event of events) {
      const response = await handlePostPublicEvent(request(evidence.token, event, "http-" + event.action), { scope, service, consent, logger: createTestLogger() });
      expect(response.status, `${event.action}: ${await response.clone().text()}`).toBe(202);
      const body = await response.json() as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(["acceptedAt", "eventId"]);
      receipts.push(body);
    }
    expect(await countEvents()).toBe(3);
    expect(await countJobs()).toBe(3);
    const rows = await admin.query(`select event_id::text, measurement_subject::text, action, page_route_identity::text, project_id::text,
      locale, consent_version, journey_context::text[], referrer_class, device_class, country_code, active_milliseconds,
      to_char(occurred_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
      to_char(accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as accepted_at,
      to_char(effective_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_at
      from measurement.public_events where portfolio_id=$1 order by action`, [portfolioId]);
    const engagement = rows.rows.find(row => row.action === "active-engagement-sampled");
    expect(engagement).toMatchObject({ page_route_identity: routeId, project_id: projectId, locale: "en", consent_version: "2026-10",
      journey_context: [routeId], referrer_class: "professional", device_class: "desktop", country_code: "EG", active_milliseconds: 12_500 });
    expect(JSON.stringify({ receipts, jobs: await admin.query("select payload from operations.jobs where job_type='measurement.public-event-received.v1'") })).not.toContain(evidence.verified.subject);
    expect(JSON.stringify(receipts)).not.toContain(evidence.verified.subject);
  });

  it("T11-01/T11-03/T11-04/T11-06/T11-08 records only current configured capability facts and stable public identities", async () => {
    const { projectId, routeId } = await seedProject({ locales: ["en", "ar"], externalLinks: [
      { type: "github-repository", label: "Private GitHub label", destination: "https://github.com/private-owner/private-repo" },
      { type: "live-demo", label: "Private demo label", destination: "https://private-demo.example/project", availableInArabic: true },
    ] });
    const evidence = await issueEvidence();
    const beforeEvents = await countEvents(), beforeJobs = await countJobs();
    for (const destination of ["github-repository", "live-demo"] as const) {
      const fact = await database.transactions.run(tx => content.getExternalProjectLinkFact({ portfolioId, projectId, destination, locale: "en" }, tx));
      expect(fact, destination).toEqual({ ok: true, value: true });
    }
    const events: PublicMeasurementEvent[] = [
      { action: "contact-channel-opened", context: context(routeId), channel: "linkedin" },
      { action: "external-project-link-opened", context: context(routeId), projectId, destination: "github-repository" },
      { action: "external-project-link-opened", context: context(routeId), projectId, destination: "live-demo" },
      { action: "global-project-cta-opened", context: context(routeId), projectId },
    ];
    const arabicDemo: PublicMeasurementEvent = {
      action: "external-project-link-opened", context: context(routeId, { locale: "ar" }), projectId, destination: "live-demo",
    };
    let externalReceipt: unknown;
    const receipts: unknown[] = [];
    const logs: unknown[] = [];
    for (const [index, event] of events.entries()) {
      const eventKey = `ticket-198-event-${index + 1}`;
      const logger = createTestLogger();
      const response = await handlePostPublicEvent(request(evidence.token, event, eventKey), { scope, service, consent, logger });
      logs.push(...logger.records);
      if (response.status !== 202) throw new Error(`T11_ACTION_FAILED:${index}:${event.action}:${await response.clone().text()}`);
      const receipt = await response.json() as Record<string, unknown>;
      expect(Object.keys(receipt).sort()).toEqual(["acceptedAt", "eventId"]);
      receipts.push(receipt);
      if (index === 1) externalReceipt = receipt;
    }
    const arabicLogger = createTestLogger();
    const arabicResponse = await handlePostPublicEvent(request(evidence.token, arabicDemo, "ticket-198-arabic-demo"), {
      scope, service, consent, logger: arabicLogger,
    });
    expect(arabicResponse.status).toBe(202);
    const arabicReceipt = await arabicResponse.json() as { eventId: string; acceptedAt: string };
    receipts.push(arabicReceipt);
    logs.push(...arabicLogger.records);
    const arabicRow = await admin.query("select action, locale, external_destination from measurement.public_events where event_id=$1", [arabicReceipt.eventId]);
    expect(arabicRow.rows).toEqual([{ action: "external-project-link-opened", locale: "ar", external_destination: "live-demo" }]);
    await admin.query("update content.public_routes set current_slug='renamed-after-interaction' where route_identity=$1", [routeId]);
    const replay = await handlePostPublicEvent(request(evidence.token, events[1], "ticket-198-event-2"), { scope, service, consent, logger: createTestLogger() });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(externalReceipt);
    const conflict = await handlePostPublicEvent(request(evidence.token, { ...events[1]!, destination: "live-demo" }, "ticket-198-event-2"), { scope, service, consent, logger: createTestLogger() });
    expect(conflict.status).toBe(409);
    expect(await countEvents()).toBe(beforeEvents + 5);
    expect(await countJobs()).toBe(beforeJobs + 5);
    const rows = await admin.query(`select action, page_route_identity::text, project_id::text, contact_channel, external_destination
      from measurement.public_events where event_id = any($1::uuid[]) order by action, external_destination`, [
      (await admin.query("select event_id from measurement.public_events where action in ('contact-channel-opened','external-project-link-opened','global-project-cta-opened') order by accepted_at desc limit 5")).rows.map(row => row.event_id),
    ]);
    expect(rows.rows).toEqual(expect.arrayContaining([
      { action: "contact-channel-opened", page_route_identity: routeId, project_id: null, contact_channel: "linkedin", external_destination: null },
      { action: "external-project-link-opened", page_route_identity: routeId, project_id: projectId, contact_channel: null, external_destination: "github-repository" },
      { action: "external-project-link-opened", page_route_identity: routeId, project_id: projectId, contact_channel: null, external_destination: "live-demo" },
      { action: "global-project-cta-opened", page_route_identity: routeId, project_id: projectId, contact_channel: null, external_destination: null },
    ]));
    expect(JSON.stringify(rows.rows)).not.toContain("Private GitHub label");
    expect(JSON.stringify(rows.rows)).not.toContain("Private demo label");
    expect(JSON.stringify(rows.rows)).not.toContain("private-demo.example");
    expect(JSON.stringify(rows.rows)).not.toContain("Private fixture title");
    expect(JSON.stringify(logs)).not.toContain("Private");
    expect(JSON.stringify(logs)).not.toContain("github.com");
    const jobPayloads = await admin.query("select payload from operations.jobs where job_type='measurement.public-event-received.v1' and payload->>'eventId' in (select event_id::text from measurement.public_events where accepted_at >= $1)", [now]);
    const privateOutputs = JSON.stringify({ receipts, jobs: jobPayloads.rows, logs });
    expect(privateOutputs).not.toContain(evidence.verified.subject);
    expect(privateOutputs).not.toContain("Private GitHub label");
    expect(privateOutputs).not.toContain("private-demo.example");

    const providerSentinel = "provider-connection-error-secret-sentinel";
    const failureLogger = createTestLogger();
    const failedRequest = await handlePostPublicEvent(request(evidence.token, events[0], "ticket-198-provider-failure"), {
      scope, consent, logger: failureLogger,
      service: { async ingestEvent() { throw new Error(`database connection failed: ${providerSentinel}`); } },
    });
    expect(failedRequest.status).toBe(500);
    expect(await failedRequest.text()).not.toContain(providerSentinel);
    expect(JSON.stringify(failureLogger.records)).not.toContain(providerSentinel);
    expect(JSON.stringify({ receipts, jobs: jobPayloads.rows, logs: logs.concat(failureLogger.records) })).not.toContain(evidence.verified.subject);
  });

  it("T11-02/T11-03/T11-05 rejects absent or mismatched current configuration without durable effects", async () => {
    const { projectId, routeId } = await seedProject({ locales: ["en", "ar"], externalLinks: [
      { type: "github-repository", label: "English-only repository", destination: "https://github.com/private-owner/private-repo" },
    ] });
    const untypedProject = await seedProject({ externalLinks: [
      { label: "Documentation, not a demo", destination: "https://docs.example.com/guide" },
    ] });
    const evidence = await issueEvidence();
    const beforeEvents = await countEvents(), beforeJobs = await countJobs();
    const invalidEvents: PublicMeasurementEvent[] = [
      { action: "contact-channel-opened", context: context(routeId), channel: "instagram" },
      { action: "contact-channel-opened", context: context(routeId, { locale: "ar" }), channel: "linkedin" },
      { action: "external-project-link-opened", context: context(routeId, { locale: "ar" }), projectId, destination: "github-repository" },
      { action: "external-project-link-opened", context: context(routeId), projectId: createStableId("Project"), destination: "github-repository" },
      { action: "global-project-cta-opened", context: context(routeId), projectId: createStableId("Project") },
      { action: "external-project-link-opened", context: context(untypedProject.routeId), projectId: untypedProject.projectId, destination: "live-demo" },
    ];
    for (const [index, event] of invalidEvents.entries()) {
      const response = await handlePostPublicEvent(request(evidence.token, event, `ticket-198-rejected-${index + 1}`), { scope, service, consent, logger: createTestLogger() });
      expect(response.status).not.toBe(202);
    }
    const privacySentinels = ["https://private-referrer.example/path?token=private-referrer-sentinel", "192.0.2.77"];
    const privacyLogger = createTestLogger();
    const privateDimensions = await handlePostPublicEvent(request(evidence.token, {
      action: "contact-channel-opened", context: { ...context(routeId), fullReferrer: privacySentinels[0], ipAddress: privacySentinels[1] }, channel: "linkedin",
    }, "ticket-198-private-dimensions"), { scope, service, consent, logger: privacyLogger });
    expect(privateDimensions.status).toBe(400);
    expect(JSON.stringify(privacyLogger.records)).not.toContain(privacySentinels[0]);
    expect(JSON.stringify(privacyLogger.records)).not.toContain(privacySentinels[1]);
    const unavailable = await makeService({ omitConfiguration: true }).ingestEvent(command(invalidEvents[0]!, evidence.verified, key("ticket-198-missing-capability")));
    expect(unavailable).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
    expect(await countEvents()).toBe(beforeEvents);
    expect(await countJobs()).toBe(beforeJobs);
  });

  it("T11-07 replays and conflicts for each current capability fact exactly once", async () => {
    const { projectId, routeId } = await seedProject({ externalLinks: [
      { type: "github-repository", label: "Replay repository", destination: "https://github.com/replay-owner/replay-project" },
      { type: "live-demo", label: "Replay demo", destination: "https://replay-demo.example/project" },
    ] });
    const evidence = await issueEvidence();
    const beforeEvents = await countEvents(), beforeJobs = await countJobs();
    const liveDemoFact = await database.transactions.run(tx => content.getExternalProjectLinkFact({ portfolioId, projectId, destination: "live-demo", locale: "en" }, tx));
    expect(liveDemoFact).toEqual({ ok: true, value: true });
    const events: PublicMeasurementEvent[] = [
      { action: "contact-channel-opened", context: context(routeId), channel: "linkedin" },
      { action: "external-project-link-opened", context: context(routeId), projectId, destination: "github-repository" },
      { action: "global-project-cta-opened", context: context(routeId), projectId },
    ];
    for (const [index, event] of events.entries()) {
      const keyValue = `ticket-198-replay-${index + 1}`;
      const first = await service.ingestEvent(command(event, evidence.verified, key(keyValue)));
      expect(await service.ingestEvent(command(event, evidence.verified, key(keyValue)))).toEqual(first);
      const changed = index === 0 ? { ...event, channel: "whatsapp" } as PublicMeasurementEvent :
        index === 1 ? { ...event, destination: "live-demo" } as PublicMeasurementEvent :
          { ...event, context: context(routeId, { referrerClass: "search" }) } as PublicMeasurementEvent;
      expect(await service.ingestEvent(command(changed, evidence.verified, key(keyValue))), event.action).toMatchObject({ ok: false, error: { kind: "conflict" } });
    }
    expect(await countEvents()).toBe(beforeEvents + 3);
    expect(await countJobs()).toBe(beforeJobs + 3);
  });

  it("T10-01/T10-04 persists related-project and testimonial actions with exact current public associations", async () => {
    const source = await seedProject(), target = await seedProject();
    const left = source.projectId < target.projectId ? source.projectId : target.projectId;
    const right = source.projectId < target.projectId ? target.projectId : source.projectId;
    await admin.query("insert into content.project_relationships (portfolio_id,left_project_id,right_project_id,created_by) values ($1,$2,$3,$4)", [portfolioId, left, right, ownerId]);
    await admin.query("insert into content.project_relationship_views (portfolio_id,project_id,related_project_id,left_project_id,right_project_id) values ($1,$2,$3,$4,$5),($1,$3,$2,$4,$5)", [portfolioId, left, right, left, right]);
    const profileTestimonial = await seedTestimonial();
    const projectTestimonial = await seedTestimonial(source.projectId);
    const evidence = await issueEvidence();
    const before = await countEvents(), beforeJobs = await countJobs();
    const events: PublicMeasurementEvent[] = [
      { action: "related-project-opened", sourceProjectId: source.projectId, targetProjectId: target.projectId, context: context(source.routeId) },
      { action: "testimonial-engaged", testimonialId: profileTestimonial, context: context(source.routeId) },
      { action: "testimonial-engaged", testimonialId: projectTestimonial, projectId: source.projectId, context: context(source.routeId) },
    ];
    const eventKeys = events.map((_, index) => key(`fact-event-key-000${index}`));
    for (const [index, event] of events.entries()) {
      expect((await service.ingestEvent(command(event, evidence.verified, eventKeys[index]))).ok).toBe(true);
    }
    expect(await countEvents()).toBe(before + 3);
    expect(await countJobs()).toBe(beforeJobs + 3);
    const rows = await admin.query(`select action, project_id::text, source_project_id::text, target_project_id::text, testimonial_id::text
      from measurement.public_events where portfolio_id=$1 order by accepted_at desc limit 3`, [portfolioId]);
    expect(rows.rows).toEqual(expect.arrayContaining([
      { action: "related-project-opened", project_id: null, source_project_id: source.projectId, target_project_id: target.projectId, testimonial_id: null },
      { action: "testimonial-engaged", project_id: null, source_project_id: null, target_project_id: null, testimonial_id: profileTestimonial },
      { action: "testimonial-engaged", project_id: source.projectId, source_project_id: null, target_project_id: null, testimonial_id: projectTestimonial },
    ]));
    const invalid: PublicMeasurementEvent[] = [
      { action: "related-project-opened", sourceProjectId: source.projectId, targetProjectId: createStableId("Project"), context: context(source.routeId) },
      { action: "testimonial-engaged", testimonialId: projectTestimonial, projectId: target.projectId, context: context(source.routeId) },
      { action: "testimonial-engaged", testimonialId: profileTestimonial, projectId: source.projectId, context: context(source.routeId) },
      { action: "testimonial-engaged", testimonialId: profileTestimonial, context: context(source.routeId, { locale: "ar" }) },
    ];
    for (const [index, event] of invalid.entries()) {
      expect((await service.ingestEvent(command(event, evidence.verified, key(`invalid-fact-key-${index}-0001`)))).ok).toBe(false);
    }
    expect(await countEvents()).toBe(before + 3);
    expect(await countJobs()).toBe(beforeJobs + 3);
    const safeOutput = JSON.stringify({ rows: rows.rows, receipt: await service.ingestEvent(command(events[1]!, evidence.verified, eventKeys[1])) });
    expect(safeOutput).not.toContain("Private fixture quote");
    expect(safeOutput).not.toContain("Fixture author");
  });

  it("T10-01/T10-03 persists Media facts only when the optional public-use capability accepts them", async () => {
    const project = await seedProject(), evidence = await issueEvidence(), { mediaAssetId, mediaFacts } = await seedAcceptedProfileMedia();
    const event: PublicMeasurementEvent = { action: "media-engaged", mediaAssetId, engagement: "completed", context: context(project.routeId) };
    const before = await countEvents(), beforeJobs = await countJobs(), eventKey = key("media-fact-accepted-0001");
    const mediaService = makeService({ media: mediaFacts });
    const accepted = await mediaService.ingestEvent(command(event, evidence.verified, eventKey));
    expect(accepted.ok).toBe(true);
    expect(await mediaService.ingestEvent(command(event, evidence.verified, eventKey))).toEqual(accepted);
    expect(await mediaService.ingestEvent(command({ ...event, engagement: "opened" }, evidence.verified, eventKey)))
      .toMatchObject({ ok: false, error: { kind: "conflict" } });
    const row = await admin.query("select action,project_id::text,media_asset_id::text,media_engagement from measurement.public_events where portfolio_id=$1 and media_asset_id=$2", [portfolioId, mediaAssetId]);
    expect(row.rows).toEqual([{ action: "media-engaged", project_id: null, media_asset_id: mediaAssetId, media_engagement: "completed" }]);
    const { mediaAssetId: unrelatedProfileAsset } = await seedAcceptedProfileMedia({ setAsProfile: false });
    await admin.query("update portfolio_config.settings set profile_media_asset_id=$3 where portfolio_id=$1 and owner_id=$2", [portfolioId, ownerId, unrelatedProfileAsset]);
    const rejected = await mediaService.ingestEvent(command(event, evidence.verified, key("media-fact-rejected-0001")));
    await admin.query("update portfolio_config.settings set profile_media_asset_id=$3 where portfolio_id=$1 and owner_id=$2", [portfolioId, ownerId, mediaAssetId]);
    const missing = await service.ingestEvent(command({ ...event, mediaAssetId: createStableId("MediaAsset") }, evidence.verified, key("media-fact-missing-0001")));
    const failingService = makeService({ media: mediaFacts, repository: { async insert() { throw new Error("injected Media event insert failure"); } } });
    expect((await failingService.ingestEvent(command(event, evidence.verified, key("media-fact-rollback-0001")))).ok).toBe(false);
    expect(rejected.ok).toBe(false);
    expect(missing.ok).toBe(false);
    expect(await countEvents()).toBe(before + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);
  });

  it("T09-02 rejects missing, forged, expired, unsupported, withdrawn and mismatched consent without writes", async () => {
    const { routeId } = await seedProject();
    const event = pageEvent(routeId);
    const evidence = await issueEvidence();
    const start = await countEvents(), jobsStart = await countJobs();
    for (const token of [undefined, "granted", "forged-cookie-value"]) {
      expect((await handlePostPublicEvent(request(token, event), { scope, service, consent })).status).toBe(403);
    }
    const mismatch = pageEvent(routeId, { consentVersion: "other-version" });
    expect((await handlePostPublicEvent(request(evidence.token, mismatch), { scope, service, consent })).status).toBe(403);
    const unsupported = await consent.recordConsent({ scope, correlationId: "unsupported", consent: "granted", noticeVersion: "unsupported", expectedRevision: 0 });
    expect(unsupported.ok).toBe(false);
    const row = await admin.query("select consent_id from measurement.consents where consent_id=$1", [evidence.consentId]);
    expect(row.rowCount).toBe(1);
    now = evidence.evidenceExpiresAt;
    expect((await handlePostPublicEvent(request(evidence.token, event, "expired-consent-key"), { scope, service, consent })).status).toBe(403);
    now = "2026-10-15T12:00:00.000Z";
    const withdrawn = await consent.recordConsent({ scope, correlationId: "withdraw-consent", consent: "denied", noticeVersion: "2026-10", consentId: evidence.consentId, expectedRevision: 1 });
    expect(withdrawn.ok).toBe(true);
    expect((await handlePostPublicEvent(request(evidence.token, event, "withdrawn-consent-key"), { scope, service, consent })).status).toBe(403);
    expect(await countEvents()).toBe(start);
    expect(await countJobs()).toBe(jobsStart);
  });

  it("T09-04 binds current routes, Project, locale, type and Portfolio while allowing retained journey identities", async () => {
    const current = await seedProject();
    const hidden = await seedProject({ lifecycle: "hidden", locales: ["en"] });
    const foreignPortfolio = createStableId("Portfolio");
    await admin.query("insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Foreign','Headline','Bio','Contact','https://example.com','Unavailable')", [foreignPortfolio, createStableId("Owner")]);
    const foreign = await seedProject({ portfolio: foreignPortfolio });
    const evidence = await issueEvidence();
    const before = await countEvents();
    expect((await service.ingestEvent(command({ action: "project-viewed", projectId: createStableId("Project"), context: context(current.routeId) }, evidence.verified))).ok).toBe(false);
    expect((await service.ingestEvent(command(pageEvent(current.routeId, { locale: "ar" }), evidence.verified))).ok).toBe(false);
    expect((await service.ingestEvent(command(pageEvent(foreign.routeId), evidence.verified))).ok).toBe(false);
    expect((await service.ingestEvent(command(pageEvent(createStableId("PublicRoute")), evidence.verified))).ok).toBe(false);
    const priorJourney = pageEvent(current.routeId, { journeyContext: [hidden.routeId] });
    const accepted = await service.ingestEvent(command(priorJourney, evidence.verified, key("retained-journey-key-001")));
    expect(accepted.ok, accepted.ok ? "" : accepted.error.code).toBe(true);
    expect(JSON.stringify(accepted)).not.toContain("Private fixture title");
    expect(await countEvents()).toBe(before + 1);
  });

  it("T09-05/T09-06 enforces microsecond time cutoffs, future clamping and bounded coarse dimensions", async () => {
    const { routeId } = await seedProject();
    const evidence = await issueEvidence();
    const acceptedAt = now;
    const atOldLimit = pageEvent(routeId, { occurredAt: "2026-10-14T12:00:00.000000Z" });
    const atFutureLimit = pageEvent(routeId, { occurredAt: "2026-10-15T12:01:00.000000Z", referrerClass: "unknown", deviceClass: "other" });
    const oneMicrosOld = pageEvent(routeId, { occurredAt: "2026-10-14T11:59:59.999999Z" });
    const oneMicrosFuture = pageEvent(routeId, { occurredAt: "2026-10-15T12:01:00.000001Z" });
    expect((await service.ingestEvent(command(atOldLimit, evidence.verified, key("old-limit-event-key-01")))).ok).toBe(true);
    const futureReceipt = await service.ingestEvent(command(atFutureLimit, evidence.verified, key("future-limit-event-key-01")));
    expect(futureReceipt.ok).toBe(true);
    expect((await service.ingestEvent(command(oneMicrosOld, evidence.verified, key("old-outside-event-key-01")))).ok).toBe(false);
    expect((await service.ingestEvent(command(oneMicrosFuture, evidence.verified, key("future-outside-event-key-01")))).ok).toBe(false);
    if (futureReceipt.ok) {
      const row = await admin.query("select to_char(accepted_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') accepted, to_char(effective_at at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') effective from measurement.public_events where event_id=$1", [futureReceipt.value.eventId]);
      expect(row.rows[0]).toEqual({ accepted: "2026-10-15T12:00:00.000000Z", effective: "2026-10-15T12:00:00.000000Z" });
    }
    expect(acceptedAt).toBe("2026-10-15T12:00:00.000Z");
  });

  it("T09-07 commits event, safe receipt and private job once; exact races replay and failures roll back", async () => {
    const { projectId, routeId } = await seedProject();
    const changedRoute = await seedProject();
    const evidence = await issueEvidence();
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const inserted = new Promise<void>(resolve => { entered = resolve; });
    let held = false;
    const blockingRepository: MeasurementEventRepositoryPort = { async insert(event, tx) {
      await repository.insert(event, tx);
      if (!held) { held = true; entered(); await barrier; }
    } };
    const firstService = makeService({ repository: blockingRepository });
    const event: PublicMeasurementEvent = { action: "project-viewed", projectId, context: context(routeId) };
    const raceKey = key("concurrent-event-key-001");
    const beforeEvents = await countEvents(), beforeJobs = await countJobs();
    const first = firstService.ingestEvent(command(event, evidence.verified, raceKey));
    await inserted;
    const replay = service.ingestEvent(command(event, evidence.verified, raceKey));
    let waiting = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !waiting) {
      waiting = ((await admin.query("select 1 from pg_stat_activity where usename='event_runtime' and wait_event_type='Lock'")).rowCount ?? 0) > 0;
    }
    expect(waiting).toBe(true);
    release();
    const [original, repeated] = await Promise.all([first, replay]);
    expect(original).toEqual(repeated);
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);
    const payload = await admin.query("select payload from operations.jobs where payload->>'eventId'=$1", [original.ok ? original.value.eventId : ""]);
    expect(payload.rows).toHaveLength(1);
    expect(JSON.stringify(payload.rows[0])).not.toContain(evidence.verified.subject);
    expect(await service.ingestEvent(command(
      { ...event, context: context(routeId, { referrerClass: "search" }) }, evidence.verified, raceKey,
    ))).toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await service.ingestEvent(command({ action: "project-viewed", projectId: changedRoute.projectId, context: context(changedRoute.routeId) }, evidence.verified, raceKey)))
      .toMatchObject({ ok: false, error: { kind: "conflict" } });
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);

    const failingRepository: MeasurementEventRepositoryPort = { async insert() { throw new Error("injected persistence failure"); } };
    const failed = await makeService({ repository: failingRepository }).ingestEvent(command(event, evidence.verified, key("rollback-event-key-001")));
    expect(failed.ok).toBe(false);
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);
    const failingJobs = { ...operations, jobs: { ...operations.jobs, async enqueue() { throw new Error("injected job failure"); } } } as typeof operations;
    expect((await makeService({ operations: failingJobs }).ingestEvent(command(event, evidence.verified, key("rollback-job-key-001")))).ok).toBe(false);
    expect(await countEvents()).toBe(beforeEvents + 1);
    expect(await countJobs()).toBe(beforeJobs + 1);
  });

  it("T09-08 serializes intake against withdrawal in both lock orders and rejects post-withdrawal replay", async () => {
    const { routeId } = await seedProject();
    const evidence = await issueEvidence();
    const event = pageEvent(routeId), replayKey = key("withdrawn-replay-key-001");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const routeLocked = new Promise<void>(resolve => { entered = resolve; });
    let held = false;
    const blockingFacts = { ...content, async getRouteFacts(input: Parameters<typeof content.getRouteFacts>[0], tx: TransactionContext) {
      const facts = await content.getRouteFacts(input, tx);
      if (!held) { held = true; entered(); await gate; }
      return facts;
    } };
    const intakeService = makeService({ facts: blockingFacts });
    const intake = intakeService.ingestEvent(command(event, evidence.verified, replayKey));
    await routeLocked;
    const withdrawal = consent.recordConsent({ scope, correlationId: "withdraw-after-intake", consent: "denied", noticeVersion: "2026-10", consentId: evidence.consentId, expectedRevision: 1 });
    let waiting = false;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && !waiting) waiting = ((await admin.query("select 1 from pg_stat_activity where usename='event_runtime' and wait_event_type='Lock'")).rowCount ?? 0) > 0;
    expect(waiting).toBe(true);
    release();
    expect((await intake).ok).toBe(true);
    expect((await withdrawal).ok).toBe(true);
    const after = await countEvents();
    expect(await service.ingestEvent(command(event, evidence.verified, replayKey))).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(await countEvents()).toBe(after);

    const secondEvidence = await issueEvidence();
    let unlock!: () => void, lockEntered!: () => void;
    const lockGate = new Promise<void>(resolve => { unlock = resolve; });
    const withdrawalLocked = new Promise<void>(resolve => { lockEntered = resolve; });
    let holdLock = true;
    const heldRepository: ConsentRepositoryPort = {
      async lock(portfolio, consentId, tx) {
        const row = await consentRepository.lock(portfolio, consentId, tx);
        if (holdLock) { holdLock = false; lockEntered(); await lockGate; }
        return row;
      },
      save: (row, tx) => consentRepository.save(row, tx),
    };
    const withdrawalFirst = createConsentApplicationService({ transactions: database.transactions, repository: heldRepository,
      crypto: new AesGcmConsentEvidenceAdapter(config, () => now), clock: { now: () => now }, ids: createSystemIdGenerator(),
      supportedNoticeVersions: ["2026-10"], ttlSeconds: 2_592_000 });
    const firstWithdraw = withdrawalFirst.recordConsent({ scope, correlationId: "withdraw-before-intake", consent: "denied", noticeVersion: "2026-10", consentId: secondEvidence.consentId, expectedRevision: 1 });
    await withdrawalLocked;
    const blockedIntake = service.ingestEvent(command(event, secondEvidence.verified, key("withdraw-before-intake-key-01")));
    waiting = false;
    const until = Date.now() + 3_000;
    while (Date.now() < until && !waiting) waiting = ((await admin.query("select 1 from pg_stat_activity where usename='event_runtime' and wait_event_type='Lock'")).rowCount ?? 0) > 0;
    expect(waiting).toBe(true);
    unlock();
    expect((await firstWithdraw).ok).toBe(true);
    expect(await blockedIntake).toMatchObject({ ok: false, error: { kind: "forbidden" } });
  });

  it("T09-09 enforces module RLS and keeps optional event assembly out of core readiness", async () => {
    const { routeId } = await seedProject();
    const evidence = await issueEvidence();
    const grants = await admin.query(`select has_table_privilege('event_runtime','measurement.public_events','INSERT') as insert,
      has_table_privilege('event_runtime','measurement.public_events','SELECT') as read,
      has_table_privilege('shipwithali_worker','measurement.public_events','SELECT') as worker_read,
      has_schema_privilege('anon','measurement','USAGE') as anon_schema,
      has_table_privilege('anon','measurement.public_events','SELECT') as anon_read`);
    expect(grants.rows[0]).toEqual({ insert: true, read: false, worker_read: true, anon_schema: false, anon_read: false });
    const roles = await admin.query("select rolbypassrls, rolsuper from pg_roles where rolname in ('event_runtime','shipwithali_application','shipwithali_worker')");
    expect(roles.rows.every(row => !row.rolbypassrls && !row.rolsuper)).toBe(true);
    await admin.query("begin");
    try {
      await admin.query("set local role shipwithali_worker");
      await admin.query("select set_config('shipwithali.portfolio_id',$1,true)", [portfolioId]);
      const worker = await admin.query("select count(*)::int as count from measurement.public_events");
      expect(worker.rows[0].count).toBeGreaterThan(0);
    } finally { await admin.query("rollback"); }
    expect((await service.ingestEvent(command(pageEvent(routeId), evidence.verified))).ok).toBe(true);

    const runtime = createPostgresRuntimeDatabase(url!);
    const runtimeOps = createPostgresOperationsPersistence(runtime.database, { now: () => now });
    const env = { NODE_ENV: "test", APP_BASE_URL: "https://example.com", DATABASE_URL: url!, PORTFOLIO_ID: portfolioId, OWNER_ID: ownerId };
    try {
      resetRuntimeForTests();
      const state = await initializeDatabaseRuntime(env, "application", () => ({ operations: runtimeOps, resource: runtime.resource, identityReadiness: { name: "isolated-test-identity", async check() { return true; } }, readiness: runtime.readiness, consent }));
      expect(state.runtimeKind).toBe("application");
      expect(getConsentApplicationService()).toBe(consent);
      expect(getMeasurementEventIngestionService()).toBeUndefined();
      const unavailable = await handlePostPublicEvent(request(evidence.token, pageEvent(routeId), "missing-event-service"), { scope, logger: createTestLogger() });
      expect(unavailable.status).toBe(503);
      resetRuntimeForTests();
      await initializeDatabaseRuntime(env, "application", () => ({ operations: runtimeOps, resource: runtime.resource, identityReadiness: { name: "isolated-test-identity", async check() { return true; } }, readiness: runtime.readiness,
        consent, eventIngestion: { scope, service } }));
      expect(getMeasurementEventIngestionService()?.service).toBe(service);
      const response = await handlePostPublicEvent(request(evidence.token, pageEvent(routeId), "assembled-event-service"), { logger: createTestLogger() });
      expect(response.status).toBe(202);
    } finally { resetRuntimeForTests(); await runtime.resource.close(); }
  });
});
