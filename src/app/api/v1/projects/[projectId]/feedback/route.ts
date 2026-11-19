import { registerProductRoute } from "../../../../../../runtime/http/product-route-registration.js";
import { dispatchPostProjectFeedbackHttp } from "../../../../../../runtime/http/feedback-http.js";

export const POST = registerProductRoute("postProjectFeedback", async (request: Request, context: {
  readonly params: Promise<{ readonly projectId: string }>;
}) => dispatchPostProjectFeedbackHttp(request, await context.params));
