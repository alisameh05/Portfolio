import type { Result, Rejection, StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import type { ContentKind, PublicLifecycle, SupportedLocale } from "../domain/index.js";
export interface ProjectInteractionFacts {
 readonly projectId: StableId<"Project">;
 readonly portfolioId: StableId<"Portfolio">;
 readonly lifecycle: PublicLifecycle;
 readonly publishedLocales: readonly SupportedLocale[];
}
/** Read/lock Content before owned Interaction records in the same transaction. No inverse Media lock. */
export interface ProjectInteractionEligibilityPort {
 getProjectInteractionFacts(input: { readonly portfolioId: StableId<"Portfolio">; readonly projectId: StableId<"Project"> }, transaction: TransactionContext): Promise<Result<ProjectInteractionFacts, Rejection>>;
}
export interface ContentMeasurementPublicFactsPort {
 getRouteFacts(input: { readonly portfolioId: StableId<"Portfolio">; readonly routeId: StableId<"PublicRoute">; readonly locale: SupportedLocale }, transaction: TransactionContext): Promise<Result<{ readonly routeId: StableId<"PublicRoute">; readonly projectId: StableId<"Project"> | null; readonly contentType: ContentKind; readonly published: boolean }, Rejection>>;
 /** Historical journey/goal references validate identity without returning private content. */
 hasRetainedPublicRoute(input: { readonly portfolioId: StableId<"Portfolio">; readonly routeId: StableId<"PublicRoute"> }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
 /** Current curated relationship and both endpoints must be public in the requested locale. */
 getRelatedProjectFact(input: { readonly portfolioId: StableId<"Portfolio">; readonly sourceProjectId: StableId<"Project">; readonly targetProjectId: StableId<"Project">; readonly locale: SupportedLocale }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
 /** Current public Testimonial and exact profile/Project association in the requested locale. */
 getTestimonialFact(input: { readonly portfolioId: StableId<"Portfolio">; readonly testimonialId: StableId<"Testimonial">; readonly projectId?: StableId<"Project">; readonly locale: SupportedLocale }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
 /** Validates an action category against the current published External link for this Project and locale. */
 getExternalProjectLinkFact(input: { readonly portfolioId: StableId<"Portfolio">; readonly projectId: StableId<"Project">; readonly destination: "github-repository" | "live-demo"; readonly locale: SupportedLocale }, transaction: TransactionContext): Promise<Result<boolean, Rejection>>;
}
