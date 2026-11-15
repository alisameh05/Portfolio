import {
  getOwnerContentAuthoringHttpDependencies,
  getOwnerTaxonomyApplicationService,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import {
  handleCreateOwnerTaxonomyValue,
  handleGetOwnerTaxonomyAggregate,
  handleMergeOwnerTaxonomyValue,
  handleRenameOwnerTaxonomyValue,
  handleRetireOwnerTaxonomyValue,
} from "./owner-taxonomy.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerTaxonomyHttpOperation =
  | "getOwnerTaxonomyAggregate"
  | "createOwnerTaxonomyValue"
  | "renameOwnerTaxonomyValue"
  | "retireOwnerTaxonomyValue"
  | "mergeOwnerTaxonomyValue";

let initialization: Promise<void> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= initializeDatabaseRuntime(getRuntimeEnvironmentSnapshot(), "application");
  const current = initialization;
  try {
    await current;
  } catch (error) {
    if (initialization === current) initialization = undefined;
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
    instance: new URL(request.url).pathname,
    code: "temporarily_unavailable",
    traceId,
  }, { status: 503, headers: { "content-type": "application/problem+json", ...OWNER_PRIVATE_RESPONSE_HEADERS } });
}

/** Initializes the configured runtime and dispatches one Taxonomy HTTP adapter. */
export async function dispatchOwnerTaxonomyHttp(
  request: Request,
  operation: OwnerTaxonomyHttpOperation,
  params: { readonly taxonomyId?: string; readonly valueId?: string },
): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const [security, service] = await Promise.all([
      getOwnerContentAuthoringHttpDependencies(),
      getOwnerTaxonomyApplicationService(),
    ]);
    const deps = { service, security: security.security };
    stage = "adapter";
    switch (operation) {
      case "getOwnerTaxonomyAggregate":
        return await handleGetOwnerTaxonomyAggregate(request, { taxonomyId: params.taxonomyId ?? "" }, deps);
      case "createOwnerTaxonomyValue":
        return await handleCreateOwnerTaxonomyValue(request, { taxonomyId: params.taxonomyId ?? "" }, deps);
      case "renameOwnerTaxonomyValue":
        return await handleRenameOwnerTaxonomyValue(request, { valueId: params.valueId ?? "" }, deps);
      case "retireOwnerTaxonomyValue":
        return await handleRetireOwnerTaxonomyValue(request, { valueId: params.valueId ?? "" }, deps);
      case "mergeOwnerTaxonomyValue":
        return await handleMergeOwnerTaxonomyValue(request, { valueId: params.valueId ?? "" }, deps);
    }
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("owner.taxonomy.http.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
