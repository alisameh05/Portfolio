import {
  getOwnerContentAuthoringHttpDependencies,
  getOwnerProjectApplicationService,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import {
  handleChangeOwnerProjectPublicSlug,
  handleChangeOwnerProjectStatus,
  handleCorrectOwnerProjectCandidateSlug,
  handleGetOwnerProjectAggregate,
  handleRelateOwnerProjects,
  handleSetOwnerProjectFeatured,
} from "./owner-project.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerProjectHttpOperation =
  | "getOwnerProjectAggregate"
  | "changeOwnerProjectStatus"
  | "setOwnerProjectFeatured"
  | "changeOwnerProjectPublicSlug"
  | "correctOwnerProjectCandidateSlug"
  | "relateOwnerProjects";

type ProjectParams = { readonly projectId: string };

const INSTANCE = "/api/owner/v1/projects";
let initialization: Promise<void> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= (async () => {
    await initializeDatabaseRuntime(getRuntimeEnvironmentSnapshot(), "application");
  })();
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
    instance: INSTANCE,
    code: "temporarily_unavailable",
    traceId,
  }, { status: 503, headers: { "content-type": "application/problem+json", ...OWNER_PRIVATE_RESPONSE_HEADERS } });
}

/** Initializes the configured runtime and dispatches one Project HTTP adapter. */
export async function dispatchOwnerProjectHttp(
  request: Request,
  operation: OwnerProjectHttpOperation,
  params: ProjectParams,
): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const [security, service] = await Promise.all([
      getOwnerContentAuthoringHttpDependencies(),
      getOwnerProjectApplicationService(),
    ]);
    const deps = { service, security: security.security };
    stage = "adapter";
    switch (operation) {
      case "getOwnerProjectAggregate": return await handleGetOwnerProjectAggregate(request, params, deps);
      case "changeOwnerProjectStatus": return await handleChangeOwnerProjectStatus(request, params, deps);
      case "setOwnerProjectFeatured": return await handleSetOwnerProjectFeatured(request, params, deps);
      case "changeOwnerProjectPublicSlug": return await handleChangeOwnerProjectPublicSlug(request, params, deps);
      case "correctOwnerProjectCandidateSlug": return await handleCorrectOwnerProjectCandidateSlug(request, params, deps);
      case "relateOwnerProjects": return await handleRelateOwnerProjects(request, params, deps);
    }
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("owner.project.http.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
