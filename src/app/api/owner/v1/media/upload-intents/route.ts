import { dispatchOwnerMediaHttp } from "../../../../../../runtime/http/owner-media-http.js";
import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = registerProductRoute("createOwnerMediaUploadIntent", async (request: Request) =>
  dispatchOwnerMediaHttp(request, "createOwnerMediaUploadIntent"));
