import type { StableId, DomainEvent } from "@shared/domain";

export type ExportScope = "full" | "content_only" | "settings_only";

export type ExportStatus = "requested" | "processing" | "completed" | "failed";

export interface IntegrityManifest {
  readonly schemaVersion: number;
  readonly exportId: StableId<"OwnerExport">;
  readonly checksumSha256: string;
  readonly recordCounts: Readonly<Record<string, number>>;
}

export interface OwnerExport {
  readonly id: StableId<"OwnerExport">;
  readonly scope: ExportScope;
  readonly status: ExportStatus;
  readonly createdAt: string;
  readonly completedAt?: string;
  readonly manifest?: IntegrityManifest;
  readonly storagePath?: string;
}

export interface OutboxRecord {
  readonly id: StableId<"Outbox">;
  readonly eventType: string;
  readonly payload: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly dispatchedAt?: string;
}

export type JobStatus = "available" | "leased" | "completed" | "failed";

export interface LeasedJob {
  readonly id: StableId<"Job">;
  readonly jobType: string;
  readonly payload: string;
  readonly status: JobStatus;
  readonly leaseExpiresAt?: string;
}

export type AlertSeverity = "info" | "warning" | "critical";

export interface OperationalAlert {
  readonly id: StableId<"Alert">;
  readonly severity: AlertSeverity;
  readonly title: string;
  readonly details: string;
  readonly raisedAt: string;
}

// Domain events
export type OwnerExportProducedEvent = DomainEvent<
  "portability.export_produced.v1",
  {
    readonly exportId: StableId<"OwnerExport">;
    readonly manifest: IntegrityManifest;
  }
>;
