import type { ContentAuthoringService } from "../modules/content-publishing/application/authoring.js";
import type { Result, Rejection } from "../shared/domain/index.js";
import { createProductionOwnerProjectService } from "./fakes/owner-project.js";
import type {
  OwnerProjectApplicationService,
  OwnerProjectCommandReceipt,
} from "./http/owner-project.js";

/** Activates the completed status/Featured slice while other Project commands stay fail closed. */
export function createContentOwnerProjectService(content: ContentAuthoringService): OwnerProjectApplicationService {
  const laterProjectOperations = createProductionOwnerProjectService();
  return {
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
    async changeOwnerProjectPublicSlug(command) { return await laterProjectOperations.changeOwnerProjectPublicSlug(command); },
    async relateOwnerProjects(command) { return await laterProjectOperations.relateOwnerProjects(command); },
    async assignOwnerProjectTaxonomyValue(command) { return await laterProjectOperations.assignOwnerProjectTaxonomyValue(command); },
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
