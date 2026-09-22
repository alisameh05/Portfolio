/**
 * owner-taxonomy.ts — Phase 2 #30 Owner Taxonomy HTTP adapter.
 *
 * Thin handwritten adapter for the five Owner Taxonomy operations:
 * `GET /api/owner/v1/taxonomies/{taxonomyId}`,
 * `POST /api/owner/v1/taxonomies/{taxonomyId}/values`,
 * `POST /api/owner/v1/taxonomy-values/{valueId}/commands/rename`,
 * `POST /api/owner/v1/taxonomy-values/{valueId}/commands/retire`, and
 * `POST /api/owner/v1/taxonomy-values/{valueId}/commands/merge`.
 *
 * Ordered behavior per operation: establish request context; validate path,
 * headers (Idempotency-Key plus If-Match concurrency where declared), and
 * body with the generated strict validators; construct one operation-specific
 * command or query; call one injected application interface once; validate
 * and serialize the declared response; complete request logging.
 *
 * The Owner actor is a deterministic Phase 2 placeholder. Real Supabase
 * session, cookie, and Owner allowlist enforcement remain Phase 4 work;
 * unauthenticated and forbidden translation is exercised through fakes.
 * Taxonomy evolution, persistence, and authorization rules remain
 * unimplemented provider-neutral application behavior.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, or provider types.
 */

import {
  zCreateOwnerTaxonomyValueBody,
  zCreateOwnerTaxonomyValueHeaders,
  zCreateOwnerTaxonomyValuePath,
  zCreateOwnerTaxonomyValueResponse,
  zGetOwnerTaxonomyAggregatePath,
  zGetOwnerTaxonomyAggregateResponse,
  zMergeOwnerTaxonomyValueBody,
  zMergeOwnerTaxonomyValueHeaders,
  zMergeOwnerTaxonomyValuePath,
  zMergeOwnerTaxonomyValueResponse,
  zRenameOwnerTaxonomyValueBody,
  zRenameOwnerTaxonomyValueHeaders,
  zRenameOwnerTaxonomyValuePath,
  zRenameOwnerTaxonomyValueResponse,
  zRetireOwnerTaxonomyValueBody,
  zRetireOwnerTaxonomyValueHeaders,
  zRetireOwnerTaxonomyValuePath,
  zRetireOwnerTaxonomyValueResponse,
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
  internalErrorProblem,
  rejectionToProblem,
  transportProblem,
} from "./problem.js";

// ── Provider-neutral application seam ─────────────────────────────────────────

export interface GetOwnerTaxonomyAggregateQuery {
  readonly actor: ActorContext;
  readonly taxonomyId: StableId<string>;
}

export interface CreateOwnerTaxonomyValueApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly taxonomyId: StableId<string>;
  readonly name: string;
}

export interface RenameOwnerTaxonomyValueApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly valueId: StableId<string>;
  readonly name: string;
}

export interface RetireOwnerTaxonomyValueApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly valueId: StableId<string>;
  readonly reason?: string;
}

export interface MergeOwnerTaxonomyValueApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly valueId: StableId<string>;
  readonly targetValueId: StableId<string>;
}

export type OwnerTaxonomyValueView =
  | { readonly valueId: StableId<string>; readonly name: string; readonly state: "active" }
  | { readonly valueId: StableId<string>; readonly name: string; readonly state: "retired" }
  | {
      readonly valueId: StableId<string>;
      readonly name: string;
      readonly state: "merged";
      readonly mergedIntoValueId: StableId<string>;
    };

export interface OwnerTaxonomyAggregateView {
  readonly taxonomyId: StableId<string>;
  readonly aggregateVersion: number;
  readonly kind: "category" | "ai-ml-domain" | "technology" | "project-type";
  readonly values: ReadonlyArray<OwnerTaxonomyValueView>;
}

export interface OwnerTaxonomyCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome:
    | "taxonomy-value-created"
    | "taxonomy-value-renamed"
    | "taxonomy-value-retired"
    | "taxonomy-value-merged";
}

export interface OwnerTaxonomyApplicationService {
  getOwnerTaxonomyAggregate(
    query: GetOwnerTaxonomyAggregateQuery,
  ): Promise<Result<OwnerTaxonomyAggregateView, Rejection>>;
  createOwnerTaxonomyValue(
    command: CreateOwnerTaxonomyValueApplicationCommand,
  ): Promise<Result<OwnerTaxonomyCommandReceipt, Rejection>>;
  renameOwnerTaxonomyValue(
    command: RenameOwnerTaxonomyValueApplicationCommand,
  ): Promise<Result<OwnerTaxonomyCommandReceipt, Rejection>>;
  retireOwnerTaxonomyValue(
    command: RetireOwnerTaxonomyValueApplicationCommand,
  ): Promise<Result<OwnerTaxonomyCommandReceipt, Rejection>>;
  mergeOwnerTaxonomyValue(
    command: MergeOwnerTaxonomyValueApplicationCommand,
  ): Promise<Result<OwnerTaxonomyCommandReceipt, Rejection>>;
}

export interface OwnerTaxonomyAdapterDeps {
  service: OwnerTaxonomyApplicationService;
  logger?: Logger;
}

const PHASE2_OWNER_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea0";

function ownerActor(): ActorContext {
  return {
    kind: "owner",
    ownerId: PHASE2_OWNER_ID as StableId<"Owner">,
    sessionId: "phase2-owner-session",
  };
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "taxonomies", "{taxonomyId}"].join("/");
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

export async function handleGetOwnerTaxonomyAggregate(
  request: Request,
  params: { taxonomyId: string },
  deps: OwnerTaxonomyAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const pathResult = zGetOwnerTaxonomyAggregatePath.safeParse({
      taxonomyId: params.taxonomyId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const query: GetOwnerTaxonomyAggregateQuery = {
      actor: ownerActor(),
      taxonomyId: pathResult.data.taxonomyId as StableId<string>,
    };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerTaxonomyAggregate>>;
    try {
      result = await deps.service.getOwnerTaxonomyAggregate(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      taxonomyId: result.value.taxonomyId,
      aggregateVersion: result.value.aggregateVersion,
      kind: result.value.kind,
      values: [...result.value.values],
    };
    const parsed = zGetOwnerTaxonomyAggregateResponse.safeParse(payload);
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

async function handleTaxonomyCommand(
  request: Request,
  pathParams: Record<string, string>,
  deps: OwnerTaxonomyAdapterDeps,
  validators: {
    readonly path: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly headers: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly body: { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };
    readonly response: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  },
  successStatus: number,
  buildCommand: (args: {
    readonly path: Record<string, StableId<string>>;
    readonly idempotencyKey: IdempotencyKey;
    readonly expectedVersion: number;
    readonly body: Record<string, unknown>;
  }) => unknown,
  call: (command: never) => Promise<Result<OwnerTaxonomyCommandReceipt, Rejection>>,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const pathResult = validators.path.safeParse(pathParams);
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
    const path: Record<string, StableId<string>> = {};
    for (const [key, value] of Object.entries(pathResult.data)) {
      path[key] = value as StableId<string>;
    }
    const command = buildCommand({
      path,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      body: bodyResult.data,
    });
    let result: Result<OwnerTaxonomyCommandReceipt, Rejection>;
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
    logger?.info("request.completed", { traceId, status: successStatus });
    return Response.json(parsed.data, { status: successStatus });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleCreateOwnerTaxonomyValue(
  request: Request,
  params: { taxonomyId: string },
  deps: OwnerTaxonomyAdapterDeps,
): Promise<Response> {
  return await handleTaxonomyCommand(
    request,
    { taxonomyId: params.taxonomyId },
    deps,
    {
      path: zCreateOwnerTaxonomyValuePath,
      headers: zCreateOwnerTaxonomyValueHeaders,
      body: zCreateOwnerTaxonomyValueBody,
      response: zCreateOwnerTaxonomyValueResponse,
    },
    201,
    ({ path, idempotencyKey, expectedVersion, body }) => ({
      actor: ownerActor(),
      idempotencyKey,
      expectedVersion,
      taxonomyId: path["taxonomyId"] as StableId<string>,
      name: body["name"] as string,
    }) as CreateOwnerTaxonomyValueApplicationCommand,
    (command) => deps.service.createOwnerTaxonomyValue(command),
  );
}

export async function handleRenameOwnerTaxonomyValue(
  request: Request,
  params: { valueId: string },
  deps: OwnerTaxonomyAdapterDeps,
): Promise<Response> {
  return await handleTaxonomyCommand(
    request,
    { valueId: params.valueId },
    deps,
    {
      path: zRenameOwnerTaxonomyValuePath,
      headers: zRenameOwnerTaxonomyValueHeaders,
      body: zRenameOwnerTaxonomyValueBody,
      response: zRenameOwnerTaxonomyValueResponse,
    },
    200,
    ({ path, idempotencyKey, expectedVersion, body }) => ({
      actor: ownerActor(),
      idempotencyKey,
      expectedVersion,
      valueId: path["valueId"] as StableId<string>,
      name: body["name"] as string,
    }) as RenameOwnerTaxonomyValueApplicationCommand,
    (command) => deps.service.renameOwnerTaxonomyValue(command),
  );
}

export async function handleRetireOwnerTaxonomyValue(
  request: Request,
  params: { valueId: string },
  deps: OwnerTaxonomyAdapterDeps,
): Promise<Response> {
  return await handleTaxonomyCommand(
    request,
    { valueId: params.valueId },
    deps,
    {
      path: zRetireOwnerTaxonomyValuePath,
      headers: zRetireOwnerTaxonomyValueHeaders,
      body: zRetireOwnerTaxonomyValueBody,
      response: zRetireOwnerTaxonomyValueResponse,
    },
    200,
    ({ path, idempotencyKey, expectedVersion, body }) => ({
      actor: ownerActor(),
      idempotencyKey,
      expectedVersion,
      valueId: path["valueId"] as StableId<string>,
      ...(typeof body["reason"] === "string" ? { reason: body["reason"] as string } : {}),
    }) as RetireOwnerTaxonomyValueApplicationCommand,
    (command) => deps.service.retireOwnerTaxonomyValue(command),
  );
}

export async function handleMergeOwnerTaxonomyValue(
  request: Request,
  params: { valueId: string },
  deps: OwnerTaxonomyAdapterDeps,
): Promise<Response> {
  return await handleTaxonomyCommand(
    request,
    { valueId: params.valueId },
    deps,
    {
      path: zMergeOwnerTaxonomyValuePath,
      headers: zMergeOwnerTaxonomyValueHeaders,
      body: zMergeOwnerTaxonomyValueBody,
      response: zMergeOwnerTaxonomyValueResponse,
    },
    200,
    ({ path, idempotencyKey, expectedVersion, body }) => ({
      actor: ownerActor(),
      idempotencyKey,
      expectedVersion,
      valueId: path["valueId"] as StableId<string>,
      targetValueId: body["targetValueId"] as StableId<string>,
    }) as MergeOwnerTaxonomyValueApplicationCommand,
    (command) => deps.service.mergeOwnerTaxonomyValue(command),
  );
}
