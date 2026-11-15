import {
  getOwnerMediaApplicationService,
  getOwnerContentAuthoringHttpDependencies,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import {
  handleCreateOwnerMediaUploadIntent,
  handleGetOwnerMediaAggregate,
  handleRecordOwnerMediaProcessing,
} from "./owner-media.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerMediaHttpOperation =
  | "getOwnerMediaAggregate"
  | "createOwnerMediaUploadIntent"
  | "recordOwnerMediaProcessing";

let initialization: ReturnType<typeof initializeDatabaseRuntime> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= initializeDatabaseRuntime(getRuntimeEnvironmentSnapshot(), "application");
  const pending = initialization;
  try {
    await pending;
  } catch (error) {
    if (initialization === pending) initialization = undefined;
    throw error;
  }
}

function unavailable(request: Request): Response {
  const { traceId } = createCorrelation(
    request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"),
  );
  return Response.json({
    type: "urn:shipwithali:problem:temporarily-unavailable",
    title: "Service Unavailable",
    status: 503,
    detail: "A required dependency is temporarily unavailable. Retry later.",
    instance: new URL(request.url).pathname,
    code: "temporarily_unavailable",
    traceId,
  }, {
    status: 503,
    headers: { "content-type": "application/problem+json", ...OWNER_PRIVATE_RESPONSE_HEADERS },
  });
}

/** Initializes the configured runtime and dispatches one existing Media HTTP adapter. */
export async function dispatchOwnerMediaHttp(
  request: Request,
  operation: OwnerMediaHttpOperation,
  params?: { readonly mediaId: string },
): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const [security, service] = await Promise.all([
      getOwnerContentAuthoringHttpDependencies(),
      getOwnerMediaApplicationService(),
    ]);
    const deps = { service, security: security.security };
    stage = "adapter";
    switch (operation) {
      case "getOwnerMediaAggregate":
        return await handleGetOwnerMediaAggregate(request, { mediaId: params?.mediaId ?? "" }, deps);
      case "createOwnerMediaUploadIntent":
        return await handleCreateOwnerMediaUploadIntent(request, deps);
      case "recordOwnerMediaProcessing":
        return await handleRecordOwnerMediaProcessing(request, { mediaId: params?.mediaId ?? "" }, deps);
    }
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("owner.media.http.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
