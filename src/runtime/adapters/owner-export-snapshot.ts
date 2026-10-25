import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { PortfolioSettingsRepository } from "../../modules/portfolio-configuration/application/settings-service.js";
import type { ContentOwnerExportRecord, ContentAuthoringRepository } from "../../modules/content-publishing/application/authoring.js";
import type { TransactionRunner } from "../ports.js";
import type { OwnerExportConfigurationSnapshot, OwnerExportSelectedSnapshot } from "../../modules/portability-operations/application/owner-export-package.js";
import type { OwnerExportSnapshotReaderPort } from "../../modules/portability-operations/application/owner-export-assembly.js";
import type { OwnerExportAssemblySnapshot } from "../../modules/portability-operations/application/owner-export-package.js";
import type { TaxonomyOwnerExportSnapshotReader } from "../../modules/taxonomy-discovery/application/taxonomy-export.js";
import type { OwnerMediaExportSnapshotReaderPort } from "../../modules/media/application/owner-contracts.js";
import type { OwnerCvExportSnapshotReaderPort } from "../../modules/cv-portfolio/index.js";

type OwnerExportMediaType = NonNullable<OwnerExportSelectedSnapshot["media"]>["assets"][number]["mediaType"];
const OWNER_EXPORT_MEDIA_TYPES: readonly OwnerExportMediaType[] = [
  "application/pdf", "image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm",
];

function isOwnerExportMediaType(value: string): value is OwnerExportMediaType {
  return OWNER_EXPORT_MEDIA_TYPES.includes(value as OwnerExportMediaType);
}

export interface OwnerExportCapabilityFactsReader {
  read(scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> }): Promise<{
    readonly currentCvAvailable: boolean; readonly externalLinksAvailable: boolean;
  }>;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function portableContentRecord(source: ContentOwnerExportRecord): Readonly<Record<string, unknown>> {
  const currentByLocale = new Map(source.publications.map((publication) => [publication.locale, publication]));
  const revisions = [...source.revisions].sort((left, right) =>
    (left.locale === right.locale ? 0 : left.locale === "en" ? -1 : 1) || left.sequence - right.sequence ||
    (left.revisionId < right.revisionId ? -1 : left.revisionId > right.revisionId ? 1 : 0),
  ).map((revision) => {
    const pointer = currentByLocale.get(revision.locale);
    return {
      revisionId: revision.revisionId,
      locale: revision.locale,
      sequence: revision.sequence,
      aggregateVersion: revision.aggregateVersion,
      savedAt: revision.savedAt,
      title: revision.payload.title,
      summary: revision.payload.summary,
      body: revision.payload.body,
      reviewed: revision.reviews.length > 0,
      currentlyPublished: pointer?.revisionId === revision.revisionId,
      payload: revision.payload,
      reviews: revision.reviews,
    };
  });
  const related = new Set(source.relatedProjectIds);
  for (const revision of source.revisions) {
    const payload = revision.payload;
    if (payload.contentType === "testimonial" && payload.association?.type === "project") related.add(payload.association.projectId);
  }
  const media = new Set<string>();
  const visitMedia = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visitMedia); return; }
    if (!object(value)) return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "mediaAssetId" && typeof nested === "string") media.add(nested);
      else visitMedia(nested);
    }
  };
  visitMedia(revisions);
  const taxonomyValueIds = source.taxonomyAssignments.map((item) => item.valueId);
  const evidenceItems = new Map<string, Record<string, unknown>>();
  for (const revision of source.revisions) {
    const payload = revision.payload;
    if (payload.contentType !== "project" || payload.evidence === undefined) continue;
    const state = "unreviewed";
    const artifacts = new Map((payload.evidence.artifacts ?? []).map((artifact) => [artifact.id, artifact]));
    for (const claim of payload.evidence.claims ?? []) {
      const supportingArtifactIds = [...claim.artifactIds].sort();
      const mediaAssetId = supportingArtifactIds.map((id) => artifacts.get(id)?.mediaAssetId).find((id) => id !== undefined);
      const key = `${claim.text}\u0000${supportingArtifactIds.join(",")}`;
      evidenceItems.set(key, {
        claim: claim.text,
        state,
        supportingArtifactIds,
        ...(mediaAssetId === undefined ? {} : { mediaAssetId }),
      });
    }
  }
  const routeHistory = source.publicRoute?.reservations
    .filter((reservation) => !reservation.isCurrent)
    .map((reservation) => ({ fromSlug: reservation.slug, toSlug: source.publicRoute!.canonicalSlug })) ?? [];
  return {
    contentId: source.contentId,
    contentType: source.contentType,
    lifecycle: source.lifecycle,
    aggregateVersion: source.aggregateVersion,
    candidateSlug: source.candidateSlug,
    firstPublishedAt: source.firstPublishedAt,
    projectStatus: source.projectStatus,
    featured: source.featured,
    revisions,
    publications: source.publications,
    publicationHistory: source.publicationHistory,
    lifecycleHistory: source.lifecycleHistory,
    publicRouteIdentity: source.publicRoute?.identity ?? null,
    publicRoute: source.publicRoute,
    routeHistory,
    relatedProjectIds: [...related].sort(),
    relationshipHistory: source.relationshipHistory,
    taxonomyValueIds: [...new Set(taxonomyValueIds)].sort(),
    taxonomyAssignments: source.taxonomyAssignments,
    mediaAssetIds: [...media].sort(),
    evidenceItems: [...evidenceItems.values()],
    publicDiscoveryOrder: source.firstPublishedAt === null ? null : {
      firstPublishedAt: source.firstPublishedAt,
      tieBreaker: "content-id-desc",
    },
  };
}

/** Captures all selected source-owned facts in one repeatable-read transaction. */
export function createOwnerExportSnapshotReader(input: {
  readonly configuration: Pick<PortfolioSettingsRepository, "getSettingsSnapshot">;
  readonly content: Pick<ContentAuthoringRepository, "readOwnerExportSnapshot" | "readOwnerExportMediaLocales">;
  readonly taxonomy?: TaxonomyOwnerExportSnapshotReader;
  readonly media?: OwnerMediaExportSnapshotReaderPort;
  readonly cv?: OwnerCvExportSnapshotReaderPort;
  readonly transactions: TransactionRunner;
  readonly capabilities: OwnerExportCapabilityFactsReader;
}): OwnerExportSnapshotReaderPort {
  return {
    async capture(request): Promise<Result<OwnerExportAssemblySnapshot, Rejection>> {
      const scopes = request.includedScopes;
      const hasContent = scopes.includes("portfolio-content");
      const hasTaxonomy = scopes.includes("taxonomy");
      const hasMedia = scopes.includes("media-metadata");
      const hasCv = scopes.includes("cv-metadata");
      const hasConfiguration = scopes.includes("portfolio-configuration");
      const canonicalScopes = ["portfolio-content", "taxonomy", "media-metadata", "cv-metadata", "portfolio-configuration"].filter((scope) => scopes.includes(scope));
      if (canonicalScopes.length !== scopes.length || canonicalScopes.some((scope, index) => scopes[index] !== scope) ||
          (!hasContent && !hasTaxonomy && !hasMedia && !hasCv && !hasConfiguration) ||
          (hasCv && scopes.length !== 1 && !(scopes.length === 2 && hasMedia)) ||
          (hasMedia && scopes.length !== 1 && !(scopes.length === 2 && hasCv))) {
        return err({ kind: "validation", code: "OWNER_EXPORT_SCOPE_UNSUPPORTED" });
      }
      if (hasTaxonomy && input.taxonomy === undefined) return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_TAXONOMY_UNAVAILABLE" });
      if (hasMedia && input.media === undefined) return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_MEDIA_UNAVAILABLE" });
      if (hasCv && input.cv === undefined) return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_CV_UNAVAILABLE" });
      try {
        const captured = await input.transactions.run(async (transaction) => {
          const settings = hasConfiguration
            ? await input.configuration.getSettingsSnapshot?.({ portfolioId: request.portfolioId, ownerId: request.ownerId }, transaction)
            : undefined;
          if (settings !== undefined && !settings.ok) throw new Error("OWNER_EXPORT_CONFIGURATION_UNAVAILABLE");
          const content = hasContent
            ? await input.content.readOwnerExportSnapshot({ portfolioId: request.portfolioId, ownerId: request.ownerId }, transaction)
            : undefined;
          if (content !== undefined && !content.ok) throw new Error("OWNER_EXPORT_CONTENT_UNAVAILABLE");
          const taxonomy = hasTaxonomy
            ? await input.taxonomy!.readOwnerExportSnapshot({ portfolioId: request.portfolioId, ownerId: request.ownerId }, transaction)
            : undefined;
          if (taxonomy !== undefined && !taxonomy.ok) throw new Error("OWNER_EXPORT_TAXONOMY_UNAVAILABLE");
          const cv = hasCv
            ? await input.cv!.readOwnerCvExportSnapshot({ portfolioId: request.portfolioId, ownerId: request.ownerId }, transaction)
            : undefined;
          if (cv !== undefined && !cv.ok) throw new Error("OWNER_EXPORT_CV_UNAVAILABLE");
          const acceptedCvMediaIds = cv?.ok
            ? [...new Set(cv.value.versions.filter((version) => version.state === "accepted").map((version) => version.mediaId))]
            : [];
          const media = hasMedia || acceptedCvMediaIds.length > 0
            ? await input.media!.readOwnerMediaExportSnapshot(
              { portfolioId: request.portfolioId, ownerId: request.ownerId }, transaction,
              hasMedia ? undefined : acceptedCvMediaIds,
            )
            : undefined;
          if (media !== undefined && !media.ok) throw new Error("OWNER_EXPORT_MEDIA_UNAVAILABLE");
          const mediaLocales = hasMedia && media?.ok
            ? await input.content.readOwnerExportMediaLocales({
              mediaAssetIds: media.value.records.map((record) => record.mediaId),
              scope: { portfolioId: request.portfolioId, ownerId: request.ownerId },
            }, transaction)
            : undefined;
          if (mediaLocales !== undefined && !mediaLocales.ok) throw new Error("OWNER_EXPORT_MEDIA_LOCALES_UNAVAILABLE");
          const capturedAt = settings?.ok ? settings.value.capturedAt : content?.ok ? content.value.capturedAt : taxonomy?.ok ? taxonomy.value.capturedAt : cv?.ok ? cv.value.capturedAt : media?.ok ? media.value.capturedAt : undefined;
          if (capturedAt === undefined || settings?.ok && settings.value.capturedAt !== capturedAt ||
              content?.ok && content.value.capturedAt !== capturedAt || taxonomy?.ok && taxonomy.value.capturedAt !== capturedAt || cv?.ok && cv.value.capturedAt !== capturedAt ||
              media?.ok && media.value.capturedAt !== capturedAt) {
            throw new Error("OWNER_EXPORT_SNAPSHOT_TIME_MISMATCH");
          }
          return {
            capturedAt,
            settings: settings?.ok ? settings.value.settings : null,
            content: content?.ok ? content.value : undefined,
            taxonomy: taxonomy?.ok ? taxonomy.value : undefined,
            media: hasMedia && media?.ok ? media.value : undefined,
            cv: cv?.ok ? cv.value : undefined,
            cvMedia: media?.ok ? media.value : undefined,
            mediaLocales: mediaLocales?.ok ? mediaLocales.value : undefined,
          };
        }, { isolationLevel: "repeatable read" });
        let configuration: OwnerExportConfigurationSnapshot | undefined;
        if (hasConfiguration) {
          const capabilityFacts = await input.capabilities.read({ portfolioId: request.portfolioId, ownerId: request.ownerId });
          configuration = {
            snapshotId: request.snapshotId,
            capturedAt: captured.capturedAt,
            configurationVersion: captured.settings?.version ?? null,
            settings: captured.settings,
            capabilities: {
              ...capabilityFacts,
              globalProjectCtaAvailable: captured.settings !== null,
            },
          };
        }
        if (!hasContent && !hasTaxonomy && !hasMedia && !hasCv && configuration !== undefined) return ok(configuration);
        const localesByMedia = new Map((captured.mediaLocales ?? []).map((fact) => [fact.mediaAssetId, fact.locales]));
        const mediaRecords = captured.media?.records.map((record) => {
          const locales = localesByMedia.get(record.mediaId) ?? [];
          const currentState = record.value["state"];
          if (locales.length > 0 && record.value["publicationEligibility"] !== "eligible") throw new Error("OWNER_EXPORT_MEDIA_USAGE_INELIGIBLE");
          return {
            ...record,
            value: {
              ...record.value,
              locales,
              publicationState: currentState === "rejected" ? "withdrawn" : currentState === "accepted" && locales.length > 0 ? "published" : record.value["publicationState"],
            },
          };
        });
        const cvAssets = captured.cv === undefined ? undefined : captured.cv.versions
          .filter((version) => version.state === "accepted")
          .map((version) => {
            const binding = version.acceptedMediaSnapshot;
            const media = captured.cvMedia;
            if (binding === undefined || media === undefined) throw new Error("OWNER_EXPORT_CV_MEDIA_BYTES_MISSING");
            const mediaRecord = media.records.find((record) => record.mediaId === version.mediaId);
            if (mediaRecord === undefined || mediaRecord.value["kind"] !== "document" || mediaRecord.value["state"] !== "accepted" ||
                mediaRecord.value["publicationEligibility"] !== "eligible" || Number(mediaRecord.value["aggregateVersion"]) !== binding.mediaAssetVersion) {
              throw new Error("OWNER_EXPORT_CV_MEDIA_INELIGIBLE");
            }
            const asset = media.assets.find((candidate) => candidate.mediaId === version.mediaId && candidate.source === "variant" &&
              candidate.objectId === binding.mediaObjectId && candidate.assetVersion === binding.mediaAssetVersion &&
              candidate.decisionId === binding.mediaDecisionId && candidate.sha256 === binding.sha256 &&
              candidate.objectVersion === binding.objectVersion && candidate.mediaType === "application/pdf");
            if (asset === undefined) throw new Error("OWNER_EXPORT_CV_MEDIA_SNAPSHOT_MISMATCH");
            return {
              path: `assets/media-metadata/sha256/${binding.sha256}`,
              mediaId: asset.mediaId,
              variantName: asset.variantName,
              mediaType: "application/pdf" as const,
              byteLength: asset.byteLength,
              digest: binding.sha256,
              objectId: binding.mediaObjectId,
              source: "variant" as const,
              assetVersion: binding.mediaAssetVersion,
              decisionId: binding.mediaDecisionId,
              objectVersion: binding.objectVersion,
            };
          });
        return ok({
          kind: "owner-export-snapshot-v1",
          snapshotId: request.snapshotId,
          capturedAt: captured.capturedAt,
          includedScopes: scopes as OwnerExportSelectedSnapshot["includedScopes"],
          ...(configuration === undefined ? {} : { configuration }),
          ...(captured.content === undefined ? {} : { content: { records: captured.content.records.map((record) => ({ contentId: record.contentId, value: portableContentRecord(record) })) } }),
          ...(captured.taxonomy === undefined ? {} : { taxonomy: { records: captured.taxonomy.taxonomies.map((record) => ({
            taxonomyId: record.taxonomyId,
            value: {
              taxonomyId: record.taxonomyId,
              aggregateVersion: record.aggregateVersion,
              kind: record.kind,
              values: record.values,
              evolutionHistory: record.evolutionHistory,
              assignments: record.assignments,
              assignmentHistory: record.assignmentHistory,
            },
          })) } }),
          ...(captured.media === undefined ? {} : { media: {
            records: mediaRecords!.map((record) => ({ mediaId: record.mediaId, value: record.value })),
            assets: captured.media.assets.map((asset) => {
              if (!isOwnerExportMediaType(asset.mediaType)) throw new Error("OWNER_EXPORT_MEDIA_TYPE_UNSUPPORTED");
              return {
                path: `assets/media-metadata/sha256/${asset.sha256}`,
                mediaId: asset.mediaId,
                variantName: asset.variantName,
                mediaType: asset.mediaType,
                byteLength: asset.byteLength,
                digest: asset.sha256,
                objectId: asset.objectId,
                source: asset.source,
                ...(asset.uploadIntentId === undefined ? {} : { uploadIntentId: asset.uploadIntentId }),
                ...(asset.assetVersion === undefined ? {} : { assetVersion: asset.assetVersion }),
                ...(asset.decisionId === undefined ? {} : { decisionId: asset.decisionId }),
                ...(asset.objectVersion === undefined ? {} : { objectVersion: asset.objectVersion }),
              };
            }),
          } }),
          ...(captured.cv === undefined ? {} : { cv: captured.cv, cvAssets: cvAssets!.map((asset) => ({
            path: `assets/media-metadata/sha256/${asset.digest}`,
            mediaId: asset.mediaId,
            variantName: asset.variantName,
            mediaType: asset.mediaType,
            byteLength: asset.byteLength,
            digest: asset.digest,
            objectId: asset.objectId,
            source: asset.source,
            assetVersion: asset.assetVersion,
            decisionId: asset.decisionId,
            objectVersion: asset.objectVersion,
          })) }),
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_SNAPSHOT_UNAVAILABLE" });
      }
    },
    async revalidateMediaForReady({ snapshot, portfolioId, ownerId, context }) {
      if (input.media === undefined || !("kind" in snapshot)) return false;
      const versions = new Map<StableId<"MediaAsset">, number>();
      if (snapshot.media !== undefined) {
        for (const record of snapshot.media.records) {
          if (record.value["state"] !== "accepted" || record.value["byteCoverage"] !== "included") continue;
          if (typeof record.value["aggregateVersion"] !== "number" || !Number.isSafeInteger(record.value["aggregateVersion"])) return false;
          const mediaId = parseStableId("MediaAsset", record.mediaId);
          if (!mediaId.ok) return false;
          versions.set(mediaId.value, record.value["aggregateVersion"]);
        }
      }
      if (snapshot.cv !== undefined) {
        for (const version of snapshot.cv.versions) {
          if (version.state !== "accepted") continue;
          if (version.acceptedMediaSnapshot === undefined) return false;
          const mediaId = version.mediaId;
          const versionNumber = version.acceptedMediaSnapshot.mediaAssetVersion;
          const existing = versions.get(mediaId);
          if (existing !== undefined && existing !== versionNumber) return false;
          versions.set(mediaId, versionNumber);
        }
      }
      const result = await input.media.revalidateOwnerMediaExportSnapshot({ portfolioId, ownerId }, versions, context);
      return result.ok && result.value;
    },
  };
}
