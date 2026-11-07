import { dispatchOwnerContentAuthoringHttp } from "@/runtime/http/owner-content-authoring-http.js";
import { registerProductRoute } from "@/runtime/http/product-route-registration.js";

type RouteContext = { readonly params: Promise<{ readonly contentId: string }> };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("archiveOwnerContent", async (request: Request, context: RouteContext) =>
  dispatchOwnerContentAuthoringHttp(request, "archiveOwnerContent", await context.params));
