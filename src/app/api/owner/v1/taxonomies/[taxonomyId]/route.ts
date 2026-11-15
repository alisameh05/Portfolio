import { dispatchOwnerTaxonomyHttp } from "../../../../../../runtime/http/owner-taxonomy-http.js";
import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = registerProductRoute("getOwnerTaxonomyAggregate", async (request: Request, context: { params: Promise<{ taxonomyId: string }> }) =>
  dispatchOwnerTaxonomyHttp(request, "getOwnerTaxonomyAggregate", await context.params));
