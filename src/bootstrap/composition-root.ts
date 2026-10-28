/**
 * composition-root.ts — Phase 2 #25 single runtime assembly point.
 *
 * This is the only place that assembles runtime configuration and
 * dependencies. Route Handlers obtain what they need from here (or, for
 * operational probes like /livez, from nothing at all) and never construct
 * providers or application services themselves.
 *
 * Configuration is parsed once when `initializeRuntime` is called — never on
 * module import — and consumers receive the frozen value via
 * `getRuntimeConfig` instead of reading the ambient environment.
 */

import {
  getLifecycleCoordinator,
  resetLifecycleForTests,
} from "../runtime/lifecycle.js";
import {
  createRuntimeConfig,
  type DatabaseRuntimeKind,
  type RuntimeConfig,
  type RuntimeConfigEnv,
} from "./configuration.js";
import { RuntimeConfigError } from "./configuration.js";
import type { OperationsPersistencePorts } from "../modules/portability-operations/application/index.js";
import type { OwnerExportApplicationService } from "../modules/portability-operations/index.js";
import type { OwnerConfigurationApplicationService } from "../runtime/http/owner-configuration.js";
import type { ContentAuthoringService } from "../modules/content-publishing/application/authoring.js";
import type { MediaAcceptancePort } from "../modules/content-publishing/application/service.js";
import type { OwnerProjectApplicationService } from "../runtime/http/owner-project.js";
import type { OwnerTaxonomyApplicationService } from "../runtime/http/owner-taxonomy.js";
import type { OwnerPublicationApplicationService } from "../runtime/http/owner-publication.js";
import type { PublicDiscoveryService } from "../modules/taxonomy-discovery/application/index.js";
import type { LifecycleResource, ReadinessCheck } from "../runtime/ports.js";
import { createSystemClock, createSystemIdGenerator } from "../runtime/ports.js";
import { parseStableId, type StableId } from "../shared/domain/index.js";
import type { OwnerMediaApplicationService } from "../modules/media/index.js";
import type { MediaDeliveryApplicationService } from "../modules/media/index.js";
import type { CurrentCvDeliveryService, OwnerCvApplicationService } from "../modules/cv-portfolio/index.js";
import type { PortfolioSettingsApplicationService } from "../modules/portfolio-configuration/index.js";
import type { ConsentApplicationService, MeasurementMediaPublicFactsPort, MeasurementService, OwnerAnalyticsApplicationService } from "../modules/measurement/index.js";
import type { InteractionModerationService, FunctionalInteractionContextPort } from "../modules/interaction-moderation/index.js";
import { createPhase7DueWorkWorker } from "./phase7-due-work-worker.js";

export interface ReactionRuntimeServices {
  readonly scope: { readonly kind: "portfolio"; readonly portfolioId: StableId<"Portfolio"> };
  readonly service: Pick<InteractionModerationService, "submitReaction">;
  readonly functionalIdentity: FunctionalInteractionContextPort;
}

export interface FeedbackRuntimeServices {
  readonly scope: ReactionRuntimeServices["scope"];
  readonly service: Pick<InteractionModerationService, "submitFeedback">;
  readonly rateLimit: import("../runtime/http/current-cv-rate-limit.js").CurrentCvRateLimitCheck;
}

export interface RatingRuntimeServices {
  readonly scope: ReactionRuntimeServices["scope"];
  readonly service: Pick<InteractionModerationService, "submitRating">;
  readonly functionalIdentity: FunctionalInteractionContextPort;
}

export interface MeasurementEventRuntimeServices {
  readonly scope: { readonly kind: "portfolio"; readonly portfolioId: StableId<"Portfolio"> };
  readonly service: Pick<MeasurementService, "ingestEvent">;
}

export type { RuntimeConfig } from "./configuration.js";

let current: RuntimeConfig | undefined;
let currentOperations: OperationsPersistencePorts | undefined;
let currentOwnerExport: OwnerExportApplicationService | undefined;
let currentOwnerExportAssembly: ReturnType<typeof import("../modules/portability-operations/application/owner-export-assembly.js").createOwnerExportAssemblyService> | undefined;
let currentOwnerConfiguration: OwnerConfigurationApplicationService | undefined;
let currentContentAuthoring: ContentAuthoringService | undefined;
let currentOwnerTaxonomy: OwnerTaxonomyApplicationService | undefined;
let currentPublicDiscovery: PublicDiscoveryService | undefined;
let currentOwnerMedia: OwnerMediaApplicationService | undefined;
let currentMediaDelivery: MediaDeliveryApplicationService | undefined;
let currentOwnerCv: OwnerCvApplicationService | undefined;
let currentCurrentCv: CurrentCvDeliveryService | undefined;
let currentPublicConfiguration: PortfolioSettingsApplicationService | undefined;
let currentConsent: ConsentApplicationService | undefined;
let currentEventIngestion: MeasurementEventRuntimeServices | undefined;
let currentReaction: ReactionRuntimeServices | undefined;
let currentRating: RatingRuntimeServices | undefined;
let currentFeedback: FeedbackRuntimeServices | undefined;
let currentInteractionSummary: Pick<InteractionModerationService, "getProjectAggregate"> | undefined;
let currentModeration: (import("../modules/interaction-moderation/index.js").OwnerModerationApplicationService & Pick<InteractionModerationService, "getApprovedFeedback">) | undefined;
let currentOwnerAnalytics: OwnerAnalyticsApplicationService | undefined;
let currentOwnerAnalyticsScope: ReactionRuntimeServices["scope"] | undefined;
let currentOwnerAggregateReport: Pick<MeasurementService, "getAggregateReport"> | undefined;
let currentPhase7PortfolioId: StableId<"Portfolio"> | undefined;

function phase7RuntimeUnavailable() {
  return {
    ok: false as const,
    error: { kind: "temporarily_unavailable" as const, code: "PHASE7_RUNTIME_NOT_CONFIGURED" },
  };
}

const unavailableReactionService: Pick<InteractionModerationService, "submitReaction"> = {
  async submitReaction() { return phase7RuntimeUnavailable(); },
};
const unavailableRatingService: Pick<InteractionModerationService, "submitRating"> = {
  async submitRating() { return phase7RuntimeUnavailable(); },
};
const unavailableFeedbackService: Pick<InteractionModerationService, "submitFeedback"> = {
  async submitFeedback() { return phase7RuntimeUnavailable(); },
};
const unavailableModerationService: import("../modules/interaction-moderation/index.js").OwnerModerationApplicationService = {
  async getOwnerFeedbackModeration() { return phase7RuntimeUnavailable(); },
  async approveOwnerFeedback() { return phase7RuntimeUnavailable(); },
  async rejectOwnerFeedback() { return phase7RuntimeUnavailable(); },
  async suppressOwnerFeedback() { return phase7RuntimeUnavailable(); },
};
const unavailableOwnerAnalyticsService: OwnerAnalyticsApplicationService = {
  async getOwnerAnalyticsGoal() { return phase7RuntimeUnavailable(); },
  async createOwnerAnalyticsGoalVersion() { return phase7RuntimeUnavailable(); },
  async activateOwnerAnalyticsGoalVersion() { return phase7RuntimeUnavailable(); },
};

export function initializeRuntime(env: RuntimeConfigEnv): RuntimeConfig {
  try {
    const config = createRuntimeConfig(env);
    current = config;
    getLifecycleCoordinator().markReady();
    return config;
  } catch (error) {
    getLifecycleCoordinator().markFailed();
    throw error;
  }
}

/** Default bootstrap seam: forwards the ambient environment exactly once. */
export function initializeRuntimeFromEnvironment(): RuntimeConfig {
  return initializeRuntime({ ...(process.env as RuntimeConfigEnv) });
}

export interface DatabaseRuntimeState extends RuntimeConfig {
  readonly runtimeKind: DatabaseRuntimeKind;
}

export interface DatabaseRuntimeDependencies {
  readonly reaction?: ReactionRuntimeServices;
  readonly rating?: RatingRuntimeServices;
  readonly feedback?: FeedbackRuntimeServices;
  readonly moderation?: NonNullable<typeof currentModeration>;
  readonly ownerAnalytics?: OwnerAnalyticsApplicationService;
  readonly ownerAggregateReport?: Pick<MeasurementService, "getAggregateReport">;
  readonly interactionSummary?: NonNullable<typeof currentInteractionSummary>;
  readonly consent?: ConsentApplicationService;
  readonly eventIngestion?: MeasurementEventRuntimeServices;
  readonly operations: OperationsPersistencePorts;
  readonly ownerExport?: OwnerExportApplicationService;
  readonly ownerExportAssembly?: ReturnType<typeof import("../modules/portability-operations/application/owner-export-assembly.js").createOwnerExportAssemblyService>;
  readonly ownerConfiguration?: OwnerConfigurationApplicationService;
  readonly contentAuthoring?: ContentAuthoringService;
  readonly ownerTaxonomy?: OwnerTaxonomyApplicationService;
  readonly publicDiscovery?: PublicDiscoveryService;
  readonly ownerMedia?: OwnerMediaApplicationService;
  readonly mediaDelivery?: MediaDeliveryApplicationService;
  readonly ownerCv?: OwnerCvApplicationService;
  readonly currentCv?: CurrentCvDeliveryService;
  readonly publicConfiguration?: PortfolioSettingsApplicationService;
  readonly resource: LifecycleResource;
  readonly readiness: ReadinessCheck;
}

/**
 * Provider-neutral services used by the Phase 5 Owner transport adapters.
 * Handlers receive this bundle from the standard composition root so routes
 * cannot assemble repositories or bypass the configured transaction scope.
 */
export interface Phase5OwnerApplicationServices {
  readonly contentAuthoring: ContentAuthoringService;
  readonly publication: OwnerPublicationApplicationService;
  readonly project: OwnerProjectApplicationService;
  readonly taxonomy: OwnerTaxonomyApplicationService;
}

export type DatabaseRuntimeFactory = () =>
  | DatabaseRuntimeDependencies
  | Promise<DatabaseRuntimeDependencies>;

function parseDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === "") {
    throw new RuntimeConfigError("DATABASE_URL", "is required");
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
      throw new Error("scheme");
    }
  } catch {
    throw new RuntimeConfigError("DATABASE_URL", "must be a PostgreSQL URL");
  }
  return raw;
}

/** Worker Media exports use the configured private buckets, matching upload and processing adapters. */
export function createOwnerExportMediaObjectReader<T>(
  env: RuntimeConfigEnv,
  createStorage: (options: {
    readonly storageUrl: string;
    readonly serviceRoleKey: string;
    readonly candidateBucket?: string;
    readonly processedBucket?: string;
  }) => T,
): T | undefined {
  const storageUrl = env["SUPABASE_URL"];
  const serviceRoleKey = env["SUPABASE_SERVICE_ROLE_KEY"];
  if (!storageUrl || !serviceRoleKey) return undefined;
  return createStorage({
    storageUrl,
    serviceRoleKey,
    ...(env["MEDIA_CANDIDATE_BUCKET"] === undefined ? {} : { candidateBucket: env["MEDIA_CANDIDATE_BUCKET"] }),
    ...(env["MEDIA_PROCESSED_BUCKET"] === undefined ? {} : { processedBucket: env["MEDIA_PROCESSED_BUCKET"] }),
  });
}

/** Production database-enabled composition for application and worker processes. */
export async function initializeDatabaseRuntime(
  env: RuntimeConfigEnv,
  runtimeKind: DatabaseRuntimeKind,
  factory?: DatabaseRuntimeFactory,
): Promise<DatabaseRuntimeState> {
  const lifecycle = getLifecycleCoordinator();
  try {
    const config = createRuntimeConfig(env);
    const databaseUrl = parseDatabaseUrl(env["DATABASE_URL"]);
    const resolvedFactory =
      factory ??
      (async (): Promise<DatabaseRuntimeDependencies> => {
        const [{ createPostgresRuntimeDatabase }, { createPostgresOperationsPersistence }] =
          await Promise.all([
            import("../shared/adapters/postgres/runtime.js"),
            import("../modules/portability-operations/adapters/postgres-operations.js"),
          ]);
        const configuredScope = runtimeKind === "application"
          ? {
            portfolioId: parseStableId("Portfolio", env["PORTFOLIO_ID"] ?? ""),
            ownerId: parseStableId("Owner", env["OWNER_ID"] ?? ""),
          }
          : undefined;
        if (configuredScope !== undefined && !configuredScope.portfolioId.ok) {
          throw new RuntimeConfigError("PORTFOLIO_ID", "must be a configured UUIDv7 identity");
        }
        if (configuredScope !== undefined && !configuredScope.ownerId.ok) {
          throw new RuntimeConfigError("OWNER_ID", "must be a configured UUIDv7 identity");
        }
        const database = createPostgresRuntimeDatabase(databaseUrl);
        const operations = createPostgresOperationsPersistence(database.database);
        const [{ createPostgresOwnerExportStore }, { createOwnerExportService }, { createPostgresFeedbackOwnerExportSnapshotReader },
          { createPostgresOwnerMediaExportSnapshotReader }, { projectFeedbackOwnerExportSnapshot }, { matchesOwnerExportModerationFacts }] = await Promise.all([
          import("../modules/portability-operations/adapters/postgres-owner-export-store.js"),
          import("../modules/portability-operations/application/owner-export-service.js"),
          import("../modules/interaction-moderation/adapters/postgres-owner-export.js"),
          import("../modules/media/adapters/postgres-owner-export-snapshot.js"),
          import("../modules/interaction-moderation/application/owner-export.js"),
          import("../modules/portability-operations/application/owner-export-package.js"),
        ]);
        const moderationExportReader = createPostgresFeedbackOwnerExportSnapshotReader();
        const mediaExportReader = createPostgresOwnerMediaExportSnapshotReader({ database: database.database, transactions: operations.transactions });
        const ownerExportStore = createPostgresOwnerExportStore(database.database, {
          outbox: operations.outbox,
          transactions: database.transactions,
        });
        let ownerExportStorage: Awaited<ReturnType<typeof import("../runtime/adapters/supabase-owner-export-storage.js").createSupabaseOwnerExportStorage>> | undefined;
        if (env["SUPABASE_URL"] && env["SUPABASE_SERVICE_ROLE_KEY"]) {
          const { createSupabaseOwnerExportStorage } = await import("../runtime/adapters/supabase-owner-export-storage.js");
          ownerExportStorage = createSupabaseOwnerExportStorage({
            storageUrl: env["SUPABASE_URL"],
            serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"],
            ...(env["OWNER_EXPORTS_BUCKET"] === undefined ? {} : { bucket: env["OWNER_EXPORTS_BUCKET"] }),
          });
        }
        const unavailableOwnerExportStorage = {
          async deleteOwnerExport() {
            return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
          },
          async writeOwnerExport() {
            return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
          },
          async readOwnerExport() {
            return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "OWNER_EXPORT_ARTIFACT_UNAVAILABLE" } };
          },
        };
        const ownerExportService = createOwnerExportService({
          operations,
          exports: ownerExportStore,
          clock: createSystemClock(),
          ids: createSystemIdGenerator(),
          ...(ownerExportStorage === undefined ? {} : { objectRead: ownerExportStorage }),
          revalidateMediaForDownload: async ({ snapshot, portfolioId, ownerId }) => {
            if (!("kind" in snapshot)) return false;
            const versions = new Map<StableId<"MediaAsset">, number>();
            for (const record of snapshot.media?.records ?? []) {
              if (record.value["state"] !== "accepted" || record.value["byteCoverage"] !== "included") continue;
              if (typeof record.value["aggregateVersion"] !== "number" || !Number.isSafeInteger(record.value["aggregateVersion"])) return false;
              const mediaId = parseStableId("MediaAsset", record.mediaId);
              if (!mediaId.ok) return false;
              versions.set(mediaId.value, record.value["aggregateVersion"]);
            }
            for (const version of snapshot.cv?.versions ?? []) {
              if (version.state !== "accepted") continue;
              if (version.acceptedMediaSnapshot === undefined) return false;
              const existing = versions.get(version.mediaId);
              if (existing !== undefined && existing !== version.acceptedMediaSnapshot.mediaAssetVersion) return false;
              versions.set(version.mediaId, version.acceptedMediaSnapshot.mediaAssetVersion);
            }
            const current = await mediaExportReader.revalidateOwnerMediaExportSnapshot({ portfolioId, ownerId }, versions);
            return current.ok && current.value;
          },
          revalidateModerationForDownload: async ({ snapshot, portfolioId, ownerId }) => {
            if (!("kind" in snapshot)) return false;
            return database.transactions.run(async transaction => {
              const current = await moderationExportReader.readOwnerExportSnapshot({ portfolioId, ownerId }, transaction);
              return matchesOwnerExportModerationFacts(snapshot, projectFeedbackOwnerExportSnapshot(current).records);
            }, { isolationLevel: "repeatable read" });
          },
        });
        let ownerExportAssembly: ReturnType<typeof import("../modules/portability-operations/application/owner-export-assembly.js").createOwnerExportAssemblyService> | undefined;
        if (runtimeKind === "worker") {
          const [
            { createOwnerExportAssemblyService },
            { createPostgresPortfolioSettingsRepository },
            { createPostgresContentAuthoringRepository },
            { createPostgresTaxonomyOwnerRepository },
            { createPostgresContentTaxonomyExportAssignmentReader },
            { createTaxonomyOwnerExportSnapshotReader },
            { createOwnerExportSnapshotReader },
            { createPostgresOwnerMediaExportSnapshotReader },
            { createPostgresOwnerCvExportSnapshotReader },
            { createPostgresFeedbackOwnerExportSnapshotReader },
            { createPostgresOwnerAnalyticsExportSnapshotReader },
            { createSupabaseMediaExportStorage },
            { createOwnerExportArtifactCleanupService },
          ] = await Promise.all([
            import("../modules/portability-operations/application/owner-export-assembly.js"),
            import("../modules/portfolio-configuration/adapters/postgres-settings.js"),
            import("../modules/content-publishing/adapters/postgres-authoring.js"),
            import("../modules/taxonomy-discovery/adapters/postgres-owner-taxonomies.js"),
            import("../modules/content-publishing/adapters/postgres-taxonomy-export-reader.js"),
            import("../modules/taxonomy-discovery/application/taxonomy-export.js"),
            import("../runtime/adapters/owner-export-snapshot.js"),
            import("../modules/media/adapters/postgres-owner-export-snapshot.js"),
            import("../modules/cv-portfolio/adapters/postgres-owner-export-snapshot.js"),
            import("../modules/interaction-moderation/adapters/postgres-owner-export.js"),
            import("../modules/measurement/adapters/postgres-owner-analytics-export.js"),
            import("../runtime/adapters/supabase-media-export-storage.js"),
            import("../modules/portability-operations/application/owner-export-cleanup.js"),
          ]);
          const mediaObjects = createOwnerExportMediaObjectReader(env, createSupabaseMediaExportStorage);
          const exportSnapshots = createOwnerExportSnapshotReader({
              configuration: createPostgresPortfolioSettingsRepository(),
              content: createPostgresContentAuthoringRepository(),
              taxonomy: createTaxonomyOwnerExportSnapshotReader({
                repository: createPostgresTaxonomyOwnerRepository(),
                assignments: createPostgresContentTaxonomyExportAssignmentReader(),
              }),
              media: createPostgresOwnerMediaExportSnapshotReader({ database: database.database, transactions: operations.transactions }),
              cv: createPostgresOwnerCvExportSnapshotReader(),
              moderation: createPostgresFeedbackOwnerExportSnapshotReader(),
              analytics: createPostgresOwnerAnalyticsExportSnapshotReader(),
              transactions: operations.transactions,
              capabilities: {
                async read(scope) {
                  if (!env["SUPABASE_URL"] || !env["SUPABASE_SERVICE_ROLE_KEY"]) {
                    return { currentCvAvailable: false, externalLinksAvailable: false };
                  }
                  const [
                    { createMediaAcceptanceApplicationService },
                    { createPostgresMediaAcceptanceRepository },
                    { createPostgresCurrentCvSnapshotRepository },
                    { createCurrentCvDeliveryService },
                    { createSupabaseCurrentCvDelivery },
                  ] = await Promise.all([
                    import("../modules/media/application/acceptance.js"),
                    import("../modules/media/adapters/postgres-acceptance.js"),
                    import("../modules/cv-portfolio/adapters/postgres-portfolio.js"),
                    import("../modules/cv-portfolio/application/current-delivery.js"),
                    import("../runtime/adapters/supabase-current-cv-delivery.js"),
                  ]);
                  const capabilityScope = { portfolioId: scope.portfolioId, ownerId: scope.ownerId };
                  const media = createMediaAcceptanceApplicationService({
                    scope: capabilityScope,
                    repository: createPostgresMediaAcceptanceRepository({
                      database: database.database,
                      transactions: operations.transactions,
                      scope: capabilityScope,
                    }),
                  });
                  const currentCv = createCurrentCvDeliveryService({
                    repository: createPostgresCurrentCvSnapshotRepository({
                      database: database.database,
                      transactions: operations.transactions,
                      scope: capabilityScope,
                      media,
                    }),
                    storage: createSupabaseCurrentCvDelivery({
                      storageUrl: env["SUPABASE_URL"]!,
                      serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"]!,
                      mode: env["NODE_ENV"] === "test" ? "test" : "deployed",
                      ...(env["MEDIA_PROCESSED_BUCKET"] === undefined ? {} : { processedBucket: env["MEDIA_PROCESSED_BUCKET"] }),
                    }),
                  });
                  return {
                    currentCvAvailable: await currentCv.getAvailability() === "available",
                    externalLinksAvailable: false,
                  };
                },
              },
            });
          if (!configuredScope?.portfolioId.ok || !configuredScope.ownerId.ok) throw new Error("OWNER_EXPORT_SCOPE_UNAVAILABLE");
          const exportCleanup = createOwnerExportArtifactCleanupService({
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
            artifacts: ownerExportStore, snapshots: exportSnapshots,
            storage: ownerExportStorage ?? unavailableOwnerExportStorage,
          });
          ownerExportAssembly = createOwnerExportAssemblyService({
            operations,
            exports: ownerExportStore,
            snapshots: exportSnapshots,
            artifacts: ownerExportStore,
            cleanup: exportCleanup,
            storage: ownerExportStorage ?? unavailableOwnerExportStorage,
            ...(mediaObjects === undefined ? {} : { mediaObjects }),
            clock: createSystemClock(),
            ids: createSystemIdGenerator(),
          });
        }
        let ownerConfiguration: OwnerConfigurationApplicationService | undefined;
        let contentAuthoring: ContentAuthoringService | undefined;
        let ownerTaxonomy: OwnerTaxonomyApplicationService | undefined;
        let publicDiscovery: PublicDiscoveryService | undefined;
        let ownerMedia: OwnerMediaApplicationService | undefined;
        let mediaDelivery: MediaDeliveryApplicationService | undefined;
        let ownerCv: OwnerCvApplicationService | undefined;
        let currentCv: CurrentCvDeliveryService | undefined;
        let publicConfiguration: PortfolioSettingsApplicationService | undefined;
        let consent: ConsentApplicationService | undefined;
        let eventIngestion: MeasurementEventRuntimeServices | undefined;
        let eventMediaFacts: MeasurementMediaPublicFactsPort | undefined;
        let reaction: ReactionRuntimeServices | undefined;
        let rating: RatingRuntimeServices | undefined;
        let feedback: FeedbackRuntimeServices | undefined;
        let moderation: NonNullable<typeof currentModeration> | undefined;
        let ownerAnalytics: OwnerAnalyticsApplicationService | undefined;
        let ownerAggregateReport: Pick<MeasurementService, "getAggregateReport"> | undefined;
        let interactionSummary: NonNullable<typeof currentInteractionSummary> | undefined;
        if (runtimeKind === "application" && configuredScope?.portfolioId.ok && configuredScope.ownerId.ok) {
          const [{ createOwnerAnalyticsGoalService, createOwnerAggregateReportService }, { createPostgresOwnerAnalyticsGoalRepository },
            { createPostgresDailyAggregateRepository },
            { createPostgresAnalyticsGoalScopeFacts }, { decideAuthorization }] = await Promise.all([
            import("../modules/measurement/index.js"),
            import("../modules/measurement/adapters/postgres-goals.js"),
            import("../modules/measurement/adapters/postgres-daily-aggregates.js"),
            import("../modules/measurement/adapters/postgres-goal-scope-facts.js"),
            import("../modules/identity-access/index.js"),
          ]);
          const analyticsScope = { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value };
          ownerAnalytics = createOwnerAnalyticsGoalService({ scope: analyticsScope, operations, authorize: async query => decideAuthorization(query),
            repository: createPostgresOwnerAnalyticsGoalRepository(), scopeFacts: createPostgresAnalyticsGoalScopeFacts(analyticsScope),
            clock: createSystemClock(), ids: createSystemIdGenerator() });
          ownerAggregateReport = createOwnerAggregateReportService({ scope: analyticsScope,
            authorize: async query => decideAuthorization(query), transactions: operations.transactions,
            repository: createPostgresDailyAggregateRepository(), clock: createSystemClock() });
          const [{ createFeedbackApplicationService, createOwnerFeedbackModerationService }, { createPostgresFeedbackSubmissionRepository },
            { createPostgresProjectInteractionFacts }, { createBoundedCurrentCvRateLimit }] = await Promise.all([
            import("../modules/interaction-moderation/index.js"),
            import("../modules/interaction-moderation/adapters/postgres-feedback.js"),
            import("../modules/content-publishing/adapters/postgres-interaction-facts.js"),
            import("../runtime/http/current-cv-rate-limit.js"),
          ]);
          const scope = { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value };
          const { createProjectInteractionSummaryService } = await import("../modules/interaction-moderation/index.js");
          const { createPostgresInteractionSummaryRepository } = await import("../modules/interaction-moderation/adapters/postgres-summary.js");
          interactionSummary = createProjectInteractionSummaryService({ portfolioId: scope.portfolioId, transactions: operations.transactions,
            content: createPostgresProjectInteractionFacts(scope), repository: createPostgresInteractionSummaryRepository() });
          const { createPostgresModerationRepository } = await import("../modules/interaction-moderation/adapters/postgres-moderation.js");
          moderation = createOwnerFeedbackModerationService({ scope, operations,
            authorize: async query => decideAuthorization(query), repository: createPostgresModerationRepository(),
            content: createPostgresProjectInteractionFacts(scope), clock: createSystemClock(), ids: createSystemIdGenerator() });
          feedback = { scope: { kind: "portfolio", portfolioId: scope.portfolioId },
            service: createFeedbackApplicationService({ portfolioId: scope.portfolioId, content: createPostgresProjectInteractionFacts(scope),
              operations, repository: createPostgresFeedbackSubmissionRepository(), clock: createSystemClock(), ids: createSystemIdGenerator() }),
            // Portfolio-wide process budget needs no IP, fingerprint or persistent identity.
            rateLimit: createBoundedCurrentCvRateLimit({ clientKey: () => "feedback:" + scope.portfolioId,
              maxRequests: Number(env["FEEDBACK_RATE_LIMIT_MAX_REQUESTS"] ?? 30), windowSeconds: Number(env["FEEDBACK_RATE_LIMIT_WINDOW_SECONDS"] ?? 60) }) };
        }
        if (runtimeKind === "application" && configuredScope?.portfolioId.ok && configuredScope.ownerId.ok && env["FUNCTIONAL_ID_HASH_KEY"]) {
          const [{ createReactionApplicationService, createRatingApplicationService, createFunctionalInteractionContext }, { createPostgresReactionRepository }, { createPostgresRatingRepository },
            { createPostgresProjectInteractionFacts }, { createIdentityAccessService },
            { AesGcmPseudonymousTokenAdapter, createFunctionalPseudonymousIdentityConfig, StubAuthProvider }] = await Promise.all([
            import("../modules/interaction-moderation/index.js"),
            import("../modules/interaction-moderation/adapters/postgres-reactions.js"),
            import("../modules/interaction-moderation/adapters/postgres-ratings.js"),
            import("../modules/content-publishing/adapters/postgres-interaction-facts.js"),
            import("../modules/identity-access/application/policy.js"),
            import("../modules/identity-access/adapters/index.js"),
          ]);
          const scope = { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value };
          const content = createPostgresProjectInteractionFacts(scope);
          const identity = createIdentityAccessService({ auth: new StubAuthProvider(), crypto: new AesGcmPseudonymousTokenAdapter({
            config: createFunctionalPseudonymousIdentityConfig(env), nowSeconds: () => Math.floor(Date.now() / 1000),
          }) });
          reaction = { scope: { kind: "portfolio", portfolioId: scope.portfolioId },
            service: createReactionApplicationService({ portfolioId: scope.portfolioId, content, operations,
              repository: createPostgresReactionRepository(), clock: createSystemClock(), ids: createSystemIdGenerator() }),
            functionalIdentity: createFunctionalInteractionContext({ portfolioId: scope.portfolioId, transactions: operations.transactions, content, identity }) };
          rating = { scope: reaction.scope,
            service: createRatingApplicationService({ portfolioId: scope.portfolioId, content, operations,
              repository: createPostgresRatingRepository(), clock: createSystemClock(), ids: createSystemIdGenerator() }),
            functionalIdentity: reaction.functionalIdentity };
        }
        // Optional Measurement capability does not become a global readiness dependency.
        if (runtimeKind === "application" && env["MEASUREMENT_CONSENT_NOTICE_VERSIONS"]) {
          try {
            const [{ createConsentApplicationService }, { createPostgresConsentRepository },
              { AesGcmConsentEvidenceAdapter }, { createPseudonymousIdentityConfig }] = await Promise.all([
              import("../modules/measurement/index.js"),
              import("../modules/measurement/adapters/postgres-consent.js"),
              import("../modules/identity-access/adapters/consent-evidence.js"),
              import("../modules/identity-access/adapters/pseudonymous-config.js"),
            ]);
            const clock = createSystemClock();
            consent = createConsentApplicationService({ transactions: database.transactions,
              repository: createPostgresConsentRepository(),
              crypto: new AesGcmConsentEvidenceAdapter(createPseudonymousIdentityConfig(env), clock.now),
              clock, ids: createSystemIdGenerator(), ttlSeconds: 2_592_000,
              supportedNoticeVersions: env["MEASUREMENT_CONSENT_NOTICE_VERSIONS"]!.split(",").map(v => v.trim()),
            });
            const [{ createMeasurementEventService }, { createPostgresMeasurementEventRepository }, { createPostgresContentMeasurementPublicFacts }, { createPostgresMeasurementConfigurationPublicFacts }] = await Promise.all([
              import("../modules/measurement/index.js"),
              import("../modules/measurement/adapters/postgres-events.js"),
              import("../modules/content-publishing/adapters/postgres-interaction-facts.js"),
              import("../modules/portfolio-configuration/adapters/postgres-measurement-public-facts.js"),
            ]);
            if (!configuredScope?.portfolioId.ok || !configuredScope.ownerId.ok) throw new Error("MEASUREMENT_SCOPE_UNAVAILABLE");
            eventIngestion = { scope: { kind: "portfolio", portfolioId: configuredScope.portfolioId.value }, service: createMeasurementEventService({ portfolioId: configuredScope.portfolioId.value,
              transactions: database.transactions, operations, consent,
              content: createPostgresContentMeasurementPublicFacts({ portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value }),
              configuration: createPostgresMeasurementConfigurationPublicFacts({ portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value }),
              media: { async getPublicUseFact(input, transaction) {
                if (!eventMediaFacts) return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEASUREMENT_MEDIA_FACTS_UNAVAILABLE" } };
                return eventMediaFacts.getPublicUseFact(input, transaction);
              } },
              repository: createPostgresMeasurementEventRepository(), clock, ids: createSystemIdGenerator() }) };
          } catch { consent = undefined; eventIngestion = undefined; }
        }
        if (runtimeKind === "application") {
          if (configuredScope === undefined || !configuredScope.portfolioId.ok || !configuredScope.ownerId.ok) {
            throw new RuntimeConfigError("PORTFOLIO_ID", "must be configured for Owner configuration commands");
          }
          const [
            { createPostgresPortfolioSettingsRepository },
            { createPortfolioProfileCommandService },
            { createPortfolioContactChannelsCommandService },
            { createPortfolioGlobalCtaCommandService },
            { createOwnerConfigurationApplicationService },
          ] = await Promise.all([
            import("../modules/portfolio-configuration/adapters/postgres-settings.js"),
            import("../modules/portfolio-configuration/application/profile-command.js"),
            import("../modules/portfolio-configuration/application/contact-channels-command.js"),
            import("../modules/portfolio-configuration/application/cta-command.js"),
            import("../runtime/owner-configuration-service.js"),
          ]);
          const repository = createPostgresPortfolioSettingsRepository();
          const profileCommands = createPortfolioProfileCommandService({
            repository,
            operations,
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
          });
          const contactChannelsCommands = createPortfolioContactChannelsCommandService({
            repository,
            operations,
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
          });
          const ctaCommands = createPortfolioGlobalCtaCommandService({
            repository,
            operations,
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
          });
          ownerConfiguration = createOwnerConfigurationApplicationService(
            profileCommands,
            contactChannelsCommands,
            ctaCommands,
            configuredScope.portfolioId.value,
          );
          const [
            { createPostgresContentAuthoringRepository },
            { createPostgresProjectDiscoveryProjectionWriter },
            { createContentAuthoringService },
          ] = await Promise.all([
            import("../modules/content-publishing/adapters/postgres-authoring.js"),
            import("../modules/taxonomy-discovery/adapters/index.js"),
            import("../modules/content-publishing/application/authoring.js"),
          ]);
          const discoveryProjection = createPostgresProjectDiscoveryProjectionWriter();
          const [{ createPostgresPublicDiscoveryReader }, { createPublicDiscoveryService }] = await Promise.all([
            import("../modules/taxonomy-discovery/adapters/index.js"),
            import("../modules/taxonomy-discovery/application/index.js"),
          ]);
          publicDiscovery = createPublicDiscoveryService({
            reader: createPostgresPublicDiscoveryReader({
              portfolioId: configuredScope.portfolioId.value,
              ownerId: configuredScope.ownerId.value,
            }),
            transactions: operations.transactions,
          });
          const [{ createPostgresTaxonomyOwnerRepository }, { createTaxonomyOwnerService }, { createContentBackedOwnerTaxonomyService }, { createProductionOwnerTaxonomyService }, { createPostgresContentTaxonomyAssignmentsPort }] = await Promise.all([
            import("../modules/taxonomy-discovery/adapters/index.js"),
            import("../modules/taxonomy-discovery/application/index.js"),
            import("../runtime/owner-taxonomy-content-service.js"),
            import("../runtime/fakes/owner-taxonomy.js"),
            import("../modules/content-publishing/adapters/postgres-taxonomy-assignments.js"),
          ]);
          const contentTaxonomyAssignments = createPostgresContentTaxonomyAssignmentsPort({
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
            discovery: discoveryProjection,
          });
          ownerTaxonomy = createContentBackedOwnerTaxonomyService(createTaxonomyOwnerService({
            repository: createPostgresTaxonomyOwnerRepository(),
            operations,
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
            contentAssignments: contentTaxonomyAssignments,
          }), createProductionOwnerTaxonomyService());

          const [
            { createPostgresMediaUploadIntentRepository },
            { createPostgresMediaProcessingRepository },
            { createUploadCapabilityVault },
            { createMediaUploadIntentApplicationService },
            { createMediaProcessingApplicationService },
            { createOwnerMediaApplicationService },
            { createSupabaseMediaUploadTargetAdapter },
            { createSupabaseMediaProcessingStorage },
            { createClamAvScanner, createOcrMyPdfProcessor, createFfmpegVideoProcessor },
            { createSharpMediaImageProcessor },
            { createNodeMediaDigest },
            { createPostgresOwnerMediaAggregateRepository },
          ] = await Promise.all([
            import("../modules/media/adapters/postgres-upload-intents.js"),
            import("../modules/media/adapters/postgres-processing.js"),
            import("../modules/media/adapters/upload-capability-vault.js"),
            import("../modules/media/application/upload-intent.js"),
            import("../modules/media/application/processing.js"),
            import("../modules/media/application/owner-service.js"),
            import("../runtime/adapters/supabase-media-upload-target.js"),
            import("../runtime/adapters/supabase-media-processing-storage.js"),
            import("../runtime/adapters/media-processing-tools.js"),
            import("../runtime/adapters/media-image-processing.js"),
            import("../runtime/adapters/media-digest.js"),
            import("../modules/media/adapters/postgres-owner-aggregate.js"),
          ]);
          const uploadIntentTarget = env["SUPABASE_URL"] && env["SUPABASE_SERVICE_ROLE_KEY"]
            ? createSupabaseMediaUploadTargetAdapter({
              storageUrl: env["SUPABASE_URL"],
              serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"],
              ...(env["MEDIA_CANDIDATE_BUCKET"] === undefined ? {} : { candidateBucket: env["MEDIA_CANDIDATE_BUCKET"] }),
              ...(env["MEDIA_PROCESSED_BUCKET"] === undefined ? {} : { processedBucket: env["MEDIA_PROCESSED_BUCKET"] }),
            })
            : {
              async prepare() {
                return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_STORAGE_UNAVAILABLE" } };
              },
              async removeAbandoned() {
                return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_STORAGE_UNAVAILABLE" } };
              },
            };
          const uploadIntent = createMediaUploadIntentApplicationService({
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
            repository: createPostgresMediaUploadIntentRepository(database.database, operations.transactions),
            target: uploadIntentTarget,
            vault: createUploadCapabilityVault(env["MEDIA_UPLOAD_REPLAY_ENCRYPTION_KEY"]),
            ids: createSystemIdGenerator(),
            clock: createSystemClock(),
          });
          const mediaStorage = env["SUPABASE_URL"] && env["SUPABASE_SERVICE_ROLE_KEY"]
            ? createSupabaseMediaProcessingStorage({
              storageUrl: env["SUPABASE_URL"],
              serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"],
              ...(env["MEDIA_CANDIDATE_BUCKET"] === undefined ? {} : { candidateBucket: env["MEDIA_CANDIDATE_BUCKET"] }),
              ...(env["MEDIA_PROCESSED_BUCKET"] === undefined ? {} : { processedBucket: env["MEDIA_PROCESSED_BUCKET"] }),
            })
            : {
              async readCandidate() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_STORAGE_UNAVAILABLE" } }; },
              async sealProcessedObject() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_STORAGE_UNAVAILABLE" } }; },
              async discardSealedObject() {},
              async preflightAcceptedPdfObject() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_STORAGE_UNAVAILABLE" } }; },
            };
          const processing = createMediaProcessingApplicationService({
              scope: { ownerId: configuredScope.ownerId.value },
              repository: createPostgresMediaProcessingRepository({
                database: database.database,
                transactions: operations.transactions,
                scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
              }),
              storage: mediaStorage,
              scanner: createClamAvScanner({
                ...(env["CLAMSCAN_PATH"] === undefined ? {} : { executable: env["CLAMSCAN_PATH"] }),
                maxBytes: 50 * 1024 * 1024,
                timeoutMs: 25_000,
              }),
              processor: createOcrMyPdfProcessor({
                ...(env["PYTHON_PATH"] === undefined ? {} : { python: env["PYTHON_PATH"] }),
                ...(env["OCRMY_PDF_PATH"] === undefined ? {} : { ocrmypdf: env["OCRMY_PDF_PATH"] }),
              }),
              videoProcessor: createFfmpegVideoProcessor(),
              imageProcessor: createSharpMediaImageProcessor(),
              digest: createNodeMediaDigest(),
              ids: createSystemIdGenerator(),
              clock: createSystemClock(),
            });
          const [
            { createPostgresMediaAcceptanceRepository },
            { createMediaAcceptanceApplicationService },
            { createPostgresCvPortfolioRepository },
            { createOwnerCvApplicationService },
          ] = await Promise.all([
            import("../modules/media/adapters/postgres-acceptance.js"),
            import("../modules/media/application/acceptance.js"),
            import("../modules/cv-portfolio/adapters/postgres-portfolio.js"),
            import("../modules/cv-portfolio/application/owner-service.js"),
          ]);
          const scope = { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value };
          const mediaAcceptance = createMediaAcceptanceApplicationService({
            scope: { ownerId: scope.ownerId, portfolioId: scope.portfolioId },
            repository: createPostgresMediaAcceptanceRepository({
              database: database.database,
              transactions: operations.transactions,
              scope,
            }),
            preflight: mediaStorage.preflightAcceptedPdfObject,
          });
          const contentMediaAcceptance: MediaAcceptancePort = {
            async getAcceptanceFacts(query, transaction) {
              const result = await mediaAcceptance.getAcceptanceFacts({ ownerId: query.ownerId,
                mediaAssetIds: query.mediaAssetIds, intendedUse: "supporting-artifact" }, transaction);
              if (!result.ok) return result;
              return { ok: true as const, value: {
                consistencyVersion: result.value[0]?.consistencyVersion ?? "media-acceptance-v1:empty",
                facts: result.value.map(({ mediaAssetId, ownerId, accepted, safe, suitable, accessible, assetVersion }) => ({
                  mediaAssetId, ownerId, accepted, safe, suitable, accessible, version: assetVersion,
                })),
              } };
            },
          };
          contentAuthoring = createContentAuthoringService({
            repository: createPostgresContentAuthoringRepository(),
            operations,
            discoveryProjection,
            taxonomyAssignments: discoveryProjection,
            scope: { portfolioId: scope.portfolioId, ownerId: scope.ownerId },
            mediaAcceptance: contentMediaAcceptance,
          });
          ownerCv = createOwnerCvApplicationService({
            ownerId: scope.ownerId,
            repository: createPostgresCvPortfolioRepository({
              database: database.database,
              transactions: operations.transactions,
              scope,
              media: mediaAcceptance,
            }),
            ids: createSystemIdGenerator(),
          });
          const [{ createCurrentCvDeliveryService }, { createPostgresCurrentCvSnapshotRepository }] = await Promise.all([
            import("../modules/cv-portfolio/application/current-delivery.js"),
            import("../modules/cv-portfolio/adapters/postgres-portfolio.js"),
          ]);
          const currentCvStorage = env["SUPABASE_URL"] && env["SUPABASE_SERVICE_ROLE_KEY"]
            ? (await import("../runtime/adapters/supabase-current-cv-delivery.js")).createSupabaseCurrentCvDelivery({
                storageUrl: env["SUPABASE_URL"],
                serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"],
                mode: env["NODE_ENV"] === "test" ? "test" : "deployed",
                ...(env["MEDIA_PROCESSED_BUCKET"] === undefined ? {} : { processedBucket: env["MEDIA_PROCESSED_BUCKET"] }),
              })
            : {
                async stream() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "CURRENT_CV_STORAGE_UNAVAILABLE" } }; },
                async createDownloadTarget() { return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "CURRENT_CV_STORAGE_UNAVAILABLE" } }; },
              };
          currentCv = createCurrentCvDeliveryService({
            repository: createPostgresCurrentCvSnapshotRepository({
              database: database.database,
              transactions: operations.transactions,
              scope,
              media: mediaAcceptance,
            }),
            storage: currentCvStorage,
          });
          if (contentAuthoring === undefined) throw new Error("CONTENT_AUTHORING_UNAVAILABLE");
          const [{ createPortfolioSettingsReader }, { createPostgresMediaDeliveryRepository },
            { createMediaDeliveryApplicationService }, { createSupabaseMediaDeliveryStorage }] = await Promise.all([
            import("../modules/portfolio-configuration/application/settings-service.js"),
            import("../modules/media/adapters/postgres-delivery.js"),
            import("../modules/media/application/delivery.js"),
            import("../runtime/adapters/supabase-media-delivery-storage.js"),
          ]);
          const profileSettings = createPortfolioSettingsReader({
            repository,
            transactions: operations.transactions,
            scope,
            capabilityReader: {
              async getFacts() {
                return {
                  currentCv: await currentCv!.getAvailability(),
                  externalLinks: "unknown",
                  globalProjectCta: "available",
                };
              },
            },
          });
          publicConfiguration = profileSettings;
          eventMediaFacts = {
            async getPublicUseFact(query, transaction) {
              const acceptance = await mediaAcceptance.getAcceptanceFacts({ ownerId: scope.ownerId,
                mediaAssetIds: [query.mediaAssetId], intendedUse: "supporting-artifact" }, transaction);
              if (!acceptance.ok) return acceptance;
              const fact = acceptance.value[0];
              if (!fact || fact.mediaAssetId !== query.mediaAssetId || !fact.accepted || !fact.safe || !fact.suitable || !fact.accessible) {
                return { ok: true as const, value: false };
              }
              if (query.projectId !== undefined) {
                return contentAuthoring!.getPublicProjectMediaUse({ mediaAssetId: query.mediaAssetId, projectId: query.projectId, locale: query.locale }, transaction);
              }
              const [projectUse, profileUse] = await Promise.all([
                contentAuthoring!.getPublicProjectMediaUse({ mediaAssetId: query.mediaAssetId, locale: query.locale }, transaction),
                profileSettings.isPublicProfileMediaUse({ mediaAssetId: query.mediaAssetId, locale: query.locale }, transaction),
              ]);
              if (!projectUse.ok) return projectUse;
              if (!profileUse.ok) return profileUse;
              return { ok: true as const, value: projectUse.value || profileUse.value };
            },
          };
          const deliveryStorage = env["SUPABASE_URL"] && env["SUPABASE_SERVICE_ROLE_KEY"]
            ? createSupabaseMediaDeliveryStorage({
              storageUrl: env["SUPABASE_URL"],
              serviceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"],
              portfolioId: scope.portfolioId,
              mode: env["NODE_ENV"] === "test" ? "test" : "deployed",
              ...(env["MEDIA_CANDIDATE_BUCKET"] === undefined ? {} : { candidateBucket: env["MEDIA_CANDIDATE_BUCKET"] }),
              ...(env["MEDIA_PROCESSED_BUCKET"] === undefined ? {} : { processedBucket: env["MEDIA_PROCESSED_BUCKET"] }),
            })
            : {
              async createSignedDeliveryTarget() {
                return { ok: false as const, error: { kind: "temporarily_unavailable" as const, code: "MEDIA_DELIVERY_UNAVAILABLE" } };
              },
            };
          mediaDelivery = createMediaDeliveryApplicationService({
            ownerId: scope.ownerId,
            transactions: operations.transactions,
            use: {
              async isCurrentlyUsed(query, transaction) {
                if (query.purpose === "project") return contentAuthoring!.getPublicProjectMediaUse({ mediaAssetId: query.mediaAssetId as StableId<"MediaAsset">, locale: query.locale }, transaction);
                if (query.purpose === "profile") return profileSettings.isPublicProfileMediaUse({ mediaAssetId: query.mediaAssetId as StableId<"MediaAsset">, locale: query.locale }, transaction);
                return { ok: true, value: false };
              },
            },
            repository: createPostgresMediaDeliveryRepository({
              database: database.database,
              scope,
            }),
            storage: deliveryStorage,
          });
          const [{ createPostgresMediaRejectionRepository }, { createMediaRejectionApplicationService }] = await Promise.all([
            import("../modules/media/adapters/postgres-rejection.js"),
            import("../modules/media/application/rejection.js"),
          ]);
          const mediaRejection = createMediaRejectionApplicationService({
            scope: { ownerId: scope.ownerId },
            repository: createPostgresMediaRejectionRepository({
              transactions: operations.transactions,
              scope,
            }),
            usage: {
              async getUsage(query, transaction) {
                if (contentAuthoring === undefined || ownerCv === undefined) {
                  return { ok: false, error: { kind: "temporarily_unavailable", code: "MEDIA_USAGE_CHECK_UNAVAILABLE" } };
                }
                const contentUsage = await contentAuthoring.getVisibleMediaUsage({
                  ownerId: query.ownerId,
                  mediaAssetIds: [query.mediaAssetId],
                }, transaction);
                if (!contentUsage.ok) return contentUsage;
                const visible = contentUsage.value.facts.find((fact) => fact.mediaAssetId === query.mediaAssetId);
                if (visible === undefined) {
                  return { ok: false, error: { kind: "temporarily_unavailable", code: "CONTENT_MEDIA_USAGE_INCOMPLETE" } };
                }
                const currentCv = await ownerCv.getCurrentCvMediaUsage({ ...query, transaction });
                if (!currentCv.ok) return currentCv;
                return { ok: true, value: {
                  hasVisibleContentReference: visible.inUse,
                  isCurrentCv: currentCv.value,
                } };
              },
            },
          });
          ownerMedia = createOwnerMediaApplicationService({
            ownerId: scope.ownerId,
            aggregateRepository: createPostgresOwnerMediaAggregateRepository({
              database: database.database,
              transactions: operations.transactions,
              scope,
            }),
            uploadIntent: { createOwnerMediaUploadIntent: uploadIntent.create },
            processing: { recordOwnerMediaProcessing: processing.record },
            acceptance: { acceptOwnerMediaAsset: mediaAcceptance.acceptOwnerMediaAsset },
            rejection: { rejectOwnerMediaAsset: mediaRejection.rejectOwnerMediaAsset },
          });
        }
        return {
          operations,
          ...(ownerExportService === undefined ? {} : { ownerExport: ownerExportService }),
          ...(ownerExportAssembly === undefined ? {} : { ownerExportAssembly }),
          ...(reaction === undefined ? {} : { reaction }),
          ...(rating === undefined ? {} : { rating }),
          ...(feedback === undefined ? {} : { feedback }),
          ...(moderation === undefined ? {} : { moderation }),
          ...(ownerAnalytics === undefined ? {} : { ownerAnalytics }),
          ...(ownerAggregateReport === undefined ? {} : { ownerAggregateReport }),
          ...(interactionSummary === undefined ? {} : { interactionSummary }),
          ...(consent === undefined ? {} : { consent }),
          ...(eventIngestion === undefined ? {} : { eventIngestion }),
          ...(ownerConfiguration === undefined ? {} : { ownerConfiguration }),
          ...(contentAuthoring === undefined ? {} : { contentAuthoring }),
          ...(ownerTaxonomy === undefined ? {} : { ownerTaxonomy }),
          ...(publicDiscovery === undefined ? {} : { publicDiscovery }),
          ...(ownerMedia === undefined ? {} : { ownerMedia }),
          ...(mediaDelivery === undefined ? {} : { mediaDelivery }),
          ...(ownerCv === undefined ? {} : { ownerCv }),
          ...(currentCv === undefined ? {} : { currentCv }),
          ...(publicConfiguration === undefined ? {} : { publicConfiguration }),
          resource: database.resource,
          readiness: database.readiness,
        };
      });
    const dependencies = await resolvedFactory();
    let ready = false;
    try {
      ready = await dependencies.readiness.check();
    } catch {
      ready = false;
    }
    if (!ready) {
      await dependencies.resource.close();
      throw new Error("DATABASE_NOT_READY");
    }
    lifecycle.registerResource(dependencies.resource);
    lifecycle.registerReadinessCheck(dependencies.readiness);
    current = config;
    currentOperations = dependencies.operations;
    currentOwnerExport = dependencies.ownerExport;
    currentOwnerExportAssembly = dependencies.ownerExportAssembly;
    currentReaction = dependencies.reaction;
    currentRating = dependencies.rating;
    currentFeedback = dependencies.feedback;
    currentModeration = dependencies.moderation;
    currentOwnerAnalytics = dependencies.ownerAnalytics;
    currentOwnerAggregateReport = dependencies.ownerAggregateReport;
    const scopedPortfolio = parseStableId("Portfolio", env["PORTFOLIO_ID"] ?? "");
    currentPhase7PortfolioId = scopedPortfolio.ok ? scopedPortfolio.value : undefined;
    currentOwnerAnalyticsScope = currentOwnerAnalytics && scopedPortfolio.ok
      ? { kind: "portfolio", portfolioId: scopedPortfolio.value } : undefined;
    currentInteractionSummary = dependencies.interactionSummary;
    currentConsent = dependencies.consent;
    currentEventIngestion = dependencies.eventIngestion;
    currentOwnerConfiguration = dependencies.ownerConfiguration;
    currentContentAuthoring = dependencies.contentAuthoring;
    currentOwnerTaxonomy = dependencies.ownerTaxonomy;
    currentPublicDiscovery = dependencies.publicDiscovery;
    currentOwnerMedia = dependencies.ownerMedia;
    currentMediaDelivery = dependencies.mediaDelivery;
    currentOwnerCv = dependencies.ownerCv;
    currentCurrentCv = dependencies.currentCv;
    currentPublicConfiguration = dependencies.publicConfiguration;
    lifecycle.markReady();
    return Object.freeze({ ...config, runtimeKind });
  } catch (error) {
    lifecycle.markFailed();
    throw new Error("Database runtime initialization failed.", { cause: error });
  }
}

export function getOperationsPersistence(): OperationsPersistencePorts {
  if (currentOperations === undefined) {
    throw new Error("Database persistence is not initialized.");
  }
  return currentOperations;
}

/** The three Owner export operations resolve through the composed PostgreSQL assembly. */
export async function getOwnerExportApplicationService(): Promise<OwnerExportApplicationService> {
  if (currentOwnerExport !== undefined) return currentOwnerExport;
  const { createProductionOwnerExportService } = await import("../runtime/fakes/owner-export.js");
  return createProductionOwnerExportService();
}

/** Worker-only queue handler for resumable Owner export assembly jobs. */
export function getOwnerExportAssemblyService() {
  if (currentOwnerExportAssembly === undefined) throw new Error("OWNER_EXPORT_ASSEMBLY_NOT_CONFIGURED");
  return currentOwnerExportAssembly;
}

/** Worker-only composition of the existing Measurement, Interaction and Owner export services. */
export function getPhase7DueWorkWorkerService() {
  if (currentOperations === undefined || currentPhase7PortfolioId === undefined) {
    throw new Error("PHASE7_DUE_WORK_NOT_CONFIGURED");
  }
  return createPhase7DueWorkWorker({
    portfolioId: currentPhase7PortfolioId,
    operations: currentOperations,
    ownerExports: getOwnerExportAssemblyService(),
    clock: createSystemClock(),
    ids: createSystemIdGenerator(),
  });
}

/** Database composition activates only configuration commands with completed phase tickets. */
export async function getOwnerConfigurationApplicationService(): Promise<OwnerConfigurationApplicationService> {
  if (currentOwnerConfiguration !== undefined) return currentOwnerConfiguration;
  const { createProductionOwnerConfigurationService } = await import("../runtime/fakes/owner-configuration.js");
  return createProductionOwnerConfigurationService();
}

/** Only the configured PostgreSQL application assembly can activate content authoring. */
export async function getContentAuthoringApplicationService(): Promise<ContentAuthoringService> {
  if (currentContentAuthoring !== undefined) return currentContentAuthoring;
  const { createProductionContentAuthoringService } = await import("../runtime/fakes/content-authoring.js");
  return createProductionContentAuthoringService();
}

/** Controlled Taxonomy roots and value creation use the configured PostgreSQL application assembly. */
export async function getOwnerTaxonomyApplicationService(): Promise<OwnerTaxonomyApplicationService> {
  if (currentOwnerTaxonomy !== undefined) return currentOwnerTaxonomy;
  const { createProductionOwnerTaxonomyService } = await import("../runtime/fakes/owner-taxonomy.js");
  return createProductionOwnerTaxonomyService();
}

/** Locale-aware public discovery is an in-process query over approved projections. */
export async function getPublicDiscoveryApplicationService(): Promise<PublicDiscoveryService> {
  if (currentPublicDiscovery !== undefined) return currentPublicDiscovery;
  throw new Error("Public discovery requires the configured PostgreSQL application assembly.");
}

/** The first completed Media Owner command is composed with scoped PostgreSQL and private Storage adapters. */
export async function getOwnerMediaApplicationService(): Promise<OwnerMediaApplicationService> {
  if (currentOwnerMedia !== undefined) return currentOwnerMedia;
  const { createProductionOwnerMediaService } = await import("../runtime/fakes/owner-media.js");
  return createProductionOwnerMediaService();
}

/** Locale-aware public Media delivery uses only currently visible Content or approved profile settings. */
export async function getMediaDeliveryApplicationService(): Promise<MediaDeliveryApplicationService> {
  if (currentMediaDelivery !== undefined) return currentMediaDelivery;
  throw new Error("Media delivery requires the configured PostgreSQL and private Storage assembly.");
}

/** CV registration and Owner reads share the configured PostgreSQL and Media acceptance transaction boundary. */
export async function getOwnerCvApplicationService(): Promise<OwnerCvApplicationService> {
  if (currentOwnerCv !== undefined) return currentOwnerCv;
  const { createProductionOwnerCvService } = await import("../runtime/fakes/owner-cv.js");
  return createProductionOwnerCvService();
}

/** Public delivery resolves the current pointer through PostgreSQL and the private processed Storage adapter. */
export async function getCurrentCvApplicationService(): Promise<CurrentCvDeliveryService> {
  if (currentCurrentCv !== undefined) return currentCurrentCv;
  const { createProductionCurrentCvService } = await import("../runtime/fakes/current-cv.js");
  return createProductionCurrentCvService();
}

/** Locale-aware public configuration combines durable settings with safe composed capability facts. */
export async function getPublicConfigurationApplicationService(): Promise<PortfolioSettingsApplicationService> {
  if (currentPublicConfiguration !== undefined) return currentPublicConfiguration;
  throw new Error("Public configuration requires the configured PostgreSQL application assembly.");
}

/** Project route, status, and Featured operations share the Content transaction boundary. */
export async function getOwnerProjectApplicationService(): Promise<OwnerProjectApplicationService> {
  const contentAuthoring = await getContentAuthoringApplicationService();
  const [{ createContentBackedOwnerProjectService }, { createContentOwnerProjectService }, { createProductionOwnerProjectService }] = await Promise.all([
    import("../runtime/owner-project-content-service.js"),
    import("../runtime/content-owner-project.js"),
    import("../runtime/fakes/owner-project.js"),
  ]);
  const routeService = createContentBackedOwnerProjectService(contentAuthoring, createProductionOwnerProjectService());
  return createContentOwnerProjectService(contentAuthoring, routeService);
}

/** Resolve every completed Phase 5 Owner facade from the active runtime. */
export async function getPhase5OwnerApplicationServices(): Promise<Phase5OwnerApplicationServices> {
  const [contentAuthoring, project, taxonomy] = await Promise.all([
    getContentAuthoringApplicationService(),
    getOwnerProjectApplicationService(),
    getOwnerTaxonomyApplicationService(),
  ]);
  const { createProductionOwnerPublicationService } = await import("../runtime/fakes/owner-publication.js");
  return Object.freeze({
    contentAuthoring,
    // Publication handlers delegate completed operations to contentAuthoring;
    // this fallback remains fail-closed for any future/unwired operation.
    publication: createProductionOwnerPublicationService(),
    project,
    taxonomy,
  });
}

export function getRuntimeConfig(): RuntimeConfig {
  if (current === undefined) {
    throw new Error("Runtime is not initialized: call initializeRuntime first.");
  }
  return current;
}

export function isRuntimeInitialized(): boolean {
  return current !== undefined;
}

/** Trusted future consent presentation and the existing event edge share this boundary. */
export function getConsentApplicationService(): ConsentApplicationService | undefined {
  return currentConsent;
}

/** Optional consent-gated event ingestion assembled with the application runtime. */
export function getMeasurementEventIngestionService(): MeasurementEventRuntimeServices | undefined {
  return currentEventIngestion;
}

/** Completed Reaction operation obtains real persistence and identity from standard assembly. */
export async function getReactionRuntimeServices(): Promise<ReactionRuntimeServices | { readonly service: Pick<InteractionModerationService, "submitReaction"> }> {
  if (currentReaction) return currentReaction;
  return { service: unavailableReactionService };
}

export async function getRatingRuntimeServices(): Promise<RatingRuntimeServices | { readonly service: Pick<InteractionModerationService, "submitRating"> }> {
  if (currentRating) return currentRating;
  return { service: unavailableRatingService };
}

/** Existing Feedback HTTP edge obtains persistence and abuse control here. */
export async function getFeedbackRuntimeServices(): Promise<FeedbackRuntimeServices | { readonly service: Pick<InteractionModerationService, "submitFeedback">; readonly rateLimit: FeedbackRuntimeServices["rateLimit"] }> {
  if (currentFeedback) return currentFeedback;
  return { service: unavailableFeedbackService, rateLimit: { check: async () => { throw new Error("FEEDBACK_NOT_CONFIGURED"); } } };
}

/** Owner adapters use configured scope plus their existing verified-session security boundary. */
export async function getOwnerAnalyticsRuntimeServices() {
  if (currentOwnerAnalytics !== undefined && currentOwnerAnalyticsScope !== undefined) {
    return { scope: currentOwnerAnalyticsScope, service: currentOwnerAnalytics };
  }
  return { service: unavailableOwnerAnalyticsService };
}

/** Safe Owner aggregate reports are an in-process capability and expose no HTTP read endpoint. */
export function getOwnerAggregateReportApplicationService(): Pick<MeasurementService, "getAggregateReport"> {
  if (!currentOwnerAggregateReport) throw new Error("OWNER_AGGREGATE_REPORT_NOT_CONFIGURED");
  return currentOwnerAggregateReport;
}

export async function getOwnerModerationRuntimeServices() {
  if (currentModeration && currentFeedback) return { scope: currentFeedback.scope, service: currentModeration };
  return { service: unavailableModerationService };
}

/** The approved exact-locale query is an in-process application capability. */
export function getApprovedFeedbackApplicationService() {
  if (!currentModeration) throw new Error("MODERATION_NOT_CONFIGURED");
  return currentModeration;
}

/** Current exact-locale summaries are an in-process capability with no identity issuance. */
export function getProjectInteractionSummaryApplicationService() {
  if (!currentInteractionSummary) throw new Error("INTERACTION_SUMMARY_NOT_CONFIGURED");
  return currentInteractionSummary;
}

/** Test-only seam to isolate focused suites. */
export function resetRuntimeForTests(): void {
  current = undefined;
  currentOperations = undefined;
  currentOwnerExport = undefined;
  currentOwnerExportAssembly = undefined;
  currentConsent = undefined;
  currentEventIngestion = undefined;
  currentReaction = undefined;
  currentRating = undefined;
  currentFeedback = undefined;
  currentModeration = undefined;
  currentOwnerAnalytics = undefined;
  currentOwnerAnalyticsScope = undefined;
  currentOwnerAggregateReport = undefined;
  currentInteractionSummary = undefined;
  currentOwnerConfiguration = undefined;
  currentContentAuthoring = undefined;
  currentOwnerTaxonomy = undefined;
  currentPublicDiscovery = undefined;
  currentOwnerMedia = undefined;
  currentMediaDelivery = undefined;
  currentOwnerCv = undefined;
  currentCurrentCv = undefined;
  currentPublicConfiguration = undefined;
  resetLifecycleForTests();
}
