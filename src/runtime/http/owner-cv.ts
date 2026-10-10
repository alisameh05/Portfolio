/**
 * owner-cv.ts — Phase 2 #31 Owner CV Portfolio HTTP adapter.
 *
 * Thin handwritten adapter for the four Owner CV Portfolio operations:
 * `GET /api/owner/v1/cv`,
 * `POST /api/owner/v1/cv/versions`,
 * `POST /api/owner/v1/cv/versions/{versionId}/commands/accept`, and
 * `POST /api/owner/v1/cv/versions/{versionId}/commands/activate`.
 *
 * Ordered behavior per operation: establish request context; validate every
 * declared path, header, and body input with the generated strict validators
 * (Idempotency-Key plus If-Match concurrency where declared; accept and
 * activate declare no body and therefore require none); construct one
 * operation-specific command or query; call one injected application
 * interface once; validate and serialize the declared response; complete
 * request logging.
 *
 * The Owner actor is resolved through the shared Phase 4 verified-actor
 * boundary (`./owner-security.js`): every operation requires a verified
 * Owner session, owner-scoped authorization, and (for mutations) exact
 * origin plus CSRF proof before dispatch. Unauthenticated and forbidden
 * translation is exercised through fakes. CV registration, acceptance,
 * Current CV activation, retention, storage, and delivery rules remain
 * unimplemented provider-neutral application behavior.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, queries, results, and rejections crossing the application
 * seam are provider-neutral. Uses only the standard Web Request/Response —
 * no Next.js, Supabase, storage, or provider types.
 */

import {
  zAcceptOwnerCvVersionHeaders,
  zAcceptOwnerCvVersionPath,
  zAcceptOwnerCvVersionResponse,
  zActivateOwnerCvVersionHeaders,
  zActivateOwnerCvVersionPath,
  zActivateOwnerCvVersionResponse,
  zGetOwnerCvPortfolioResponse,
  zRegisterOwnerCvVersionBody,
  zRegisterOwnerCvVersionHeaders,
  zRegisterOwnerCvVersionResponse,
} from "../../contracts/http/owner/v1/generated/zod.gen.js";
import type {
  ActorContext,
  IdempotencyKey,
  Rejection,
  Result,
  StableId,
} from "../../shared/domain/index.js";
import type {
  AcceptOwnerCvVersionApplicationCommand,
  ActivateOwnerCvVersionApplicationCommand,
  GetOwnerCvPortfolioQuery,
  OwnerCvApplicationService,
  OwnerCvCommandReceipt,
  OwnerCvPortfolioView,
  RegisterOwnerCvVersionApplicationCommand,
  RegisterOwnerCvVersionReceipt,
} from "../../modules/cv-portfolio/index.js";
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

// Public compatibility exports keep existing adapter consumers stable while
// the module barrel owns the application contract.
export type {
  AcceptOwnerCvVersionApplicationCommand,
  ActivateOwnerCvVersionApplicationCommand,
  GetOwnerCvPortfolioQuery,
  OwnerCvActivationView,
  OwnerCvApplicationService,
  OwnerCvCommandReceipt,
  OwnerCvPortfolioView,
  OwnerCvVersionView,
  RegisterOwnerCvVersionApplicationCommand,
  RegisterOwnerCvVersionReceipt,
} from "../../modules/cv-portfolio/index.js";

export interface OwnerCvAdapterDeps {
  service: OwnerCvApplicationService;
  security: OwnerRequestSecurity;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "cv"].join("/");
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

export async function handleGetOwnerCvPortfolio(
  request: Request,
  deps: OwnerCvAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "getOwnerCvPortfolio",
      mode: "read",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    // The CV Portfolio retrieval declares no path, query, header, or body
    // input: dispatch a single owner-scoped query directly.
    const query: GetOwnerCvPortfolioQuery = { actor: guard.actor };
    let result: Awaited<ReturnType<typeof deps.service.getOwnerCvPortfolio>>;
    try {
      result = await deps.service.getOwnerCvPortfolio(query);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      aggregateVersion: result.value.aggregateVersion,
      currentVersionId: result.value.currentVersionId,
      versions: [...result.value.versions],
      activationHistory: [...result.value.activationHistory],
    };
    const parsed = zGetOwnerCvPortfolioResponse.safeParse(payload);
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

export async function handleRegisterOwnerCvVersion(
  request: Request,
  deps: OwnerCvAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "registerOwnerCvVersion",
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const headersResult = zRegisterOwnerCvVersionHeaders.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
      "If-Match": request.headers.get("if-match") ?? undefined,
    });
    if (!headersResult.success) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const raw = await readJsonBody(request);
    if (!raw.ok) {
      return reject(logger, traceId, instance, "Malformed JSON body.");
    }
    const bodyResult = zRegisterOwnerCvVersionBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"] ?? "");
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const command: RegisterOwnerCvVersionApplicationCommand = {
      actor: guard.actor,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      mediaId: bodyResult.data.mediaId as StableId<string>,
      locale: "en",
      label: bodyResult.data.label,
    };
    let result: Awaited<ReturnType<typeof deps.service.registerOwnerCvVersion>>;
    try {
      result = await deps.service.registerOwnerCvVersion(command);
    } catch (error) {
      return internalErrorProblem(error, traceId, instance, logger);
    }
    if (!result.ok) {
      return toRejection(result.error, traceId, instance, logger);
    }
    const payload = {
      versionId: result.value.versionId,
      aggregateVersion: result.value.aggregateVersion,
      outcome: result.value.outcome,
    };
    const parsed = zRegisterOwnerCvVersionResponse.safeParse(payload);
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

async function handleCvVersionCommand(
  request: Request,
  params: { versionId: string },
  deps: OwnerCvAdapterDeps,
  operation: string,
  validators: {
    readonly path: { safeParse(value: unknown): { success: boolean; data?: { versionId: string } } };
    readonly headers: { safeParse(value: unknown): { success: boolean; data?: Record<string, string> } };
    readonly response: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  },
  buildCommand: (args: {
    readonly actor: ActorContext;
    readonly versionId: StableId<string>;
    readonly idempotencyKey: IdempotencyKey;
    readonly expectedVersion: number;
  }) => unknown,
  call: (command: never) => Promise<Result<OwnerCvCommandReceipt, Rejection>>,
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
    // Accept and activate declare no request body: validate only the declared
    // path and concurrency headers before dispatch.
    const pathResult = validators.path.safeParse({ versionId: params.versionId });
    if (!pathResult.success || pathResult.data === undefined) {
      return reject(logger, traceId, instance, "Invalid path parameters.");
    }
    const headersResult = validators.headers.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
      "If-Match": request.headers.get("if-match") ?? undefined,
    });
    if (!headersResult.success || headersResult.data === undefined) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"] ?? "");
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const command = buildCommand({
      actor: guard.actor,
      versionId: pathResult.data.versionId as StableId<string>,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
    });
    let result: Result<OwnerCvCommandReceipt, Rejection>;
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
    logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(parsed.data, { status: 200 });
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleAcceptOwnerCvVersion(
  request: Request,
  params: { versionId: string },
  deps: OwnerCvAdapterDeps,
): Promise<Response> {
  return await handleCvVersionCommand(
    request,
    params,
    deps,
    "acceptOwnerCvVersion",
    {
      path: zAcceptOwnerCvVersionPath,
      headers: zAcceptOwnerCvVersionHeaders,
      response: zAcceptOwnerCvVersionResponse,
    },
    ({ actor, versionId, idempotencyKey, expectedVersion }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      versionId,
    }) as AcceptOwnerCvVersionApplicationCommand,
    (command) => deps.service.acceptOwnerCvVersion(command),
  );
}

export async function handleActivateOwnerCvVersion(
  request: Request,
  params: { versionId: string },
  deps: OwnerCvAdapterDeps,
): Promise<Response> {
  return await handleCvVersionCommand(
    request,
    params,
    deps,
    "activateOwnerCvVersion",
    {
      path: zActivateOwnerCvVersionPath,
      headers: zActivateOwnerCvVersionHeaders,
      response: zActivateOwnerCvVersionResponse,
    },
    ({ actor, versionId, idempotencyKey, expectedVersion }) => ({
      actor,
      idempotencyKey,
      expectedVersion,
      versionId,
    }) as ActivateOwnerCvVersionApplicationCommand,
    (command) => deps.service.activateOwnerCvVersion(command),
  );
}
