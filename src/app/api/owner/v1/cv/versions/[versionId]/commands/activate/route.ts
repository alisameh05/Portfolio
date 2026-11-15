import { dispatchOwnerCvHttp } from "../../../../../../../../../runtime/http/owner-cv-http.js";
import { registerProductRoute } from "../../../../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("activateOwnerCvVersion", async (
  request: Request,
  context: { params: Promise<{ versionId: string }> },
) => dispatchOwnerCvHttp(request, "activateOwnerCvVersion", await context.params));
