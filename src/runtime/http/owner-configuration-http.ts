import {
  getOwnerConfigurationHttpDependencies,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import {
  handleUpdateOwnerContactChannels,
  handleUpdateOwnerGlobalProjectCta,
  handleUpdateOwnerProfileConfiguration,
} from "./owner-configuration.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerConfigurationOperation =
  | "updateOwnerProfileConfiguration"
  | "updateOwnerContactChannels"
  | "updateOwnerGlobalProjectCta";

const OWNER_CONFIGURATION_INSTANCE_PATH = ["", "api", "owner", "v1", "configuration"].join("/");

let initialization: Promise<void> | undefined;

async function ensureRuntime(): Promise<void> {
  initialization ??= (async () => {
    const environment = getRuntimeEnvironmentSnapshot();
    await initializeDatabaseRuntime(environment, "application");
  })();
  const pending = initialization;
  try {
    await pending;
  } catch (error) {
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
    instance: OWNER_CONFIGURATION_INSTANCE_PATH,
    code: "temporarily_unavailable",
    traceId,
  }, { status: 503, headers: {
    "content-type": "application/problem+json",
    ...OWNER_PRIVATE_RESPONSE_HEADERS,
  } });
}

/** Initializes production composition once per server process and dispatches one existing HTTP adapter. */
export async function dispatchOwnerConfigurationHttp(
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
