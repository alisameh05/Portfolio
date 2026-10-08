import type { TaxonomyOwnerService } from "../modules/taxonomy-discovery/index.js";
import type { OwnerTaxonomyApplicationService, OwnerTaxonomyAggregateView, OwnerTaxonomyCommandReceipt } from "./http/owner-taxonomy.js";
import type { Result, Rejection } from "../shared/domain/index.js";
import { createProductionOwnerTaxonomyService } from "./fakes/owner-taxonomy.js";

export function createContentBackedOwnerTaxonomyService(
  taxonomy: TaxonomyOwnerService,
  fallback: OwnerTaxonomyApplicationService = createProductionOwnerTaxonomyService(),
): OwnerTaxonomyApplicationService {
  return {
    ...fallback,
    async getOwnerTaxonomyAggregate(query) {
      const result = await taxonomy.getOwnerTaxonomy({ actor: query.actor, taxonomyId: query.taxonomyId as never });
      if (!result.ok) return result;
      return { ok: true, value: result.value as unknown as OwnerTaxonomyAggregateView };
    },
    async createOwnerTaxonomyValue(command) {
      const result = await taxonomy.createOwnerTaxonomyValue(command as never);
      return mapReceipt(result);
    },
    async renameOwnerTaxonomyValue(command) {
      const result = await taxonomy.renameOwnerTaxonomyValue(command as never);
      return mapReceipt(result);
    },
    async retireOwnerTaxonomyValue(command) {
      const result = await taxonomy.retireOwnerTaxonomyValue(command as never);
      return mapReceipt(result);
    },
  };
}

function mapReceipt(result: Result<OwnerTaxonomyCommandReceiptShape, Rejection>): Result<OwnerTaxonomyCommandReceipt, Rejection> {
  if (!result.ok) return result;
  return { ok: true, value: {
    aggregateId: result.value.aggregateId,
    aggregateVersion: result.value.aggregateVersion,
    outcome: result.value.outcome,
  } };
}

interface OwnerTaxonomyCommandReceiptShape {
  readonly aggregateId: OwnerTaxonomyCommandReceipt["aggregateId"];
  readonly aggregateVersion: number;
  readonly outcome: "taxonomy-value-created" | "taxonomy-value-renamed" | "taxonomy-value-retired";
}
