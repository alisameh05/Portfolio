import {
  getOwnerContentAuthoringHttpDependencies,
  getOwnerCvApplicationService,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import {
  handleAcceptOwnerCvVersion,
  handleActivateOwnerCvVersion,
  handleGetOwnerCvPortfolio,
  handleRegisterOwnerCvVersion,
} from "./owner-cv.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerCvHttpOperation =
  | "getOwnerCvPortfolio"
  | "registerOwnerCvVersion"
  | "acceptOwnerCvVersion"
  | "activateOwnerCvVersion";

let initialization: Promise<unknown> | undefined;

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

/** Dispatches one existing CV Owner adapter after the production runtime is ready. */
export async function dispatchOwnerCvHttp(
  request: Request,
  operation: OwnerCvHttpOperation,
  params?: { readonly versionId: string },
): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const [security, service] = await Promise.all([
      getOwnerContentAuthoringHttpDependencies(),
      getOwnerCvApplicationService(),
    ]);
    const deps = { service, security: security.security };
    stage = "adapter";
    let response: Response;
    switch (operation) {
      case "getOwnerCvPortfolio":
        response = await handleGetOwnerCvPortfolio(request, deps);
        break;
      case "registerOwnerCvVersion":
        response = await handleRegisterOwnerCvVersion(request, deps);
        break;
      case "acceptOwnerCvVersion":
        response = await handleAcceptOwnerCvVersion(request, { versionId: params?.versionId ?? "" }, deps);
        break;
      case "activateOwnerCvVersion":
        response = await handleActivateOwnerCvVersion(request, { versionId: params?.versionId ?? "" }, deps);
        break;
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(OWNER_PRIVATE_RESPONSE_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("owner.cv.http.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
