import { err, ok, parseIdempotencyKey, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/index.js";
import type { ApplicationRequestContext } from "@shared/application";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { requestTransactionRollback } from "../../../runtime/ports.js";
import type { OperationsPersistencePorts } from "../../portability-operations/index.js";
import type { ContentMeasurementPublicFactsPort } from "../../content-publishing/index.js";
import type { ConsentApplicationService, VerifiedMeasurementEvidence } from "./consent.js";
import type { EventReceipt, PublicEventData, PublicMeasurementEvent } from "../domain/index.js";

export interface MeasurementEventRepositoryPort {
  insert(event: PublicEventData, transaction: TransactionContext): Promise<void>;
}

/** Optional cross-module capability. Its absence rejects Media observations only. */
export interface MeasurementMediaPublicFactsPort {
  getPublicUseFact(input: {
    readonly portfolioId: StableId<"Portfolio">;
    readonly mediaAssetId: StableId<"MediaAsset">;
    readonly projectId?: StableId<"Project">;
    readonly locale: "en" | "ar";
  }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
}

export interface MeasurementEventApplicationDeps {
  readonly portfolioId: StableId<"Portfolio">;
  readonly transactions: OperationsPersistencePorts["transactions"];
  readonly operations: OperationsPersistencePorts;
  readonly consent: Pick<ConsentApplicationService, "checkCurrentEvidence">;
  readonly content: Pick<ContentMeasurementPublicFactsPort, "getRouteFacts" | "hasRetainedPublicRoute"> &
    Partial<Pick<ContentMeasurementPublicFactsPort, "getRelatedProjectFact" | "getTestimonialFact">>;
  readonly media?: MeasurementMediaPublicFactsPort;
  readonly repository: MeasurementEventRepositoryPort;
  readonly clock: Clock;
  readonly ids: StableIdGenerator;
}

type SupportedEvent = Extract<PublicMeasurementEvent, {
  readonly action: "page-viewed" | "project-viewed" | "active-engagement-sampled" |
    "media-engaged" | "related-project-opened" | "testimonial-engaged";
}>;

const unavailable = (): Result<never, Rejection> => err({ kind: "not_found", code: "PUBLIC_ROUTE_UNAVAILABLE" });
const denied = (): Result<never, Rejection> => err({ kind: "forbidden", code: "MEASUREMENT_CONSENT_REQUIRED" });
const invalid = (): Result<never, Rejection> => err({ kind: "validation", code: "EVENT_INVALID" });
const transient = (): Result<never, Rejection> => err({ kind: "temporarily_unavailable", code: "MEASUREMENT_UNAVAILABLE" });
const contextKeys = new Set(["occurredAt", "locale", "consentVersion", "pageRouteIdentity", "journeyContext", "referrerClass", "deviceClass", "countryCode"]);
const actionKeys: Readonly<Record<SupportedEvent["action"], ReadonlySet<string>>> = {
  "page-viewed": new Set(["action", "context"]),
  "project-viewed": new Set(["action", "context", "projectId"]),
  "active-engagement-sampled": new Set(["action", "context", "projectId", "activeMilliseconds"]),
  "media-engaged": new Set(["action", "context", "projectId", "mediaAssetId", "engagement"]),
  "related-project-opened": new Set(["action", "context", "sourceProjectId", "targetProjectId"]),
  "testimonial-engaged": new Set(["action", "context", "testimonialId", "projectId"]),
};
const referrers = new Set(["direct", "search", "social", "professional", "referral", "unknown"]);
const devices = new Set(["desktop", "mobile", "tablet", "other", "unknown"]);
const instantPattern = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,9}))?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

function parseInstantMicros(value: unknown): number | null {
  if (typeof value !== "string" || !instantPattern.test(value)) return null;
  const match = instantPattern.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) return null;
  const millis = Date.parse(value);
  const fraction = (match[7] ?? "").padEnd(6, "0").slice(3, 6);
  return millis * 1_000 + Number(fraction);
}

function validContext(value: unknown): value is SupportedEvent["context"] {
  if (!isRecord(value) || !hasOnlyKeys(value, contextKeys) ||
      (value["locale"] !== "en" && value["locale"] !== "ar") ||
      typeof value["consentVersion"] !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(value["consentVersion"]) ||
      typeof value["pageRouteIdentity"] !== "string" || !parseStableId("PublicRoute", value["pageRouteIdentity"]).ok || parseInstantMicros(value["occurredAt"]) === null) return false;
  if (value["journeyContext"] !== undefined) {
    const journey = value["journeyContext"];
    if (!Array.isArray(journey) || journey.length > 10 ||
        journey.some(item => typeof item !== "string" || !parseStableId("PublicRoute", item).ok) ||
        new Set(journey).size !== journey.length) return false;
  }
  if (value["referrerClass"] !== undefined && (typeof value["referrerClass"] !== "string" || !referrers.has(value["referrerClass"]))) return false;
  if (value["deviceClass"] !== undefined && (typeof value["deviceClass"] !== "string" || !devices.has(value["deviceClass"]))) return false;
  if (value["countryCode"] !== undefined && (typeof value["countryCode"] !== "string" || !/^[A-Z]{2}$/.test(value["countryCode"]))) return false;
  return true;
}

function validateEvent(value: unknown): Result<SupportedEvent, Rejection> {
  const actions = ["page-viewed", "project-viewed", "active-engagement-sampled", "media-engaged", "related-project-opened", "testimonial-engaged"] as const;
  if (!isRecord(value) || typeof value["action"] !== "string" || !actions.includes(value["action"] as typeof actions[number])) return invalid();
  const action = value["action"] as SupportedEvent["action"];
  if (!hasOnlyKeys(value, actionKeys[action]) || !validContext(value["context"])) return invalid();
  const projectIdRequired = action === "project-viewed";
  if ((projectIdRequired || value["projectId"] !== undefined) &&
      (typeof value["projectId"] !== "string" || !parseStableId("Project", value["projectId"]).ok)) return invalid();
  if (action === "page-viewed" && value["projectId"] !== undefined) return invalid();
  if (action === "active-engagement-sampled") {
    if (typeof value["activeMilliseconds"] !== "number" || !Number.isSafeInteger(value["activeMilliseconds"]) || value["activeMilliseconds"] < 1_000 || value["activeMilliseconds"] > 60_000) return invalid();
  } else if (value["activeMilliseconds"] !== undefined) return invalid();
  if (action === "media-engaged" && (typeof value["mediaAssetId"] !== "string" || !parseStableId("MediaAsset", value["mediaAssetId"]).ok || !["opened", "played", "paused", "completed"].includes(String(value["engagement"])))) return invalid();
  if (action === "related-project-opened" && (typeof value["sourceProjectId"] !== "string" || !parseStableId("Project", value["sourceProjectId"]).ok ||
      typeof value["targetProjectId"] !== "string" || !parseStableId("Project", value["targetProjectId"]).ok || value["sourceProjectId"] === value["targetProjectId"])) return invalid();
  if (action === "testimonial-engaged" && (typeof value["testimonialId"] !== "string" || !parseStableId("Testimonial", value["testimonialId"]).ok)) return invalid();
  return ok(value as unknown as SupportedEvent);
}

function parseReceipt(value: Readonly<Record<string, unknown>>): EventReceipt {
  if (!hasOnlyKeys(value, new Set(["eventId", "acceptedAt"])) || typeof value["eventId"] !== "string" || !parseStableId("PublicEvent", value["eventId"]).ok || parseInstantMicros(value["acceptedAt"]) === null) {
    throw new Error("INVALID_EVENT_RECEIPT");
  }
  return { eventId: value["eventId"] as StableId<"PublicEvent">, acceptedAt: value["acceptedAt"] as string };
}

async function validatePublicFacts(event: SupportedEvent, portfolioId: StableId<"Portfolio">, content: MeasurementEventApplicationDeps["content"], media: MeasurementMediaPublicFactsPort | undefined, tx: TransactionContext): Promise<Result<void, Rejection>> {
  const route = await content.getRouteFacts({ portfolioId, routeId: event.context.pageRouteIdentity, locale: event.context.locale }, tx);
  if (!route.ok) return route;
  if (!route.value.published) return unavailable();
  if (event.action === "project-viewed" && route.value.projectId !== event.projectId) return unavailable();
  if (event.action === "active-engagement-sampled" && event.projectId !== undefined && route.value.projectId !== event.projectId) return unavailable();
  if ((event.action === "media-engaged" || event.action === "testimonial-engaged") && event.projectId !== undefined && route.value.projectId !== event.projectId) return unavailable();
  if (event.action === "related-project-opened") {
    if (route.value.contentType !== "project" || route.value.projectId !== event.sourceProjectId) return unavailable();
    if (!content.getRelatedProjectFact) return transient();
    const related = await content.getRelatedProjectFact({ portfolioId, sourceProjectId: event.sourceProjectId, targetProjectId: event.targetProjectId, locale: event.context.locale }, tx);
    if (!related.ok) return related;
    if (!related.value) return unavailable();
  }
  if (event.action === "testimonial-engaged") {
    if (!content.getTestimonialFact) return transient();
    const testimonial = await content.getTestimonialFact({ portfolioId, testimonialId: event.testimonialId,
      ...(event.projectId === undefined ? {} : { projectId: event.projectId }), locale: event.context.locale }, tx);
    if (!testimonial.ok) return testimonial;
    if (!testimonial.value) return unavailable();
  }
  if (event.action === "media-engaged") {
    if (!media) return transient();
    const use = await media.getPublicUseFact({ portfolioId, mediaAssetId: event.mediaAssetId,
      ...(event.projectId === undefined ? {} : { projectId: event.projectId }), locale: event.context.locale }, tx);
    if (!use.ok) return use;
    if (!use.value) return unavailable();
  }
  for (const routeId of event.context.journeyContext ?? []) {
    const retained = await content.hasRetainedPublicRoute({ portfolioId, routeId: routeId as StableId<"PublicRoute"> }, tx);
    if (!retained.ok) return retained;
    if (!retained.value) return err({ kind: "not_found", code: "JOURNEY_ROUTE_UNAVAILABLE" });
  }
  return ok(undefined);
}

export function createMeasurementEventService(deps: MeasurementEventApplicationDeps): { ingestEvent: (command: import("./service.js").IngestPublicEventCommand) => Promise<Result<EventReceipt, Rejection>> } {
  return {
    async ingestEvent(command): Promise<Result<EventReceipt, Rejection>> {
      if (command.scope.kind !== "portfolio" || command.scope.portfolioId !== deps.portfolioId) return unavailable();
      const parsedKey = parseIdempotencyKey(command.idempotencyKey);
      if (!parsedKey.ok) return invalid();
      const parsedEvent = validateEvent(command.event);
      if (!parsedEvent.ok) return parsedEvent;
      const event = parsedEvent.value;
      const evidence: VerifiedMeasurementEvidence | undefined = command.measurement;
      if (!evidence || evidence.purpose !== "measurement" || evidence.portfolioId !== deps.portfolioId ||
          evidence.noticeVersion !== event.context.consentVersion || !parseStableId("MeasurementVisitor", evidence.subject).ok ||
          !parseStableId("Consent", evidence.consentId).ok) return denied();
      const occurredMicros = parseInstantMicros(event.context.occurredAt);
      const nowRaw = deps.clock.now();
      const nowMicros = parseInstantMicros(nowRaw);
      if (occurredMicros === null || nowMicros === null) return transient();
      if (occurredMicros < nowMicros - 86_400_000_000 || occurredMicros > nowMicros + 60_000_000) return invalid();
      const acceptedAt = new Date(Math.floor(nowMicros / 1_000)).toISOString();
      const effectiveAt = occurredMicros > nowMicros ? acceptedAt : event.context.occurredAt;
      try {
        return await deps.transactions.run<Result<EventReceipt, Rejection>>(async tx => {
          const currentConsent = await deps.consent.checkCurrentEvidence(evidence, tx);
          if (!currentConsent.ok) return requestTransactionRollback(currentConsent);
          const facts = await validatePublicFacts(event, deps.portfolioId, deps.content, deps.media, tx);
          if (!facts.ok) return requestTransactionRollback(facts);
          const requestHash = await hashCanonicalRequest(event as unknown as Parameters<typeof hashCanonicalRequest>[0]);
          const execution = await deps.operations.idempotency.execute({
            operationScope: `measurement.public-event:${deps.portfolioId}`,
            actorScope: await hashCanonicalRequest({ purpose: "measurement", portfolioId: deps.portfolioId, subject: evidence.subject }),
            key: parsedKey.value,
            requestHash,
            expiresAt: new Date(Date.parse(acceptedAt) + 30 * 86_400_000).toISOString(),
          }, async context => {
            const eventId = parseStableId("PublicEvent", deps.ids.generate("PublicEvent"));
            const jobId = parseStableId("Job", deps.ids.generate("Job"));
            if (!eventId.ok || !jobId.ok) throw new Error("EVENT_ID_UNAVAILABLE");
            await deps.repository.insert({
              eventId: eventId.value, portfolioId: deps.portfolioId, measurementSubject: evidence.subject,
              event, acceptedAt, effectiveAt,
            }, context);
            await deps.operations.jobs.enqueue(context, {
              jobId: jobId.value,
              payload: { type: "measurement.public-event-received.v1", version: 1, value: { portfolioId: deps.portfolioId, eventId: eventId.value } },
              availableAt: acceptedAt,
            });
            return { eventId: eventId.value, acceptedAt };
          }, tx);
          if (execution.kind === "conflict") return requestTransactionRollback(err({ kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" }));
          return ok(parseReceipt(execution.result));
        });
      } catch {
        return transient();
      }
    },
  };
}
