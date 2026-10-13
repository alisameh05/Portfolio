/**
 * fakes/current-cv.ts — Phase 2 #28 deterministic Current CV fakes.
 *
 * Test composition may inject deterministic application fakes for the
 * declared redirect success and every rejection. The fake supplies a
 * short-lived signed location without touching storage. Production Phase 2
 * composition injects the fail-closed fake, which returns
 * `temporarily_unavailable` with the stable `RUNTIME_NOT_IMPLEMENTED` code
 * and never fabricates a CV stream or redirect. Real storage, signing, and
 * domain behavior remain later-phase work.
 */

import type { Rejection } from "../../shared/domain/index.js";
import type {
  CvPortfolioApplicationService,
  CurrentCvDownloadQuery,
} from "../../modules/cv-portfolio/index.js";

export type CurrentCvFakeMode =
  | { readonly type: "redirect"; readonly downloadUrl?: string }
  | { readonly type: "stream"; readonly chunks?: ReadonlyArray<Uint8Array> }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-redirect" };

export interface CurrentCvTestFake
  extends Pick<CvPortfolioApplicationService, "downloadCurrentCv"> {
  readonly calls: ReadonlyArray<CurrentCvDownloadQuery>;
}

const FAKE_SIGNED_URL = "https://storage.example/signed/current-cv?token=fake";

export function createCurrentCvTestFake(mode: CurrentCvFakeMode): CurrentCvTestFake {
  const calls: CurrentCvDownloadQuery[] = [];
  return {
    get calls(): ReadonlyArray<CurrentCvDownloadQuery> {
      return calls;
    },
    async downloadCurrentCv(query: CurrentCvDownloadQuery) {
      calls.push(query);
      switch (mode.type) {
        case "redirect":
          return {
            ok: true as const,
            value: {
              kind: "redirect" as const,
              downloadUrl: mode.downloadUrl ?? FAKE_SIGNED_URL,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              disposition: query.disposition,
            },
          };
        case "stream":
          return {
            ok: true as const,
            value: {
              kind: "stream" as const,
              bytes: (async function* () {
                yield* mode.chunks ?? [new Uint8Array([37, 80, 68, 70])];
              })(),
              disposition: query.disposition,
            },
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-redirect":
          return {
            ok: true as const,
            value: {
              kind: "redirect" as const,
              downloadUrl: "not-a-url",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              disposition: query.disposition,
            },
          };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the Current CV operation.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionCurrentCvService(): Pick<
  CvPortfolioApplicationService,
  "downloadCurrentCv"
> {
  return {
    async downloadCurrentCv(_query: CurrentCvDownloadQuery) {
      return {
        ok: false as const,
        error: {
          kind: "temporarily_unavailable" as const,
          code: "RUNTIME_NOT_IMPLEMENTED",
        },
      };
    },
  };
}
