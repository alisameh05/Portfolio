/**
 * fakes/owner-configuration.ts — Phase 2 #29 deterministic Owner Configuration fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real identity, authorization, persistence, and domain behavior
 * remain later-phase work.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import type {
  OwnerConfigurationApplicationService,
  OwnerConfigurationReceipt,
  UpdateOwnerContactChannelsApplicationCommand,
  UpdateOwnerGlobalProjectCtaApplicationCommand,
  UpdateOwnerProfileApplicationCommand,
} from "../http/owner-configuration.js";

export type OwnerConfigurationFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerConfigurationTestFake extends OwnerConfigurationApplicationService {
  readonly calls: {
    readonly updateOwnerProfile: ReadonlyArray<UpdateOwnerProfileApplicationCommand>;
    readonly updateOwnerContactChannels: ReadonlyArray<UpdateOwnerContactChannelsApplicationCommand>;
    readonly updateOwnerGlobalProjectCta: ReadonlyArray<UpdateOwnerGlobalProjectCtaApplicationCommand>;
  };
}

const FAKE_CONFIG_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea1";

function receipt(expectedVersion: number): OwnerConfigurationReceipt {
  return {
    aggregateId: FAKE_CONFIG_ID as StableId<string>,
    aggregateVersion: expectedVersion + 1,
    outcome: "configuration-updated",
  };
}

function invalidReceipt(): OwnerConfigurationReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "configuration-updated",
  };
}

export function createOwnerConfigurationTestFake(
  mode: OwnerConfigurationFakeMode,
): OwnerConfigurationTestFake {
  const profileCalls: UpdateOwnerProfileApplicationCommand[] = [];
  const channelsCalls: UpdateOwnerContactChannelsApplicationCommand[] = [];
  const ctaCalls: UpdateOwnerGlobalProjectCtaApplicationCommand[] = [];
  return {
    get calls() {
      return {
        updateOwnerProfile: profileCalls,
        updateOwnerContactChannels: channelsCalls,
        updateOwnerGlobalProjectCta: ctaCalls,
      };
    },
    async updateOwnerProfile(command: UpdateOwnerProfileApplicationCommand) {
      profileCalls.push(command);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: receipt(command.expectedVersion) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async updateOwnerContactChannels(
      command: UpdateOwnerContactChannelsApplicationCommand,
    ) {
      channelsCalls.push(command);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: receipt(command.expectedVersion) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async updateOwnerGlobalProjectCta(
      command: UpdateOwnerGlobalProjectCtaApplicationCommand,
    ) {
      ctaCalls.push(command);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: receipt(command.expectedVersion) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the three Owner Configuration operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerConfigurationService(): OwnerConfigurationApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async updateOwnerProfile(_command: UpdateOwnerProfileApplicationCommand) {
      return failure;
    },
    async updateOwnerContactChannels(
      _command: UpdateOwnerContactChannelsApplicationCommand,
    ) {
      return failure;
    },
    async updateOwnerGlobalProjectCta(
      _command: UpdateOwnerGlobalProjectCtaApplicationCommand,
    ) {
      return failure;
    },
  };
}
