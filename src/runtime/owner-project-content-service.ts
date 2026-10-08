import type { ContentAuthoringService } from "../modules/content-publishing/application/authoring.js";
import type { Result, Rejection } from "../shared/domain/index.js";
import type {
  OwnerProjectApplicationService,
  OwnerProjectCommandReceipt,
} from "./http/owner-project.js";
import { createProductionOwnerProjectService } from "./fakes/owner-project.js";

/** Activates route operations from the Content module while preserving fail-closed behavior for later Project operations. */
export function createContentBackedOwnerProjectService(
  content: ContentAuthoringService,
  fallback: OwnerProjectApplicationService = createProductionOwnerProjectService(),
): OwnerProjectApplicationService {
  return {
    ...fallback,
    async getOwnerProjectAggregate(query) {
      const result = await content.getOwnerProjectRelationships({ actor: query.actor, projectId: query.projectId });
      if (!result.ok) return result;
      return { ok: true, value: {
        projectId: result.value.projectId,
        aggregateVersion: result.value.aggregateVersion,
        statusValueId: null,
        featured: false,
        publicRoute: result.value.publicRoute === null ? null : {
          identity: result.value.publicRoute.identity,
          canonicalSlug: result.value.publicRoute.canonicalSlug,
          redirects: result.value.publicRoute.redirects,
        },
        relatedProjectIds: result.value.relatedProjectIds,
        taxonomyAssignments: [],
      } };
    },
    async changeOwnerProjectPublicSlug(command) {
      const result = await content.changePublicSlug({
        actor: command.actor, projectId: command.projectId, newSlug: command.slug,
        expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey,
        correlationId: command.correlationId,
      });
      return mapRouteReceipt(result);
    },
    async correctOwnerProjectCandidateSlug(command) {
      const result = await content.correctCandidateSlug({
        actor: command.actor, projectId: command.projectId, candidateSlug: command.candidateSlug,
        expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey,
        correlationId: command.correlationId,
      });
      return mapRouteReceipt(result);
    },
    async relateOwnerProjects(command) {
      const result = await content.relateProjects({
        actor: command.actor,
        projectId: command.projectId,
        relatedProjectId: command.relatedProjectId,
        expectedVersion: command.expectedVersion,
        idempotencyKey: command.idempotencyKey,
        correlationId: command.correlationId,
      });
      if (!result.ok) return result;
      return { ok: true, value: {
        aggregateId: result.value.aggregateId,
        aggregateVersion: result.value.aggregateVersion,
        relatedProjectAggregateVersion: result.value.relatedProjectAggregateVersion,
        outcome: result.value.outcome,
      } };
    },
  };
}

function mapRouteReceipt(
  result: Result<{ readonly aggregateId: string; readonly aggregateVersion: number; readonly outcome: string }, Rejection>,
): Result<OwnerProjectCommandReceipt, Rejection> {
  if (!result.ok) return result;
  if (result.value.outcome !== "public-slug-changed" && result.value.outcome !== "candidate-slug-corrected") {
    return { ok: false, error: { kind: "temporarily_unavailable", code: "INVALID_ROUTE_RECEIPT" } };
  }
  return { ok: true, value: {
    aggregateId: result.value.aggregateId as OwnerProjectCommandReceipt["aggregateId"],
    aggregateVersion: result.value.aggregateVersion,
    outcome: result.value.outcome,
  } };
}
