import { dispatchPutProjectReactionHttp } from "../../../../../../runtime/http/reaction-http.js";
import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = registerProductRoute("putProjectReaction", async (
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) => dispatchPutProjectReactionHttp(request, await context.params));
