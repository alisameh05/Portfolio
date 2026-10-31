import {
  getOwnerConfigurationHttpDependencies,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "./composition-root.js";
import {
  handleUpdateOwnerContactChannels,
  handleUpdateOwnerGlobalProjectCta,
  handleUpdateOwnerProfileConfiguration,
} from "../runtime/http/owner-configuration.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "../runtime/http/owner-security.js";
import { createCorrelation } from "../runtime/ports.js";

export type OwnerConfigurationOperation =
  | "updateOwnerProfileConfiguration"
  | "updateOwnerContactChannels"
  | "updateOwnerGlobalProjectCta";

let initialization: Promise<void> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= (async () => {
    const environment = getRuntimeEnvironmentSnapshot();
    await initializeDatabaseRuntime(environment, "application");
  })();
  await initialization;
}

function unavailable(request: Request): Response {
  const { traceId } = createCorrelation(request.headers.get("x-request-id") ?? request.headers.get("x-correlation-id"));
  return Response.json({
    type: "urn:shipwithali:problem:temporarily-unavailable",
    title: "Service Unavailable",
    status: 503,
    detail: "A required dependency is temporarily unavailable. Retry later.",
    instance: "/api/owner/v1/configuration",
    code: "temporarily_unavailable",
    traceId,
  }, { status: 503, headers: {
    "content-type": "application/problem+json",
    ...OWNER_PRIVATE_RESPONSE_HEADERS,
  } });
}

/** Initializes production composition once per server process and dispatches one existing HTTP adapter. */
export async function handleOwnerConfigurationHttp(
  request: Request,
  operation: OwnerConfigurationOperation,
): Promise<Response> {
  try {
    await ensureRuntime();
    const dependencies = getOwnerConfigurationHttpDependencies();
    switch (operation) {
      case "updateOwnerProfileConfiguration":
        return await handleUpdateOwnerProfileConfiguration(request, dependencies);
      case "updateOwnerContactChannels":
        return await handleUpdateOwnerContactChannels(request, dependencies);
      case "updateOwnerGlobalProjectCta":
        return await handleUpdateOwnerGlobalProjectCta(request, dependencies);
    }
  } catch {
    return unavailable(request);
  }
}
