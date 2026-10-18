import type { DomainEvent, StableId } from "@shared/domain";

export const OWNER_EXPORT_SCOPES = [
  "portfolio-content",
  "taxonomy",
  "media-metadata",
  "cv-metadata",
  "moderation-history",
  "analytics-reports",
  "portfolio-configuration",
] as const;

export type ExportScope = (typeof OWNER_EXPORT_SCOPES)[number];

export type ExportStatus = "requested" | "building" | "ready" | "failed" | "expired";

export interface IntegrityManifest {
  readonly schemaVersion: string;
  readonly exportId: StableId<"OwnerExport">;
  readonly checksumSha256: string;
  readonly recordCounts: Readonly<Partial<Record<ExportScope, number>>>;
}

/** Provider-neutral identity and lifecycle facts for one Owner export. */
export interface OwnerExport {
  readonly id: StableId<"OwnerExport">;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly includedScopes: readonly ExportScope[];
  readonly status: ExportStatus;
  readonly schemaVersion: string;
  readonly requestedAt: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly expiredAt?: string;
  readonly failureCode?: string;
  readonly manifest?: IntegrityManifest;
  readonly artifactId?: StableId<"OwnerExportArtifact">;
}

export type JobStatus = "available" | "leased" | "completed" | "failed" | "dead";

/** Purpose namespaces accepted by the operations worker boundary. */
export type ScopedWorkerPurpose =
  | `operations.${string}`
  | `content.${string}`
  | `taxonomy.${string}`
  | `media.${string}`
  | `cv.${string}`
  | `interaction.${string}`
  | `measurement.${string}`
  | `feedback.${string}`;

export interface OwnerExportProducedEvent extends DomainEvent<
  "portability.export_produced.v1",
  {
    readonly exportId: StableId<"OwnerExport">;
    readonly manifest: IntegrityManifest;
  }
> {}
