import type { ContentAuthoringService } from "../modules/content-publishing/application/authoring.js";
import type { Result, Rejection } from "../shared/domain/index.js";
import { createProductionOwnerProjectService } from "./fakes/owner-project.js";
import { createCorrelation } from "./ports.js";
import type {
  OwnerProjectApplicationService,
  OwnerProjectCommandReceipt,
} from "./http/owner-project.js";

/** Activates the completed status/Featured slice while other Project commands stay fail closed. */
export function createContentOwnerProjectService(
  content: ContentAuthoringService,
  fallback: OwnerProjectApplicationService = createProductionOwnerProjectService(),
): OwnerProjectApplicationService {
  return {
    ...fallback,
    async getOwnerProjectAggregate(query) {
      const result = await content.getProjectOwnerView(query);
      if (!result.ok) return result;
      return { ok: true, value: {
        projectId: result.value.projectId,
        aggregateVersion: result.value.aggregateVersion,
        statusValueId: result.value.statusValueId,
        featured: result.value.featured,
        publicRoute: result.value.publicRoute,
        relatedProjectIds: result.value.relatedProjectIds,
        relationshipHistory: result.value.relationshipHistory,
        statusHistory: result.value.statusHistory,
        taxonomyAssignments: result.value.taxonomyAssignments,
      } };
    },
    async changeOwnerProjectStatus(command) {
      const result = await content.changeProjectStatus({ ...command, statusValueId: command.statusValueId as never });
      return mapProjectReceipt(result);
    },
    async setOwnerProjectFeatured(command) {
      const result = await content.setProjectFeatured(command);
      return mapProjectReceipt(result);
    },
    async assignOwnerProjectTaxonomyValue(command) {
      const result = await content.assignProjectTaxonomyValue({
        actor: command.actor,
        projectId: command.projectId,
        valueId: command.valueId as never,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        correlationId: createCorrelation().traceId,
      });
      return mapProjectReceipt(result);
    },
  };
}

function mapProjectReceipt(result: Result<import("../modules/content-publishing/application/service.js").ProjectCommandReceipt, Rejection>): Result<OwnerProjectCommandReceipt, Rejection> {
  if (!result.ok) return result;
  return { ok: true, value: {
    aggregateId: result.value.projectId,
    aggregateVersion: result.value.aggregateVersion,
    outcome: result.value.outcome as OwnerProjectCommandReceipt["outcome"],
  } };
}
