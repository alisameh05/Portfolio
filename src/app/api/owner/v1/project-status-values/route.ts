import { dispatchOwnerProjectStatusHttp } from "../../../../../runtime/http/owner-project-status-http.js";
import { registerProductRoute } from "../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = registerProductRoute("listOwnerProjectStatusValues", async (request: Request) =>
  dispatchOwnerProjectStatusHttp(request, "listOwnerProjectStatusValues"));

export const POST = registerProductRoute("createOwnerProjectStatusValue", async (request: Request) =>
  dispatchOwnerProjectStatusHttp(request, "createOwnerProjectStatusValue"));
