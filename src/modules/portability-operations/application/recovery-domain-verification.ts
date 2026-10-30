import { createHash } from "node:crypto";
import type { StableId } from "@shared/domain";
import type { OwnerExportSnapshotReaderPort } from "./owner-export-assembly.js";
import type { OwnerExportSelectedSnapshot } from "./owner-export-package.js";
import type { RecoveryDomainFacts } from "./recovery-rehearsal.js";

export const RECOVERY_DOMAIN_SCOPES = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata",
  "moderation-history", "analytics-reports", "portfolio-configuration"] as const;

export function recoveryDomainSnapshotSha256(snapshot: OwnerExportSelectedSnapshot): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, canonical(nested)]));
    return value;
  };
  return createHash("sha256").update(JSON.stringify(canonical(snapshot))).digest("hex");
}

function records(value: unknown): readonly Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((record): record is Record<string, unknown> =>
    record !== null && typeof record === "object" && !Array.isArray(record)) : [];
}

function valueOf(record: Record<string, unknown>): Record<string, unknown> {
  const value = record["value"];
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Verify the restored domain through the established Owner Export snapshot application boundary. */
export async function verifyRecoveryDomainMeaning(input: {
  readonly snapshots: OwnerExportSnapshotReaderPort;
  readonly portfolioId: StableId<"Portfolio">;
  readonly ownerId: StableId<"Owner">;
  readonly snapshotId: StableId<"OwnerExportArtifact">;
  readonly expectedSnapshotSha256: string;
  /** Evidence outside the export contract, such as current deletions and restored object bytes. */
  readonly currentPrivacyAndObjectChecks: Readonly<{ deletionApplied: boolean; revokedExportBytesCleared: boolean;
    revokedExportObjectRemoved: boolean; mediaObjectDigestMatches: boolean }>;
}): Promise<RecoveryDomainFacts> {
  const captured = await input.snapshots.capture({ portfolioId: input.portfolioId, ownerId: input.ownerId,
    snapshotId: input.snapshotId, includedScopes: RECOVERY_DOMAIN_SCOPES });
  if (!captured.ok || !("kind" in captured.value) || captured.value.kind !== "owner-export-snapshot-v1") {
    throw new Error("RECOVERY_DOMAIN_SNAPSHOT_UNAVAILABLE");
  }
  const snapshot = captured.value;
  const content = records(snapshot.content?.records).map(valueOf);
  const revisions = content.flatMap(record => records(record["revisions"]));
  const locales = new Set(revisions.map(revision => revision["locale"]).filter((locale): locale is string => typeof locale === "string"));
  const lifecycleStates = new Set(content.map(record => record["lifecycle"]).filter((state): state is string => typeof state === "string"));
  const routes = content.flatMap(record => records(record["routeHistory"]));
  const relationships = content.reduce((count, record) => count + records(record["relationshipHistory"]).length +
    (Array.isArray(record["relatedProjectIds"]) ? record["relatedProjectIds"].length : 0), 0);
  const taxonomy = records(snapshot.taxonomy?.records).map(valueOf);
  const taxonomyValues = taxonomy.flatMap(record => records(record["values"]));
  const taxonomyStates = new Set(taxonomyValues.map(value => value["state"]).filter((state): state is string => typeof state === "string"));
  const taxonomyHistory = taxonomy.reduce((count, record) => count + records(record["evolutionHistory"]).length, 0);
  const media = records(snapshot.media?.records).map(valueOf);
  const mediaAssets = records(snapshot.media?.assets);
  const accessibleMedia = media.filter(record => {
    const accessibility = record["accessibilityMetadata"];
    return record["state"] === "accepted" && accessibility !== null && typeof accessibility === "object";
  });
  const cvVersions = records(snapshot.cv?.versions);
  const activeCvVersions = cvVersions.filter(version => version["isCurrent"] === true);
  const moderation = records(snapshot.moderation?.records).map(valueOf);
  const analytics = records(snapshot.analytics?.records).map(valueOf);
  const analyticsGoals = analytics.filter(record => {
    const goal = record["goal"];
    return goal !== null && typeof goal === "object" && Array.isArray((goal as Record<string, unknown>)["versions"]);
  });
  const configuration = snapshot.configuration;
  const digests = mediaAssets.map(asset => asset["digest"]).filter((digest): digest is string => typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest));
  const snapshotSha256 = recoveryDomainSnapshotSha256(snapshot);
  return Object.freeze({
    ids: content.length,
    relationships,
    hashes: new Set(digests).size,
    snapshotSha256,
    expectedSnapshotSha256: input.expectedSnapshotSha256,
    locales: locales.has("en") && locales.has("ar"),
    lifecycle: lifecycleStates.size >= 2 && content.some(record => records(record["lifecycleHistory"]).length > 0),
    routes: content.some(record => typeof record["publicRouteIdentity"] === "string") && routes.length > 0 &&
      content.some(record => record["publicDiscoveryOrder"] !== null && record["publicDiscoveryOrder"] !== undefined),
    taxonomy: taxonomyValues.length >= 3 && taxonomyStates.size >= 3 && taxonomyHistory >= 3,
    mediaAccessibility: accessibleMedia.length > 0 && mediaAssets.length > 0 && digests.length === mediaAssets.length &&
      input.currentPrivacyAndObjectChecks.mediaObjectDigestMatches,
    cvHistory: cvVersions.length >= 2 && activeCvVersions.length === 1,
    moderationPrivacy: moderation.some(record => record["state"] === "suppressed" || record["state"] === "expired") &&
    moderation.some(record => records(record["decisionHistory"]).length > 0) && input.currentPrivacyAndObjectChecks.deletionApplied &&
      input.currentPrivacyAndObjectChecks.revokedExportBytesCleared && input.currentPrivacyAndObjectChecks.revokedExportObjectRemoved,
    analyticsPrivacy: analytics.length > 0 && analyticsGoals.length > 0 && analytics.some(record =>
      records(record["reports"]).some(report => report["sampleState"] === "low-sample" || report["countDisposition"] === "withheld" ||
        report["countDisposition"] === "partially-withheld")),
    configuration: configuration !== undefined && configuration.configurationVersion !== null && configuration.settings !== null &&
      configuration.capabilities.currentCvAvailable && configuration.capabilities.externalLinksAvailable,
  });
}
