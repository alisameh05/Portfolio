/**
 * fakes/owner-export.ts — Phase 2 #32 deterministic Owner export fakes.
 *
 * Test composition may inject deterministic application fakes for every
 * declared success and rejection. Production Phase 2 composition injects
 * the fail-closed fake, which returns `temporarily_unavailable` with the
 * stable `RUNTIME_NOT_IMPLEMENTED` code and never fabricates business
 * success. Real export generation, storage, delivery, retention, identity,
 * and authorization behavior remain later-phase work.
 *
 * Download fakes exercise only the declared response shape through an
 * in-memory payload: they never access storage and never produce signed
 * URLs.
 */

import type { Rejection, StableId } from "../../shared/domain/index.js";
import { unsafeStableId } from "../../shared/domain/index.js";
import type {
  DownloadOwnerExportQuery,
  ExportScope,
  GetOwnerExportQuery,
  OwnerExportApplicationService,
  OwnerExportDownloadView,
  OwnerExportRequestReceipt,
  OwnerExportView,
  RequestOwnerExportApplicationCommand,
} from "../../modules/portability-operations/index.js";

export type OwnerExportFakeMode =
  | { readonly type: "success" }
  | { readonly type: "rejection"; readonly rejection: Rejection }
  | { readonly type: "invalid-success" };

export interface OwnerExportTestFake extends OwnerExportApplicationService {
  readonly calls: {
    readonly requestOwnerExport: ReadonlyArray<RequestOwnerExportApplicationCommand>;
    readonly getOwnerExport: ReadonlyArray<GetOwnerExportQuery>;
    readonly downloadOwnerExport: ReadonlyArray<DownloadOwnerExportQuery>;
  };
}

export const OWNER_EXPORT_ID = "0196a1b2-7c3d-7e11-9f22-3a4b5c6d7ee0";
export const OWNER_EXPORT_SCHEMA_VERSION = "1.0";
export const OWNER_EXPORT_FILENAME = "shipwithali-owner-export-1.0.zip";

const DEFAULT_SCOPES: ReadonlyArray<ExportScope> = [
  "portfolio-content",
  "taxonomy",
];

function requestedView(exportId: StableId<"OwnerExport">): OwnerExportView {
  return {
    exportId,
    state: "requested",
    schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
    requestedAt: "2026-09-22T00:00:00.000Z",
    includedScopes: [...DEFAULT_SCOPES],
    publicEventDataCoverage: { mode: "excluded" },
    downloadAvailable: false,
  };
}

function invalidRequestedView(exportId: StableId<"OwnerExport">): OwnerExportView {
  return {
    exportId: "not-a-uuid" as unknown as StableId<"OwnerExport">,
    state: "requested",
    schemaVersion: "not-a-version",
    requestedAt: "not-a-datetime",
    includedScopes: [] as unknown as ExportScope[],
    publicEventDataCoverage: { mode: "excluded" },
    downloadAvailable: false,
  };
}

function receipt(exportId: string): OwnerExportRequestReceipt {
  return {
    exportId: unsafeStableId<"OwnerExport">(exportId),
    outcome: "owner-export-requested",
    state: "requested",
  };
}

function invalidReceipt(): OwnerExportRequestReceipt {
  return {
    exportId: "not-a-uuid" as unknown as StableId<"OwnerExport">,
    outcome: "owner-export-requested",
    state: "requested",
  };
}

function downloadView(exportId: StableId<"OwnerExport">): OwnerExportDownloadView {
  const bytes = new TextEncoder().encode(
    `{"packageFormat":"shipwithali-owner-export","schemaVersion":"${OWNER_EXPORT_SCHEMA_VERSION}","exportId":"${exportId}"}`,
  );
  return {
    exportId,
    schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
    filename: OWNER_EXPORT_FILENAME,
    contentLength: bytes.byteLength,
    content: (async function* () { yield bytes; })(),
  };
}

function invalidDownloadView(exportId: StableId<"OwnerExport">): OwnerExportDownloadView {
  return {
    exportId: "not-a-uuid" as unknown as StableId<"OwnerExport">,
    schemaVersion: "not-a-version",
    filename: "https://storage.example/signed?token=tok_123",
    contentLength: 0,
    content: (async function* () {})(),
  };
}

export function createOwnerExportTestFake(mode: OwnerExportFakeMode): OwnerExportTestFake {
  const requestCalls: RequestOwnerExportApplicationCommand[] = [];
  const getCalls: GetOwnerExportQuery[] = [];
  const downloadCalls: DownloadOwnerExportQuery[] = [];
  return {
    get calls() {
      return {
        requestOwnerExport: requestCalls,
        getOwnerExport: getCalls,
        downloadOwnerExport: downloadCalls,
      };
    },
    async requestOwnerExport(command: RequestOwnerExportApplicationCommand) {
      requestCalls.push(command);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: receipt(OWNER_EXPORT_ID) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidReceipt() };
      }
    },
    async getOwnerExport(query: GetOwnerExportQuery) {
      getCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: requestedView(query.exportId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidRequestedView(query.exportId) };
      }
    },
    async downloadOwnerExport(query: DownloadOwnerExportQuery) {
      downloadCalls.push(query);
      switch (mode.type) {
        case "success":
          return { ok: true as const, value: downloadView(query.exportId) };
        case "rejection":
          return { ok: false as const, error: mode.rejection };
        case "invalid-success":
          return { ok: true as const, value: invalidDownloadView(query.exportId) };
      }
    },
  };
}

/**
 * Production Phase 2 composition for the three Owner export operations.
 *
 * Every unfinished product operation fails closed with the declared 503
 * response (`temporarily_unavailable` / `RUNTIME_NOT_IMPLEMENTED`) and
 * never returns fabricated business success.
 */
export function createProductionOwnerExportService(): OwnerExportApplicationService {
  const failure = {
    ok: false as const,
    error: {
      kind: "temporarily_unavailable" as const,
      code: "RUNTIME_NOT_IMPLEMENTED",
    },
  };
  return {
    async requestOwnerExport(_command: RequestOwnerExportApplicationCommand) {
      return failure;
    },
    async getOwnerExport(_query: GetOwnerExportQuery) {
      return failure;
    },
    async downloadOwnerExport(_query: DownloadOwnerExportQuery) {
      return failure;
    },
  };
}
