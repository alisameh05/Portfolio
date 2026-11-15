import { dispatchOwnerTaxonomyHttp } from "../../../../../../../runtime/http/owner-taxonomy-http.js";
import { registerProductRoute } from "../../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("createOwnerTaxonomyValue", async (request: Request, context: { params: Promise<{ taxonomyId: string }> }) =>
  dispatchOwnerTaxonomyHttp(request, "createOwnerTaxonomyValue", await context.params));
