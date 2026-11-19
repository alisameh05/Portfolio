import { dispatchOwnerModerationHttp } from "../../../../../../../../runtime/http/owner-moderation-http.js";
import { registerProductRoute } from "../../../../../../../../runtime/http/product-route-registration.js";

type RouteContext = { readonly params: Promise<{ readonly feedbackId: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("approveOwnerFeedback", async (request: Request, context: RouteContext) =>
  dispatchOwnerModerationHttp(request, "approveOwnerFeedback", await context.params));
