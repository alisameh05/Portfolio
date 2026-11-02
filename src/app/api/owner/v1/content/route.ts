import { dispatchOwnerContentAuthoringHttp } from "../../../../../runtime/http/owner-content-authoring-http.js";
import { registerProductRoute } from "../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("createOwnerContent", async (request: Request) =>
  dispatchOwnerContentAuthoringHttp(request, "createOwnerContent"));
