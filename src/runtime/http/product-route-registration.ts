/**
 * Marks the OpenAPI operation served by a product Route Handler export.
 * The Phase 9 route inventory verifies its method, filesystem path, and
 * operationId against both canonical OpenAPI bundles before a slice is valid.
 */
export function registerProductRoute<Handler extends (...args: never[]) => unknown>(
  operationId: string,
  handler: Handler,
): Handler {
  if (typeof operationId !== "string" || operationId.length === 0 || typeof handler !== "function") {
    throw new TypeError("A canonical product operation and handler are required.");
  }
  return handler;
}

/**
 * Marks the one protected internal due-work Route Handler. It has no product
 * operationId, remains separate from the OpenAPI count, and Phase 10 owns
 * installing its schedule and secret.
 */
export function registerProtectedDueWorkRoute<Handler extends (...args: never[]) => unknown>(
  handler: Handler,
): Handler {
  if (typeof handler !== "function") throw new TypeError("A protected due-work handler is required.");
  return handler;
}
