import {
  getOwnerContentAuthoringHttpDependencies,
  getOwnerModerationRuntimeServices,
  getRuntimeEnvironmentSnapshot,
  initializeDatabaseRuntime,
} from "../../bootstrap/composition-root.js";
import {
  handleApproveOwnerFeedback,
  handleGetOwnerFeedbackModeration,
  handleRejectOwnerFeedback,
  handleSuppressOwnerFeedback,
} from "./owner-moderation.js";
import { OWNER_PRIVATE_RESPONSE_HEADERS } from "./owner-security.js";
import { createCorrelation } from "../ports.js";

export type OwnerModerationHttpOperation =
  | "getOwnerFeedbackModeration"
  | "approveOwnerFeedback"
  | "rejectOwnerFeedback"
  | "suppressOwnerFeedback";

type FeedbackParams = { readonly feedbackId: string };

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

/** Initializes the production runtime and sends one canonical Moderation operation to its adapter. */
export async function dispatchOwnerModerationHttp(
  request: Request,
  operation: OwnerModerationHttpOperation,
  params: FeedbackParams,
): Promise<Response> {
  let stage = "runtime";
  try {
    await ensureRuntime();
    stage = "dependencies";
    const [security, moderation] = await Promise.all([
      getOwnerContentAuthoringHttpDependencies(),
      getOwnerModerationRuntimeServices(),
    ]);
    const deps = { ...moderation, security: security.security };
    stage = "adapter";
    switch (operation) {
      case "getOwnerFeedbackModeration":
        return await handleGetOwnerFeedbackModeration(request, params, deps);
      case "approveOwnerFeedback":
        return await handleApproveOwnerFeedback(request, params, deps);
      case "rejectOwnerFeedback":
        return await handleRejectOwnerFeedback(request, params, deps);
      case "suppressOwnerFeedback":
        return await handleSuppressOwnerFeedback(request, params, deps);
    }
  } catch (error) {
    const safeCode = error instanceof Error && /^[A-Z][A-Z0-9_]{1,80}$/u.test(error.message)
      ? error.message
      : "UNEXPECTED";
    console.error("owner.moderation.http.unavailable", { stage, code: safeCode });
    return unavailable(request);
  }
}
