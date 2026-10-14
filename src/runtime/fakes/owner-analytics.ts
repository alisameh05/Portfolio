/**
 * fakes/owner-analytics.ts — Phase 2 #32 deterministic Owner Analytics fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real goal definition, versioning, activation, measurement
 * storage, identity, and authorization behavior remain later-phase work.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import type {
  ActivateOwnerAnalyticsGoalVersionApplicationCommand,
  AnalyticsGoalActivationReceipt,
  AnalyticsGoalAggregateView,
  AnalyticsGoalVersionReceipt,
  CreateOwnerAnalyticsGoalVersionApplicationCommand,
  GetOwnerAnalyticsGoalQuery,
  OwnerAnalyticsApplicationService,
} from "../../modules/measurement/index.js";

export type OwnerAnalyticsFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerAnalyticsTestFake extends OwnerAnalyticsApplicationService {
  readonly calls: {
    readonly getOwnerAnalyticsGoal: ReadonlyArray<GetOwnerAnalyticsGoalQuery>;
    readonly createOwnerAnalyticsGoalVersion: ReadonlyArray<CreateOwnerAnalyticsGoalVersionApplicationCommand>;
    readonly activateOwnerAnalyticsGoalVersion: ReadonlyArray<ActivateOwnerAnalyticsGoalVersionApplicationCommand>;
  };
}

export const OWNER_ANALYTICS_GOAL_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ed0";
export const OWNER_ANALYTICS_VERSION_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ed1";

function aggregateView(goalId: StableId<"AnalyticsGoal">): AnalyticsGoalAggregateView {
  return {
    goalId,
    aggregateVersion: 2,
    activeVersionId: OWNER_ANALYTICS_VERSION_ID as StableId<"AnalyticsGoalVersion">,
    versions: [
      {
        versionId: OWNER_ANALYTICS_VERSION_ID as StableId<"AnalyticsGoalVersion">,
        versionNumber: 1,
        definition: {
          name: "Project view to contact",
          steps: [{ action: "project-viewed" }, { action: "contact-channel-opened" }],
        },
        createdAt: "2026-09-22T00:00:00.000Z",
      },
    ],
    activationHistory: [
      {
        versionId: OWNER_ANALYTICS_VERSION_ID as StableId<"AnalyticsGoalVersion">,
        activatedAt: "2026-09-22T00:00:00.000Z",
      },
    ],
  };
}

function invalidAggregateView(goalId: StableId<"AnalyticsGoal">): AnalyticsGoalAggregateView {
  return {
    goalId: "not-a-uuid" as unknown as StableId<"AnalyticsGoal">,
    aggregateVersion: -1,
    activeVersionId: goalId as unknown as StableId<"AnalyticsGoalVersion">,
    versions: [
      {
        versionId: goalId as unknown as StableId<"AnalyticsGoalVersion">,
        versionNumber: -1,
        definition: { name: "", steps: [] },
        createdAt: "not-a-datetime",
      },
    ],
    activationHistory: [],
  };
}

function versionReceipt(goalId: string, versionId: string): AnalyticsGoalVersionReceipt {
  return {
    goalId: goalId as StableId<"AnalyticsGoal">,
    versionId: versionId as StableId<"AnalyticsGoalVersion">,
    aggregateVersion: 3,
    outcome: "analytics-goal-version-created",
  };
}

function activationReceipt(goalId: string): AnalyticsGoalActivationReceipt {
  return {
    aggregateId: goalId as StableId<"AnalyticsGoal">,
    aggregateVersion: 3,
    outcome: "analytics-goal-version-activated",
  };
}

function invalidVersionReceipt(): AnalyticsGoalVersionReceipt {
  return {
    goalId: "not-a-uuid" as unknown as StableId<"AnalyticsGoal">,
    versionId: "not-a-uuid" as unknown as StableId<"AnalyticsGoalVersion">,
    aggregateVersion: -1,
    outcome: "analytics-goal-version-created",
  };
}

function invalidActivationReceipt(): AnalyticsGoalActivationReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<"AnalyticsGoal">,
    aggregateVersion: -1,
    outcome: "analytics-goal-version-activated",
  };
}

export function createOwnerAnalyticsTestFake(mode: OwnerAnalyticsFakeMode): OwnerAnalyticsTestFake {
  const getCalls: GetOwnerAnalyticsGoalQuery[] = [];
  const createCalls: CreateOwnerAnalyticsGoalVersionApplicationCommand[] = [];
  const activateCalls: ActivateOwnerAnalyticsGoalVersionApplicationCommand[] = [];
  return {
    get calls() {
      return {
        getOwnerAnalyticsGoal: getCalls,
        createOwnerAnalyticsGoalVersion: createCalls,
        activateOwnerAnalyticsGoalVersion: activateCalls,
      };
    },
    async getOwnerAnalyticsGoal(query: GetOwnerAnalyticsGoalQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: aggregateView(query.goalId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidAggregateView(query.goalId) };
      }
    },
    async createOwnerAnalyticsGoalVersion(command: CreateOwnerAnalyticsGoalVersionApplicationCommand) {
      createCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: versionReceipt(command.goalId, OWNER_ANALYTICS_VERSION_ID),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidVersionReceipt() };
      }
    },
    async activateOwnerAnalyticsGoalVersion(command: ActivateOwnerAnalyticsGoalVersionApplicationCommand) {
      activateCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: activationReceipt(command.goalId),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidActivationReceipt() };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the three Owner Analytics operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerAnalyticsService(): OwnerAnalyticsApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async getOwnerAnalyticsGoal(_query: GetOwnerAnalyticsGoalQuery) {
      return failure;
    },
    async createOwnerAnalyticsGoalVersion(_command: CreateOwnerAnalyticsGoalVersionApplicationCommand) {
      return failure;
    },
    async activateOwnerAnalyticsGoalVersion(_command: ActivateOwnerAnalyticsGoalVersionApplicationCommand) {
      return failure;
    },
  };
}
