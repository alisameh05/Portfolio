/**
 * owner-publication.ts — Phase 2 #30 Owner Publication HTTP adapter.
 *
 * Thin handwritten adapter for the six Owner Publication operations:
 * `GET /api/owner/v1/content/{contentId}`,
 * `POST /api/owner/v1/content/{contentId}/revisions`,
 * `POST /api/owner/v1/content/{contentId}/commands/publish-language`,
 * `POST /api/owner/v1/content/{contentId}/commands/hide`,
 * `POST /api/owner/v1/content/{contentId}/commands/archive`, and
 * `POST /api/owner/v1/content/{contentId}/commands/restore`.
 *
 * Ordered behavior per operation: establish request context; validate path,
 * headers (Idempotency-Key plus If-Match concurrency where declared), and
 * body with the generated strict validators; construct one operation-specific
 * command or query; call one injected application interface once; validate
 * and serialize the declared response; complete request logging.
 *
 * The Owner actor is resolved through the shared Phase 4 verified-actor
 * boundary (`./owner-security.js`): every operation requires a verified
 * Owner session, owner-scoped authorization, and (for mutations) exact
 * origin plus CSRF proof before dispatch. Unauthenticated and forbidden
 * translation is exercised through fakes. Revisions, Language-version
 * publication, lifecycle decisions, Taxonomy evolution, evidence, routes,
 * persistence, and authorization rules remain unimplemented
 * provider-neutral application behavior.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, or provider types.
 */

import {
  zArchiveOwnerContentBody,
  zArchiveOwnerContentHeaders,
  zArchiveOwnerContentPath,
  zArchiveOwnerContentResponse,
  zGetOwnerContentAggregatePath,
  zGetOwnerContentAggregateResponse,
  zHideOwnerContentBody,
  zHideOwnerContentHeaders,
  zHideOwnerContentPath,
  zHideOwnerContentResponse,
  zPublishOwnerContentLanguageBody,
  zPublishOwnerContentLanguageHeaders,
  zPublishOwnerContentLanguagePath,
  zPublishOwnerContentLanguageResponse,
  zRestoreOwnerContentBody,
  zRestoreOwnerContentHeaders,
  zRestoreOwnerContentPath,
  zRestoreOwnerContentResponse,
  zSaveOwnerContentRevisionBody,
  zSaveOwnerContentRevisionHeaders,
  zSaveOwnerContentRevisionPath,
  zSaveOwnerContentRevisionResponse,
} from "../../contracts/http/owner/v1/generated/zod.gen.js";
import type {
  ActorContext,
  IdempotencyKey,
  Rejection,
  Result,
  StableId,
} from "../../shared/domain/index.js";
import { createCorrelation, type Logger } from "../ports.js";
import {
  guardOwnerRequest,
  type OwnerRequestSecurity,
} from "./owner-security.js";
import {
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

// ── Provider-neutral application seam ─────────────────────────────────────────

export interface GetOwnerContentAggregateQuery {
  readonly actor: ActorContext;
  readonly contentId: StableId<string>;
}

export interface SaveOwnerContentRevisionApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly contentId: StableId<string>;
  readonly locale: "en" | "ar";
  readonly title: string;
  readonly summary: string;
  readonly body: string;
}

export interface PublishOwnerContentLanguageApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly contentId: StableId<string>;
  readonly locale: "en" | "ar";
  readonly revisionId: StableId<"Revision">;
}

export interface HideOwnerContentApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly contentId: StableId<string>;
  readonly reason?: string;
}

export interface ArchiveOwnerContentApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly contentId: StableId<string>;
  readonly reason?: string;
}

export interface RestoreOwnerContentApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly contentId: StableId<string>;
  readonly reason?: string;
}

export interface OwnerContentAggregateView {
  readonly contentId: StableId<string>;
  readonly aggregateVersion: number;
  readonly contentType: "project" | "achievement" | "testimonial";
  readonly lifecycle: "draft" | "published" | "hidden" | "archived";
  readonly localizedStreams: {
    readonly en?: {
      readonly revisionCount: number;
      readonly currentPublishedRevisionId: StableId<string> | null;
    };
    readonly ar?: {
      readonly revisionCount: number;
      readonly currentPublishedRevisionId: StableId<string> | null;
    };
  };
  readonly revisions: ReadonlyArray<{
    readonly revisionId: StableId<string>;
    readonly locale: "en" | "ar";
    readonly sequence: number;
    readonly reviewed: boolean;
  }>;
}

export interface SaveOwnerContentRevisionReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "revision-saved";
  readonly revisionId: StableId<string>;
}

export interface OwnerPublicationCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome:
    | "language-published"
    | "content-hidden"
    | "content-archived"
    | "content-restored";
}

export interface OwnerPublicationApplicationService {
  getOwnerContentAggregate(
    query: GetOwnerContentAggregateQuery,
  ): Promise<Result<OwnerContentAggregateView, Rejection>>;
  saveOwnerContentRevision(
    command: SaveOwnerContentRevisionApplicationCommand,
  ): Promise<Result<SaveOwnerContentRevisionReceipt, Rejection>>;
  publishOwnerContentLanguage(
    command: PublishOwnerContentLanguageApplicationCommand,
  ): Promise<Result<OwnerPublicationCommandReceipt, Rejection>>;
  hideOwnerContent(
    command: HideOwnerContentApplicationCommand,
  ): Promise<Result<OwnerPublicationCommandReceipt, Rejection>>;
  archiveOwnerContent(
    command: ArchiveOwnerContentApplicationCommand,
  ): Promise<Result<OwnerPublicationCommandReceipt, Rejection>>;
  restoreOwnerContent(
    command: RestoreOwnerContentApplicationCommand,
  ): Promise<Result<OwnerPublicationCommandReceipt, Rejection>>;
}

export interface OwnerPublicationAdapterDeps {
  service: OwnerPublicationApplicationService;
  security: OwnerRequestSecurity;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "content", "{contentId}"].join("/");
  }
}

function parseExpectedVersion(ifMatch: string): number | null {
  const match = /^"([1-9][0-9]*)"$/.exec(ifMatch);
  if (match === null || match[1] === undefined) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

async function readJsonBody(request: Request): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false }
> {
  try {
    return { ok: true, value: (await request.json()) as unknown };
  } catch {
    return { ok: false };
  }
}

function reject(
  logger: Logger | undefined,
  traceId: string,
  instance: string,
  detail: string,
): Response {
  logger?.warn("request.rejected", { traceId, status: 400 });
  return transportProblem(detail, traceId, instance);
}

function toRejection(
  error: Rejection,
  traceId: string,
  instance: string,
  logger: Logger | undefined,
): Response {
  const rejection = rejectionToProblem(error, traceId, instance);
  logger?.warn("request.rejected", {
    traceId,
    status: rejection.status,
    code: error.code,
  });
  return rejection;
}

function commandHeaders(request: Request): Record<string, string | undefined> {
  return {
    "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
    "If-Match": request.headers.get("if-match") ?? undefined,
  };
}

export async function handleGetOwnerContentAggregate(
  request: Request,
  params: { contentId: string },
  deps: OwnerPublicationAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "getOwnerContentAggregate",
      mode: "read",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const pathResult = zGetOwnerContentAggregatePath.safeParse({
      contentId: params.contentId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const query: GetOwnerContentAggregateQuery = {
      actor: guard.actor,
      contentId: pathResult.data.contentId as StableId<string>,
    };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerContentAggregate>>;
    try {
      result = await deps.service.getOwnerContentAggregate(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      contentId: result.value.contentId,
      aggregateVersion: result.value.aggregateVersion,
      contentType: result.value.contentType,
      lifecycle: result.value.lifecycle,
      localizedStreams: result.value.localizedStreams,
      revisions: [...result.value.revisions],
    };
    const parsed = zGetOwnerContentAggregateResponse.safeParse(payload);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(parsed.data, { status: 200 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

async function handleContentCommand(
  request: Request,
  params: { contentId: string },
  deps: OwnerPublicationAdapterDeps,
  operation: string,
  validators: {
    readonly path: { safeParse(value: unknown): { success: boolean; data?: { contentId: string } } };
    readonly headers: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly body: { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };
    readonly response: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  },
  successStatus: number,
  buildCommand: (args: {
    readonly actor: ActorContext;
    readonly contentId: StableId<string>;
    readonly idempotencyKey: IdempotencyKey;
    readonly expectedVersion: number;
    readonly body: Record<string, unknown>;
  }) => unknown,
  call: (
    command: never,
  ) => Promise<Result<{ readonly aggregateId: StableId<string>; readonly aggregateVersion: number }, Rejection>>,
  toPayload: (value: {
    readonly aggregateId: StableId<string>;
    readonly aggregateVersion: number;
    readonly [key: string]: unknown;
  }) => Record<string, unknown>,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation,
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const pathResult = validators.path.safeParse({ contentId: params.contentId });
    if (!pathResult.success || pathResult.data === undefined) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const headersResult = validators.headers.safeParse(commandHeaders(request));
    if (!headersResult.success || headersResult.data === undefined) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const raw = await readJsonBody(request);
    if (!raw.ok) {
      return reject(logger, traceId, instance, "Malformed JSON body.");
    }
    const bodyResult = validators.body.safeParse(raw.value);
    if (!bodyResult.success || bodyResult.data === undefined) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"] ?? "");
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const command = buildCommand({
      actor: guard.actor,
      contentId: pathResult.data.contentId as StableId<string>,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      body: bodyResult.data,
    });
    let result: Result<{ readonly aggregateId: StableId<string>; readonly aggregateVersion: number; readonly [key: string]: unknown }, Rejection>;
    try {
      result = (await call(command as never)) as Result<
        { readonly aggregateId: StableId<string>; readonly aggregateVersion: number; readonly [key: string]: unknown },
        Rejection
      >;
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = toPayload(result.value);
    const parsed = validators.response.safeParse(payload);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: successStatus });
    return Response.json(parsed.data, { status: successStatus });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleSaveOwnerContentRevision(
  request: Request,
  params: { contentId: string },
  deps: OwnerPublicationAdapterDeps,
): Promise<Response> {
  return await handleContentCommand(
    request,
    params,
    deps,
    "saveOwnerContentRevision",
    {
      path: zSaveOwnerContentRevisionPath,
      headers: zSaveOwnerContentRevisionHeaders,
      body: zSaveOwnerContentRevisionBody,
      response: zSaveOwnerContentRevisionResponse,
    },
    201,
    ({ actor, contentId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      contentId,
      locale: body["locale"] as "en" | "ar",
      title: body["title"] as string,
      summary: body["summary"] as string,
      body: body["body"] as string,
    }) as SaveOwnerContentRevisionApplicationCommand,
    (command) => deps.service.saveOwnerContentRevision(command),
    (value) => ({
      aggregateId: value.aggregateId,
      aggregateVersion: value.aggregateVersion,
      outcome: value["outcome"],
      revisionId: value["revisionId"],
    }),
  );
}

export async function handlePublishOwnerContentLanguage(
  request: Request,
  params: { contentId: string },
  deps: OwnerPublicationAdapterDeps,
): Promise<Response> {
  return await handleContentCommand(
    request,
    params,
    deps,
    "publishOwnerContentLanguage",
    {
      path: zPublishOwnerContentLanguagePath,
      headers: zPublishOwnerContentLanguageHeaders,
      body: zPublishOwnerContentLanguageBody,
      response: zPublishOwnerContentLanguageResponse,
    },
    200,
    ({ actor, contentId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      contentId,
      locale: body["locale"] as "en" | "ar",
      revisionId: body["revisionId"] as StableId<"Revision">,
    }) as PublishOwnerContentLanguageApplicationCommand,
    (command) => deps.service.publishOwnerContentLanguage(command),
    (value) => ({
      aggregateId: value.aggregateId,
      aggregateVersion: value.aggregateVersion,
      outcome: value["outcome"],
    }),
  );
}

function lifecyclePayload(value: {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly [key: string]: unknown;
}): Record<string, unknown> {
  return {
    aggregateId: value.aggregateId,
    aggregateVersion: value.aggregateVersion,
    outcome: value["outcome"],
  };
}

export async function handleHideOwnerContent(
  request: Request,
  params: { contentId: string },
  deps: OwnerPublicationAdapterDeps,
): Promise<Response> {
  return await handleContentCommand(
    request,
    params,
    deps,
    "hideOwnerContent",
    {
      path: zHideOwnerContentPath,
      headers: zHideOwnerContentHeaders,
      body: zHideOwnerContentBody,
      response: zHideOwnerContentResponse,
    },
    200,
    ({ actor, contentId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      contentId,
      ...(typeof body["reason"] === "string" ? { reason: body["reason"] as string } : {}),
    }) as HideOwnerContentApplicationCommand,
    (command) => deps.service.hideOwnerContent(command),
    lifecyclePayload,
  );
}

export async function handleArchiveOwnerContent(
  request: Request,
  params: { contentId: string },
  deps: OwnerPublicationAdapterDeps,
): Promise<Response> {
  return await handleContentCommand(
    request,
    params,
    deps,
    "archiveOwnerContent",
    {
      path: zArchiveOwnerContentPath,
      headers: zArchiveOwnerContentHeaders,
      body: zArchiveOwnerContentBody,
      response: zArchiveOwnerContentResponse,
    },
    200,
    ({ actor, contentId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      contentId,
      ...(typeof body["reason"] === "string" ? { reason: body["reason"] as string } : {}),
    }) as ArchiveOwnerContentApplicationCommand,
    (command) => deps.service.archiveOwnerContent(command),
    lifecyclePayload,
  );
}

export async function handleRestoreOwnerContent(
  request: Request,
  params: { contentId: string },
  deps: OwnerPublicationAdapterDeps,
): Promise<Response> {
  return await handleContentCommand(
    request,
    params,
    deps,
    "restoreOwnerContent",
    {
      path: zRestoreOwnerContentPath,
      headers: zRestoreOwnerContentHeaders,
      body: zRestoreOwnerContentBody,
      response: zRestoreOwnerContentResponse,
    },
    200,
    ({ actor, contentId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      contentId,
      ...(typeof body["reason"] === "string" ? { reason: body["reason"] as string } : {}),
    }) as RestoreOwnerContentApplicationCommand,
    (command) => deps.service.restoreOwnerContent(command),
    lifecyclePayload,
  );
}
