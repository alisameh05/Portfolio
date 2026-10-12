import { err, type ActorContext, type IdempotencyKey, type Rejection, type StableId } from "@shared/domain";
import { hashCanonicalRequest } from "../../../shared/application/idempotency.js";
import { createSystemIdGenerator, type StableIdGenerator } from "../../../runtime/ports.js";
import type {
  AcceptOwnerCvVersionApplicationCommand,
  ActivateOwnerCvVersionApplicationCommand,
  GetOwnerCvPortfolioQuery,
  OwnerCvApplicationService,
  RegisterOwnerCvVersionApplicationCommand,
} from "./owner-contracts.js";
import type { CvPortfolioRepositoryPort } from "./repository.js";

function isAuthorizedOwner(actor: ActorContext, ownerId: StableId<"Owner">): boolean {
  return actor.kind === "owner" && actor.ownerId === ownerId;
}

function validIdempotencyKey(key: IdempotencyKey): boolean {
  return typeof key === "string" && /^[\x21-\x7e]{1,128}$/u.test(key);
}

function validLabel(label: string): string | undefined {
  if (typeof label !== "string" || /[\u0000-\u001f\u007f]/u.test(label)) return undefined;
  const normalized = label.trim();
  return normalized.length >= 1 && normalized.length <= 120 ? normalized : undefined;
}

function unavailable(): { readonly ok: false; readonly error: Rejection } {
  return { ok: false, error: { kind: "temporarily_unavailable", code: "CV_WORKFLOW_NOT_IMPLEMENTED" } };
}

export function createOwnerCvApplicationService(input: {
  readonly ownerId: StableId<"Owner">;
  readonly repository: CvPortfolioRepositoryPort;
  readonly ids?: StableIdGenerator;
}): OwnerCvApplicationService {
  const ids = input.ids ?? createSystemIdGenerator();

  return {
    async getOwnerCvPortfolio(query: GetOwnerCvPortfolioQuery) {
      if (!isAuthorizedOwner(query.actor, input.ownerId)) {
        return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      }
      return input.repository.getOwnerCvPortfolio(input.ownerId);
    },

    async registerOwnerCvVersion(command: RegisterOwnerCvVersionApplicationCommand) {
      if (!isAuthorizedOwner(command.actor, input.ownerId)) {
        return err({ kind: "forbidden", code: "OWNER_REQUIRED" });
      }
      const label = validLabel(command.label);
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 1 ||
          command.locale !== "en" || label === undefined || !validIdempotencyKey(command.idempotencyKey) ||
          typeof command.mediaId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(command.mediaId)) {
        return err({ kind: "validation", code: "CV_REGISTRATION_INVALID" });
      }
      const requestHash = await hashCanonicalRequest({
        ownerId: input.ownerId,
        mediaId: command.mediaId,
        locale: command.locale,
        label,
        expectedVersion: command.expectedVersion,
      });
      return input.repository.registerOwnerCvVersion({
        ownerId: input.ownerId,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        expectedVersion: command.expectedVersion,
        mediaId: command.mediaId,
        locale: command.locale,
        label,
        versionId: ids.generate("CvVersion") as StableId<"CvVersion">,
      });
    },

    async acceptOwnerCvVersion(_command: AcceptOwnerCvVersionApplicationCommand) {
      return unavailable();
    },

    async activateOwnerCvVersion(_command: ActivateOwnerCvVersionApplicationCommand) {
      return unavailable();
    },
  };
}
