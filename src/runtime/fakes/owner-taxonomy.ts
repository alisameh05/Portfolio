/**
 * fakes/owner-taxonomy.ts — Phase 2 #30 deterministic Owner Taxonomy fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real Taxonomy evolution, persistence, and authorization behavior
 * remain later-phase work.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import type {
  CreateOwnerTaxonomyValueApplicationCommand,
  GetOwnerTaxonomyAggregateQuery,
  MergeOwnerTaxonomyValueApplicationCommand,
  OwnerTaxonomyAggregateView,
  OwnerTaxonomyApplicationService,
  OwnerTaxonomyCommandReceipt,
  RenameOwnerTaxonomyValueApplicationCommand,
  RetireOwnerTaxonomyValueApplicationCommand,
} from "../http/owner-taxonomy.js";

export type OwnerTaxonomyFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerTaxonomyTestFake extends OwnerTaxonomyApplicationService {
  readonly calls: {
    readonly getOwnerTaxonomyAggregate: ReadonlyArray<GetOwnerTaxonomyAggregateQuery>;
    readonly createOwnerTaxonomyValue: ReadonlyArray<CreateOwnerTaxonomyValueApplicationCommand>;
    readonly renameOwnerTaxonomyValue: ReadonlyArray<RenameOwnerTaxonomyValueApplicationCommand>;
    readonly retireOwnerTaxonomyValue: ReadonlyArray<RetireOwnerTaxonomyValueApplicationCommand>;
    readonly mergeOwnerTaxonomyValue: ReadonlyArray<MergeOwnerTaxonomyValueApplicationCommand>;
  };
}

const VALUE_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7eb1";

function aggregateView(taxonomyId: StableId<string>): OwnerTaxonomyAggregateView {
  return {
    taxonomyId,
    aggregateVersion: 1,
    kind: "technology",
    values: [{ valueId: VALUE_ID as StableId<string>, name: "TypeScript", state: "active" }],
  };
}

function invalidAggregateView(taxonomyId: StableId<string>): OwnerTaxonomyAggregateView {
  return {
    taxonomyId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    kind: "technology",
    values: [{ valueId: taxonomyId, name: "TypeScript", state: "active" }],
  };
}

function receipt(
  aggregateId: string,
  aggregateVersion: number,
  outcome: OwnerTaxonomyCommandReceipt["outcome"],
): OwnerTaxonomyCommandReceipt {
  return {
    aggregateId: aggregateId as StableId<string>,
    aggregateVersion,
    outcome,
  };
}

function invalidReceipt(): OwnerTaxonomyCommandReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "taxonomy-value-created",
  };
}

export function createOwnerTaxonomyTestFake(mode: OwnerTaxonomyFakeMode): OwnerTaxonomyTestFake {
  const getCalls: GetOwnerTaxonomyAggregateQuery[] = [];
  const createCalls: CreateOwnerTaxonomyValueApplicationCommand[] = [];
  const renameCalls: RenameOwnerTaxonomyValueApplicationCommand[] = [];
  const retireCalls: RetireOwnerTaxonomyValueApplicationCommand[] = [];
  const mergeCalls: MergeOwnerTaxonomyValueApplicationCommand[] = [];
  return {
    get calls() {
      return {
        getOwnerTaxonomyAggregate: getCalls,
        createOwnerTaxonomyValue: createCalls,
        renameOwnerTaxonomyValue: renameCalls,
        retireOwnerTaxonomyValue: retireCalls,
        mergeOwnerTaxonomyValue: mergeCalls,
      };
    },
    async getOwnerTaxonomyAggregate(query: GetOwnerTaxonomyAggregateQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: aggregateView(query.taxonomyId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidAggregateView(query.taxonomyId) };
      }
    },
    async createOwnerTaxonomyValue(command: CreateOwnerTaxonomyValueApplicationCommand) {
      createCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.taxonomyId, command.expectedVersion + 1, "taxonomy-value-created"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async renameOwnerTaxonomyValue(command: RenameOwnerTaxonomyValueApplicationCommand) {
      renameCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.valueId, command.expectedVersion + 1, "taxonomy-value-renamed"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async retireOwnerTaxonomyValue(command: RetireOwnerTaxonomyValueApplicationCommand) {
      retireCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.valueId, command.expectedVersion + 1, "taxonomy-value-retired"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async mergeOwnerTaxonomyValue(command: MergeOwnerTaxonomyValueApplicationCommand) {
      mergeCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: receipt(command.valueId, command.expectedVersion + 1, "taxonomy-value-merged"),
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
 * Production Phase 2 composition for the five Owner Taxonomy operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerTaxonomyService(): OwnerTaxonomyApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async getOwnerTaxonomyAggregate(_query: GetOwnerTaxonomyAggregateQuery) {
      return failure;
    },
    async createOwnerTaxonomyValue(_command: CreateOwnerTaxonomyValueApplicationCommand) {
      return failure;
    },
    async renameOwnerTaxonomyValue(_command: RenameOwnerTaxonomyValueApplicationCommand) {
      return failure;
    },
    async retireOwnerTaxonomyValue(_command: RetireOwnerTaxonomyValueApplicationCommand) {
      return failure;
    },
    async mergeOwnerTaxonomyValue(_command: MergeOwnerTaxonomyValueApplicationCommand) {
      return failure;
    },
  };
}
