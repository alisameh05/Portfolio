export function canonicalizeOwnerExportManifest(manifest: unknown): string;
export function ownerExportManifestDigest(manifest: unknown): string;
export const MAX_OWNER_EXPORT_ARCHIVE_BYTES: number;
export class OwnerExportValidationError extends Error {
  readonly code: string;
}
export interface OwnerExportValidationEntry {
  readonly path: string;
  readonly scope: string;
  readonly mediaType: "application/x-ndjson" | "application/json";
  readonly recordSchema: string;
  readonly schemaPath: string;
  readonly schemaVersion: string;
  readonly digest: string;
  readonly recordCount: number;
}
interface OwnerExportValidationManifestBase extends Record<string, unknown> {
  readonly packageFormat: "shipwithali-owner-export";
  readonly createdAt: string;
  readonly algorithm: "sha-256";
  readonly digest: string;
  readonly includedScopes: readonly string[];
  readonly publicEventDataCoverage: Readonly<{ mode: "excluded" }>;
  readonly entries: readonly OwnerExportValidationEntry[];
}
export interface OwnerExportValidationManifestV1_0 extends OwnerExportValidationManifestBase {
  readonly schemaVersion: "1.0";
}
export interface OwnerExportValidationManifestV1_1 extends OwnerExportValidationManifestBase {
  readonly schemaVersion: `1.${number}`;
  readonly exportId: string;
  readonly snapshot: Readonly<{ snapshotId: string; capturedAt: string; consistency: "transactional" }>;
  readonly requiredFeatures: readonly string[];
  readonly dependencies: readonly Readonly<Record<string, unknown>>[];
  readonly exclusions: readonly string[];
  readonly schemas: readonly Readonly<Record<string, unknown>>[];
  readonly assets: readonly Readonly<Record<string, unknown>>[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}
export interface OwnerExportValidationManifestV1_8 extends OwnerExportValidationManifestV1_1 {
  readonly schemaVersion: "1.8";
}
export type OwnerExportValidationManifest = OwnerExportValidationManifestV1_0 | OwnerExportValidationManifestV1_1 | OwnerExportValidationManifestV1_8;
export interface OwnerExportValidationResult {
  readonly manifest: OwnerExportValidationManifest;
  readonly includedScopes: readonly string[];
  readonly recordCounts: Readonly<Record<string, number>>;
  readonly verifiedSchemaCount: number;
  readonly verifiedAssetCount: number;
  readonly dependencyCount: number;
  readonly archiveDigest: string;
}
export function validateOwnerExportZip(input: Uint8Array): OwnerExportValidationResult;
