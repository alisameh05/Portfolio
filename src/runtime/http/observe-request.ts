import { emitOperationsSignal, type OperationsObservationPort, type OperationsSignalObservation } from "../../modules/portability-operations/index.js";
import type { Logger } from "../ports.js";

export type HttpObservationRoute = Extract<OperationsSignalObservation, { readonly kind: "http-request" }>["route"];

/** Observe one handwritten adapter boundary with fixed labels and no request data. */
export async function observeHttpRequest(
  route: HttpObservationRoute,
  action: () => Promise<Response>,
  logger?: Logger,
  observations?: Pick<OperationsObservationPort, "recordSignal">,
): Promise<Response> {
  const startedAt = performance.now();
  let response: Response | undefined;
  try {
    response = await action();
    return response;
  } finally {
    const durationMs = Math.max(0, Math.min(86_400_000, Math.floor(performance.now() - startedAt)));
    const status = response?.status ?? 500;
    const statusClass = `${Math.floor(status / 100)}xx` as "2xx" | "3xx" | "4xx" | "5xx";
    await emitOperationsSignal(logger, observations, { kind: "http-request", route, statusClass, durationMs });
  }
}
