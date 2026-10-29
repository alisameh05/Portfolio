/** Strict Owner HTTP adapters for the Content-owned Project status registry. */
import {
  zCreateOwnerProjectStatusValueBody,
  zCreateOwnerProjectStatusValueHeaders,
  zCreateOwnerProjectStatusValueResponse,
  zListOwnerProjectStatusValuesResponse,
  zRenameOwnerProjectStatusValueBody,
  zRenameOwnerProjectStatusValueHeaders,
  zRenameOwnerProjectStatusValuePath,
  zRenameOwnerProjectStatusValueResponse,
  zRetireOwnerProjectStatusValueBody,
  zRetireOwnerProjectStatusValueHeaders,
  zRetireOwnerProjectStatusValuePath,
  zRetireOwnerProjectStatusValueResponse,
} from "../../contracts/http/owner/v1/generated/zod.gen.js";
import { observeHttpRequest } from "./observe-request.js";

import type { ActorContext, IdempotencyKey, Rejection, Result, StableId } from "../../shared/domain/index.js";
import type { ContentAuthoringService, ContentProjectStatusValue } from "../../modules/content-publishing/application/authoring.js";
import { createCorrelation, type Logger } from "../ports.js";
import { guardOwnerRequest, OWNER_PRIVATE_RESPONSE_HEADERS, type OwnerRequestSecurity } from "./owner-security.js";
import { internalErrorProblem, rejectionToProblem, transportProblem } from "./problem.js";

export interface OwnerProjectStatusAdapterDeps {
  readonly service: ContentAuthoringService;
  readonly security: OwnerRequestSecurity;
  readonly logger?: Logger;
}

function context(request: Request) {
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  let instance: string;
  try { instance = new URL(request.url).pathname; } catch { instance = "/api/owner/v1/project-status-values"; }
  return { traceId, instance };
}

function requestHeaders(request: Request): Record<string, string | undefined> {
  return {
    "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
    "If-Match": request.headers.get("if-match") ?? undefined,
  };
}

async function body(request: Request): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  try { return { ok: true, value: await request.json() as unknown }; } catch { return { ok: false }; }
}

function reject(deps: OwnerProjectStatusAdapterDeps, traceId: string, instance: string, detail: string): Response {
  deps.logger?.warn("request.rejected", { traceId, status: 400 });
  return transportProblem(detail, traceId, instance);
}

function rejection(deps: OwnerProjectStatusAdapterDeps, error: Rejection, traceId: string, instance: string): Response {
  const response = rejectionToProblem(error, traceId, instance);
  deps.logger?.warn("request.rejected", { traceId, status: response.status, code: error.code });
  return response;
}

function valueView(value: ContentProjectStatusValue) {
  return { valueId: value.valueId, label: value.label, state: value.state };
}

function valueReceipt(value: ContentProjectStatusValue, outcome: "project-status-value-created" | "project-status-value-renamed" | "project-status-value-retired") {
  return { ...valueView(value), aggregateVersion: value.aggregateVersion, outcome };
}

 async function handleListOwnerProjectStatusValuesUnobserved(request: Request, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  const { traceId, instance } = context(request);
  try {
    const guard = await guardOwnerRequest(request, { operation: "listOwnerProjectStatusValues", mode: "read", security: deps.security, traceId, instance, logger: deps.logger });
    if (!guard.ok) return guard.response;
    let result: Awaited<ReturnType<ContentAuthoringService["listProjectStatusValues"]>>;
    try { result = await deps.service.listProjectStatusValues({ actor: guard.actor }); }
    catch (error) { return internalErrorProblem(error, traceId, instance, deps.logger); }
    if (!result.ok) return rejection(deps, result.error, traceId, instance);
    const parsed = zListOwnerProjectStatusValuesResponse.safeParse({ values: result.value.map(valueView) });
    if (!parsed.success) return internalErrorProblem(new Error("Invalid application result"), traceId, instance, deps.logger);
    deps.logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(parsed.data, { status: 200, headers: OWNER_PRIVATE_RESPONSE_HEADERS });
  } catch (error) { return internalErrorProblem(error, traceId, instance, deps.logger); }
}

 async function handleCreateOwnerProjectStatusValueUnobserved(request: Request, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  const { traceId, instance } = context(request);
  try {
    const guard = await guardOwnerRequest(request, { operation: "createOwnerProjectStatusValue", mode: "mutation", security: deps.security, traceId, instance, logger: deps.logger });
    if (!guard.ok) return guard.response;
    const headers = zCreateOwnerProjectStatusValueHeaders.safeParse({
      "Idempotency-Key": request.headers.get("idempotency-key") ?? undefined,
    });
    if (!headers.success) return reject(deps, traceId, instance, "Missing or invalid Idempotency-Key header.");
    const raw = await body(request);
    if (!raw.ok) return reject(deps, traceId, instance, "Malformed JSON body.");
    const parsedBody = zCreateOwnerProjectStatusValueBody.safeParse(raw.value);
    if (!parsedBody.success) return reject(deps, traceId, instance, "Invalid request body.");
    const command = { actor: guard.actor, label: parsedBody.data.label, idempotencyKey: headers.data["Idempotency-Key"] as IdempotencyKey, correlationId: traceId };
    let result: Awaited<ReturnType<ContentAuthoringService["createProjectStatusValue"]>>;
    try { result = await deps.service.createProjectStatusValue(command); }
    catch (error) { return internalErrorProblem(error, traceId, instance, deps.logger); }
    if (!result.ok) return rejection(deps, result.error, traceId, instance);
    const parsed = zCreateOwnerProjectStatusValueResponse.safeParse(valueReceipt(result.value, "project-status-value-created"));
    if (!parsed.success) return internalErrorProblem(new Error("Invalid application result"), traceId, instance, deps.logger);
    deps.logger?.info("request.completed", { traceId, status: 201 });
    return Response.json(parsed.data, { status: 201 });
  } catch (error) { return internalErrorProblem(error, traceId, instance, deps.logger); }
}

async function handleStatusValueCommand(
  request: Request,
  valueId: string,
  deps: OwnerProjectStatusAdapterDeps,
  action: "rename" | "retire",
): Promise<Response> {
  const { traceId, instance } = context(request);
  const operation = action === "rename" ? "renameOwnerProjectStatusValue" : "retireOwnerProjectStatusValue";
  try {
    const guard = await guardOwnerRequest(request, { operation, mode: "mutation", security: deps.security, traceId, instance, logger: deps.logger });
    if (!guard.ok) return guard.response;
    const validators = action === "rename"
      ? { path: zRenameOwnerProjectStatusValuePath, headers: zRenameOwnerProjectStatusValueHeaders, body: zRenameOwnerProjectStatusValueBody, response: zRenameOwnerProjectStatusValueResponse }
      : { path: zRetireOwnerProjectStatusValuePath, headers: zRetireOwnerProjectStatusValueHeaders, body: zRetireOwnerProjectStatusValueBody, response: zRetireOwnerProjectStatusValueResponse };
    const parsedPath = validators.path.safeParse({ valueId });
    const parsedHeaders = validators.headers.safeParse(requestHeaders(request));
    if (!parsedPath.success) return reject(deps, traceId, instance, "Invalid path parameters.");
    if (!parsedHeaders.success) return reject(deps, traceId, instance, "Missing or invalid concurrency headers.");
    const raw = await body(request);
    if (!raw.ok) return reject(deps, traceId, instance, "Malformed JSON body.");
    const parsedBody = validators.body.safeParse(raw.value);
    if (!parsedBody.success) return reject(deps, traceId, instance, "Invalid request body.");
    const expectedVersion = Number((/^"([1-9][0-9]*)"$/u.exec(parsedHeaders.data["If-Match"] ?? "") ?? [])[1]);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return reject(deps, traceId, instance, "Missing or invalid concurrency headers.");
    const id = parsedPath.data.valueId as StableId<"ProjectStatusValue">;
    const commandBase = { actor: guard.actor, valueId: id, expectedVersion, idempotencyKey: parsedHeaders.data["Idempotency-Key"] as IdempotencyKey, correlationId: traceId };
    let result: Result<ContentProjectStatusValue, Rejection>;
    try {
      result = action === "rename"
        ? await deps.service.renameProjectStatusValue({ ...commandBase, label: (parsedBody.data as { label: string }).label })
        : await deps.service.retireProjectStatusValue(commandBase);
    } catch (error) { return internalErrorProblem(error, traceId, instance, deps.logger); }
    if (!result.ok) return rejection(deps, result.error, traceId, instance);
    const outcome = action === "rename" ? "project-status-value-renamed" : "project-status-value-retired";
    const parsed = validators.response.safeParse(valueReceipt(result.value, outcome));
    if (!parsed.success) return internalErrorProblem(new Error("Invalid application result"), traceId, instance, deps.logger);
    deps.logger?.info("request.completed", { traceId, status: 200 });
    return Response.json(parsed.data, { status: 200 });
  } catch (error) { return internalErrorProblem(error, traceId, instance, deps.logger); }
}

 async function handleRenameOwnerProjectStatusValueUnobserved(request: Request, params: { readonly valueId: string }, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  return await handleStatusValueCommand(request, params.valueId, deps, "rename");
}

 async function handleRetireOwnerProjectStatusValueUnobserved(request: Request, params: { readonly valueId: string }, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  return await handleStatusValueCommand(request, params.valueId, deps, "retire");
}


export function handleListOwnerProjectStatusValues(request: Request, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  return observeHttpRequest("owner-project-status", () => handleListOwnerProjectStatusValuesUnobserved(request, deps), deps.logger);
}

export function handleCreateOwnerProjectStatusValue(request: Request, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  return observeHttpRequest("owner-project-status", () => handleCreateOwnerProjectStatusValueUnobserved(request, deps), deps.logger);
}

export function handleRenameOwnerProjectStatusValue(request: Request, params: { readonly valueId: string }, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  return observeHttpRequest("owner-project-status", () => handleRenameOwnerProjectStatusValueUnobserved(request, params, deps), deps.logger);
}

export function handleRetireOwnerProjectStatusValue(request: Request, params: { readonly valueId: string }, deps: OwnerProjectStatusAdapterDeps): Promise<Response> {
  return observeHttpRequest("owner-project-status", () => handleRetireOwnerProjectStatusValueUnobserved(request, params, deps), deps.logger);
}
