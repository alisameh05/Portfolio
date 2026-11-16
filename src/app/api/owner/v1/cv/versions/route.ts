import { dispatchOwnerCvHttp } from "../../../../../../runtime/http/owner-cv-http.js";
import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("registerOwnerCvVersion", async (request: Request) =>
  dispatchOwnerCvHttp(request, "registerOwnerCvVersion"));
