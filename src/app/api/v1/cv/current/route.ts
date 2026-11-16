import { dispatchCurrentCvHttp } from "../../../../../runtime/http/current-cv-http.js";
import { registerProductRoute } from "../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = registerProductRoute("getCurrentCv", async (request: Request) =>
  dispatchCurrentCvHttp(request));
