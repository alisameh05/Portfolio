import { err, type Rejection, type Result } from "@shared/domain";
import type { CurrentCvDisposition } from "../domain/index.js";
import type {
  CurrentCvDelivery,
  CurrentCvDownloadQuery,
  CurrentCvSnapshot,
} from "./owner-contracts.js";

export interface CurrentCvSnapshotRepositoryPort {
  getCurrentCvSnapshot(): Promise<Result<CurrentCvSnapshot, Rejection>>;
}

export interface CurrentCvObjectDeliveryPort {
  stream(input: {
    readonly snapshot: CurrentCvSnapshot;
    readonly disposition: CurrentCvDisposition;
  }): Promise<Result<AsyncIterable<Uint8Array>, Rejection>>;
  createDownloadTarget(input: {
    readonly snapshot: CurrentCvSnapshot;
    readonly disposition: CurrentCvDisposition;
  }): Promise<Result<{ readonly url: string; readonly expiresAt: string }, Rejection>>;
}

/** Public delivery is resolved from the authoritative current pointer each request. */
export function createCurrentCvDeliveryService(input: {
  readonly repository: CurrentCvSnapshotRepositoryPort;
  readonly storage: CurrentCvObjectDeliveryPort;
  readonly mode?: "stream" | "redirect";
}) {
  return {
    async downloadCurrentCv(query: CurrentCvDownloadQuery): Promise<Result<CurrentCvDelivery, Rejection>> {
      if (query.actor.kind !== "visitor" || query.locale !== "en" ||
          (query.disposition !== "inline" && query.disposition !== "attachment")) {
        return err({ kind: "validation", code: "CURRENT_CV_REQUEST_INVALID" });
      }
      const current = await input.repository.getCurrentCvSnapshot();
      if (!current.ok) return current;
      if (input.mode === "redirect") {
        const target = await input.storage.createDownloadTarget({
          snapshot: current.value,
          disposition: query.disposition,
        });
        return target.ok
          ? { ok: true, value: { kind: "redirect", downloadUrl: target.value.url,
            expiresAt: target.value.expiresAt, disposition: query.disposition } }
          : target;
      }
      const stream = await input.storage.stream({ snapshot: current.value, disposition: query.disposition });
      return stream.ok
        ? { ok: true, value: { kind: "stream", bytes: stream.value, disposition: query.disposition } }
        : stream;
    },
  };
}

export type CurrentCvDeliveryService = ReturnType<typeof createCurrentCvDeliveryService>;
