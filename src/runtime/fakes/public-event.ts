/**
 * fakes/public-event.ts — Phase 2 #28 deterministic Public event fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real consent verification, persistence, aggregation, and domain
 * behavior remain later-phase work.
 */

import type {
  Rejection,
  StableId,
} from "../../shared/domain/index.js";
import type {
  IngestPublicEventCommand,
  MeasurementService,
} from "../../modules/measurement/index.js";
import { createSystemClock, type Clock } from "../ports.js";

export type PublicEventFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface PublicEventTestFake
  extends Pick<MeasurementService, "ingestEvent"> {
  readonly calls: ReadonlyArray<IngestPublicEventCommand>;
}

const FAKE_EVENT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7e92";

export function createPublicEventTestFake(
  mode: PublicEventFakeMode,
  clock: Clock = createSystemClock(),
): PublicEventTestFake {
  const calls: IngestPublicEventCommand[] = [];
  return {
    get calls(): ReadonlyArray<IngestPublicEventCommand> {
      return calls;
    },
    async ingestEvent(command: IngestPublicEventCommand) {
      calls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: {
              eventId: FAKE_EVENT_ID as StableId<"PublicEvent">,
              eventType: command.eventType,
              timestamp: clock.now(),
              routeIdentity: command.routeIdentity,
              ...(command.coarseCountry === undefined
                ? {}
                : { coarseCountry: command.coarseCountry }),
              ...(command.coarseDevice === undefined
                ? {}
                : { coarseDevice: command.coarseDevice }),
            },
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return {
            ok: true as const,
            value: {
              eventId: "not-a-uuid" as unknown as StableId<"PublicEvent">,
              eventType: command.eventType,
              timestamp: clock.now(),
              routeIdentity: command.routeIdentity,
            },
          };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the Public event operation.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionPublicEventService(): Pick<
  MeasurementService,
  "ingestEvent"
> {
  return {
    async ingestEvent(_command: IngestPublicEventCommand) {
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
