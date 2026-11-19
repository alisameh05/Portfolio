import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";
import { dispatchPutProjectRatingHttp } from "../../../../../../runtime/http/rating-http.js";

export const PUT = registerProductRoute("putProjectRating", async (request: Request, context: {
  readonly params: Promise<{ readonly projectId: string }>;
}) => dispatchPutProjectRatingHttp(request, await context.params));
