import {
  getOwnerContentAuthoringHttpDependencies,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import {
  handleCreateOwnerProjectStatusValue,
  handleListOwnerProjectStatusValues,
  handleRenameOwnerProjectStatusValue,
  handleRetireOwnerProjectStatusValue,
} from "./owner-project-status.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerProjectStatusOperation =
  | "listOwnerProjectStatusValues"
  | "createOwnerProjectStatusValue"
  | "renameOwnerProjectStatusValue"
  | "retireOwnerProjectStatusValue";

const INSTANCE = "/api/owner/v1/project-status-values";
let initialization: Promise<void> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= (async () => {
    await initializeDatabaseRuntime(getRuntimeEnvironmentSnapshot(), "application");
  })();
  const pending = initialization;
  try { await pending; }
  catch (error) {
    if (initialization === pending) initialization = undefined;
    throw error;
  }
}

function unavailable(request: Request): Response {
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  return Response.json({
    type: "urn:shipwithali:problem:temporarily-unavailable",
    title: "Service Unavailable",
    status: 503,
    detail: "A required dependency is temporarily unavailable. Retry later.",
    instance: INSTANCE,
    code: "temporarily_unavailable",
    traceId,
  }, { status: 503, headers: { "content-type": "application/problem+json", ...OWNER_PRIVATE_RESPONSE_HEADERS } });
}

/** Initializes the configured PostgreSQL application and dispatches one status catalogue adapter. */
export async function dispatchOwnerProjectStatusHttp(
  request: Request,
  operation: OwnerProjectStatusOperation,
  params?: { readonly valueId: string },
): Promise<Response> {
  try {
    await ensureRuntime();
    const dependencies = await getOwnerContentAuthoringHttpDependencies();
    const adapterDependencies = { service: dependencies.contentAuthoring, security: dependencies.security };
    switch (operation) {
      case "listOwnerProjectStatusValues": return await handleListOwnerProjectStatusValues(request, adapterDependencies);
      case "createOwnerProjectStatusValue": return await handleCreateOwnerProjectStatusValue(request, adapterDependencies);
      case "renameOwnerProjectStatusValue":
        return await handleRenameOwnerProjectStatusValue(request, params ?? { valueId: "" }, adapterDependencies);
      case "retireOwnerProjectStatusValue":
        return await handleRetireOwnerProjectStatusValue(request, params ?? { valueId: "" }, adapterDependencies);
    }
  } catch {
    return unavailable(request);
  }
}
