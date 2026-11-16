import { getReactionRuntimeServices } from "../../../../../../bootstrap/composition-root.js";
import { handlePutProjectReaction } from "../../../../../../runtime/http/reaction.js";
import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = registerProductRoute("putProjectReaction", async (
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) => {
  const [{ projectId }, services] = await Promise.all([
    context.params,
    getReactionRuntimeServices(),
  ]);
  return handlePutProjectReaction(request, { projectId }, services);
});
