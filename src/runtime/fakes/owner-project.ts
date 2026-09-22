/**
 * fakes/owner-project.ts — Phase 2 #29 deterministic Owner Project fakes.
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
  AssignOwnerProjectTaxonomyValueApplicationCommand,
  ChangeOwnerProjectPublicSlugApplicationCommand,
  ChangeOwnerProjectStatusApplicationCommand,
  GetOwnerProjectAggregateQuery,
  OwnerProjectAggregateView,
  OwnerProjectApplicationService,
  OwnerProjectCommandReceipt,
  RelateOwnerProjectsApplicationCommand,
  SetOwnerProjectFeaturedApplicationCommand,
} from "../http/owner-project.js";

export type OwnerProjectFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerProjectTestFake extends OwnerProjectApplicationService {
  readonly calls: {
    readonly getOwnerProjectAggregate: ReadonlyArray<GetOwnerProjectAggregateQuery>;
    readonly changeOwnerProjectStatus: ReadonlyArray<ChangeOwnerProjectStatusApplicationCommand>;
    readonly setOwnerProjectFeatured: ReadonlyArray<SetOwnerProjectFeaturedApplicationCommand>;
    readonly changeOwnerProjectPublicSlug: ReadonlyArray<ChangeOwnerProjectPublicSlugApplicationCommand>;
    readonly relateOwnerProjects: ReadonlyArray<RelateOwnerProjectsApplicationCommand>;
    readonly assignOwnerProjectTaxonomyValue: ReadonlyArray<AssignOwnerProjectTaxonomyValueApplicationCommand>;
  };
}

function receipt(
  aggregateId: string,
  aggregateVersion: number,
  outcome: OwnerProjectCommandReceipt["outcome"],
): OwnerProjectCommandReceipt {
  return {
    aggregateId: aggregateId as StableId<string>,
    aggregateVersion,
    outcome,
  };
}

function invalidReceipt(): OwnerProjectCommandReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "project-status-changed",
  };
}

function aggregateView(projectId: StableId<"Project">): OwnerProjectAggregateView {
  return {
    projectId,
    aggregateVersion: 1,
    statusValueId: null,
    featured: false,
    publicRoute: null,
    relatedProjectIds: [],
    taxonomyAssignments: [],
  };
}

function invalidAggregateView(projectId: StableId<"Project">): OwnerProjectAggregateView {
  return {
    projectId: "not-a-uuid" as unknown as StableId<"Project">,
    aggregateVersion: -1,
    statusValueId: null,
    featured: false,
    publicRoute: null,
    relatedProjectIds: [projectId],
    taxonomyAssignments: [],
  };
}

export function createOwnerProjectTestFake(mode: OwnerProjectFakeMode): OwnerProjectTestFake {
  const getCalls: GetOwnerProjectAggregateQuery[] = [];
  const statusCalls: ChangeOwnerProjectStatusApplicationCommand[] = [];
  const featuredCalls: SetOwnerProjectFeaturedApplicationCommand[] = [];
  const slugCalls: ChangeOwnerProjectPublicSlugApplicationCommand[] = [];
  const relateCalls: RelateOwnerProjectsApplicationCommand[] = [];
  const assignCalls: AssignOwnerProjectTaxonomyValueApplicationCommand[] = [];
  return {
    get calls() {
      return {
        getOwnerProjectAggregate: getCalls,
        changeOwnerProjectStatus: statusCalls,
        setOwnerProjectFeatured: featuredCalls,
        changeOwnerProjectPublicSlug: slugCalls,
        relateOwnerProjects: relateCalls,
        assignOwnerProjectTaxonomyValue: assignCalls,
      };
    },
    async getOwnerProjectAggregate(query: GetOwnerProjectAggregateQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: aggregateView(query.projectId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidAggregateView(query.projectId) };
      }
    },
    async changeOwnerProjectStatus(command: ChangeOwnerProjectStatusApplicationCommand) {
      statusCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.projectId, command.expectedVersion + 1, "project-status-changed"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async setOwnerProjectFeatured(command: SetOwnerProjectFeaturedApplicationCommand) {
      featuredCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.projectId, command.expectedVersion + 1, "project-featured-changed"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async changeOwnerProjectPublicSlug(
      command: ChangeOwnerProjectPublicSlugApplicationCommand,
    ) {
      slugCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.projectId, command.expectedVersion + 1, "public-slug-changed"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async relateOwnerProjects(command: RelateOwnerProjectsApplicationCommand) {
      relateCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.projectId, command.expectedVersion + 1, "project-related"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async assignOwnerProjectTaxonomyValue(
      command: AssignOwnerProjectTaxonomyValueApplicationCommand,
    ) {
      assignCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.projectId, command.expectedVersion + 1, "taxonomy-value-assigned"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the six Owner Project operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerProjectService(): OwnerProjectApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async getOwnerProjectAggregate(_query: GetOwnerProjectAggregateQuery) {
      return failure;
    },
    async changeOwnerProjectStatus(_command: ChangeOwnerProjectStatusApplicationCommand) {
      return failure;
    },
    async setOwnerProjectFeatured(_command: SetOwnerProjectFeaturedApplicationCommand) {
      return failure;
    },
    async changeOwnerProjectPublicSlug(
      _command: ChangeOwnerProjectPublicSlugApplicationCommand,
    ) {
      return failure;
    },
    async relateOwnerProjects(_command: RelateOwnerProjectsApplicationCommand) {
      return failure;
    },
    async assignOwnerProjectTaxonomyValue(
      _command: AssignOwnerProjectTaxonomyValueApplicationCommand,
    ) {
      return failure;
    },
  };
}
