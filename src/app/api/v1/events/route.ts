import { dispatchPostPublicEventHttp } from "../../../../runtime/http/public-event.js";
import { registerProductRoute } from "../../../../runtime/http/product-route-registration.js";

export const POST = registerProductRoute("postPublicEvent", dispatchPostPublicEventHttp);
