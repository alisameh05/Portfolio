import { dispatchOwnerTaxonomyHttp } from "../../../../../../../../runtime/http/owner-taxonomy-http.js";
import { registerProductRoute } from "../../../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("retireOwnerTaxonomyValue", async (request: Request, context: { params: Promise<{ valueId: string }> }) =>
  dispatchOwnerTaxonomyHttp(request, "retireOwnerTaxonomyValue", await context.params));
