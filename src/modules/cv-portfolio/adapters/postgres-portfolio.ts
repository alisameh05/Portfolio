import { createHash } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { sql, type Kysely } from "kysely";
import { err, ok, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { TransactionContext, TransactionRunner } from "../../../runtime/ports.js";
import { PostgresInfrastructureError, resolvePostgresTransaction } from "../../../shared/adapters/postgres/runtime.js";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { MediaReadApplicationService } from "../../media/index.js";
import type { OwnerCvActivationView, OwnerCvPortfolioView, OwnerCvVersionView, RegisterOwnerCvVersionReceipt } from "../application/owner-contracts.js";
import type { CvPortfolioRepositoryPort, RegisterCvPortfolioVersionInput } from "../application/repository.js";

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

interface MediaRow {
  readonly kind: string;
  readonly declared_media_type: string;
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
  return {
    versionId: stableId("CvVersion", row.version_id),
    mediaId: stableId("MediaAsset", row.media_id),
    locale: "en",
    label: row.label,
    state: row.state,
    isCurrent: row.version_id === currentVersionId,
  };
}

function isoInstant(value: Date | string): string {
  const result = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  if (!Number.isFinite(Date.parse(result))) throw new PostgresInfrastructureError();
  return result;
}

export function createPostgresCvPortfolioRepository(input: {
  readonly database: Kysely<DB>;
  readonly transactions: TransactionRunner;
  readonly scope: { readonly portfolioId: StableId<"Portfolio">; readonly ownerId: StableId<"Owner"> };
  readonly media: Pick<MediaReadApplicationService, "getAcceptanceFacts">;
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
      on conflict (portfolio_id) do nothing`.execute(executor);
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
              locale, label, state, version_number
            from cv_portfolio.versions
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            order by version_number desc, version_id desc limit 100`.execute(executor);
          const activations = await sql<ActivationRow>`select version_id::text as version_id, activated_at
            from cv_portfolio.activation_history
            where portfolio_id = ${input.scope.portfolioId}::uuid and owner_id = ${input.scope.ownerId}::uuid
            order by activated_at desc, activation_id desc limit 100`.execute(executor);
          const currentVersionId = root.current_version_id;
          const view: OwnerCvPortfolioView = {
            aggregateVersion: Number(root.aggregate_version),
            currentVersionId: currentVersionId === null ? null : stableId("CvVersion", currentVersionId),
            versions: versions.rows.map((row) => mapVersion(row, currentVersionId)),
            activationHistory: activations.rows.map((row): OwnerCvActivationView => ({
              versionId: stableId("CvVersion", row.version_id),
              activatedAt: isoInstant(row.activated_at),
            })),
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
          const mediaFacts = await input.media.getAcceptanceFacts({
            ownerId: input.scope.ownerId,
            mediaAssetIds: [command.mediaId as StableId<"MediaAsset">],
            intendedUse: "supporting-artifact",
          }, context);
          if (!mediaFacts.ok) return mediaFacts;
          const fact = mediaFacts.value[0];
          if (mediaFacts.value.length !== 1 || fact === undefined || fact.mediaAssetId !== command.mediaId ||
              fact.ownerId !== input.scope.ownerId || !fact.accepted || !fact.safe || !fact.suitable || !fact.accessible) {
            return err({ kind: "conflict", code: "CV_MEDIA_NOT_ELIGIBLE" });
          }
          const media = await sql<MediaRow>`select kind, declared_media_type from media.assets
            where media_id = ${command.mediaId}::uuid and portfolio_id = ${input.scope.portfolioId}::uuid
              and owner_id = ${input.scope.ownerId}::uuid`.execute(executor);
          if (media.rows[0]?.kind !== "document" || media.rows[0]?.declared_media_type !== "application/pdf") {
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
              (version_id, portfolio_id, owner_id, media_id, media_asset_version, version_number, locale, label, state)
            values (${command.versionId}::uuid, ${input.scope.portfolioId}::uuid, ${input.scope.ownerId}::uuid,
              ${command.mediaId}::uuid, ${fact.assetVersion}, ${versionNumber}, 'en', ${command.label}, 'registered')`.execute(executor);
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
  };
}
