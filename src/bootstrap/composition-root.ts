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
import type { OwnerConfigurationApplicationService } from "../runtime/http/owner-configuration.js";
import type { ContentAuthoringService } from "../modules/content-publishing/application/authoring.js";
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
import type { ConsentApplicationService } from "../modules/measurement/index.js";
import type { InteractionModerationService, FunctionalInteractionContextPort } from "../modules/interaction-moderation/index.js";

export interface ReactionRuntimeServices {
  readonly scope: { readonly kind: "portfolio"; readonly portfolioId: StableId<"Portfolio"> };
  readonly service: Pick<InteractionModerationService, "submitReaction">;
  readonly functionalIdentity: FunctionalInteractionContextPort;
}

export interface RatingRuntimeServices {
  readonly scope: ReactionRuntimeServices["scope"];
  readonly service: Pick<InteractionModerationService, "submitRating">;
  readonly functionalIdentity: FunctionalInteractionContextPort;
}

export type { RuntimeConfig } from "./configuration.js";

let current: RuntimeConfig | undefined;
let currentOperations: OperationsPersistencePorts | undefined;
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
let currentReaction: ReactionRuntimeServices | undefined;
let currentRating: RatingRuntimeServices | undefined;

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
  readonly consent?: ConsentApplicationService;
  readonly operations: OperationsPersistencePorts;
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
        let reaction: ReactionRuntimeServices | undefined;
        let rating: RatingRuntimeServices | undefined;
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
          } catch { consent = undefined; }
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
          contentAuthoring = createContentAuthoringService({
            repository: createPostgresContentAuthoringRepository(),
            operations,
            discoveryProjection,
            taxonomyAssignments: discoveryProjection,
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
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
          ...(reaction === undefined ? {} : { reaction }),
          ...(rating === undefined ? {} : { rating }),
          ...(consent === undefined ? {} : { consent }),
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
    currentReaction = dependencies.reaction;
    currentRating = dependencies.rating;
    currentConsent = dependencies.consent;
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

/** Completed Reaction operation obtains real persistence and identity from standard assembly. */
export async function getReactionRuntimeServices(): Promise<ReactionRuntimeServices | { readonly service: Pick<InteractionModerationService, "submitReaction"> }> {
  if (currentReaction) return currentReaction;
  const { createProductionReactionService } = await import("../runtime/fakes/reaction.js");
  return { service: createProductionReactionService() };
}

export async function getRatingRuntimeServices(): Promise<RatingRuntimeServices | { readonly service: Pick<InteractionModerationService, "submitRating"> }> {
  if (currentRating) return currentRating;
  const { createProductionRatingService } = await import("../runtime/fakes/rating.js");
  return { service: createProductionRatingService() };
}

/** Test-only seam to isolate focused suites. */
export function resetRuntimeForTests(): void {
  current = undefined;
  currentOperations = undefined;
  currentConsent = undefined;
  currentReaction = undefined;
  currentRating = undefined;
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
