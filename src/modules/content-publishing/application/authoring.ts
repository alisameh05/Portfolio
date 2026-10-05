import { err, parseStableId, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import type { Clock, StableIdGenerator, TransactionContext } from "../../../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../../../runtime/ports.js";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { OperationsPersistencePorts, SafeResultEnvelope } from "../../portability-operations/application/persistence.js";
import type { ContentKind, CreateDraftPayload, LocalizedDraftData, SupportedLocale } from "../domain/index.js";

export interface ContentAuthoringScope {
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
}

export interface ContentAuthoringRevision {
  readonly revisionId: StableId<"Revision">;
  readonly contentId: StableId<string>;
  readonly contentType: ContentKind;
  readonly locale: SupportedLocale;
  readonly sequence: number;
  readonly aggregateVersion: number;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly payload: CreateDraftPayload;
  readonly savedAt: string;
  readonly reviewed: boolean;
}

export interface ContentAuthoringRecord {
  readonly contentId: StableId<string>;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly contentType: ContentKind;
  readonly lifecycle: "draft" | "published" | "hidden" | "archived";
  readonly candidateSlug: string | null;
  readonly aggregateVersion: number;
  readonly revisions: readonly ContentAuthoringRevision[];
}

export interface CreateContentPersistenceInput {
  readonly contentId: StableId<string>;
  readonly revisionId: StableId<"Revision">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly candidateSlug: string | null;
  readonly payload: CreateDraftPayload;
  readonly savedAt: string;
}

export interface AppendContentRevisionInput {
  readonly contentId: StableId<string>;
  readonly scope: ContentAuthoringScope;
  readonly revisionId: StableId<"Revision">;
  readonly expectedVersion: number;
  readonly payload: CreateDraftPayload;
  readonly savedAt: string;
}

export interface ContentAuthoringRepository {
  projectExists(projectId: StableId<"Project">, scope: ContentAuthoringScope, context: TransactionContext): Promise<boolean>;
  create(input: CreateContentPersistenceInput, context: TransactionContext): Promise<Result<ContentAuthoringRecord, Rejection>>;
  get(contentId: StableId<string>, scope: ContentAuthoringScope, context: TransactionContext): Promise<Result<ContentAuthoringRecord, Rejection>>;
  appendRevision(input: AppendContentRevisionInput, context: TransactionContext): Promise<Result<{ readonly record: ContentAuthoringRecord; readonly revision: ContentAuthoringRevision }, Rejection>>;
}

export interface SaveContentRevisionCommand {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
  readonly expectedVersion: number;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly locale: SupportedLocale;
  readonly title: string;
  readonly summary: string;
  readonly body: string;
  readonly draftData?: LocalizedDraftData;
}

export interface CreateOwnerContentCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly correlationId: string;
  readonly payload: CreateDraftPayload;
}

export interface GetOwnerContentAggregateQuery {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
}

export interface CreateContentReceipt {
  readonly contentId: StableId<string>;
  readonly aggregateVersion: number;
  readonly revisionId: StableId<"Revision">;
  readonly outcome: "content-created";
}

export interface SaveContentRevisionReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "revision-saved";
  readonly revisionId: StableId<"Revision">;
}

export interface OwnerContentAggregateView {
  readonly contentId: StableId<string>;
  readonly aggregateVersion: number;
  readonly contentType: ContentKind;
  readonly lifecycle: ContentAuthoringRecord["lifecycle"];
  readonly localizedStreams: Partial<Record<SupportedLocale, {
    readonly revisionCount: number;
    readonly currentPublishedRevisionId: StableId<string> | null;
  }>>;
  readonly revisions: readonly {
    readonly revisionId: StableId<"Revision">;
    readonly locale: SupportedLocale;
    readonly sequence: number;
    readonly reviewed: boolean;
  }[];
}

export interface ContentAuthoringService {
  createContent(command: CreateOwnerContentCommand): Promise<Result<CreateContentReceipt, Rejection>>;
  getOwnerContentAggregate(query: GetOwnerContentAggregateQuery): Promise<Result<OwnerContentAggregateView, Rejection>>;
  saveRevision(command: SaveContentRevisionCommand): Promise<Result<SaveContentRevisionReceipt, Rejection>>;
}

const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1_000;
const CREATE_SCOPE = "content-publishing.create-owner-content";
const SAVE_SCOPE = "content-publishing.save-owner-content-revision";
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const EXECUTABLE_MARKUP = /<\s*(?:script|iframe|object|embed|svg|math)\b|\bon[a-z]{2,}\s*=|(?:javascript|vbscript)\s*:|data\s*:\s*text\/html/i;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function rejectionOutcome(rejection: Rejection): SafeResultEnvelope {
  return {
    status: "rejected",
    kind: rejection.kind,
    code: rejection.code,
    ...(rejection.kind === "precondition_failed" && rejection.currentVersion !== undefined
      ? { currentVersion: rejection.currentVersion }
      : {}),
  };
}

function parseRejection(result: SafeResultEnvelope): Rejection {
  const kind = result["kind"];
  const code = result["code"];
  if (typeof kind !== "string" || typeof code !== "string") throw new Error("Invalid saved content operation outcome.");
  if (kind === "precondition_failed" && typeof result["currentVersion"] === "number") {
    return { kind, code, currentVersion: result["currentVersion"] };
  }
  if (["validation", "unauthenticated", "forbidden", "not_found", "conflict", "precondition_failed", "rate_limited", "temporarily_unavailable"].includes(kind)) {
    return { kind: kind as Rejection["kind"], code } as Rejection;
  }
  throw new Error("Invalid saved content operation rejection.");
}

function readReceipt<T>(result: SafeResultEnvelope): Result<T, Rejection> {
  if (result["status"] === "rejected") return err(parseRejection(result));
  if (result["status"] !== "completed" || typeof result["receipt"] !== "object" || result["receipt"] === null || Array.isArray(result["receipt"])) {
    throw new Error("Invalid saved content operation receipt.");
  }
  return { ok: true, value: result["receipt"] as T };
}

function isCleanText(value: string, max: number): boolean {
  return value.trim().length > 0 && value.length <= max && !CONTROL_CHARS.test(value) && !EXECUTABLE_MARKUP.test(value);
}

function payloadIsValid(payload: CreateDraftPayload): boolean {
  if (payload.locale !== "en" && payload.locale !== "ar") return false;
  if (!isCleanText(payload.title, 160) || !isCleanText(payload.summary, 500) || !isCleanText(payload.body, 50_000)) return false;
  if (payload.contentType === "project") {
    if (payload.candidateSlug !== undefined && (payload.candidateSlug.length > 120 || !SLUG_PATTERN.test(payload.candidateSlug))) return false;
    const study = payload.caseStudy;
    return study === undefined ||
      ((study.problem === undefined || study.problem.length <= 5_000 && !CONTROL_CHARS.test(study.problem) && !EXECUTABLE_MARKUP.test(study.problem)) &&
      (study.ownerRole === undefined || study.ownerRole.length <= 2_000 && !CONTROL_CHARS.test(study.ownerRole) && !EXECUTABLE_MARKUP.test(study.ownerRole)) &&
      (study.lessons === undefined || study.lessons.length <= 5_000 && !CONTROL_CHARS.test(study.lessons) && !EXECUTABLE_MARKUP.test(study.lessons)) &&
      [study.contributions ?? [], study.outcomes ?? []].every((items) => items.length <= 50 && items.every((item) => item.length <= 2_000 && !CONTROL_CHARS.test(item) && !EXECUTABLE_MARKUP.test(item))));
  }
  if (payload.contentType === "achievement") {
    const dateValid = payload.achievedOn === undefined || /^\d{4}-\d{2}-\d{2}$/.test(payload.achievedOn) && Number.isFinite(Date.parse(`${payload.achievedOn}T00:00:00Z`)) && new Date(`${payload.achievedOn}T00:00:00Z`).toISOString().slice(0, 10) === payload.achievedOn;
    const claims = payload.evidence?.claims;
    return dateValid && (claims === undefined || claims.length <= 100 && claims.every((claim) =>
      parseStableId("EvidenceClaim", claim.claimId).ok && isCleanText(claim.text, 2_000) && claim.artifactIds.length <= 100 &&
      claim.artifactIds.every((id) => parseStableId("SupportingArtifact", id).ok)));
  }
  return (payload.authorName === undefined || isCleanText(payload.authorName, 200)) &&
    (payload.quote === undefined || isCleanText(payload.quote, 10_000)) &&
    (payload.relatedProjectId === undefined || parseStableId("Project", payload.relatedProjectId).ok);
}

function candidateFromTitle(title: string, contentId: StableId<string>): string {
  const slug = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120).replace(/-+$/g, "");
  return slug || `draft-${contentId.slice(0, 8)}`;
}

function snapshotPayload(payload: CreateDraftPayload): CreateDraftPayload {
  if (payload.contentType === "testimonial") {
    const association = payload.relatedProjectId === undefined
      ? { type: "profile" as const }
      : { type: "project" as const, projectId: payload.relatedProjectId };
    return Object.freeze({ ...payload, association });
  }
  return Object.freeze({ ...payload });
}

function ownerAuthorized(actor: ActorContext, scope: ContentAuthoringScope): boolean {
  return actor.kind === "owner" && actor.ownerId === scope.ownerId;
}

function validCorrelation(value: string): boolean {
  return /^[\x21-\x7e]{1,128}$/.test(value);
}

function view(record: ContentAuthoringRecord): OwnerContentAggregateView {
  const localizedStreams: OwnerContentAggregateView["localizedStreams"] = {};
  for (const locale of ["en", "ar"] as const) {
    const count = record.revisions.filter((revision) => revision.locale === locale).length;
    if (count > 0) localizedStreams[locale] = { revisionCount: count, currentPublishedRevisionId: null };
  }
  return {
    contentId: record.contentId,
    aggregateVersion: record.aggregateVersion,
    contentType: record.contentType,
    lifecycle: record.lifecycle,
    localizedStreams,
    revisions: record.revisions.map(({ revisionId, locale, sequence, reviewed }) => ({ revisionId, locale, sequence, reviewed })),
  };
}

export function createContentAuthoringService(input: {
  readonly repository: ContentAuthoringRepository;
  readonly operations: OperationsPersistencePorts;
  readonly scope: ContentAuthoringScope;
  readonly clock?: Clock;
  readonly ids?: StableIdGenerator;
}): ContentAuthoringService {
  const clock = input.clock ?? createSystemClock();
  const ids = input.ids ?? createSystemIdGenerator();
  const actorScope = hashCanonicalRequest({ ownerId: input.scope.ownerId });

  async function executeIdempotently<T>(options: {
    readonly operationScope: string;
    readonly actor: ActorContext;
    readonly key: IdempotencyKey;
    readonly request: unknown;
    readonly effect: (context: TransactionContext) => Promise<SafeResultEnvelope>;
  }): Promise<Result<T, Rejection>> {
    if (!ownerAuthorized(options.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
    const [requestHash, ownerScope] = await Promise.all([
      hashCanonicalRequest(options.request as Parameters<typeof hashCanonicalRequest>[0]),
      actorScope,
    ]);
    const now = clock.now();
    const expiresAt = new Date(Date.parse(now) + IDEMPOTENCY_RETENTION_MS).toISOString();
    const execution = await input.operations.idempotency.execute({
      operationScope: options.operationScope,
      actorScope: ownerScope,
      key: options.key,
      requestHash,
      expiresAt,
    }, options.effect);
    if (execution.kind === "conflict") return err({ kind: "conflict", code: "IDEMPOTENCY_KEY_REUSED" });
    return readReceipt<T>(execution.result);
  }

  return {
    async createContent(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !payloadIsValid(command.payload)) {
        return err({ kind: "validation", code: "INVALID_CONTENT_DRAFT" });
      }
      const contentId = parseStableId("Content", ids.generate("Content"));
      const revisionId = parseStableId("Revision", ids.generate("Revision"));
      if (!contentId.ok || !revisionId.ok) throw new Error("Stable ID generator returned an invalid identity.");
      const prepared = snapshotPayload(command.payload);
      const payload: CreateDraftPayload = prepared.contentType === "project"
        ? { ...prepared, candidateSlug: prepared.candidateSlug ?? candidateFromTitle(prepared.title, contentId.value) }
        : prepared;
      const candidateSlug = payload.contentType === "project" ? payload.candidateSlug ?? null : null;
      const savedAt = clock.now();
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        if (payload.contentType === "testimonial" && payload.relatedProjectId !== undefined &&
            !await input.repository.projectExists(payload.relatedProjectId, input.scope, context)) {
          return rejectionOutcome({ kind: "validation", code: "RELATED_PROJECT_UNAVAILABLE" });
        }
        const created = await input.repository.create({
          contentId: contentId.value,
          revisionId: revisionId.value,
          portfolioId: input.scope.portfolioId,
          ownerId: input.scope.ownerId,
          candidateSlug,
          payload,
          savedAt,
        }, context);
        if (!created.ok) return rejectionOutcome(created.error);
        const receipt: CreateContentReceipt = {
          contentId: contentId.value,
          aggregateVersion: created.value.aggregateVersion,
          revisionId: revisionId.value,
          outcome: "content-created",
        };
        const ownerHash = await actorScope;
        for (const [type, eventId] of [
          ["content.created.v1", ids.generate("DomainEvent")],
          ["content.revision_saved.v1", ids.generate("DomainEvent")],
        ] as const) {
          await input.operations.outbox.append(context, {
            eventId,
            payload: {
              type,
              version: 1,
              value: { contentId: contentId.value, revisionId: revisionId.value, contentType: payload.contentType, locale: payload.locale, ownerScope: ownerHash },
            },
            aggregateId: contentId.value,
            aggregateVersion: 1,
            correlationId: command.correlationId,
            occurredAt: savedAt,
            availableAt: savedAt,
          });
        }
        return { status: "completed", receipt: {
          contentId: receipt.contentId,
          aggregateVersion: receipt.aggregateVersion,
          revisionId: receipt.revisionId,
          outcome: receipt.outcome,
        } };
      };
      const execution = await executeIdempotently<CreateContentReceipt>({
        operationScope: CREATE_SCOPE,
        actor: command.actor,
        key: command.idempotencyKey,
        request: command.payload,
        effect,
      });
      return execution;
    },

    async getOwnerContentAggregate(query) {
      if (!ownerAuthorized(query.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      return await input.operations.transactions.run(async (context) => {
        const result = await input.repository.get(query.contentId, input.scope, context);
        return result.ok ? { ok: true as const, value: view(result.value) } : result;
      });
    },

    async saveRevision(command) {
      if (!ownerAuthorized(command.actor, input.scope)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (!validCorrelation(command.correlationId) || !Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          !isCleanText(command.title, 160) || !isCleanText(command.summary, 500) || !isCleanText(command.body, 50_000) ||
          (command.locale !== "en" && command.locale !== "ar")) {
        return err({ kind: "validation", code: "INVALID_CONTENT_REVISION" });
      }
      const revisionId = parseStableId("Revision", ids.generate("Revision"));
      if (!revisionId.ok) throw new Error("Stable ID generator returned an invalid revision identity.");
      const savedAt = clock.now();
      const effect = async (context: TransactionContext): Promise<SafeResultEnvelope> => {
        const existing = await input.repository.get(command.contentId, input.scope, context);
        if (!existing.ok) return rejectionOutcome(existing.error);
        if (command.draftData !== undefined && command.draftData.contentType !== existing.value.contentType) {
          return rejectionOutcome({ kind: "validation", code: "CONTENT_DRAFT_TYPE_MISMATCH" });
        }
        if (existing.value.aggregateVersion !== command.expectedVersion) {
          return rejectionOutcome({ kind: "precondition_failed", code: "CONTENT_VERSION_MISMATCH", currentVersion: existing.value.aggregateVersion });
        }
        const orderedRevisions = [...existing.value.revisions].reverse();
        const previous = orderedRevisions.find((revision) => revision.locale === command.locale) ?? orderedRevisions[0];
        const draftData = command.draftData;
        let payload: CreateDraftPayload;
        const common = { locale: command.locale, title: command.title, summary: command.summary, body: command.body };
        if (existing.value.contentType === "project") {
          const prior = previous?.payload.contentType === "project" ? previous.payload : undefined;
          const caseStudy = draftData?.contentType === "project" ? draftData.caseStudy : prior?.caseStudy;
          payload = { contentType: "project", ...(existing.value.candidateSlug === null ? {} : { candidateSlug: existing.value.candidateSlug }), ...common,
            ...(caseStudy === undefined ? {} : { caseStudy }) };
        } else if (existing.value.contentType === "achievement") {
          const prior = previous?.payload.contentType === "achievement" ? previous.payload : undefined;
          const achievedOn = draftData?.contentType === "achievement" ? draftData.achievedOn : prior?.achievedOn;
          const evidence = draftData?.contentType === "achievement" ? draftData.evidence : prior?.evidence;
          payload = { contentType: "achievement", ...common, ...(achievedOn === undefined ? {} : { achievedOn }), ...(evidence === undefined ? {} : { evidence }) };
        } else {
          const prior = previous?.payload.contentType === "testimonial" ? previous.payload : undefined;
          const authorName = draftData?.contentType === "testimonial" ? draftData.authorName : prior?.authorName;
          const quote = draftData?.contentType === "testimonial" ? draftData.quote : prior?.quote;
          const relatedProjectId = draftData?.contentType === "testimonial" ? draftData.relatedProjectId : prior?.relatedProjectId;
          payload = snapshotPayload({ contentType: "testimonial", ...common, ...(authorName === undefined ? {} : { authorName }), ...(quote === undefined ? {} : { quote }), ...(relatedProjectId === undefined ? {} : { relatedProjectId }) });
          if (relatedProjectId !== undefined && !await input.repository.projectExists(relatedProjectId, input.scope, context)) {
            return rejectionOutcome({ kind: "validation", code: "RELATED_PROJECT_UNAVAILABLE" });
          }
        }
        if (!payloadIsValid(payload)) return rejectionOutcome({ kind: "validation", code: "INVALID_CONTENT_DRAFT" });
        const appended = await input.repository.appendRevision({
          contentId: command.contentId,
          scope: input.scope,
          revisionId: revisionId.value,
          expectedVersion: command.expectedVersion,
          payload,
          savedAt,
        }, context);
        if (!appended.ok) return rejectionOutcome(appended.error);
        const receipt: SaveContentRevisionReceipt = {
          aggregateId: command.contentId,
          aggregateVersion: appended.value.record.aggregateVersion,
          outcome: "revision-saved",
          revisionId: revisionId.value,
        };
        await input.operations.outbox.append(context, {
          eventId: ids.generate("DomainEvent"),
          payload: { type: "content.revision_saved.v1", version: 1, value: { contentId: command.contentId, revisionId: revisionId.value, locale: command.locale, ownerScope: await actorScope } },
          aggregateId: command.contentId,
          aggregateVersion: appended.value.record.aggregateVersion,
          correlationId: command.correlationId,
          occurredAt: savedAt,
          availableAt: savedAt,
        });
        return { status: "completed", receipt: {
          aggregateId: receipt.aggregateId,
          aggregateVersion: receipt.aggregateVersion,
          outcome: receipt.outcome,
          revisionId: receipt.revisionId,
        } };
      };
      return await executeIdempotently<SaveContentRevisionReceipt>({
        operationScope: SAVE_SCOPE,
        actor: command.actor,
        key: command.idempotencyKey,
        request: { contentId: command.contentId, expectedVersion: command.expectedVersion, locale: command.locale, title: command.title, summary: command.summary, body: command.body, draftData: command.draftData ?? null },
        effect,
      });
    },
  };
}
