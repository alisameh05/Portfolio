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
      const base = await fallback.getOwnerProjectAggregate(query);
      if (!base.ok) return base;
      const aggregate = await content.getOwnerContentAggregate({ actor: query.actor, contentId: query.projectId });
      if (!aggregate.ok) return aggregate;
      const route = aggregate.value.publicRoute;
      return { ok: true, value: {
        ...base.value,
        publicRoute: route === null ? null : {
          identity: route.identity,
          canonicalSlug: route.canonicalSlug,
          redirects: route.redirects,
        },
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
