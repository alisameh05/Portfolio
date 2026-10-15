import { describe, expect, it } from "vitest";
import { createStableId } from "../../src/shared/domain/index.js";
import { isTransactionRollback } from "../../src/runtime/ports.js";
import { createMeasurementEventService } from "../../src/modules/measurement/application/ingest-event.js";
import type { PublicMeasurementEvent } from "../../src/modules/measurement/index.js";

const portfolioId = createStableId("Portfolio");
const routeId = createStableId("PublicRoute");
const projectId = createStableId("Project");
const targetProjectId = createStableId("Project");
const mediaAssetId = createStableId("MediaAsset");
const testimonialId = createStableId("Testimonial");
const subject = createStableId("MeasurementVisitor");
const consentId = createStableId("Consent");
const eventId = createStableId("PublicEvent");
const jobId = createStableId("Job");
const context = {
  occurredAt: "2026-10-14T12:00:00.000000Z",
  locale: "en" as const,
  consentVersion: "2026-10",
  pageRouteIdentity: routeId,
  journeyContext: [routeId],
  referrerClass: "professional" as const,
  deviceClass: "desktop" as const,
  countryCode: "EG",
};
const evidence = {
  purpose: "measurement" as const,
  subject,
  portfolioId,
  consentId,
  noticeVersion: "2026-10",
  revision: 1,
  issuedAt: "2026-10-14T11:00:00.000Z",
  expiresAt: "2026-11-13T11:00:00.000Z",
};

function setup(options: { media?: "ready" | "missing" | "unavailable"; contactAvailable?: boolean; linkAvailable?: boolean; linkAvailableInArabic?: boolean; ctaAvailable?: boolean; arabicPublished?: boolean; configuration?: boolean; externalFacts?: boolean } = {}) {
  const writes: unknown[] = [];
  const jobs: unknown[] = [];
  const requests = new Map<string, { hash: string; result: Record<string, unknown> }>();
  let generatedEvents = 0;
  const tx = { kind: "transaction" as const };
  const operations = {
    transactions: { async run<T>(work: (context: typeof tx) => Promise<T> | T) {
      const result = await work(tx);
      return isTransactionRollback(result) ? result.value : result;
    } },
    idempotency: {
      async execute(input: { operationScope: string; actorScope: string; key: string; requestHash: string }, effect: (context: typeof tx) => Promise<Record<string, unknown>>) {
        const key = `${input.operationScope}:${input.actorScope}:${input.key}`;
        const existing = requests.get(key);
        if (existing) return existing.hash === input.requestHash
          ? { kind: "replayed" as const, result: existing.result }
          : { kind: "conflict" as const };
        const result = await effect(tx);
        requests.set(key, { hash: input.requestHash, result });
        return { kind: "executed" as const, result };
      },
    },
    jobs: { async enqueue(_context: typeof tx, job: unknown) { jobs.push(job); } },
  };
  const service = createMeasurementEventService({
    portfolioId,
    transactions: operations.transactions as never,
    operations: operations as never,
    consent: { async checkCurrentEvidence(value: typeof evidence) { return value.revision === 1 ? { ok: true as const, value } : { ok: false as const, error: { kind: "forbidden" as const, code: "MEASUREMENT_CONSENT_REQUIRED" } }; } } as never,
    content: {
      async getRouteFacts(query: { routeId: string; locale: string }) {
        return query.routeId === routeId && (query.locale === "en" || (query.locale === "ar" && options.arabicPublished === true))
          ? { ok: true as const, value: { routeId, projectId, contentType: "project" as const, published: true } }
          : { ok: false as const, error: { kind: "not_found" as const, code: "PUBLIC_ROUTE_UNAVAILABLE" } };
      },
      async hasRetainedPublicRoute(query: { routeId: string }) {
        return { ok: true as const, value: query.routeId === routeId };
      },
      async getRelatedProjectFact(query: { sourceProjectId: string; targetProjectId: string; locale: string }) {
        return { ok: true as const, value: query.sourceProjectId === projectId && query.targetProjectId === targetProjectId && query.locale === "en" };
      },
      async getTestimonialFact(query: { testimonialId: string; projectId?: string; locale: string }) {
        return { ok: true as const, value: query.testimonialId === testimonialId && query.projectId === projectId && query.locale === "en" };
      },
      ...(options.externalFacts === false ? {} : { async getExternalProjectLinkFact(query: { projectId: string; destination: string; locale: string }) {
        return { ok: true as const, value: query.projectId === projectId && options.linkAvailable !== false && (query.locale === "en" || options.linkAvailableInArabic === true) };
      } }),
    } as never,
    ...(options.configuration === false ? {} : { configuration: {
      async hasPublicContactChannel(query: { channel: string; locale: string }) {
        return { ok: true as const, value: options.contactAvailable !== false && query.channel === "linkedin" && query.locale === "en" };
      },
      async hasAvailableGlobalProjectCta() { return { ok: true as const, value: options.ctaAvailable !== false }; },
    } as never }),
    ...(options.media === "missing" ? {} : { media: { async getPublicUseFact(query: { mediaAssetId: string; projectId?: string; locale: string }) {
      return options.media === "unavailable"
        ? { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_FACTS_DOWN" } }
        : { ok: true as const, value: query.mediaAssetId === mediaAssetId && query.projectId === projectId && query.locale === "en" };
    } } }),
    repository: { async insert(event: unknown) { writes.push(event); } },
    clock: { now: () => "2026-10-15T12:00:00.000Z" },
    ids: { generate(kind: string) { return kind === "Job" ? jobId : (++generatedEvents, eventId); } },
  });
  const command = (event: PublicMeasurementEvent, key = "event-key-001") => ({
    scope: { kind: "portfolio" as const, portfolioId },
    correlationId: "test-correlation",
    actor: { kind: "visitor" as const, consent: "granted" as const },
    measurement: evidence,
    idempotencyKey: key as never,
    event,
  });
  return { service, command, writes, jobs };
}

describe("Measurement event ingestion application seam", () => {
  it("round-trips the first-slice action and full coarse context, then returns only a safe receipt", async () => {
    const { service, command, writes, jobs } = setup();
    const event: PublicMeasurementEvent = { action: "active-engagement-sampled", context, projectId, activeMilliseconds: 12_500 };
    const result = await service.ingestEvent(command(event));
    expect(result).toEqual({ ok: true, value: { eventId, acceptedAt: "2026-10-15T12:00:00.000Z" } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ portfolioId, measurementSubject: subject, event, acceptedAt: "2026-10-15T12:00:00.000Z", effectiveAt: "2026-10-14T12:00:00.000000Z" });
    expect(jobs).toHaveLength(1);
    expect(JSON.stringify({ receipt: result, job: jobs[0] })).not.toContain(subject);
  });

  it("accepts Media, related-Project and Testimonial facts as distinct persisted actions", async () => {
    const { service, command, writes, jobs } = setup();
    const events: PublicMeasurementEvent[] = [
      { action: "media-engaged", context, projectId, mediaAssetId, engagement: "completed" },
      { action: "related-project-opened", context, sourceProjectId: projectId, targetProjectId },
      { action: "testimonial-engaged", context, testimonialId, projectId },
    ];
    for (const [index, event] of events.entries()) {
      expect(await service.ingestEvent(command(event, `event-facts-${index + 1}`))).toMatchObject({ ok: true });
    }
    expect(writes).toHaveLength(3);
    expect(writes.map((write) => (write as { event: PublicMeasurementEvent }).event)).toEqual(events);
    expect(jobs).toHaveLength(3);
  });

  it("T11-01/T11-06 accepts and preserves all nine action mappings as distinct facts", async () => {
    const { service, command, writes, jobs } = setup();
    const events: PublicMeasurementEvent[] = [
      { action: "page-viewed", context },
      { action: "project-viewed", context, projectId },
      { action: "active-engagement-sampled", context, projectId, activeMilliseconds: 4_000 },
      { action: "media-engaged", context, projectId, mediaAssetId, engagement: "played" },
      { action: "related-project-opened", context, sourceProjectId: projectId, targetProjectId },
      { action: "testimonial-engaged", context, testimonialId, projectId },
      { action: "contact-channel-opened", context, projectId, channel: "linkedin" },
      { action: "external-project-link-opened", context, projectId, destination: "github-repository" },
      { action: "global-project-cta-opened", context, projectId },
    ];
    for (const [index, event] of events.entries()) {
      expect(await service.ingestEvent(command(event, `all-nine-events-${index + 1}`))).toMatchObject({ ok: true });
    }
    expect(writes.map((write) => (write as { event: PublicMeasurementEvent }).event)).toEqual(events);
    expect(jobs).toHaveLength(9);
  });

  it.each([
    ["unconfigured Contact channel", { action: "contact-channel-opened", context, channel: "linkedin" }, { contactAvailable: false }],
    ["unavailable Global CTA destination", { action: "global-project-cta-opened", context, projectId }, { ctaAvailable: false }],
    ["unconfigured Project destination", { action: "external-project-link-opened", context, projectId, destination: "live-demo" }, { linkAvailable: false }],
    ["English-only Project destination in Arabic", { action: "external-project-link-opened", context: { ...context, locale: "ar" }, projectId, destination: "github-repository" }, { arabicPublished: true }],
    ["wrong Project page", { action: "global-project-cta-opened", context, projectId: createStableId("Project") }, {}],
  ] as const)("T11-02/T11-03 rejects %s before durable effects", async (_label, event, options) => {
    const { service, command, writes, jobs } = setup(options);
    expect(await service.ingestEvent(command(event as unknown as PublicMeasurementEvent))).toMatchObject({ ok: false });
    expect(writes).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it.each([
    ["missing Configuration capability", { action: "contact-channel-opened", context, channel: "linkedin" }, { configuration: false }],
    ["missing External link capability", { action: "external-project-link-opened", context, projectId, destination: "live-demo" }, { externalFacts: false }],
  ] as const)("fails closed for %s without blocking independent page observations", async (_label, event, options) => {
    const { service, command, writes, jobs } = setup(options);
    expect(await service.ingestEvent(command(event as unknown as PublicMeasurementEvent))).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
    expect(await service.ingestEvent(command({ action: "page-viewed", context }, "independent-public-page"))).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it("rejects forged or mismatched Media, related-Project, and Testimonial facts without effects", async () => {
    const invalidEvents = [
      { action: "media-engaged", context, projectId: createStableId("Project"), mediaAssetId, engagement: "opened" },
      { action: "related-project-opened", context, sourceProjectId: createStableId("Project"), targetProjectId },
      { action: "related-project-opened", context, sourceProjectId: projectId, targetProjectId: projectId },
      { action: "testimonial-engaged", context, testimonialId, projectId: createStableId("Project") },
    ];
    for (const event of invalidEvents) {
      const { service, command, writes, jobs } = setup();
      expect((await service.ingestEvent(command(event as unknown as PublicMeasurementEvent))).ok).toBe(false);
      expect(writes).toHaveLength(0);
      expect(jobs).toHaveLength(0);
    }
  });

  it.each(["missing", "unavailable"] as const)("fails only Media engagement safely when its optional public-use capability is %s", async (media) => {
    const { service, command, writes, jobs } = setup({ media });
    const rejected = await service.ingestEvent(command({ action: "media-engaged", context, mediaAssetId, engagement: "opened" }));
    expect(rejected).toMatchObject({ ok: false, error: { kind: "temporarily_unavailable" } });
    expect(writes).toHaveLength(0);
    expect(jobs).toHaveLength(0);
    expect((await service.ingestEvent(command({ action: "page-viewed", context }, "independent-event-key"))).ok).toBe(true);
    expect(writes).toHaveLength(1);
  });

  it.each([
    ["unknown event field", { action: "page-viewed", context, unexpected: "private" }],
    ["unknown nested context field", { action: "page-viewed", context: { ...context, ipAddress: "192.0.2.1" } }],
    ["invalid Media engagement", { action: "media-engaged", context, mediaAssetId, engagement: "liked" }],
    ["invalid relationship payload", { action: "related-project-opened", context, sourceProjectId: projectId, targetProjectId, extra: true }],
    ["unknown testimonial property", { action: "testimonial-engaged", context, testimonialId, personalEmail: "private@example.test" }],
    ["invalid Contact channel", { action: "contact-channel-opened", context, channel: "email" }],
    ["raw destination URL", { action: "external-project-link-opened", context, projectId, destination: "live-demo", url: "https://private.example" }],
    ["invalid destination category", { action: "external-project-link-opened", context, projectId, destination: "other" }],
    ["wrong action fields", { action: "global-project-cta-opened", context, projectId, channel: "linkedin" }],
    ["out-of-range engagement", { action: "active-engagement-sampled", context, activeMilliseconds: 999 }],
    ["duplicate Journey context", { action: "page-viewed", context: { ...context, journeyContext: [routeId, routeId] } }],
    ["overlong Journey context", { action: "page-viewed", context: { ...context, journeyContext: Array.from({ length: 11 }, () => createStableId("PublicRoute")) } }],
    ["unpublished locale", { action: "page-viewed", context: { ...context, locale: "ar" } }],
    ["fine geography", { action: "page-viewed", context: { ...context, countryCode: "EG-01" } }],
    ["unknown device class", { action: "page-viewed", context: { ...context, deviceClass: "phone-model" } }],
    ["mismatched Project", { action: "project-viewed", context, projectId: createStableId("Project") }],
  ] as const)("rejects %s before durable effects", async (_label, event) => {
    const { service, command, writes, jobs } = setup();
    const result = await service.ingestEvent(command(event as unknown as PublicMeasurementEvent));
    expect(result.ok).toBe(false);
    expect(writes).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it("does not treat actor.consent or body consentVersion as verified evidence", async () => {
    const { service, command, writes, jobs } = setup();
    const { measurement: ignoredMeasurement, ...noEvidence } = command({ action: "page-viewed", context });
    void ignoredMeasurement;
    expect(await service.ingestEvent(noEvidence)).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    const mismatched = { ...command({ action: "page-viewed", context: { ...context, consentVersion: "other" } }) };
    expect(await service.ingestEvent(mismatched)).toMatchObject({ ok: false, error: { kind: "forbidden" } });
    expect(writes).toHaveLength(0);
    expect(jobs).toHaveLength(0);
  });

  it("accepts the inclusive clock window, clamps future effective time, and rejects values outside it", async () => {
    const { service, command, writes } = setup();
    const exactlyOld = { action: "page-viewed", context: { ...context, occurredAt: "2026-10-14T12:00:00.000000Z" } } as const;
    expect((await service.ingestEvent(command(exactlyOld))).ok).toBe(true);
    const exactlyFuture = { action: "page-viewed", context: { ...context, occurredAt: "2026-10-15T12:01:00.000000Z" } } as const;
    expect((await service.ingestEvent(command(exactlyFuture, "event-key-002"))).ok).toBe(true);
    expect(writes[1]).toMatchObject({ effectiveAt: "2026-10-15T12:00:00.000Z" });
    const outsideOld = { action: "page-viewed", context: { ...context, occurredAt: "2026-10-14T11:59:59.999999Z" } } as const;
    const outsideFuture = { action: "page-viewed", context: { ...context, occurredAt: "2026-10-15T12:01:00.000001Z" } } as const;
    expect((await service.ingestEvent(command(outsideOld, "event-key-003"))).ok).toBe(false);
    expect((await service.ingestEvent(command(outsideFuture, "event-key-004"))).ok).toBe(false);
    expect(writes).toHaveLength(2);
  });

  it("replays one receipt/job for an exact key and conflicts on changed payload", async () => {
    const { service, command, writes, jobs } = setup();
    const event: PublicMeasurementEvent = { action: "project-viewed", context, projectId };
    const first = await service.ingestEvent(command(event));
    expect(await service.ingestEvent(command(event))).toEqual(first);
    expect((await service.ingestEvent(command({ action: "project-viewed", context: { ...context, referrerClass: "search" }, projectId }))).ok).toBe(false);
    expect(writes).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });
});
