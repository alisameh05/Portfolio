import { err, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionRunner } from "../../../runtime/ports.js";
import type {
  MediaDeliveryApplicationService,
  MediaDeliveryCandidate,
  MediaDeliveryLocation,
  MediaDeliveryPurpose,
  ResolveMediaDeliveryQuery,
} from "./owner-contracts.js";
import type {
  MediaDeliveryRepositoryPort,
  MediaDeliveryStoragePort,
  MediaDeliveryUsePort,
} from "./owner-contracts.js";

const DELIVERY_TTL_MS = 5 * 60 * 1000;

function unavailable(): Result<never, Rejection> {
  return err({ kind: "temporarily_unavailable", code: "MEDIA_DELIVERY_UNAVAILABLE" });
}

function validQuery(query: ResolveMediaDeliveryQuery): boolean {
  return parseStableId("MediaAsset", query.mediaAssetId).ok &&
    (query.purpose === "project" || query.purpose === "profile") &&
    (query.locale === "en" || query.locale === "ar");
}

function validCandidate(candidate: MediaDeliveryCandidate, ownerId: StableId<"Owner">, mediaAssetId: StableId<string>): boolean {
  if (candidate.mediaAssetId !== mediaAssetId || candidate.ownerId !== ownerId ||
      !Number.isSafeInteger(candidate.assetVersion) || candidate.assetVersion < 1 ||
      candidate.variants.length < 1 || candidate.variants.length > 8 ||
      typeof candidate.accessibility !== "object" || candidate.accessibility === null ||
      typeof candidate.accessibility.isDecorative !== "boolean") return false;
  const ids = new Set<string>();
  for (const variant of candidate.variants) {
    if (!parseStableId("MediaObject", variant.objectId).ok || ids.has(variant.objectId) ||
        !/^[a-z][a-z0-9-]{0,39}$/.test(variant.name) ||
        !Number.isSafeInteger(variant.byteLength) || variant.byteLength < 1 ||
        !/^[0-9a-f]{64}$/.test(variant.sha256) ||
        typeof variant.objectVersion !== "string" || variant.objectVersion.length < 1 || variant.objectVersion.length > 255 ||
        !["image/webp", "video/mp4", "video/webm", "application/pdf"].includes(variant.mimeType) ||
        (variant.width !== undefined && (!Number.isSafeInteger(variant.width) || variant.width < 1)) ||
        (variant.height !== undefined && (!Number.isSafeInteger(variant.height) || variant.height < 1)) ||
        (variant.codec !== undefined && !/^[a-zA-Z0-9._-]{1,32}$/.test(variant.codec))) return false;
    ids.add(variant.objectId);
  }
  return true;
}

function validTarget(url: string, expiresAt: string, now: number): boolean {
  if (url.length < 1 || url.length > 4096 || /[\u0000-\u0020\u007f]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    const expiry = Date.parse(expiresAt);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      parsed.username === "" && parsed.password === "" && parsed.hash === "" &&
      Number.isFinite(expiry) && expiry > now && expiry <= now + DELIVERY_TTL_MS + 2_000;
  } catch {
    return false;
  }
}

function publicPurpose(purpose: MediaDeliveryPurpose): purpose is "project" | "profile" {
  return purpose === "project" || purpose === "profile";
}

/** Resolve a public use, sealed Media snapshot, and short-lived Storage capability. */
export function createMediaDeliveryApplicationService(input: {
  readonly ownerId: StableId<"Owner">;
  readonly transactions: TransactionRunner;
  readonly use: MediaDeliveryUsePort;
  readonly repository: MediaDeliveryRepositoryPort;
  readonly storage: MediaDeliveryStoragePort;
  readonly now?: () => number;
}): MediaDeliveryApplicationService {
  const now = input.now ?? Date.now;

  return {
    async resolveDelivery(query) {
      if (!validQuery(query)) return err({ kind: "validation", code: "MEDIA_DELIVERY_QUERY_INVALID" });
      if (!publicPurpose(query.purpose)) return err({ kind: "not_found", code: "MEDIA_DELIVERY_NOT_VISIBLE" });

      const candidateResult = await input.transactions.run(async (transaction) => {
        const use = await input.use.isCurrentlyUsed(query, transaction);
        if (!use.ok) return use;
        if (!use.value) return err({ kind: "not_found" as const, code: "MEDIA_DELIVERY_NOT_VISIBLE" });
        return input.repository.getEligibleDeliveryCandidate({ ...query, ownerId: input.ownerId }, transaction);
      });
      if (!candidateResult.ok) return candidateResult;
      const candidate = candidateResult.value;
      if (!validCandidate(candidate, input.ownerId, query.mediaAssetId)) return unavailable();

      const variants: MediaDeliveryLocation["variants"][number][] = [];
      for (const candidateVariant of candidate.variants) {
        const target = await input.storage.createSignedDeliveryTarget({
          mediaAssetId: candidate.mediaAssetId,
          purpose: query.purpose,
          locale: query.locale,
          variant: candidateVariant,
        });
        if (!target.ok) return target;
        if (!validTarget(target.value.url, target.value.expiresAt, now())) return unavailable();
        variants.push({
          objectId: candidateVariant.objectId,
          name: candidateVariant.name,
          url: target.value.url,
          expiresAt: target.value.expiresAt,
          mimeType: candidateVariant.mimeType,
          byteLength: candidateVariant.byteLength,
          ...(candidateVariant.width === undefined ? {} : { width: candidateVariant.width }),
          ...(candidateVariant.height === undefined ? {} : { height: candidateVariant.height }),
          ...(candidateVariant.codec === undefined ? {} : { codec: candidateVariant.codec }),
        });
      }
      // Signing crosses the database boundary. Recheck the use after signing so a
      // hide/archive/profile change during the Storage call cannot return a new cap.
      const finalUse = await input.transactions.run((transaction) =>
        input.use.isCurrentlyUsed(query, transaction));
      if (!finalUse.ok) return finalUse;
      if (!finalUse.value) return err({ kind: "not_found" as const, code: "MEDIA_DELIVERY_NOT_VISIBLE" });
      return {
        ok: true,
        value: {
          mediaAssetId: candidate.mediaAssetId as StableId<"MediaAsset">,
          purpose: query.purpose,
          locale: query.locale,
          variants,
          accessibility: candidate.accessibility,
        },
      };
    },
  };
}
