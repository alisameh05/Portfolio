export type FailurePoint = "transaction" | "projection" | "outbox" | "receipt";

export function createFailureInjector(failAt: FailurePoint) {
  return Object.freeze({
    hit(point: FailurePoint) {
      if (point === failAt) throw new Error(`INJECTED_${point.toUpperCase()}_FAILURE`);
    },
  });
}

export const mediaAcceptanceFacts = Object.freeze([
  Object.freeze({ status: "accepted" as const }),
  Object.freeze({ status: "rejected" as const, reason: "unsafe" as const }),
  Object.freeze({ status: "unavailable" as const }),
]);
