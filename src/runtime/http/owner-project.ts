/**
 * owner-project.ts — Phase 2 #29 Owner Project HTTP adapter.
 *
 * Thin handwritten adapter for the six Owner Project operations:
 * `GET /api/owner/v1/projects/{projectId}`,
 * `POST /api/owner/v1/projects/{projectId}/commands/change-status`,
 * `POST /api/owner/v1/projects/{projectId}/commands/set-featured`,
 * `POST /api/owner/v1/projects/{projectId}/commands/change-slug`,
 * `POST /api/owner/v1/projects/{projectId}/commands/relate-project`, and
 * `POST /api/owner/v1/projects/{projectId}/commands/assign-taxonomy-value`.
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
 * translation is exercised through fakes.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, or provider types.
 */

import {
  zAssignOwnerProjectTaxonomyValueBody,
  zAssignOwnerProjectTaxonomyValueHeaders,
  zAssignOwnerProjectTaxonomyValuePath,
  zAssignOwnerProjectTaxonomyValueResponse,
  zChangeOwnerProjectPublicSlugBody,
  zChangeOwnerProjectPublicSlugHeaders,
  zChangeOwnerProjectPublicSlugPath,
  zChangeOwnerProjectPublicSlugResponse,
  zCorrectOwnerProjectCandidateSlugBody,
  zCorrectOwnerProjectCandidateSlugHeaders,
  zCorrectOwnerProjectCandidateSlugPath,
  zCorrectOwnerProjectCandidateSlugResponse,
  zChangeOwnerProjectStatusBody,
  zChangeOwnerProjectStatusHeaders,
  zChangeOwnerProjectStatusPath,
  zChangeOwnerProjectStatusResponse,
  zGetOwnerProjectAggregatePath,
  zGetOwnerProjectAggregateResponse,
  zRelateOwnerProjectsBody,
  zRelateOwnerProjectsHeaders,
  zRelateOwnerProjectsPath,
  zRelateOwnerProjectsResponse,
  zSetOwnerProjectFeaturedBody,
  zSetOwnerProjectFeaturedHeaders,
  zSetOwnerProjectFeaturedPath,
  zSetOwnerProjectFeaturedResponse,
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

export interface GetOwnerProjectAggregateQuery {
  readonly actor: ActorContext;
  readonly projectId: StableId<"Project">;
}

export interface ChangeOwnerProjectStatusApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly projectId: StableId<"Project">;
  readonly statusValueId: StableId<string>;
}

export interface SetOwnerProjectFeaturedApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly projectId: StableId<"Project">;
  readonly featured: boolean;
}

export interface ChangeOwnerProjectPublicSlugApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly projectId: StableId<"Project">;
  readonly slug: string;
  readonly correlationId: string;
}

export interface CorrectOwnerProjectCandidateSlugApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly projectId: StableId<"Project">;
  readonly candidateSlug: string;
  readonly correlationId: string;
}

export interface RelateOwnerProjectsApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly projectId: StableId<"Project">;
  readonly relatedProjectId: StableId<"Project">;
  readonly correlationId: string;
}

export interface AssignOwnerProjectTaxonomyValueApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly projectId: StableId<"Project">;
  readonly valueId: StableId<string>;
}

export type OwnerProjectCommandOutcome =
  | "project-status-changed"
  | "project-featured-changed"
  | "public-slug-changed"
  | "candidate-slug-corrected"
  | "project-related"
  | "taxonomy-value-assigned";

export interface OwnerProjectCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: OwnerProjectCommandOutcome;
  readonly relatedProjectAggregateVersion?: number;
}

export interface OwnerProjectAggregateView {
  readonly projectId: StableId<"Project">;
  readonly aggregateVersion: number;
  readonly statusValueId: StableId<string> | null;
  readonly featured: boolean;
  readonly publicRoute: {
    readonly identity: StableId<string>;
    readonly canonicalSlug: string;
    readonly redirects: ReadonlyArray<{
      readonly fromSlug: string;
      readonly toSlug: string;
    }>;
  } | null;
  readonly relatedProjectIds: ReadonlyArray<StableId<"Project">>;
  readonly taxonomyAssignments: ReadonlyArray<{
    readonly taxonomyId: StableId<string>;
    readonly taxonomyKind: string;
    readonly valueId: StableId<string>;
  }>;
}

export interface OwnerProjectApplicationService {
  getOwnerProjectAggregate(
    query: GetOwnerProjectAggregateQuery,
  ): Promise<Result<OwnerProjectAggregateView, Rejection>>;
  changeOwnerProjectStatus(
    command: ChangeOwnerProjectStatusApplicationCommand,
  ): Promise<Result<OwnerProjectCommandReceipt, Rejection>>;
  setOwnerProjectFeatured(
    command: SetOwnerProjectFeaturedApplicationCommand,
  ): Promise<Result<OwnerProjectCommandReceipt, Rejection>>;
  changeOwnerProjectPublicSlug(
    command: ChangeOwnerProjectPublicSlugApplicationCommand,
  ): Promise<Result<OwnerProjectCommandReceipt, Rejection>>;
  correctOwnerProjectCandidateSlug(
    command: CorrectOwnerProjectCandidateSlugApplicationCommand,
  ): Promise<Result<OwnerProjectCommandReceipt, Rejection>>;
  relateOwnerProjects(
    command: RelateOwnerProjectsApplicationCommand,
  ): Promise<Result<OwnerProjectCommandReceipt, Rejection>>;
  assignOwnerProjectTaxonomyValue(
    command: AssignOwnerProjectTaxonomyValueApplicationCommand,
  ): Promise<Result<OwnerProjectCommandReceipt, Rejection>>;
}

export interface OwnerProjectAdapterDeps {
  service: OwnerProjectApplicationService;
  security: OwnerRequestSecurity;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "projects", "{projectId}"].join("/");
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

export async function handleGetOwnerProjectAggregate(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "getOwnerProjectAggregate",
      mode: "read",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const pathResult = zGetOwnerProjectAggregatePath.safeParse({
      projectId: params.projectId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const query: GetOwnerProjectAggregateQuery = {
      actor: guard.actor,
      projectId: pathResult.data.projectId as StableId<"Project">,
    };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerProjectAggregate>>;
    try {
      result = await deps.service.getOwnerProjectAggregate(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      projectId: result.value.projectId,
      aggregateVersion: result.value.aggregateVersion,
      statusValueId: result.value.statusValueId,
      featured: result.value.featured,
      publicRoute: result.value.publicRoute,
      relatedProjectIds: [...result.value.relatedProjectIds],
      taxonomyAssignments: result.value.taxonomyAssignments.map((entry) => ({
        taxonomyId: entry.taxonomyId,
        taxonomyKind: entry.taxonomyKind,
        valueId: entry.valueId,
      })),
    };
    const parsed = zGetOwnerProjectAggregateResponse.safeParse(payload);
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

async function handleProjectCommand(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
  operation: string,
  validators: {
    readonly path: { safeParse(value: unknown): { success: boolean; data?: { projectId: string } } };
    readonly headers: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly body: { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };
    readonly response: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  },
  buildCommand: (args: {
    readonly actor: ActorContext;
    readonly projectId: StableId<"Project">;
    readonly idempotencyKey: IdempotencyKey;
    readonly expectedVersion: number;
    readonly body: Record<string, unknown>;
    readonly correlationId: string;
  }) => unknown,
  call: (command: never) => Promise<Result<OwnerProjectCommandReceipt, Rejection>>,
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
    const pathResult = validators.path.safeParse({ projectId: params.projectId });
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
      projectId: pathResult.data.projectId as StableId<"Project">,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      body: bodyResult.data,
      correlationId: traceId,
    });
    let result: Result<OwnerProjectCommandReceipt, Rejection>;
    try {
      result = await call(command as never);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      aggregateId: result.value.aggregateId,
      aggregateVersion: result.value.aggregateVersion,
      outcome: result.value.outcome,
      ...(result.value.relatedProjectAggregateVersion === undefined
        ? {}
        : { relatedProjectAggregateVersion: result.value.relatedProjectAggregateVersion }),
    };
    const parsed = validators.response.safeParse(payload);
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

export async function handleChangeOwnerProjectStatus(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
): Promise<Response> {
  return await handleProjectCommand(
    request,
    params,
    deps,
    "changeOwnerProjectStatus",
    {
      path: zChangeOwnerProjectStatusPath,
      headers: zChangeOwnerProjectStatusHeaders,
      body: zChangeOwnerProjectStatusBody,
      response: zChangeOwnerProjectStatusResponse,
    },
    ({ actor, projectId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      projectId,
      statusValueId: body["statusValueId"] as StableId<string>,
    }) as ChangeOwnerProjectStatusApplicationCommand,
    (command) => deps.service.changeOwnerProjectStatus(command),
  );
}

export async function handleSetOwnerProjectFeatured(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
): Promise<Response> {
  return await handleProjectCommand(
    request,
    params,
    deps,
    "setOwnerProjectFeatured",
    {
      path: zSetOwnerProjectFeaturedPath,
      headers: zSetOwnerProjectFeaturedHeaders,
      body: zSetOwnerProjectFeaturedBody,
      response: zSetOwnerProjectFeaturedResponse,
    },
    ({ actor, projectId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      projectId,
      featured: body["featured"] as boolean,
    }) as SetOwnerProjectFeaturedApplicationCommand,
    (command) => deps.service.setOwnerProjectFeatured(command),
  );
}

export async function handleChangeOwnerProjectPublicSlug(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
): Promise<Response> {
  return await handleProjectCommand(
    request,
    params,
    deps,
    "changeOwnerProjectPublicSlug",
    {
      path: zChangeOwnerProjectPublicSlugPath,
      headers: zChangeOwnerProjectPublicSlugHeaders,
      body: zChangeOwnerProjectPublicSlugBody,
      response: zChangeOwnerProjectPublicSlugResponse,
    },
    ({ actor, projectId, idempotencyKey, expectedVersion, body, correlationId }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      projectId,
      slug: body["slug"] as string,
      correlationId,
    }) as ChangeOwnerProjectPublicSlugApplicationCommand,
    (command) => deps.service.changeOwnerProjectPublicSlug(command),
  );
}

export async function handleCorrectOwnerProjectCandidateSlug(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
): Promise<Response> {
  return await handleProjectCommand(
    request,
    params,
    deps,
    "correctOwnerProjectCandidateSlug",
    {
      path: zCorrectOwnerProjectCandidateSlugPath,
      headers: zCorrectOwnerProjectCandidateSlugHeaders,
      body: zCorrectOwnerProjectCandidateSlugBody,
      response: zCorrectOwnerProjectCandidateSlugResponse,
    },
    ({ actor, projectId, idempotencyKey, expectedVersion, body, correlationId }) => ({
      actor, idempotencyKey, expectedVersion, projectId,
      candidateSlug: body["candidateSlug"] as string, correlationId,
    }) as CorrectOwnerProjectCandidateSlugApplicationCommand,
    (command) => deps.service.correctOwnerProjectCandidateSlug(command),
  );
}

export async function handleRelateOwnerProjects(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
): Promise<Response> {
  return await handleProjectCommand(
    request,
    params,
    deps,
    "relateOwnerProjects",
    {
      path: zRelateOwnerProjectsPath,
      headers: zRelateOwnerProjectsHeaders,
      body: zRelateOwnerProjectsBody,
      response: zRelateOwnerProjectsResponse,
    },
    ({ actor, projectId, idempotencyKey, expectedVersion, body, correlationId }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      projectId,
      relatedProjectId: body["relatedProjectId"] as StableId<"Project">,
      correlationId,
    }) as RelateOwnerProjectsApplicationCommand,
    (command) => deps.service.relateOwnerProjects(command),
  );
}

export async function handleAssignOwnerProjectTaxonomyValue(
  request: Request,
  params: { projectId: string },
  deps: OwnerProjectAdapterDeps,
): Promise<Response> {
  return await handleProjectCommand(
    request,
    params,
    deps,
    "assignOwnerProjectTaxonomyValue",
    {
      path: zAssignOwnerProjectTaxonomyValuePath,
      headers: zAssignOwnerProjectTaxonomyValueHeaders,
      body: zAssignOwnerProjectTaxonomyValueBody,
      response: zAssignOwnerProjectTaxonomyValueResponse,
    },
    ({ actor, projectId, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      projectId,
      valueId: body["valueId"] as StableId<string>,
    }) as AssignOwnerProjectTaxonomyValueApplicationCommand,
    (command) => deps.service.assignOwnerProjectTaxonomyValue(command),
  );
}
