import { dispatchOwnerMediaHttp } from "../../../../../../../../runtime/http/owner-media-http.js";
import { registerProductRoute } from "../../../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("recordOwnerMediaProcessing", async (
  request: Request,
  context: { params: Promise<{ mediaId: string }> },
) => dispatchOwnerMediaHttp(request, "recordOwnerMediaProcessing", await context.params));
