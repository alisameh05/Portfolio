import { sql } from "kysely";
import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type {
  OwnerCvExportSnapshot,
  OwnerCvExportSnapshotReaderPort,
} from "../application/owner-export-snapshot.js";

const HISTORY_LIMIT = 100;

interface RootRow {
  readonly aggregate_version: number | string;
  readonly current_version_id: string | null;
}

interface VersionRow {
  readonly version_id: string;
  readonly media_id: string;
  readonly media_asset_version: number | string;
  readonly version_number: number | string;
  readonly locale: string;
  readonly label: string;
  readonly state: string;
  readonly registered_at: Date | string;
  readonly is_current: boolean;
  readonly media_decision_id: string;
  readonly media_object_id: string;
  readonly media_sha256: string;
  readonly media_object_version: string;
}

interface AcceptanceRow {
  readonly approval_id: string;
  readonly version_id: string;
  readonly media_decision_id: string;
  readonly media_object_id: string;
  readonly media_sha256: string;
  readonly media_object_version: string;
  readonly accepted_at: Date | string;
}

interface ActivationRow {
  readonly activation_id: string;
  readonly version_id: string;
  readonly activated_at: Date | string;
}

function stableId<K extends string>(kind: K, value: string): StableId<K> {
  const parsed = parseStableId(kind, value);
  if (!parsed.ok) throw new PostgresInfrastructureError();
  return parsed.value;
}

function integer(value: number | string, min = 1): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min) throw new PostgresInfrastructureError();
  return result;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new PostgresInfrastructureError();
  return date.toISOString();
}

function mediaSnapshot(row: VersionRow) {
  if (!/^[a-f0-9]{64}$/.test(row.media_sha256) || row.media_object_version.length < 1 || row.media_object_version.length > 255) {
    throw new PostgresInfrastructureError();
  }
  return {
    mediaAssetVersion: integer(row.media_asset_version),
    mediaDecisionId: stableId("MediaDecision", row.media_decision_id),
    mediaObjectId: stableId("MediaObject", row.media_object_id),
    sha256: row.media_sha256,
    objectVersion: row.media_object_version,
  };
}

function sameMediaSnapshot(left: ReturnType<typeof mediaSnapshot>, right: AcceptanceRow): boolean {
  return left.mediaDecisionId === right.media_decision_id && left.mediaObjectId === right.media_object_id &&
    left.sha256 === right.media_sha256 && left.objectVersion === right.media_object_version;
}

/** Reads CV-owned retained facts through the purpose-bound Worker policy. */
export function createPostgresOwnerCvExportSnapshotReader(): OwnerCvExportSnapshotReaderPort {
  return {
    async readOwnerCvExportSnapshot(scope, context): Promise<Result<OwnerCvExportSnapshot, Rejection>> {
      const read = async (transaction: TransactionContext): Promise<OwnerCvExportSnapshot> => {
        const executor = resolvePostgresTransaction(transaction);
        await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${scope.ownerId}, true),
                         set_config('shipwithali.worker_purpose', 'cv.owner-export', true)`.execute(executor);
        const captured = await sql<{ readonly captured_at: Date | string }>`
          select transaction_timestamp() as captured_at
        `.execute(executor);
        const rootResult = await sql<RootRow>`
          select aggregate_version, current_version_id::text as current_version_id
            from cv_portfolio.portfolios
           where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
        `.execute(executor);
        if (rootResult.rows.length > 1) throw new PostgresInfrastructureError();
        const root = rootResult.rows[0];
        const currentVersionId = root === undefined || root.current_version_id === null
          ? null
          : stableId("CvVersion", root.current_version_id);

        const versionResult = await sql<VersionRow>`
          select version_id::text as version_id, media_id::text as media_id, media_asset_version,
                 version_number, locale, label, state, registered_at, is_current,
                 media_decision_id::text as media_decision_id, media_object_id::text as media_object_id,
                 media_sha256, media_object_version
            from cv_portfolio.versions
           where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
           order by version_number desc, version_id desc
           limit ${HISTORY_LIMIT + 1}
        `.execute(executor);
        let retainedVersions = [...versionResult.rows.slice(0, HISTORY_LIMIT)];
        let versionsTruncated = versionResult.rows.length > HISTORY_LIMIT;
        if (currentVersionId !== null && !retainedVersions.some((row) => row.version_id === currentVersionId)) {
          const currentResult = await sql<VersionRow>`
            select version_id::text as version_id, media_id::text as media_id, media_asset_version,
                   version_number, locale, label, state, registered_at, is_current,
                   media_decision_id::text as media_decision_id, media_object_id::text as media_object_id,
                   media_sha256, media_object_version
              from cv_portfolio.versions
             where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
               and version_id = ${currentVersionId}::uuid
          `.execute(executor);
          const current = currentResult.rows[0];
          if (current === undefined || current.state !== "accepted" || !current.is_current) throw new PostgresInfrastructureError();
          retainedVersions = [...retainedVersions.slice(0, HISTORY_LIMIT - 1), current]
            .sort((left, right) => integer(right.version_number) - integer(left.version_number) ||
              (left.version_id < right.version_id ? 1 : left.version_id > right.version_id ? -1 : 0));
          versionsTruncated = true;
        }

        const recentAcceptances = await sql<AcceptanceRow>`
          select approval_id::text as approval_id, version_id::text as version_id,
                 media_decision_id::text as media_decision_id, media_object_id::text as media_object_id,
                 media_sha256, media_object_version, accepted_at
            from cv_portfolio.acceptance_history
           where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
           order by accepted_at desc, approval_id desc
           limit ${HISTORY_LIMIT + 1}
        `.execute(executor);
        const activations = await sql<ActivationRow>`
          select activation_id::text as activation_id, version_id::text as version_id, activated_at
            from cv_portfolio.activation_history
           where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
           order by activated_at desc, activation_id desc
           limit ${HISTORY_LIMIT + 1}
        `.execute(executor);

        const acceptedVersionIds = retainedVersions.filter((row) => row.state === "accepted").map((row) => row.version_id);
        const versionAcceptances = acceptedVersionIds.length === 0 ? { rows: [] as AcceptanceRow[] } : await sql<AcceptanceRow>`
          select approval_id::text as approval_id, version_id::text as version_id,
                 media_decision_id::text as media_decision_id, media_object_id::text as media_object_id,
                 media_sha256, media_object_version, accepted_at
            from cv_portfolio.acceptance_history
           where portfolio_id = ${scope.portfolioId}::uuid and owner_id = ${scope.ownerId}::uuid
             and version_id = any(${acceptedVersionIds}::uuid[])
        `.execute(executor);

        const acceptanceByVersion = new Map(versionAcceptances.rows.map((row) => [row.version_id, row]));
        const versions = retainedVersions.map((row) => {
          const versionId = stableId("CvVersion", row.version_id);
          const mediaId = stableId("MediaAsset", row.media_id);
          const isCurrent = currentVersionId === versionId;
          if (row.locale !== "en" || (row.state !== "registered" && row.state !== "accepted") || row.is_current !== isCurrent) {
            throw new PostgresInfrastructureError();
          }
          const acceptedMediaSnapshot = mediaSnapshot(row);
          if (row.state === "accepted") {
            const approval = acceptanceByVersion.get(row.version_id);
            if (approval === undefined || !sameMediaSnapshot(acceptedMediaSnapshot, approval)) throw new PostgresInfrastructureError();
          } else if (acceptanceByVersion.has(row.version_id)) {
            throw new PostgresInfrastructureError();
          }
          const acceptance = acceptanceByVersion.get(row.version_id);
          return {
            versionId,
            mediaId,
            locale: "en" as const,
            label: row.label,
            state: row.state,
            isCurrent,
            versionNumber: integer(row.version_number),
            registeredAt: iso(row.registered_at),
            ...(row.state === "accepted" ? { acceptedAt: iso(acceptance!.accepted_at), acceptedMediaSnapshot } : {}),
          };
        });
        if (currentVersionId !== null && !versions.some((version) => version.versionId === currentVersionId && version.isCurrent && version.state === "accepted")) {
          throw new PostgresInfrastructureError();
        }

        const versionIds = new Set(versions.map((version) => version.versionId));
        const acceptanceHistory = recentAcceptances.rows.slice(0, HISTORY_LIMIT).map((row) => ({
          approvalId: stableId("CvAcceptance", row.approval_id),
          versionId: stableId("CvVersion", row.version_id),
          acceptedAt: iso(row.accepted_at),
        }));
        const activationHistory = activations.rows.slice(0, HISTORY_LIMIT).map((row) => ({
          activationId: stableId("CvActivation", row.activation_id),
          versionId: stableId("CvVersion", row.version_id),
          activatedAt: iso(row.activated_at),
        }));
        if (!versionsTruncated && (acceptanceHistory.some((entry) => !versionIds.has(entry.versionId)) ||
            activationHistory.some((entry) => !versionIds.has(entry.versionId)))) throw new PostgresInfrastructureError();
        const capturedAt = captured.rows[0]?.captured_at;
        if (capturedAt === undefined) throw new PostgresInfrastructureError();
        return {
          capturedAt: iso(capturedAt),
          aggregateVersion: root === undefined ? 1 : integer(root.aggregate_version),
          currentVersionId,
          versions,
          versionsTruncated,
          acceptanceHistory,
          acceptanceHistoryTruncated: recentAcceptances.rows.length > HISTORY_LIMIT,
          activationHistory,
          activationHistoryTruncated: activations.rows.length > HISTORY_LIMIT,
        };
      };
      try {
        return ok(await read(context));
      } catch {
        return err({ kind: "temporarily_unavailable", code: "CV_OWNER_EXPORT_UNAVAILABLE" });
      }
    },
  };
}
