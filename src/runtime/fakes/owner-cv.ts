/**
 * fakes/owner-cv.ts — Phase 2 #31 deterministic Owner CV Portfolio fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real CV registration, acceptance, Current CV activation,
 * retention, storage, and delivery behavior remain later-phase work.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import type {
  AcceptOwnerCvVersionApplicationCommand,
  ActivateOwnerCvVersionApplicationCommand,
  GetOwnerCvPortfolioQuery,
  GetCurrentCvMediaUsageQuery,
  OwnerCvApplicationService,
  OwnerCvCommandReceipt,
  OwnerCvPortfolioView,
  RegisterOwnerCvVersionApplicationCommand,
  RegisterOwnerCvVersionReceipt,
} from "../../modules/cv-portfolio/index.js";

export type OwnerCvFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerCvTestFake extends OwnerCvApplicationService {
  readonly calls: {
    readonly getOwnerCvPortfolio: ReadonlyArray<GetOwnerCvPortfolioQuery>;
    readonly registerOwnerCvVersion: ReadonlyArray<RegisterOwnerCvVersionApplicationCommand>;
    readonly acceptOwnerCvVersion: ReadonlyArray<AcceptOwnerCvVersionApplicationCommand>;
    readonly activateOwnerCvVersion: ReadonlyArray<ActivateOwnerCvVersionApplicationCommand>;
    readonly getCurrentCvMediaUsage: ReadonlyArray<GetCurrentCvMediaUsageQuery>;
  };
}

export const OWNER_CV_VERSION_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec2";
export const OWNER_CV_MEDIA_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ec0";
const ACTIVATED_AT = "2026-09-22T00:00:00.000Z";

function portfolioView(): OwnerCvPortfolioView {
  return {
    aggregateVersion: 2,
    currentVersionId: OWNER_CV_VERSION_ID as StableId<string>,
    versions: [
      {
        versionId: OWNER_CV_VERSION_ID as StableId<string>,
        mediaId: OWNER_CV_MEDIA_ID as StableId<string>,
        locale: "en",
        label: "CV September 2026",
        state: "accepted",
        isCurrent: true,
      },
    ],
    activationHistory: [
      {
        versionId: OWNER_CV_VERSION_ID as StableId<string>,
        activatedAt: ACTIVATED_AT,
      },
    ],
  };
}

function invalidPortfolioView(): OwnerCvPortfolioView {
  return {
    aggregateVersion: -1,
    currentVersionId: "not-a-uuid" as unknown as StableId<string>,
    versions: [
      {
        versionId: "not-a-uuid" as unknown as StableId<string>,
        mediaId: "not-a-uuid" as unknown as StableId<string>,
        locale: "en",
        label: "CV September 2026",
        state: "accepted",
        isCurrent: true,
      },
    ],
    activationHistory: [],
  };
}

function registerReceipt(expectedVersion: number): RegisterOwnerCvVersionReceipt {
  return {
    versionId: OWNER_CV_VERSION_ID as StableId<string>,
    aggregateVersion: expectedVersion + 1,
    outcome: "cv-version-registered",
  };
}

function invalidRegisterReceipt(): RegisterOwnerCvVersionReceipt {
  return {
    versionId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "cv-version-registered",
  };
}

function commandReceipt(
  aggregateId: string,
  aggregateVersion: number,
  outcome: OwnerCvCommandReceipt["outcome"],
): OwnerCvCommandReceipt {
  return {
    aggregateId: aggregateId as StableId<string>,
    aggregateVersion,
    outcome,
  };
}

function invalidCommandReceipt(): OwnerCvCommandReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "cv-version-accepted",
  };
}

export function createOwnerCvTestFake(mode: OwnerCvFakeMode): OwnerCvTestFake {
  const getCalls: GetOwnerCvPortfolioQuery[] = [];
  const registerCalls: RegisterOwnerCvVersionApplicationCommand[] = [];
  const acceptCalls: AcceptOwnerCvVersionApplicationCommand[] = [];
  const activateCalls: ActivateOwnerCvVersionApplicationCommand[] = [];
  const currentUsageCalls: GetCurrentCvMediaUsageQuery[] = [];
  return {
    get calls() {
      return {
        getOwnerCvPortfolio: getCalls,
        registerOwnerCvVersion: registerCalls,
        acceptOwnerCvVersion: acceptCalls,
        activateOwnerCvVersion: activateCalls,
        getCurrentCvMediaUsage: currentUsageCalls,
      };
    },
    async getOwnerCvPortfolio(query: GetOwnerCvPortfolioQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: portfolioView() };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidPortfolioView() };
      }
    },
    async registerOwnerCvVersion(command: RegisterOwnerCvVersionApplicationCommand) {
      registerCalls.push(command);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: registerReceipt(command.expectedVersion) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidRegisterReceipt() };
      }
    },
    async acceptOwnerCvVersion(command: AcceptOwnerCvVersionApplicationCommand) {
      acceptCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: commandReceipt(command.versionId, command.expectedVersion + 1, "cv-version-accepted"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidCommandReceipt() };
      }
    },
    async activateOwnerCvVersion(command: ActivateOwnerCvVersionApplicationCommand) {
      activateCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: commandReceipt(command.versionId, command.expectedVersion + 1, "current-cv-activated"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidCommandReceipt() };
      }
    },
    async getCurrentCvMediaUsage(query: GetCurrentCvMediaUsageQuery) {
      currentUsageCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: query.mediaAssetId === OWNER_CV_MEDIA_ID };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: "yes" as unknown as boolean };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the four Owner CV Portfolio operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerCvService(): OwnerCvApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async getOwnerCvPortfolio(_query: GetOwnerCvPortfolioQuery) {
      return failure;
    },
    async registerOwnerCvVersion(_command: RegisterOwnerCvVersionApplicationCommand) {
      return failure;
    },
    async acceptOwnerCvVersion(_command: AcceptOwnerCvVersionApplicationCommand) {
      return failure;
    },
    async activateOwnerCvVersion(_command: ActivateOwnerCvVersionApplicationCommand) {
      return failure;
    },
    async getCurrentCvMediaUsage(_query: GetCurrentCvMediaUsageQuery) {
      return failure;
    },
  };
}
