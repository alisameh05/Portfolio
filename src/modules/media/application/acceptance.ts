import { err, ok, type ActorContext, type IdempotencyKey, type Rejection, type Result, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import type { TransactionContext } from "../../../runtime/ports.js";
import type {
  AcceptOwnerMediaAssetApplicationCommand,
  GetMediaAcceptanceFactsQuery,
  MediaAcceptanceFact,
  OwnerMediaCommandReceipt,
} from "./owner-contracts.js";

export interface MediaAcceptanceRepositoryFact {
  readonly mediaAssetId: StableId<"MediaAsset">;
  readonly ownerId: StableId<"Owner">;
  readonly assetVersion: number;
  readonly accepted: boolean;
  readonly safe: boolean;
  readonly suitable: boolean;
  readonly accessible: boolean;
  readonly policyVersion: string | null;
}

export interface MediaAcceptanceRepositoryPort {
  accept(input: {
    readonly actor: ActorContext;
    readonly idempotencyKey: IdempotencyKey;
    readonly expectedVersion: number;
    readonly mediaId: AcceptOwnerMediaAssetApplicationCommand["mediaId"];
    readonly accessibility: AcceptOwnerMediaAssetApplicationCommand["accessibility"];
    readonly requestHash: string;
  }): Promise<Result<OwnerMediaCommandReceipt, Rejection>>;
  getAcceptanceFacts(
    query: GetMediaAcceptanceFactsQuery,
    transaction: TransactionContext,
  ): Promise<Result<ReadonlyArray<MediaAcceptanceRepositoryFact>, Rejection>>;
}

export interface MediaAcceptanceApplicationService {
  acceptOwnerMediaAsset(
    command: AcceptOwnerMediaAssetApplicationCommand,
  ): Promise<Result<OwnerMediaCommandReceipt, Rejection>>;
  getAcceptanceFacts(
    query: GetMediaAcceptanceFactsQuery,
    transaction: TransactionContext,
  ): Promise<Result<ReadonlyArray<MediaAcceptanceFact>, Rejection>>;
}

type Accessibility = AcceptOwnerMediaAssetApplicationCommand["accessibility"];

function normalizedAccessibility(value: Accessibility): Result<Accessibility, Rejection> {
  const cleanText = (text: string, max: number): string | undefined => {
    const trimmed = text.trim();
    return trimmed.length > 0 && trimmed.length <= max && !/[\u0000-\u001f\u007f]/u.test(trimmed) ? trimmed : undefined;
  };
  if (value.kind === "described-image") {
    const altText = cleanText(value.altText, 1_000);
    return altText === undefined
      ? err({ kind: "validation", code: "MEDIA_ACCESSIBILITY_INVALID" })
      : ok({ kind: value.kind, altText });
  }
  if (value.kind === "decorative-image") return ok({ kind: value.kind });
  if (value.kind === "video" || value.kind === "document") {
    const summary = cleanText(value.summary, 2_000);
    return summary === undefined
      ? err({ kind: "validation", code: "MEDIA_ACCESSIBILITY_INVALID" })
      : ok({ kind: value.kind, summary });
  }
  return err({ kind: "validation", code: "MEDIA_ACCESSIBILITY_INVALID" });
}

function validOwnerActor(actor: ActorContext, ownerId: StableId<"Owner">): boolean {
  return actor.kind === "owner" && actor.ownerId === ownerId;
}

export function createMediaAcceptanceApplicationService(input: {
  readonly scope: { readonly ownerId: StableId<"Owner"> };
  readonly repository: MediaAcceptanceRepositoryPort;
}): MediaAcceptanceApplicationService {
  return {
    async acceptOwnerMediaAsset(command) {
      if (!validOwnerActor(command.actor, input.scope.ownerId)) {
        return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      }
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1) {
        return err({ kind: "validation", code: "MEDIA_VERSION_INVALID" });
      }
      const accessibility = normalizedAccessibility(command.accessibility);
      if (!accessibility.ok) return accessibility;
      const requestHash = await hashCanonicalRequest({
        mediaId: command.mediaId,
        expectedVersion: command.expectedVersion,
        accessibility: accessibility.value,
      });
      return input.repository.accept({ ...command, accessibility: accessibility.value, requestHash });
    },

    async getAcceptanceFacts(query, transaction) {
      if (query.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      if (transaction?.kind !== "transaction") return err({ kind: "validation", code: "MEDIA_TRANSACTION_REQUIRED" });
      const ids = [...new Set(query.mediaAssetIds)];
      if (ids.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(id))) {
        return err({ kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" });
      }
      if (ids.length === 0) return ok([]);
      const sortedIds = ids.sort();
      const result = await input.repository.getAcceptanceFacts({ ownerId: query.ownerId, mediaAssetIds: sortedIds, intendedUse: query.intendedUse }, transaction);
      if (!result.ok) return result;
      const expected = new Set(sortedIds);
      const byId = new Map<string, MediaAcceptanceRepositoryFact>();
      for (const fact of result.value) {
        if (!expected.has(fact.mediaAssetId) || byId.has(fact.mediaAssetId) || fact.ownerId !== query.ownerId ||
            !Number.isSafeInteger(fact.assetVersion) || fact.assetVersion < 1 ||
            (fact.policyVersion !== null && (fact.policyVersion.length < 1 || fact.policyVersion.length > 160))) {
          return err({ kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" });
        }
        byId.set(fact.mediaAssetId, fact);
      }
      if (byId.size !== sortedIds.length) return err({ kind: "validation", code: "MEDIA_ACCEPTANCE_FACTS_INVALID" });
      const consistencyVersion = `media-acceptance-v1:${await hashCanonicalRequest({
        policy: "media-acceptance-facts-v1",
        ownerId: query.ownerId,
        intendedUse: query.intendedUse,
        facts: sortedIds.map((id) => {
          const fact = byId.get(id)!;
          return { id, version: fact.assetVersion, accepted: fact.accepted, safe: fact.safe,
            suitable: fact.suitable, accessible: fact.accessible, policyVersion: fact.policyVersion };
        }),
      })}`;
      return ok(sortedIds.map((id) => {
        const { policyVersion: _policyVersion, ...fact } = byId.get(id)!;
        return { ...fact, consistencyVersion };
      }));
    },
  };
}
