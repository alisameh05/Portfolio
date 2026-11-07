import { dispatchOwnerContentAuthoringHttp } from "../../../../../../../../../runtime/http/owner-content-authoring-http.js";
import { registerProductRoute } from "../../../../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = registerProductRoute("previewOwnerContentRevision", async (request: Request, context: { params: Promise<{ contentId: string; revisionId: string }> }) =>
  dispatchOwnerContentAuthoringHttp(request, "previewOwnerContentRevision", await context.params));
