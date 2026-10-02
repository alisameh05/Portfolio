/**
 * owner-configuration.ts — Phase 2 #29 Owner Configuration HTTP adapter.
 *
 * Thin handwritten adapter for the three Owner Configuration operations:
 * `PUT /api/owner/v1/configuration/profile`,
 * `PUT /api/owner/v1/configuration/contact-channels`, and
 * `PUT /api/owner/v1/configuration/project-cta`.
 *
 * Ordered behavior per operation: establish request context; validate
 * headers (Idempotency-Key plus If-Match concurrency) and body with the
 * generated strict validators; construct one operation-specific command;
 * call one injected application interface once; validate and serialize the
 * declared CommandReceipt response; complete request logging.
 *
 * The Owner actor is resolved through the shared Phase 4 verified-actor
 * boundary (`./owner-security.js`): every operation requires a verified
 * Owner session, owner-scoped authorization, and (for these mutations) exact
 * origin plus CSRF proof before dispatch. Unauthenticated and forbidden
 * translation is exercised through fakes.
 *
 * Generated transport types and validators remain confined to this HTTP
 * layer. Commands, results, and rejections crossing the application seam
 * are provider-neutral. Uses only the standard Web Request/Response — no
 * Next.js, Supabase, or provider types.
 */

import {
  zUpdateOwnerContactChannelsBody,
  zUpdateOwnerContactChannelsHeaders,
  zUpdateOwnerContactChannelsResponse,
  zUpdateOwnerGlobalProjectCtaBody,
  zUpdateOwnerGlobalProjectCtaHeaders,
  zUpdateOwnerGlobalProjectCtaResponse,
  zUpdateOwnerProfileConfigurationBody,
  zUpdateOwnerProfileConfigurationHeaders,
  zUpdateOwnerProfileConfigurationResponse,
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

export interface UpdateOwnerProfileApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly displayName: string;
  readonly headline: string;
  readonly bio: string;
}

export interface UpdateOwnerContactChannelsApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly channels: ReadonlyArray<{
    readonly channel: string;
    readonly label: string;
    readonly destination: string;
    readonly availableLocales: ReadonlyArray<string>;
  }>;
}

export interface UpdateOwnerGlobalProjectCtaApplicationCommand {
  readonly actor: ActorContext;
  readonly idempotencyKey: IdempotencyKey;
  readonly expectedVersion: number;
  readonly correlationId: string;
  readonly label: string;
  readonly destination: string;
  readonly unavailableFallback: string;
}

export interface OwnerConfigurationReceipt {
  readonly aggregateId: StableId<string>;
  readonly aggregateVersion: number;
  readonly outcome: "configuration-updated";
}

export interface OwnerConfigurationApplicationService {
  updateOwnerProfile(
    command: UpdateOwnerProfileApplicationCommand,
  ): Promise<Result<OwnerConfigurationReceipt, Rejection>>;
  updateOwnerContactChannels(
    command: UpdateOwnerContactChannelsApplicationCommand,
  ): Promise<Result<OwnerConfigurationReceipt, Rejection>>;
  updateOwnerGlobalProjectCta(
    command: UpdateOwnerGlobalProjectCtaApplicationCommand,
  ): Promise<Result<OwnerConfigurationReceipt, Rejection>>;
}

export interface OwnerConfigurationAdapterDeps {
  service: OwnerConfigurationApplicationService;
  security: OwnerRequestSecurity;
  logger?: Logger;
}

function requestInstance(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return ["", "api", "owner", "v1", "configuration"].join("/");
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

async function dispatchReceipt(
  call: () => Promise<Result<OwnerConfigurationReceipt, Rejection>>,
  responseValidator: { safeParse(value: unknown): { success: boolean; data?: unknown } },
  logger: Logger | undefined,
  traceId: string,
  instance: string,
): Promise<Response> {
  let result: Result<OwnerConfigurationReceipt, Rejection>;
  try {
    result = await call();
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
  if (!result.ok) {
    const rejection = rejectionToProblem(result.error, traceId, instance);
    logger?.warn("request.rejected", {
      traceId,
      status: rejection.status,
      code: result.error.code,
    });
    return rejection;
  }
  const payload = {
    aggregateId: result.value.aggregateId,
    aggregateVersion: result.value.aggregateVersion,
    outcome: result.value.outcome,
  };
  const parsed = responseValidator.safeParse(payload);
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
}

export async function handleUpdateOwnerProfileConfiguration(
  request: Request,
  deps: OwnerConfigurationAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "updateOwnerProfileConfiguration",
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const headersResult = zUpdateOwnerProfileConfigurationHeaders.safeParse({
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
    const bodyResult = zUpdateOwnerProfileConfigurationBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"]);
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const command: UpdateOwnerProfileApplicationCommand = {
      actor: guard.actor,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      correlationId: traceId,
      displayName: bodyResult.data.displayName,
      headline: bodyResult.data.headline,
      bio: bodyResult.data.bio,
    };
    return await dispatchReceipt(
      () => deps.service.updateOwnerProfile(command),
      zUpdateOwnerProfileConfigurationResponse,
      logger,
      traceId,
      instance,
    );
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleUpdateOwnerContactChannels(
  request: Request,
  deps: OwnerConfigurationAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "updateOwnerContactChannels",
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const headersResult = zUpdateOwnerContactChannelsHeaders.safeParse({
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
    const bodyResult = zUpdateOwnerContactChannelsBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"]);
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const command: UpdateOwnerContactChannelsApplicationCommand = {
      actor: guard.actor,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      channels: bodyResult.data.channels,
    };
    return await dispatchReceipt(
      () => deps.service.updateOwnerContactChannels(command),
      zUpdateOwnerContactChannelsResponse,
      logger,
      traceId,
      instance,
    );
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}

export async function handleUpdateOwnerGlobalProjectCta(
  request: Request,
  deps: OwnerConfigurationAdapterDeps,
): Promise<Response> {
  const logger = deps.logger;
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  const instance = requestInstance(request);
  try {
    const guard = await guardOwnerRequest(request, {
      operation: "updateOwnerGlobalProjectCta",
      mode: "mutation",
      security: deps.security,
      traceId,
      instance,
      logger,
    });
    if (!guard.ok) {
      return guard.response;
    }
    const headersResult = zUpdateOwnerGlobalProjectCtaHeaders.safeParse({
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
    const bodyResult = zUpdateOwnerGlobalProjectCtaBody.safeParse(raw.value);
    if (!bodyResult.success) {
      return reject(logger, traceId, instance, "Invalid request body.");
    }
    const expectedVersion = parseExpectedVersion(headersResult.data["If-Match"]);
    if (expectedVersion === null) {
      return reject(logger, traceId, instance, "Missing or invalid concurrency headers.");
    }
    const command: UpdateOwnerGlobalProjectCtaApplicationCommand = {
      actor: guard.actor,
      idempotencyKey: headersResult.data["Idempotency-Key"] as IdempotencyKey,
      expectedVersion,
      correlationId: traceId,
      label: bodyResult.data.label,
      destination: bodyResult.data.destination,
      unavailableFallback: bodyResult.data.unavailableFallback,
    };
    return await dispatchReceipt(
      () => deps.service.updateOwnerGlobalProjectCta(command),
      zUpdateOwnerGlobalProjectCtaResponse,
      logger,
      traceId,
      instance,
    );
  } catch (error) {
    return internalErrorProblem(error, traceId, instance, logger);
  }
}
