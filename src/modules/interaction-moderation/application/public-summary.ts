import { parseStableId, type StableId, type Result, type Rejection } from "@shared/domain";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import type { ProjectInteractionEligibilityPort } from "../../content-publishing/index.js";
import type { ProjectAggregate } from "../domain/index.js";
import type { InteractionModerationService } from "./service.js";

/** One statement snapshot of current votes and exact-locale approved Feedback. */
export interface InteractionSummaryRepositoryPort {
  read(input: { portfolioId: StableId<"Portfolio">; projectId: StableId<"Project">; locale: "en" | "ar" },
    transaction: TransactionContext): Promise<Omit<ProjectAggregate, "projectId" | "ratingState">>;
}

export function createProjectInteractionSummaryService(deps: {
  readonly portfolioId: StableId<"Portfolio">;
  readonly content: ProjectInteractionEligibilityPort;
  readonly transactions: TransactionRunner;
  readonly repository: InteractionSummaryRepositoryPort;
}): Pick<InteractionModerationService, "getProjectAggregate"> {
  const missing = (): Result<never, Rejection> => ({ ok: false, error: { kind: "not_found", code: "PROJECT_UNAVAILABLE" } });
  return {
    async getProjectAggregate(query): Promise<Result<ProjectAggregate, Rejection>> {
      if (query.scope.kind !== "portfolio" || query.scope.portfolioId !== deps.portfolioId || query.portfolioId !== deps.portfolioId) return missing();
      if (!parseStableId("Project", query.projectId).ok || !["en", "ar"].includes(query.locale)) {
        return { ok: false, error: { kind: "validation", code: "INTERACTION_SUMMARY_QUERY_INVALID" } };
      }
      try {
        return await deps.transactions.run(async tx => {
          // Content-before-Interaction, shared with mutations, lifecycle and publication.
          const facts = await deps.content.getProjectInteractionFacts({ portfolioId: deps.portfolioId, projectId: query.projectId }, tx);
          if (!facts.ok) return facts;
          if (facts.value.portfolioId !== deps.portfolioId || facts.value.projectId !== query.projectId ||
              facts.value.lifecycle !== "published" || !facts.value.publishedLocales.includes(query.locale)) return missing();
          const row = await deps.repository.read({ portfolioId: deps.portfolioId, projectId: query.projectId, locale: query.locale }, tx);
          const counts = { projectId: query.projectId, likesCount: row.likesCount, dislikesCount: row.dislikesCount,
            ratingCount: row.ratingCount, approvedFeedbackCount: row.approvedFeedbackCount, asOf: row.asOf };
          if (row.ratingCount < 5) return { ok: true, value: { ...counts, ratingState: row.ratingCount === 0 ? "no-data" : "low-sample" } };
          if (typeof row.averageRating !== "number" || !Number.isFinite(row.averageRating) || row.averageRating < 1 || row.averageRating > 5) throw new Error("SUMMARY_INVALID");
          return { ok: true, value: { ...counts, ratingState: "available", averageRating: row.averageRating } };
        });
      } catch { return { ok: false, error: { kind: "temporarily_unavailable", code: "INTERACTION_SUMMARY_UNAVAILABLE" } }; }
    },
  };
}
