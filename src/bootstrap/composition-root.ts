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
import type { LifecycleResource, ReadinessCheck } from "../runtime/ports.js";
import { parseStableId } from "../shared/domain/index.js";

export type { RuntimeConfig } from "./configuration.js";

let current: RuntimeConfig | undefined;
let currentOperations: OperationsPersistencePorts | undefined;
let currentOwnerConfiguration: OwnerConfigurationApplicationService | undefined;
let currentContentAuthoring: ContentAuthoringService | undefined;

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
  readonly operations: OperationsPersistencePorts;
  readonly ownerConfiguration?: OwnerConfigurationApplicationService;
  readonly contentAuthoring?: ContentAuthoringService;
  readonly resource: LifecycleResource;
  readonly readiness: ReadinessCheck;
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
          contentAuthoring = createContentAuthoringService({
            repository: createPostgresContentAuthoringRepository(),
            operations,
            discoveryProjection: createPostgresProjectDiscoveryProjectionWriter(),
            scope: { portfolioId: configuredScope.portfolioId.value, ownerId: configuredScope.ownerId.value },
          });
        }
        return {
          operations,
          ...(ownerConfiguration === undefined ? {} : { ownerConfiguration }),
          ...(contentAuthoring === undefined ? {} : { contentAuthoring }),
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
    currentOwnerConfiguration = dependencies.ownerConfiguration;
    currentContentAuthoring = dependencies.contentAuthoring;
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

export function getRuntimeConfig(): RuntimeConfig {
  if (current === undefined) {
    throw new Error("Runtime is not initialized: call initializeRuntime first.");
  }
  return current;
}

export function isRuntimeInitialized(): boolean {
  return current !== undefined;
}

/** Test-only seam to isolate focused suites. */
export function resetRuntimeForTests(): void {
  current = undefined;
  currentOperations = undefined;
  currentOwnerConfiguration = undefined;
  currentContentAuthoring = undefined;
  resetLifecycleForTests();
}
