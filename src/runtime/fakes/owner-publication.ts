/**
 * fakes/owner-publication.ts — Phase 2 #30 deterministic Owner Publication fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real publication, lifecycle, evidence, route, persistence, and
 * authorization behavior remain later-phase work.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import type {
  ArchiveOwnerContentApplicationCommand,
  GetOwnerContentAggregateQuery,
  HideOwnerContentApplicationCommand,
  OwnerContentAggregateView,
  OwnerPublicationApplicationService,
  OwnerPublicationCommandReceipt,
  PublishOwnerContentLanguageApplicationCommand,
  RestoreOwnerContentApplicationCommand,
  SaveOwnerContentRevisionApplicationCommand,
  SaveOwnerContentRevisionReceipt,
} from "../http/owner-publication.js";

export type OwnerPublicationFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerPublicationTestFake extends OwnerPublicationApplicationService {
  readonly calls: {
    readonly getOwnerContentAggregate: ReadonlyArray<GetOwnerContentAggregateQuery>;
    readonly saveOwnerContentRevision: ReadonlyArray<SaveOwnerContentRevisionApplicationCommand>;
    readonly publishOwnerContentLanguage: ReadonlyArray<PublishOwnerContentLanguageApplicationCommand>;
    readonly hideOwnerContent: ReadonlyArray<HideOwnerContentApplicationCommand>;
    readonly archiveOwnerContent: ReadonlyArray<ArchiveOwnerContentApplicationCommand>;
    readonly restoreOwnerContent: ReadonlyArray<RestoreOwnerContentApplicationCommand>;
  };
}

const REVISION_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ea5";

function aggregateView(contentId: StableId<string>): OwnerContentAggregateView {
  return {
    contentId,
    aggregateVersion: 1,
    contentType: "project",
    lifecycle: "draft",
    publicRoute: null,
    routeHistory: [],
    localizedStreams: {
      en: { revisionCount: 1, currentPublishedRevisionId: null },
    },
    revisions: [
      {
        revisionId: REVISION_ID as StableId<string>,
        locale: "en",
        sequence: 1,
        reviewed: false,
      },
    ],
  };
}

function invalidAggregateView(contentId: StableId<string>): OwnerContentAggregateView {
  return {
    contentId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    contentType: "project",
    lifecycle: "draft",
    publicRoute: null,
    routeHistory: [],
    localizedStreams: {
      en: { revisionCount: 1, currentPublishedRevisionId: null },
    },
    revisions: [
      {
        revisionId: contentId,
        locale: "en",
        sequence: 1,
        reviewed: false,
      },
    ],
  };
}

function revisionReceipt(
  aggregateId: StableId<string>,
  aggregateVersion: number,
): SaveOwnerContentRevisionReceipt {
  return {
    aggregateId,
    aggregateVersion,
    outcome: "revision-saved",
    revisionId: REVISION_ID as StableId<string>,
  };
}

function commandReceipt(
  aggregateId: StableId<string>,
  aggregateVersion: number,
  outcome: OwnerPublicationCommandReceipt["outcome"],
): OwnerPublicationCommandReceipt {
  return { aggregateId, aggregateVersion, outcome };
}

function invalidRevisionReceipt(): SaveOwnerContentRevisionReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "revision-saved",
    revisionId: "not-a-uuid" as unknown as StableId<string>,
  };
}

function invalidCommandReceipt(): OwnerPublicationCommandReceipt {
  return {
    aggregateId: "not-a-uuid" as unknown as StableId<string>,
    aggregateVersion: -1,
    outcome: "content-hidden",
  };
}

export function createOwnerPublicationTestFake(mode: OwnerPublicationFakeMode): OwnerPublicationTestFake {
  const getCalls: GetOwnerContentAggregateQuery[] = [];
  const saveCalls: SaveOwnerContentRevisionApplicationCommand[] = [];
  const publishCalls: PublishOwnerContentLanguageApplicationCommand[] = [];
  const hideCalls: HideOwnerContentApplicationCommand[] = [];
  const archiveCalls: ArchiveOwnerContentApplicationCommand[] = [];
  const restoreCalls: RestoreOwnerContentApplicationCommand[] = [];
  return {
    get calls() {
      return {
        getOwnerContentAggregate: getCalls,
        saveOwnerContentRevision: saveCalls,
        publishOwnerContentLanguage: publishCalls,
        hideOwnerContent: hideCalls,
        archiveOwnerContent: archiveCalls,
        restoreOwnerContent: restoreCalls,
      };
    },
    async getOwnerContentAggregate(query: GetOwnerContentAggregateQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: aggregateView(query.contentId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidAggregateView(query.contentId) };
      }
    },
    async saveOwnerContentRevision(command: SaveOwnerContentRevisionApplicationCommand) {
      saveCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: revisionReceipt(command.contentId, command.expectedVersion + 1),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidRevisionReceipt() };
      }
    },
    async publishOwnerContentLanguage(command: PublishOwnerContentLanguageApplicationCommand) {
      publishCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: commandReceipt(command.contentId, command.expectedVersion + 1, "language-published"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidCommandReceipt() };
      }
    },
    async hideOwnerContent(command: HideOwnerContentApplicationCommand) {
      hideCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: commandReceipt(command.contentId, command.expectedVersion + 1, "content-hidden"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidCommandReceipt() };
      }
    },
    async archiveOwnerContent(command: ArchiveOwnerContentApplicationCommand) {
      archiveCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: commandReceipt(command.contentId, command.expectedVersion + 1, "content-archived"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidCommandReceipt() };
      }
    },
    async restoreOwnerContent(command: RestoreOwnerContentApplicationCommand) {
      restoreCalls.push(command);
      switch (mode.type) {
        case "success":
          return {
            ok: true as const,
            value: commandReceipt(command.contentId, command.expectedVersion + 1, "content-restored"),
          };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidCommandReceipt() };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the six Owner Publication operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerPublicationService(): OwnerPublicationApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async getOwnerContentAggregate(_query: GetOwnerContentAggregateQuery) {
      return failure;
    },
    async saveOwnerContentRevision(_command: SaveOwnerContentRevisionApplicationCommand) {
      return failure;
    },
    async publishOwnerContentLanguage(_command: PublishOwnerContentLanguageApplicationCommand) {
      return failure;
    },
    async hideOwnerContent(_command: HideOwnerContentApplicationCommand) {
      return failure;
    },
    async archiveOwnerContent(_command: ArchiveOwnerContentApplicationCommand) {
      return failure;
    },
    async restoreOwnerContent(_command: RestoreOwnerContentApplicationCommand) {
      return failure;
    },
  };
}
