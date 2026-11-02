import {
  getOwnerContentAuthoringHttpDependencies,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import { handleCreateOwnerContent } from "./owner-content-authoring.js";
import {
  handleGetOwnerContentAggregate,
  handleSaveOwnerContentRevision,
} from "./owner-publication.js";
import {
  handleGetOwnerContentHistory,
  handlePreviewOwnerContentRevision,
  handleReviewOwnerContentRevision,
} from "./owner-content-review.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerContentAuthoringOperation =
  | "createOwnerContent"
  | "getOwnerContentAggregate"
  | "saveOwnerContentRevision"
  | "previewOwnerContentRevision"
  | "reviewOwnerContentRevision"
  | "getOwnerContentHistory";

type ContentParams = { readonly contentId: string };
type RevisionParams = ContentParams & { readonly revisionId: string };

const INSTANCE = "/api/owner/v1/content";
let initialization: Promise<void> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= (async () => {
    await initializeDatabaseRuntime(getRuntimeEnvironmentSnapshot(), "application");
  })();
  const current = initialization;
  try { await current; }
  catch (error) {
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

/** Initializes the configured application runtime and dispatches one content HTTP adapter. */
export async function dispatchOwnerContentAuthoringHttp(
  request: Request,
  operation: OwnerContentAuthoringOperation,
  params?: ContentParams | RevisionParams,
): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const deps = await getOwnerContentAuthoringHttpDependencies();
    stage = "adapter";
    switch (operation) {
      case "createOwnerContent": return await handleCreateOwnerContent(request, { service: deps.contentAuthoring, security: deps.security });
      case "getOwnerContentAggregate": return await handleGetOwnerContentAggregate(request, params as ContentParams, { service: deps.publication, contentAuthoring: deps.contentAuthoring, security: deps.security });
      case "saveOwnerContentRevision": return await handleSaveOwnerContentRevision(request, params as ContentParams, { service: deps.publication, contentAuthoring: deps.contentAuthoring, security: deps.security });
      case "previewOwnerContentRevision": return await handlePreviewOwnerContentRevision(request, params as RevisionParams, { service: deps.contentAuthoring, security: deps.security });
      case "reviewOwnerContentRevision": return await handleReviewOwnerContentRevision(request, params as RevisionParams, { service: deps.contentAuthoring, security: deps.security });
      case "getOwnerContentHistory": return await handleGetOwnerContentHistory(request, params as ContentParams, { service: deps.contentAuthoring, security: deps.security });
    }
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("owner.content.authoring.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
