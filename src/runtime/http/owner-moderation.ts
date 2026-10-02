/**
 * owner-moderation.ts — Phase 2 #32 Owner Feedback Moderation HTTP adapter.
 *
 * Thin handwritten adapter for the four Owner Moderation operations:
 * `GET /api/owner/v1/feedback/{feedbackId}`,
 * `POST /api/owner/v1/feedback/{feedbackId}/commands/approve`,
 * `POST /api/owner/v1/feedback/{feedbackId}/commands/reject`, and
 * `POST /api/owner/v1/feedback/{feedbackId}/commands/suppress`.
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
 * translation is exercised through fakes. Moderation decisions, retention,
 * persistence, and authorization rules remain unimplemented
 * provider-neutral application behavior.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, or provider types.
 */

import {
  zApproveOwnerFeedbackBody,
  zApproveOwnerFeedbackHeaders,
  zApproveOwnerFeedbackPath,
  zApproveOwnerFeedbackResponse,
  zGetOwnerFeedbackModerationPath,
  zGetOwnerFeedbackModerationResponse,
  zRejectOwnerFeedbackBody,
  zRejectOwnerFeedbackHeaders,
  zRejectOwnerFeedbackPath,
  zRejectOwnerFeedbackResponse,
  zSuppressOwnerFeedbackBody,
  zSuppressOwnerFeedbackHeaders,
  zSuppressOwnerFeedbackPath,
  zSuppressOwnerFeedbackResponse,
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

export interface GetOwnerFeedbackModerationQuery {
  readonly actor: ActorContext;
  readonly feedbackId: StableId<string>;
}

export interface ApproveOwnerFeedbackApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly feedbackId: StableId<string>;
  readonly reason: string;
}

export interface RejectOwnerFeedbackApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly feedbackId: StableId<string>;
  readonly reason: string;
}

export interface SuppressOwnerFeedbackApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly feedbackId: StableId<string>;
  readonly reason: string;
}

export interface OwnerModerationDecisionView {
  readonly decision: "approved" | "rejected" | "suppressed";
  readonly reason: string;
  readonly decidedAt: string;
}

export interface OwnerFeedbackModerationView {
  readonly feedbackId: StableId<string>;
  readonly aggregateVersion: number;
  readonly state: "pending" | "approved" | "rejected" | "suppressed";
  readonly authorName: string;
  readonly paragraph: string;
  readonly submittedAt: string;
  readonly decisionHistory: ReadonlyArray<OwnerModerationDecisionView>;
}

export interface OwnerModerationCommandReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "feedback-approved" | "feedback-rejected" | "feedback-suppressed";
}

export interface OwnerModerationApplicationService {
  getOwnerFeedbackModeration(
    query: GetOwnerFeedbackModerationQuery,
  ): Promise<Result<OwnerFeedbackModerationView, Rejection>>;
  approveOwnerFeedback(
    command: ApproveOwnerFeedbackApplicationCommand,
  ): Promise<Result<OwnerModerationCommandReceipt, Rejection>>;
  rejectOwnerFeedback(
    command: RejectOwnerFeedbackApplicationCommand,
  ): Promise<Result<OwnerModerationCommandReceipt, Rejection>>;
  suppressOwnerFeedback(
    command: SuppressOwnerFeedbackApplicationCommand,
  ): Promise<Result<OwnerModerationCommandReceipt, Rejection>>;
}

export interface OwnerModerationAdapterDeps {
  service: OwnerModerationApplicationService;
  security: OwnerRequestSecurity;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "feedback", "{feedbackId}"].join("/");
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

export async function handleGetOwnerFeedbackModeration(
  request: Request,
  params: { feedbackId: string },
  deps: OwnerModerationAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "getOwnerFeedbackModeration",
      mode: "read",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const pathResult = zGetOwnerFeedbackModerationPath.safeParse({
      feedbackId: params.feedbackId,
    });
    if (!pathResult.success) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const query: GetOwnerFeedbackModerationQuery = {
      actor: guard.actor,
      feedbackId: pathResult.data.feedbackId as StableId<string>,
    };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerFeedbackModeration>>;
    try {
      result = await deps.service.getOwnerFeedbackModeration(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      feedbackId: result.value.feedbackId,
      aggregateVersion: result.value.aggregateVersion,
      state: result.value.state,
      authorName: result.value.authorName,
      paragraph: result.value.paragraph,
      submittedAt: result.value.submittedAt,
      decisionHistory: [...result.value.decisionHistory],
    };
    const parsed = zGetOwnerFeedbackModerationResponse.safeParse(payload);
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

async function handleModerationCommand(
  request: Request,
  pathParams: Record<string, string>,
  deps: OwnerModerationAdapterDeps,
  operation: string,
  validators: {
    readonly path: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly headers: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly body: { safeParse(value: unknown): { success: boolean; data?: Record<string, unknown> } };
    readonly response: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  },
  buildCommand: (args: {
    readonly actor: ActorContext;
    readonly path: Record<string, StableId<string>>;
    readonly idempotencyKey: IdempotencyKey;
    readonly expectedVersion: number;
    readonly body: Record<string, unknown>;
  }) => unknown,
  call: (command: never) => Promise<Result<OwnerModerationCommandReceipt, Rejection>>,
  outcome: OwnerModerationCommandReceipt["outcome"],
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
      actor: guard.actor,
      path,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      body: bodyResult.data,
    });
    let result: Result<OwnerModerationCommandReceipt, Rejection>;
    try {
      result = await call(command as never);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    if (result.value.outcome !== outcome) {
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

export async function handleApproveOwnerFeedback(
  request: Request,
  params: { feedbackId: string },
  deps: OwnerModerationAdapterDeps,
): Promise<Response> {
  return await handleModerationCommand(
    request,
    { feedbackId: params.feedbackId },
    deps,
    "approveOwnerFeedback",
    {
      path: zApproveOwnerFeedbackPath,
      headers: zApproveOwnerFeedbackHeaders,
      body: zApproveOwnerFeedbackBody,
      response: zApproveOwnerFeedbackResponse,
    },
    ({ actor, path, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      feedbackId: path["feedbackId"] as StableId<string>,
      reason: body["reason"] as string,
    }) as ApproveOwnerFeedbackApplicationCommand,
    (command) => deps.service.approveOwnerFeedback(command),
    "feedback-approved",
  );
}

export async function handleRejectOwnerFeedback(
  request: Request,
  params: { feedbackId: string },
  deps: OwnerModerationAdapterDeps,
): Promise<Response> {
  return await handleModerationCommand(
    request,
    { feedbackId: params.feedbackId },
    deps,
    "rejectOwnerFeedback",
    {
      path: zRejectOwnerFeedbackPath,
      headers: zRejectOwnerFeedbackHeaders,
      body: zRejectOwnerFeedbackBody,
      response: zRejectOwnerFeedbackResponse,
    },
    ({ actor, path, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      feedbackId: path["feedbackId"] as StableId<string>,
      reason: body["reason"] as string,
    }) as RejectOwnerFeedbackApplicationCommand,
    (command) => deps.service.rejectOwnerFeedback(command),
    "feedback-rejected",
  );
}

export async function handleSuppressOwnerFeedback(
  request: Request,
  params: { feedbackId: string },
  deps: OwnerModerationAdapterDeps,
): Promise<Response> {
  return await handleModerationCommand(
    request,
    { feedbackId: params.feedbackId },
    deps,
    "suppressOwnerFeedback",
    {
      path: zSuppressOwnerFeedbackPath,
      headers: zSuppressOwnerFeedbackHeaders,
      body: zSuppressOwnerFeedbackBody,
      response: zSuppressOwnerFeedbackResponse,
    },
    ({ actor, path, idempotencyKey, expectedVersion, body }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      feedbackId: path["feedbackId"] as StableId<string>,
      reason: body["reason"] as string,
    }) as SuppressOwnerFeedbackApplicationCommand,
    (command) => deps.service.suppressOwnerFeedback(command),
    "feedback-suppressed",
  );
}
