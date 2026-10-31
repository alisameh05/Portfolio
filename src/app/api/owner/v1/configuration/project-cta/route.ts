import { dispatchOwnerConfigurationHttp } from "../../../../../../runtime/http/owner-configuration-http.js";
import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = registerProductRoute("updateOwnerGlobalProjectCta", async (request: Request) =>
  dispatchOwnerConfigurationHttp(request, "updateOwnerGlobalProjectCta"));
