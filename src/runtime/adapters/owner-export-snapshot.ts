import { err, ok, type Rejection, type Result, type StableId } from "@shared/domain";
import type { PortfolioSettingsRepository } from "../../modules/portfolio-configuration/application/settings-service.js";
import type { ContentOwnerExportRecord, ContentAuthoringRepository } from "../../modules/content-publishing/application/authoring.js";
import type { TransactionRunner } from "../ports.js";
import type { OwnerExportConfigurationSnapshot, OwnerExportSelectedSnapshot } from "../../modules/portability-operations/application/owner-export-package.js";
import type { OwnerExportSnapshotReaderPort } from "../../modules/portability-operations/application/owner-export-assembly.js";
import type { OwnerExportAssemblySnapshot } from "../../modules/portability-operations/application/owner-export-package.js";

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
  readonly content: Pick<ContentAuthoringRepository, "readOwnerExportSnapshot">;
  readonly transactions: TransactionRunner;
  readonly capabilities: OwnerExportCapabilityFactsReader;
}): OwnerExportSnapshotReaderPort {
  return {
    async capture(request): Promise<Result<OwnerExportAssemblySnapshot, Rejection>> {
      const scopes = request.includedScopes;
      const hasContent = scopes.includes("portfolio-content");
      const hasConfiguration = scopes.includes("portfolio-configuration");
      if (!hasContent && !hasConfiguration || scopes.some((scope) => scope !== "portfolio-content" && scope !== "portfolio-configuration")) {
        return err({ kind: "validation", code: "OWNER_EXPORT_SCOPE_UNSUPPORTED" });
      }
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
          const capturedAt = settings?.ok ? settings.value.capturedAt : content?.ok ? content.value.capturedAt : undefined;
          if (capturedAt === undefined || settings?.ok && settings.value.capturedAt !== capturedAt || content?.ok && content.value.capturedAt !== capturedAt) {
            throw new Error("OWNER_EXPORT_SNAPSHOT_TIME_MISMATCH");
          }
          return { capturedAt, settings: settings?.ok ? settings.value.settings : null, content: content?.ok ? content.value : undefined };
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
        if (!hasContent && configuration !== undefined) return ok(configuration);
        return ok({
          kind: "owner-export-snapshot-v1",
          snapshotId: request.snapshotId,
          capturedAt: captured.capturedAt,
          includedScopes: scopes as OwnerExportSelectedSnapshot["includedScopes"],
          ...(configuration === undefined ? {} : { configuration }),
          ...(captured.content === undefined ? {} : { content: { records: captured.content.records.map((record) => ({ contentId: record.contentId, value: portableContentRecord(record) })) } }),
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_SNAPSHOT_UNAVAILABLE" });
      }
    },
  };
}
