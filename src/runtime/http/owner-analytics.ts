/**
 * owner-analytics.ts — Phase 2 #32 Owner Analytics goal HTTP adapter.
 *
 * Thin handwritten adapter for the three Owner Measurement operations:
 * `GET /api/owner/v1/analytics-goals/{goalId}`,
 * `POST /api/owner/v1/analytics-goals/{goalId}/versions`, and
 * `POST /api/owner/v1/analytics-goals/{goalId}/commands/activate-version`.
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
 * Goal definitions, versioning, activation, measurement storage, and
 * authorization rules remain unimplemented provider-neutral application
 * behavior.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, or provider types.
 */

import {
  zActivateOwnerAnalyticsGoalVersionBody,
  zActivateOwnerAnalyticsGoalVersionHeaders,
  zActivateOwnerAnalyticsGoalVersionPath,
  zActivateOwnerAnalyticsGoalVersionResponse,
  zCreateOwnerAnalyticsGoalVersionBody,
  zCreateOwnerAnalyticsGoalVersionHeaders,
  zCreateOwnerAnalyticsGoalVersionPath,
  zCreateOwnerAnalyticsGoalVersionResponse,
  zGetOwnerAnalyticsGoalPath,
  zGetOwnerAnalyticsGoalResponse,
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

export type AnalyticsEventAction =
  | "page-viewed"
  | "project-viewed"
  | "active-engagement-sampled"
  | "media-engaged"
  | "related-project-opened"
  | "contact-channel-opened"
  | "external-project-link-opened"
  | "testimonial-engaged"
  | "global-project-cta-opened";

export interface AnalyticsGoalStep {
  readonly action: AnalyticsEventAction;
  readonly publicRouteIds?: ReadonlyArray<StableId<string>>;
  readonly projectIds?: ReadonlyArray<StableId<string>>;
}

export interface AnalyticsGoalDefinition {
  readonly name: string;
  readonly steps: ReadonlyArray<AnalyticsGoalStep>;
}

export interface GetOwnerAnalyticsGoalQuery {
  readonly actor: ActorContext;
  readonly goalId: StableId<string>;
}

export interface CreateOwnerAnalyticsGoalVersionApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly goalId: StableId<string>;
  readonly definition: AnalyticsGoalDefinition;
}

export interface ActivateOwnerAnalyticsGoalVersionApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly goalId: StableId<string>;
  readonly versionId: StableId<string>;
}

export interface AnalyticsGoalVersionView {
  readonly versionId: StableId<string>;
  readonly versionNumber: number;
  readonly definition: AnalyticsGoalDefinition;
  readonly createdAt: string;
}

export interface AnalyticsGoalActivationView {
  readonly versionId: StableId<string>;
  readonly activatedAt: string;
}

export interface AnalyticsGoalAggregateView {
  readonly goalId: StableId<string>;
  readonly aggregateVersion: number;
  readonly activeVersionId: StableId<string> | null;
  readonly versions: ReadonlyArray<AnalyticsGoalVersionView>;
  readonly activationHistory: ReadonlyArray<AnalyticsGoalActivationView>;
}

export interface AnalyticsGoalVersionReceipt {
  readonly goalId: StableId<string>;
  readonly versionId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "analytics-goal-version-created";
}

export interface AnalyticsGoalActivationReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "analytics-goal-version-activated";
}

export interface OwnerAnalyticsApplicationService {
  getOwnerAnalyticsGoal(
    query: GetOwnerAnalyticsGoalQuery,
  ): Promise<Result<AnalyticsGoalAggregateView, Rejection>>;
  createOwnerAnalyticsGoalVersion(
    command: CreateOwnerAnalyticsGoalVersionApplicationCommand,
  ): Promise<Result<AnalyticsGoalVersionReceipt, Rejection>>;
  activateOwnerAnalyticsGoalVersion(
    command: ActivateOwnerAnalyticsGoalVersionApplicationCommand,
  ): Promise<Result<AnalyticsGoalActivationReceipt, Rejection>>;
}

export interface OwnerAnalyticsAdapterDeps {
  service: OwnerAnalyticsApplicationService;
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
    return ["", "api", "owner", "v1", "analytics-goals", "{goalId}"].join("/");
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

export async function handleGetOwnerAnalyticsGoal(
  request: Request,
  params: { goalId: string },
  deps: OwnerAnalyticsAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const pathResult = zGetOwnerAnalyticsGoalPath.safeParse({
      goalId: params.goalId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const query: GetOwnerAnalyticsGoalQuery = {
      actor: ownerActor(),
      goalId: pathResult.data.goalId as StableId<string>,
    };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerAnalyticsGoal>>;
    try {
      result = await deps.service.getOwnerAnalyticsGoal(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      goalId: result.value.goalId,
      aggregateVersion: result.value.aggregateVersion,
      activeVersionId: result.value.activeVersionId,
      versions: result.value.versions.map((version) => ({
        versionId: version.versionId,
        versionNumber: version.versionNumber,
        definition: {
          name: version.definition.name,
          steps: version.definition.steps.map((step) => ({
            action: step.action,
            ...(step.publicRouteIds !== undefined ? { publicRouteIds: [...step.publicRouteIds] } : {}),
            ...(step.projectIds !== undefined ? { projectIds: [...step.projectIds] } : {}),
          })),
        },
        createdAt: version.createdAt,
      })),
      activationHistory: [...result.value.activationHistory],
    };
    const parsed = zGetOwnerAnalyticsGoalResponse.safeParse(payload);
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

export async function handleCreateOwnerAnalyticsGoalVersion(
  request: Request,
  params: { goalId: string },
  deps: OwnerAnalyticsAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const pathResult = zCreateOwnerAnalyticsGoalVersionPath.safeParse({
      goalId: params.goalId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const headersResult = zCreateOwnerAnalyticsGoalVersionHeaders.safeParse(
      commandHeaders(request),
    );
    if (!headersResult.success) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const raw = await readJsonBody(request);
    if (!raw.ok) {
      return reject(logger, traceId, instance, "Malformed JSON body.");
    }
    const bodyResult = zCreateOwnerAnalyticsGoalVersionBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"] ?? "");
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const body = bodyResult.data as {
      definition: {
        name: string;
        steps: Array<{
          action: AnalyticsEventAction;
          publicRouteIds?: StableId<string>[];
          projectIds?: StableId<string>[];
        }>;
      };
    };
    const command: CreateOwnerAnalyticsGoalVersionApplicationCommand = {
      actor: ownerActor(),
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      goalId: pathResult.data.goalId as StableId<string>,
      definition: {
        name: body.definition.name,
        steps: body.definition.steps.map((step) => ({
          action: step.action,
          ...(step.publicRouteIds !== undefined ? { publicRouteIds: [...step.publicRouteIds] } : {}),
          ...(step.projectIds !== undefined ? { projectIds: [...step.projectIds] } : {}),
        })),
      },
    };
    let result: Awaited<ReturnType<typeof deps.service.createOwnerAnalyticsGoalVersion>>;
    try {
      result = await deps.service.createOwnerAnalyticsGoalVersion(command);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      goalId: result.value.goalId,
      versionId: result.value.versionId,
      aggregateVersion: result.value.aggregateVersion,
      outcome: result.value.outcome,
    };
    const parsed = zCreateOwnerAnalyticsGoalVersionResponse.safeParse(payload);
    if (!parsed.success) {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    logger?.info("request.completed", { traceId, status: 201 });
    return Response.json(parsed.data, { status: 201 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleActivateOwnerAnalyticsGoalVersion(
  request: Request,
  params: { goalId: string },
  deps: OwnerAnalyticsAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const pathResult = zActivateOwnerAnalyticsGoalVersionPath.safeParse({
      goalId: params.goalId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const headersResult = zActivateOwnerAnalyticsGoalVersionHeaders.safeParse(
      commandHeaders(request),
    );
    if (!headersResult.success) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const raw = await readJsonBody(request);
    if (!raw.ok) {
      return reject(logger, traceId, instance, "Malformed JSON body.");
    }
    const bodyResult = zActivateOwnerAnalyticsGoalVersionBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"] ?? "");
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const body = bodyResult.data as { versionId: StableId<string> };
    const command: ActivateOwnerAnalyticsGoalVersionApplicationCommand = {
      actor: ownerActor(),
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      goalId: pathResult.data.goalId as StableId<string>,
      versionId: body.versionId,
    };
    let result: Awaited<ReturnType<typeof deps.service.activateOwnerAnalyticsGoalVersion>>;
    try {
      result = await deps.service.activateOwnerAnalyticsGoalVersion(command);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    if (result.value.outcome !== "analytics-goal-version-activated") {
      return internalErrorProblem(
        new Error("Invalid application result"),
        traceId,
        instance,
        logger,
      );
    }
    const payload = {
      aggregateId: result.value.aggregateId,
      aggregateVersion: result.value.aggregateVersion,
      outcome: result.value.outcome,
    };
    const parsed = zActivateOwnerAnalyticsGoalVersionResponse.safeParse(payload);
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
