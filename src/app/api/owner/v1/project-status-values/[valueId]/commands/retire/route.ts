import { dispatchOwnerProjectStatusHttp } from "../../../../../../../../runtime/http/owner-project-status-http.js";
import { registerProductRoute } from "../../../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("retireOwnerProjectStatusValue", async (
  request: Request,
  context: { readonly params: Promise<{ readonly valueId: string }> },
) => dispatchOwnerProjectStatusHttp(request, "retireOwnerProjectStatusValue", await context.params));
