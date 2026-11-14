import { dispatchOwnerProjectHttp } from "../../../../../../../../runtime/http/owner-project-http.js";
import { registerProductRoute } from "../../../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("changeOwnerProjectPublicSlug", async (request: Request, context: { params: Promise<{ projectId: string }> }) =>
  dispatchOwnerProjectHttp(request, "changeOwnerProjectPublicSlug", await context.params));
