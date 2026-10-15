import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { sql, type Kysely } from "kysely";
import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { AcceptedPdfSnapshot, MediaReadApplicationService } from "../../media/index.js";
import type { CurrentCvSnapshot, OwnerCvActivationView, OwnerCvCommandReceipt, OwnerCvPortfolioView, OwnerCvVersionView, RegisterOwnerCvVersionReceipt } from "../application/owner-contracts.js";
import type { CurrentCvSnapshotRepositoryPort } from "../application/current-delivery.js";
import type { AcceptCvPortfolioVersionInput, ActivateCvPortfolioVersionInput, CvPortfolioRepositoryPort, GetCurrentCvMediaUsageInput, RegisterCvPortfolioVersionInput } from "../application/repository.js";

interface RootRow {
  readonly portfolio_id: string;
  readonly owner_id: string;
  readonly aggregate_version: number | string;
  readonly current_version_id: string | null;
}

interface VersionRow {
  readonly version_id: string;
  readonly media_id: string;
  readonly locale: string;
  readonly label: string;
  readonly state: string;
  readonly version_number: number | string;
  readonly is_current: boolean;
}

interface ActivationRow {
  readonly version_id: string;
  readonly activated_at: Date | string;
}

interface ReplayRow {
  readonly request_hash: string;
  readonly version_id: string;
  readonly aggregate_version: number | string;
}

interface CvSnapshotRow {
  readonly media_id: string;
  readonly media_asset_version: number | string;
  readonly state: string;
  readonly media_decision_id: string;
  readonly media_object_id: string;
  readonly media_sha256: string;
  readonly media_object_version: string;
}

interface AcceptanceReplayRow {
  readonly request_hash: string;
  readonly version_id: string;
  readonly aggregate_version: number | string;
}

interface ActivationReplayRow {
  readonly request_hash: string;
  readonly version_id: string;
  readonly aggregate_version: number | string;
}

function keyHash(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function stableId<K extends string>(kind: K, value: string): StableId<K> {
  const parsed = parseStableId(kind, value);
  if (!parsed.ok) throw new PostgresInfrastructureError();
  return parsed.value;
}

function mapVersion(row: VersionRow, currentVersionId: string | null): OwnerCvVersionView {
  if (row.locale !== "en" || (row.state !== "registered" && row.state !== "accepted")) {
    throw new PostgresInfrastructureError();
  }
  if (row.is_current !== (row.version_id === currentVersionId)) throw new PostgresInfrastructureError();
  return {
    versionId: stableId("CvVersion", row.version_id),
    mediaId: stableId("MediaAsset", row.media_id),
    locale: "en",
    label: row.label,
    state: row.state,
    isCurrent: row.is_current,
  };
}

function isoInstant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new PostgresInfrastructureError();
  return result;
}

function activationMediaSnapshotMatches(
  media: AcceptedPdfSnapshot,
  registered: CvSnapshotRow,
  mediaAssetId: StableId<"MediaAsset">,
  ownerId: StableId<"Owner">,
): boolean {
  return media.mediaAssetId === mediaAssetId && media.ownerId === ownerId &&
    media.assetVersion === Number(registered.media_asset_version) &&
    media.decisionId === registered.media_decision_id && media.objectId === registered.media_object_id &&
    media.sha256 === registered.media_sha256 && media.objectVersion === registered.media_object_version;
}

export function createPostgresCvPortfolioRepository(input: {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
  readonly media: Pick<MediaReadApplicationService, "getAcceptanceFacts" | "getAcceptedPdfSnapshot" | "preflightAcceptedPdfObject">;
}): CvPortfolioRepositoryPort {
  const setScope = async (context: TransactionContext): Promise<void> => {
    const executor = resolvePostgresTransaction(context);
    await sql`select set_config('shipwithali.portfolio_id', ${input.scope.portfolioId}, true),
                     set_config('shipwithali.owner_id', ${input.scope.ownerId}, true)`
      .execute(executor);
  };

  const ensureRoot = async (context: TransactionContext): Promise<RootRow | undefined> => {
    const executor = resolvePostgresTransaction(context);
    await setScope(context);
    await sql`insert into cv_portfolio.portfolios (portfolio_id, owner_id, aggregate_version)
      select settings.portfolio_id, settings.owner_id, 1
        from portfolio_config.settings settings
       where settings.portfolio_id = ${input.scope.portfolioId}::uuid
         and settings.owner_id = ${input.scope.ownerId}::uuid
      -- Both the primary key and the Owner-scope unique key can arbitrate
      -- simultaneous initialization. The scoped read below still fails closed.
      on conflict do nothing`.execute(executor);
    const selected = await sql<RootRow>`select portfolio_id::text as portfolio_id, owner_id::text as owner_id,
        aggregate_version, current_version_id::text as current_version_id
      from cv_portfolio.portfolios
      where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid`
      .execute(executor);
    return selected.rows[0];
  };

  return {
    async getOwnerCvPortfolio(ownerId) {
      if (ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      try {
        return await input.transactions.run(async (context) => {
          const root = await ensureRoot(context);
          if (root === undefined) return err({ kind: "not_found", code: "CV_PORTFOLIO_NOT_CONFIGURED" });
          const executor = resolvePostgresTransaction(context);
          const versions = await sql<VersionRow>`select version_id::text as version_id, media_id::text as media_id,
              locale, label, state, version_number, is_current
            from cv_portfolio.versions
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
             order by version_number desc, version_id desc limit 101`.execute(executor);
          const activations = await sql<ActivationRow>`select version_id::text as version_id, activated_at
            from cv_portfolio.activation_history
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            order by activated_at desc, activation_id desc limit 101`.execute(executor);
          const currentVersionId = root.current_version_id;
          const view: OwnerCvPortfolioView = {
            aggregateVersion: Number(root.aggregate_version),
            currentVersionId: currentVersionId === null ? null : stableId("CvVersion", currentVersionId),
            versions: versions.rows.slice(0, 100).map((row) => mapVersion(row, currentVersionId)),
            versionsTruncated: versions.rows.length > 100,
            activationHistory: activations.rows.slice(0, 100).map((row): OwnerCvActivationView => ({
              versionId: stableId("CvVersion", row.version_id),
              activatedAt: isoInstant(row.activated_at),
            })),
            activationHistoryTruncated: activations.rows.length > 100,
          };
          return ok(view);
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "CV_PORTFOLIO_READ_FAILED" });
      }
    },

    async registerOwnerCvVersion(command: RegisterCvPortfolioVersionInput): Promise<Result<RegisterOwnerCvVersionReceipt, Rejection>> {
      if (command.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      const idempotencyKeyHash = keyHash(command.idempotencyKey);
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setScope(context);
          await sql`select set_config('lock_timeout', '3s', true),
                           set_config('statement_timeout', '5s', true),
                           set_config('transaction_timeout', '8s', true)`.execute(executor);

          const replay = await sql<ReplayRow>`select request_hash, version_id::text as version_id, aggregate_version
            from cv_portfolio.registration_commands
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
              and idempotency_key_hash = ${idempotencyKeyHash}`.execute(executor);
          const previous = replay.rows[0];
          if (previous !== undefined) {
            if (previous.request_hash !== command.requestHash) return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
            return ok({ versionId: stableId("CvVersion", previous.version_id),
              aggregateVersion: Number(previous.aggregate_version), outcome: "cv-version-registered" });
          }

          // Media facts acquire the shared Media lock. Keep this before the CV
          // root lock so publication, rejection and registration share the
          // documented Media-before-root order.
          const mediaResult = await input.media.getAcceptedPdfSnapshot({
            ownerId: input.scope.ownerId,
            mediaAssetId: command.mediaId as StableId<"MediaAsset">,
          }, context);
          if (!mediaResult.ok) return mediaResult;
          if (mediaResult.value.status === "not-eligible") return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          if (mediaResult.value.status === "not-pdf") {
            return err({ kind: "validation", code: "CV_REQUIRES_ACCEPTED_ENGLISH_PDF" });
          }
          const mediaSnapshot = mediaResult.value.snapshot;
          if (mediaSnapshot.mediaAssetId !== command.mediaId || mediaSnapshot.ownerId !== input.scope.ownerId) {
            return err({ kind: "validation", code: "CV_REQUIRES_ACCEPTED_ENGLISH_PDF" });
          }

          const root = await ensureRoot(context);
          if (root === undefined) return err({ kind: "not_found", code: "CV_PORTFOLIO_NOT_CONFIGURED" });
          const locked = await sql<RootRow>`select portfolio_id::text as portfolio_id, owner_id::text as owner_id,
              aggregate_version, current_version_id::text as current_version_id
            from cv_portfolio.portfolios
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            for update`.execute(executor);
          const current = locked.rows[0];
          if (current === undefined) throw new PostgresInfrastructureError();
          const committedReplay = await sql<ReplayRow>`select request_hash, version_id::text as version_id, aggregate_version
            from cv_portfolio.registration_commands
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
              and idempotency_key_hash = ${idempotencyKeyHash}`.execute(executor);
          const committed = committedReplay.rows[0];
          if (committed !== undefined) {
            if (committed.request_hash !== command.requestHash) return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
            return ok({ versionId: stableId("CvVersion", committed.version_id),
              aggregateVersion: Number(committed.aggregate_version), outcome: "cv-version-registered" });
          }
          if (Number(current.aggregate_version) !== command.expectedVersion) {
            return { ok: false, error: { kind: "precondition_failed", code: "CV_PORTFOLIO_VERSION_MISMATCH", currentVersion: Number(current.aggregate_version) } };
          }
          const latest = await sql<{ readonly next_version: number | string }>`select coalesce(max(version_number), 0) + 1 as next_version
            from cv_portfolio.versions
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid`.execute(executor);
          const versionNumber = Number(latest.rows[0]?.next_version);
          if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) throw new PostgresInfrastructureError();
          const aggregateVersion = command.expectedVersion + 1;
          await sql`insert into cv_portfolio.versions
              (version_id, portfolio_id, owner_id, media_id, media_asset_version, media_decision_id,
               media_object_id, media_sha256, media_object_version, version_number, locale, label, state)
            values (${command.versionId}::uuid, ${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
              ${command.mediaId}::uuid, ${mediaSnapshot.assetVersion}, ${mediaSnapshot.decisionId}::uuid,
              ${mediaSnapshot.objectId}::uuid, ${mediaSnapshot.sha256}, ${mediaSnapshot.objectVersion},
              ${versionNumber}, 'en', ${command.label}, 'registered')`.execute(executor);
          const updated = await sql`update cv_portfolio.portfolios set aggregate_version = ${aggregateVersion},
              updated_at = transaction_timestamp()
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
              and aggregate_version = ${command.expectedVersion}`.execute(executor);
          if (Number(updated.numAffectedRows ?? 0n) !== 1) throw new PostgresInfrastructureError();
          await sql`insert into cv_portfolio.registration_commands
              (portfolio_id, owner_id, idempotency_key_hash, request_hash, version_id, aggregate_version)
            values (${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
              ${idempotencyKeyHash}, ${command.requestHash}, ${command.versionId}::uuid, ${aggregateVersion})`.execute(executor);
          await sql`insert into operations.outbox_events
              (event_id, event_type, schema_version, aggregate_id, aggregate_version, payload, correlation_id, occurred_at, available_at)
            values (${uuidv7()}::uuid, 'cv.version_registered.v1', 1, ${input.scope.portfolioId}::uuid, ${aggregateVersion},
              ${JSON.stringify({ versionId: command.versionId, mediaId: command.mediaId })}::jsonb,
              ${idempotencyKeyHash}, transaction_timestamp(), transaction_timestamp())`.execute(executor);
          return ok({ versionId: command.versionId, aggregateVersion, outcome: "cv-version-registered" });
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "CV_REGISTRATION_COMMIT_FAILED" });
      }
    },

    async acceptOwnerCvVersion(command: AcceptCvPortfolioVersionInput): Promise<Result<OwnerCvCommandReceipt, Rejection>> {
      if (command.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      const idempotencyKeyHash = keyHash(command.idempotencyKey);
      const readReplay = async (context: TransactionContext): Promise<Result<OwnerCvCommandReceipt, Rejection> | undefined> => {
        const rows = await sql<AcceptanceReplayRow>`select request_hash, version_id::text as version_id, aggregate_version
          from cv_portfolio.acceptance_commands
          where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            and idempotency_key_hash = ${idempotencyKeyHash}`.execute(resolvePostgresTransaction(context));
        const previous = rows.rows[0];
        if (previous === undefined) return undefined;
        if (previous.request_hash !== command.requestHash) return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
        if (previous.version_id !== command.versionId) throw new PostgresInfrastructureError();
        return ok({ aggregateId: stableId("CvVersion", previous.version_id),
          aggregateVersion: Number(previous.aggregate_version), outcome: "cv-version-accepted" });
      };

      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setScope(context);
          await sql`select set_config('lock_timeout', '3s', true),
                           set_config('statement_timeout', '5s', true),
                           set_config('transaction_timeout', '8s', true)`.execute(executor);

          const earlyReplay = await readReplay(context);
          if (earlyReplay !== undefined) return earlyReplay;

          // The registration row is immutable. Read it before Media locks, then
          // acquire the shared Media lock before taking the CV root lock.
          const registered = await sql<CvSnapshotRow>`
            select version.media_id::text as media_id, version.media_asset_version, version.state,
                   version.media_decision_id::text as media_decision_id, version.media_object_id::text as media_object_id,
                   version.media_sha256, version.media_object_version
              from cv_portfolio.versions version
             where version.version_id = ${command.versionId}::uuid
               and version.portfolio_id = ${input.scope.portfolioId}::uuid and version.owner_id = ${input.scope.ownerId}::uuid
          `.execute(executor);
          const snapshot = registered.rows[0];
          if (snapshot === undefined) return err({ kind: "not_found", code: "CV_VERSION_NOT_FOUND" });
          if (snapshot.state !== "registered") return err({ kind: "conflict", code: "CV_VERSION_NOT_ACCEPTABLE" });

          const mediaAssetId = stableId("MediaAsset", snapshot.media_id);
          const mediaResult = await input.media.getAcceptedPdfSnapshot({
            ownerId: input.scope.ownerId,
            mediaAssetId,
          }, context);
          if (!mediaResult.ok) return mediaResult;
          if (mediaResult.value.status !== "accepted") return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          const currentMedia = mediaResult.value.snapshot;
          if (currentMedia.mediaAssetId !== mediaAssetId ||
              currentMedia.ownerId !== input.scope.ownerId || currentMedia.assetVersion !== Number(snapshot.media_asset_version) ||
              currentMedia.decisionId !== snapshot.media_decision_id || currentMedia.objectId !== snapshot.media_object_id ||
              currentMedia.sha256 !== snapshot.media_sha256 || currentMedia.objectVersion !== snapshot.media_object_version) {
            return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          }
          const currentFacts = await input.media.getAcceptanceFacts({
            ownerId: input.scope.ownerId,
            mediaAssetIds: [mediaAssetId],
            intendedUse: "supporting-artifact",
          }, context);
          if (!currentFacts.ok) return currentFacts;
          const currentFact = currentFacts.value.find((fact) => fact.mediaAssetId === mediaAssetId);
          if (currentFact === undefined || currentFact.assetVersion !== Number(snapshot.media_asset_version) ||
              !currentFact.accepted || !currentFact.safe || !currentFact.suitable || !currentFact.accessible) {
            return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          }

          // getAcceptanceFacts applies its own bounded savepoint limits; restore
          // the complete acceptance transaction budget before the CV commit.
          await sql`select set_config('transaction_timeout', '8s', true)`.execute(executor);

          const roots = await sql<RootRow>`select portfolio_id::text as portfolio_id, owner_id::text as owner_id,
              aggregate_version, current_version_id::text as current_version_id
            from cv_portfolio.portfolios
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            for update`.execute(executor);
          const root = roots.rows[0];
          if (root === undefined) return err({ kind: "not_found", code: "CV_PORTFOLIO_NOT_CONFIGURED" });

          const committedReplay = await readReplay(context);
          if (committedReplay !== undefined) return committedReplay;
          if (Number(root.aggregate_version) !== command.expectedVersion) {
            return { ok: false, error: { kind: "precondition_failed", code: "CV_PORTFOLIO_VERSION_MISMATCH", currentVersion: Number(root.aggregate_version) } };
          }

          const updatedVersion = await sql`update cv_portfolio.versions set state = 'accepted'
            where version_id = ${command.versionId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
              and owner_id = ${input.scope.ownerId}::uuid and state = 'registered'`.execute(executor);
          if (Number(updatedVersion.numAffectedRows ?? 0n) !== 1) {
            return err({ kind: "conflict", code: "CV_VERSION_NOT_ACCEPTABLE" });
          }
          const aggregateVersion = command.expectedVersion + 1;
          await sql`insert into cv_portfolio.acceptance_history
              (approval_id, portfolio_id, owner_id, version_id, media_decision_id, media_object_id,
               media_sha256, media_object_version, accepted_by)
            values (${uuidv7()}::uuid, ${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
              ${command.versionId}::uuid, ${snapshot.media_decision_id}::uuid, ${snapshot.media_object_id}::uuid,
              ${snapshot.media_sha256}, ${snapshot.media_object_version}, ${input.scope.ownerId}::uuid)`.execute(executor);
          const changedRoot = await sql`update cv_portfolio.portfolios set aggregate_version = ${aggregateVersion},
              updated_at = transaction_timestamp()
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
              and aggregate_version = ${command.expectedVersion}`.execute(executor);
          if (Number(changedRoot.numAffectedRows ?? 0n) !== 1) throw new PostgresInfrastructureError();
          await sql`insert into cv_portfolio.acceptance_commands
              (portfolio_id, owner_id, idempotency_key_hash, request_hash, version_id, aggregate_version)
            values (${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
              ${idempotencyKeyHash}, ${command.requestHash}, ${command.versionId}::uuid, ${aggregateVersion})`.execute(executor);
          await sql`insert into operations.outbox_events
              (event_id, event_type, schema_version, aggregate_id, aggregate_version, payload, correlation_id, occurred_at, available_at)
            values (${uuidv7()}::uuid, 'cv.version_accepted.v1', 1, ${input.scope.portfolioId}::uuid, ${aggregateVersion},
              ${JSON.stringify({ versionId: command.versionId })}::jsonb, ${idempotencyKeyHash},
              transaction_timestamp(), transaction_timestamp())`.execute(executor);
          return ok({ aggregateId: command.versionId, aggregateVersion, outcome: "cv-version-accepted" });
        });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "55P03") {
          return err({ kind: "temporarily_unavailable", code: "CV_ACCEPTANCE_LOCK_TIMEOUT" });
        }
        return err({ kind: "temporarily_unavailable", code: "CV_ACCEPTANCE_COMMIT_FAILED" });
      }
    },

    async activateOwnerCvVersion(command: ActivateCvPortfolioVersionInput): Promise<Result<OwnerCvCommandReceipt, Rejection>> {
      if (command.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      const idempotencyKeyHash = keyHash(command.idempotencyKey);
      const readReplay = async (context: TransactionContext): Promise<Result<OwnerCvCommandReceipt, Rejection> | undefined> => {
        const rows = await sql<ActivationReplayRow>`select request_hash, version_id::text as version_id, aggregate_version
          from cv_portfolio.activation_commands
          where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            and idempotency_key_hash = ${idempotencyKeyHash}`.execute(resolvePostgresTransaction(context));
        const previous = rows.rows[0];
        if (previous === undefined) return undefined;
        if (previous.request_hash !== command.requestHash) return err({ kind: "conflict", code: "IDEMPOTENCY_CONFLICT" });
        if (previous.version_id !== command.versionId) throw new PostgresInfrastructureError();
        return ok({ aggregateId: stableId("CvVersion", previous.version_id),
          aggregateVersion: Number(previous.aggregate_version), outcome: "current-cv-activated" });
      };

      try {
        // Check Storage outside the activation transaction. The immutable
        // Media snapshot is read under the normal application role here and
        // revalidated again inside the write transaction below.
        type ActivationPreflight =
          | { readonly kind: "replay"; readonly receipt: OwnerCvCommandReceipt }
          | { readonly kind: "error"; readonly error: Rejection }
          | { readonly kind: "preflight"; readonly snapshot: AcceptedPdfSnapshot };
        const preflight = await input.transactions.run<Result<ActivationPreflight, Rejection>>(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setScope(context);
          const replay = await readReplay(context);
          if (replay !== undefined) return replay.ok
            ? ok({ kind: "replay" as const, receipt: replay.value })
            : ok({ kind: "error" as const, error: replay.error });
          const registered = await sql<CvSnapshotRow>`select version.media_id::text as media_id,
              version.media_asset_version, version.state,
              version.media_decision_id::text as media_decision_id, version.media_object_id::text as media_object_id,
              version.media_sha256, version.media_object_version
            from cv_portfolio.versions version
            where version.version_id = ${command.versionId}::uuid
              and version.portfolio_id = ${input.scope.portfolioId}::uuid
              and version.owner_id = ${input.scope.ownerId}::uuid`.execute(executor);
          const candidate = registered.rows[0];
          if (candidate === undefined) return err({ kind: "not_found", code: "CV_VERSION_NOT_FOUND" });
          if (candidate.state !== "accepted") return err({ kind: "conflict", code: "CV_VERSION_NOT_ACTIVATABLE" });
          const mediaAssetId = stableId("MediaAsset", candidate.media_id);
          const accepted = await input.media.getAcceptedPdfSnapshot({ ownerId: input.scope.ownerId, mediaAssetId }, context);
          if (!accepted.ok) return accepted;
          if (accepted.value.status !== "accepted") return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          const snapshot = accepted.value.snapshot;
          if (!activationMediaSnapshotMatches(snapshot, candidate, mediaAssetId, input.scope.ownerId)) {
            return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          }
          return ok({ kind: "preflight" as const, snapshot });
        });
        if (!preflight.ok) return preflight;
        if (preflight.value.kind === "error") return err(preflight.value.error);
        if (preflight.value.kind === "replay") return ok(preflight.value.receipt);
        const storage = await input.media.preflightAcceptedPdfObject({ portfolioId: input.scope.portfolioId, snapshot: preflight.value.snapshot });
        if (!storage.ok) return storage;

        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await setScope(context);
          await sql`select set_config('lock_timeout', '3s', true),
                           set_config('statement_timeout', '5s', true),
                           set_config('transaction_timeout', '8s', true)`.execute(executor);

          const earlyReplay = await readReplay(context);
          if (earlyReplay !== undefined) return earlyReplay;

          // Read the immutable registration to learn its Media identity, then
          // acquire the shared Media lock before taking the CV root lock.
          const registered = await sql<CvSnapshotRow>`select version.media_id::text as media_id,
              version.media_asset_version, version.state,
              version.media_decision_id::text as media_decision_id, version.media_object_id::text as media_object_id,
              version.media_sha256, version.media_object_version
            from cv_portfolio.versions version
            where version.version_id = ${command.versionId}::uuid
              and version.portfolio_id = ${input.scope.portfolioId}::uuid
              and version.owner_id = ${input.scope.ownerId}::uuid`.execute(executor);
          const snapshot = registered.rows[0];
          if (snapshot === undefined) return err({ kind: "not_found", code: "CV_VERSION_NOT_FOUND" });
          if (snapshot.state !== "accepted") return err({ kind: "conflict", code: "CV_VERSION_NOT_ACTIVATABLE" });

          const mediaAssetId = stableId("MediaAsset", snapshot.media_id);
          const mediaResult = await input.media.getAcceptedPdfSnapshot({
            ownerId: input.scope.ownerId,
            mediaAssetId,
          }, context);
          if (!mediaResult.ok) return mediaResult;
          if (mediaResult.value.status !== "accepted") return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          const currentMedia = mediaResult.value.snapshot;
          if (!activationMediaSnapshotMatches(currentMedia, snapshot, mediaAssetId, input.scope.ownerId)) {
            return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          }

          // Serialize activation with Media rejection and recheck the
          // authoritative decision while holding the shared Media lock.
          const currentFacts = await input.media.getAcceptanceFacts({
            ownerId: input.scope.ownerId,
            mediaAssetIds: [mediaAssetId],
            intendedUse: "supporting-artifact",
          }, context);
          if (!currentFacts.ok) return currentFacts;
          const currentFact = currentFacts.value.find((fact) => fact.mediaAssetId === mediaAssetId);
          if (currentFact === undefined || !currentFact.accepted || !currentFact.safe || !currentFact.suitable) {
            return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          }

          // Acceptance's Media fact query uses bounded local limits. Restore
          // this transaction's total budget before locking the root.
          await sql`select set_config('transaction_timeout', '8s', true)`.execute(executor);
          const roots = await sql<RootRow>`select portfolio_id::text as portfolio_id, owner_id::text as owner_id,
              aggregate_version, current_version_id::text as current_version_id
            from cv_portfolio.portfolios
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            for update`.execute(executor);
          const root = roots.rows[0];
          if (root === undefined) return err({ kind: "not_found", code: "CV_PORTFOLIO_NOT_CONFIGURED" });

          const committedReplay = await readReplay(context);
          if (committedReplay !== undefined) return committedReplay;
          if (Number(root.aggregate_version) !== command.expectedVersion) {
            return { ok: false, error: { kind: "precondition_failed", code: "CV_PORTFOLIO_VERSION_MISMATCH", currentVersion: Number(root.aggregate_version) } };
          }

          const aggregateVersion = Number(root.aggregate_version);
          const currentVersionId = root.current_version_id;
          if (currentVersionId === command.versionId) {
            await sql`insert into cv_portfolio.activation_commands
                (portfolio_id, owner_id, idempotency_key_hash, request_hash, version_id, aggregate_version)
              values (${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
                ${idempotencyKeyHash}, ${command.requestHash}, ${command.versionId}::uuid, ${aggregateVersion})`.execute(executor);
            return ok({ aggregateId: command.versionId, aggregateVersion, outcome: "current-cv-activated" });
          }

          const nextAggregateVersion = command.expectedVersion + 1;
          const eventTime = await sql<{ readonly activated_at: Date | string }>`
            select transaction_timestamp() as activated_at`.execute(executor);
          const activationTimestamp = isoInstant(eventTime.rows[0]?.activated_at ?? "");
          if (currentVersionId !== null) {
            const oldDesignation = await sql`update cv_portfolio.versions set is_current = false
              where version_id = ${currentVersionId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
                and owner_id = ${input.scope.ownerId}::uuid and is_current`.execute(executor);
            if (Number(oldDesignation.numAffectedRows ?? 0n) !== 1) throw new PostgresInfrastructureError();
          }
          const newDesignation = await sql`update cv_portfolio.versions set is_current = true
            where version_id = ${command.versionId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
              and owner_id = ${input.scope.ownerId}::uuid and state = 'accepted' and locale = 'en' and not is_current`.execute(executor);
          if (Number(newDesignation.numAffectedRows ?? 0n) !== 1) return err({ kind: "conflict", code: "CV_VERSION_NOT_ACTIVATABLE" });
          const changedRoot = await sql`update cv_portfolio.portfolios
              set current_version_id = ${command.versionId}::uuid,
                  aggregate_version = ${nextAggregateVersion}, updated_at = transaction_timestamp()
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
              and aggregate_version = ${command.expectedVersion}`.execute(executor);
          if (Number(changedRoot.numAffectedRows ?? 0n) !== 1) throw new PostgresInfrastructureError();

          await sql`insert into cv_portfolio.activation_history
              (activation_id, portfolio_id, owner_id, version_id, activated_at)
            values (${uuidv7()}::uuid, ${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
              ${command.versionId}::uuid, transaction_timestamp())`.execute(executor);
          await sql`insert into cv_portfolio.activation_commands
              (portfolio_id, owner_id, idempotency_key_hash, request_hash, version_id, aggregate_version)
            values (${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
              ${idempotencyKeyHash}, ${command.requestHash}, ${command.versionId}::uuid, ${nextAggregateVersion})`.execute(executor);
          await sql`insert into operations.outbox_events
              (event_id, event_type, schema_version, aggregate_id, aggregate_version, payload, correlation_id, occurred_at, available_at)
            values (${uuidv7()}::uuid, 'cv.current_changed.v1', 1, ${input.scope.portfolioId}::uuid, ${nextAggregateVersion},
              ${JSON.stringify({ ...(currentVersionId === null ? {} : { previousCurrentCvId: currentVersionId }),
                newCurrentCvId: command.versionId, activatedAt: activationTimestamp })}::jsonb,
              ${idempotencyKeyHash}, transaction_timestamp(), transaction_timestamp())`.execute(executor);
          return ok({ aggregateId: command.versionId, aggregateVersion: nextAggregateVersion, outcome: "current-cv-activated" });
        });
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "55P03") {
          return err({ kind: "temporarily_unavailable", code: "CV_ACTIVATION_LOCK_TIMEOUT" });
        }
        return err({ kind: "temporarily_unavailable", code: "CV_ACTIVATION_COMMIT_FAILED" });
      }
    },

    async getCurrentCvMediaUsage(query: GetCurrentCvMediaUsageInput): Promise<Result<boolean, Rejection>> {
      if (query.ownerId !== input.scope.ownerId) return err({ kind: "forbidden", code: "OWNER_SCOPE_MISMATCH" });
      try {
        const executor = resolvePostgresTransaction(query.transaction);
        await setScope(query.transaction);
        const usage = await sql`select 1
          from cv_portfolio.portfolios portfolio
          join cv_portfolio.versions version
            on version.version_id = portfolio.current_version_id
           and version.portfolio_id = portfolio.portfolio_id
           and version.owner_id = portfolio.owner_id
         where portfolio.portfolio_id = ${input.scope.portfolioId}::uuid
           and portfolio.owner_id = ${input.scope.ownerId}::uuid
           and version.media_id = ${query.mediaAssetId}::uuid
         limit 1`.execute(executor);
        return ok(usage.rows.length > 0);
      } catch {
        return err({ kind: "temporarily_unavailable", code: "CV_CURRENT_USAGE_READ_FAILED" });
      }
    },
  };
}

/** Reads only the current, accepted English version and revalidates its exact Media snapshot. */
export function createPostgresCurrentCvSnapshotRepository(input: {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
  readonly media: Pick<MediaReadApplicationService, "getAcceptedPdfSnapshot">;
}): CurrentCvSnapshotRepositoryPort {
  return {
    async getCurrentCvSnapshot(): Promise<Result<CurrentCvSnapshot, Rejection>> {
      try {
        return await input.transactions.run(async (context) => {
          const executor = resolvePostgresTransaction(context);
          await sql`select set_config('shipwithali.portfolio_id', ${input.scope.portfolioId}, true),
                           set_config('shipwithali.owner_id', ${input.scope.ownerId}, true)`
            .execute(executor);
          const selected = await sql<{
            readonly version_id: string;
            readonly media_id: string;
            readonly locale: string;
            readonly state: string;
            readonly is_current: boolean;
            readonly media_asset_version: number | string;
            readonly media_decision_id: string;
            readonly media_object_id: string;
            readonly media_sha256: string;
            readonly media_object_version: string;
          }>`select version.version_id::text as version_id, version.media_id::text as media_id,
                     version.locale, version.state, version.is_current, version.media_asset_version,
                     version.media_decision_id::text as media_decision_id,
                     version.media_object_id::text as media_object_id, version.media_sha256,
                     version.media_object_version
                from cv_portfolio.portfolios portfolio
                join cv_portfolio.versions version
                  on version.version_id = portfolio.current_version_id
                 and version.portfolio_id = portfolio.portfolio_id
                 and version.owner_id = portfolio.owner_id
                join cv_portfolio.acceptance_history approval
                  on approval.version_id = version.version_id
                 and approval.portfolio_id = version.portfolio_id
                 and approval.owner_id = version.owner_id
               where portfolio.portfolio_id = ${input.scope.portfolioId}::uuid
                 and portfolio.owner_id = ${input.scope.ownerId}::uuid
                 and version.state = 'accepted' and version.locale = 'en' and version.is_current
               limit 1`.execute(executor);
          const row = selected.rows[0];
          if (row === undefined) return err({ kind: "not_found", code: "CURRENT_CV_NOT_FOUND" });
          const mediaAssetId = parseStableId("MediaAsset", row.media_id);
          const objectId = parseStableId("MediaObject", row.media_object_id);
          if (!mediaAssetId.ok || !objectId.ok || row.locale !== "en" || row.state !== "accepted" ||
              row.is_current !== true || !Number.isSafeInteger(Number(row.media_asset_version)) ||
              !/^[0-9a-f]{64}$/u.test(row.media_sha256) || row.media_object_version !== row.media_sha256 ||
              row.media_object_version.length > 512) {
            return err({ kind: "temporarily_unavailable", code: "CURRENT_CV_UNAVAILABLE" });
          }
          const media = await input.media.getAcceptedPdfSnapshot({
            ownerId: input.scope.ownerId,
            mediaAssetId: mediaAssetId.value,
          }, context);
          if (!media.ok) return media;
          if (media.value.status !== "accepted" || media.value.snapshot.assetVersion !== Number(row.media_asset_version) ||
              media.value.snapshot.decisionId !== row.media_decision_id || media.value.snapshot.objectId !== objectId.value ||
              media.value.snapshot.sha256 !== row.media_sha256 || media.value.snapshot.objectVersion !== row.media_object_version) {
            return err({ kind: "not_found", code: "CURRENT_CV_NOT_FOUND" });
          }
          return ok({ portfolioId: input.scope.portfolioId, mediaAssetId: mediaAssetId.value, objectId: objectId.value,
            sha256: row.media_sha256, objectVersion: row.media_object_version });
        });
      } catch {
        return err({ kind: "temporarily_unavailable", code: "CURRENT_CV_UNAVAILABLE" });
      }
    },
  };
}
