import { err, type ActorContext, type StableId } from "@shared/domain";
import type {
  OwnerMediaAggregateRepositoryPort,
  OwnerMediaApplicationService,
} from "./owner-contracts.js";

type ServiceParts = Pick<OwnerMediaApplicationService,
  "createOwnerMediaUploadIntent" | "recordOwnerMediaProcessing" | "acceptOwnerMediaAsset" | "rejectOwnerMediaAsset">;

function isOwner(actor: ActorContext, ownerId: StableId<"Owner">): boolean {
  return actor.kind === "owner" && actor.ownerId === ownerId;
}

export function createOwnerMediaApplicationService(input: {
  readonly ownerId: StableId<"Owner">;
  readonly aggregateRepository: OwnerMediaAggregateRepositoryPort;
  readonly uploadIntent: Pick<ServiceParts, "createOwnerMediaUploadIntent">;
  readonly processing: Pick<ServiceParts, "recordOwnerMediaProcessing">;
  readonly acceptance: Pick<ServiceParts, "acceptOwnerMediaAsset">;
  readonly rejection: Pick<ServiceParts, "rejectOwnerMediaAsset">;
}): OwnerMediaApplicationService {
  return {
    async getOwnerMediaAggregate(query) {
      if (!isOwner(query.actor, input.ownerId)) return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      if (typeof query.mediaId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(query.mediaId)) {
        return err({ kind: "validation", code: "MEDIA_ID_INVALID" });
      }
      return input.aggregateRepository.getOwnerMediaAggregate({ ownerId: input.ownerId, mediaId: query.mediaId as StableId<"MediaAsset"> });
    },
    createOwnerMediaUploadIntent: (command) => input.uploadIntent.createOwnerMediaUploadIntent(command),
    recordOwnerMediaProcessing: (command) => input.processing.recordOwnerMediaProcessing(command),
    acceptOwnerMediaAsset: (command) => input.acceptance.acceptOwnerMediaAsset(command),
    rejectOwnerMediaAsset: (command) => input.rejection.rejectOwnerMediaAsset(command),
  };
}
