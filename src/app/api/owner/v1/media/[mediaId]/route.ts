import { dispatchOwnerMediaHttp } from "../../../../../../runtime/http/owner-media-http.js";
import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = registerProductRoute("getOwnerMediaAggregate", async (
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
) => dispatchOwnerMediaHttp(request, "getOwnerMediaAggregate", await context.params));
