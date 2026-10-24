import { sql } from "kysely";
import { err, type Rejection, type Result } from "@shared/domain";
import type { TransactionContext } from "../../../runtime/ports.js";
import {
  PostgresInfrastructureError,
  resolvePostgresTransaction,
} from "../../../shared/adapters/postgres/runtime.js";
import type {
  ContactChannel,
  GlobalProjectCta,
  PortfolioProfile,
  PortfolioSettings,
} from "../domain/index.js";
import type { PortfolioAggregateUpdate, PortfolioScope } from "../ports/index.js";
import type { PortfolioSettingsRepository } from "../application/settings-service.js";

interface SettingsRow {
  readonly portfolio_id: string;
  readonly display_name: string;
  readonly headline: string;
  readonly bio: string;
  readonly profile_media_asset_id: string | null;
  readonly global_cta_label: string;
  readonly global_cta_destination: string;
  readonly global_cta_unavailable_fallback: string;
  readonly version: number;
}

interface ChannelRow {
  readonly channel: ContactChannel["channel"];
  readonly label: string;
  readonly destination: string;
  readonly available_locales: unknown;
}

function isLocaleList(value: unknown): value is readonly ("en" | "ar")[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 &&
    value.every((locale): locale is "en" | "ar" => locale === "en" || locale === "ar") &&
    new Set(value).size === value.length;
}

function safeRow(row: SettingsRow, channels: readonly ChannelRow[]): PortfolioSettings {
  const contactChannels = channels.map((channel): ContactChannel => {
    let locales: unknown = channel.available_locales;
    if (typeof locales === "string") {
      try { locales = JSON.parse(locales) as unknown; } catch { throw new PostgresInfrastructureError(); }
    }
    if (!isLocaleList(locales)) throw new PostgresInfrastructureError();
    return {
      channel: channel.channel,
      label: channel.label,
      destination: channel.destination,
      availableLocales: locales,
    };
  });
  return {
    portfolioId: row.portfolio_id as PortfolioSettings["portfolioId"],
    profile: {
      displayName: row.display_name,
      headline: row.headline,
      bio: row.bio,
      ...(row.profile_media_asset_id === null ? {} : { mediaAssetId: row.profile_media_asset_id as NonNullable<PortfolioProfile["mediaAssetId"]> }),
    },
    contactChannels,
    globalCta: {
      label: row.global_cta_label,
      destination: row.global_cta_destination,
      unavailableFallback: row.global_cta_unavailable_fallback,
    },
    version: row.version,
  };
}

function expectedScope(scope: PortfolioScope, settings: PortfolioSettings): boolean {
  return settings.portfolioId === scope.portfolioId && settings.version === 1;
}

export function createPostgresPortfolioSettingsRepository(
): PortfolioSettingsRepository {
  async function setTrustedScope(context: TransactionContext, scope: PortfolioScope): Promise<void> {
    const executor = resolvePostgresTransaction(context);
    await sql`
      select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
             set_config('shipwithali.owner_id', ${scope.ownerId}, true)
    `.execute(executor);
  }

  return {
    async getSettings(
      scope: PortfolioScope,
      context: TransactionContext,
    ): Promise<Result<PortfolioSettings, Rejection>> {
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const selected = await sql<SettingsRow>`
          select portfolio_id::text as portfolio_id, display_name, headline, bio, profile_media_asset_id::text as profile_media_asset_id,
                 global_cta_label, global_cta_destination,
                 global_cta_unavailable_fallback, version
            from portfolio_config.settings
           where portfolio_id = ${scope.portfolioId}::uuid
             and owner_id = ${scope.ownerId}::uuid
        `.execute(executor);
        const row = selected.rows[0];
        if (row === undefined) {
          return err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" });
        }
        const channelRows = await sql<ChannelRow>`
          select channel, label, destination, available_locales
            from portfolio_config.contact_channels
           where portfolio_id = ${scope.portfolioId}::uuid
           order by position asc
        `.execute(executor);
        return { ok: true, value: safeRow(row, channelRows.rows) };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async getSettingsSnapshot(scope: PortfolioScope, context: TransactionContext) {
      try {
        const settings = await this.getSettings(scope, context);
        if (!settings.ok && settings.error.kind !== "not_found") return settings;
        const timestamp = await sql<{ captured_at: Date | string }>`
          select transaction_timestamp() as captured_at
        `.execute(resolvePostgresTransaction(context));
        const instant = timestamp.rows[0]?.captured_at;
        if (instant === undefined) throw new PostgresInfrastructureError();
        const capturedAt = instant instanceof Date ? instant.toISOString() : new Date(instant).toISOString();
        if (!Number.isFinite(Date.parse(capturedAt))) throw new PostgresInfrastructureError();
        return { ok: true as const, value: { settings: settings.ok ? settings.value : null, capturedAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async provisionSettings(
      scope: PortfolioScope,
      settings: PortfolioSettings,
      context: TransactionContext,
    ): Promise<Result<PortfolioSettings, Rejection>> {
      if (!expectedScope(scope, settings)) {
        return err({ kind: "validation", code: "INVALID_PORTFOLIO_SETTINGS_SCOPE" });
      }
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const inserted = await sql<{ portfolio_id: string }>`
          insert into portfolio_config.settings (
            portfolio_id, owner_id, display_name, headline, bio, profile_media_asset_id,
            global_cta_label, global_cta_destination,
            global_cta_unavailable_fallback, version
          ) values (
            ${scope.portfolioId}::uuid, ${scope.ownerId}::uuid,
            ${settings.profile.displayName}, ${settings.profile.headline}, ${settings.profile.bio}, ${settings.profile.mediaAssetId ?? null}::uuid,
            ${settings.globalCta.label}, ${settings.globalCta.destination},
            ${settings.globalCta.unavailableFallback}, 1
          ) on conflict do nothing
          returning portfolio_id::text as portfolio_id
        `.execute(executor);
        if (inserted.rows.length === 0) {
          return err({ kind: "conflict", code: "PORTFOLIO_SETTINGS_ALREADY_PROVISIONED" });
        }
        for (const [position, channel] of settings.contactChannels.entries()) {
          await sql`
            insert into portfolio_config.contact_channels (
              portfolio_id, position, channel, label, destination, available_locales
            ) values (
              ${scope.portfolioId}::uuid, ${position}, ${channel.channel}, ${channel.label},
              ${channel.destination}, ${JSON.stringify(channel.availableLocales)}::jsonb
            )
          `.execute(executor);
        }
        return { ok: true, value: settings };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async updateProfile(
      scope: PortfolioScope,
      profile: PortfolioProfile,
      expectedVersion: number,
      context: TransactionContext,
    ): Promise<Result<PortfolioAggregateUpdate, Rejection>> {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_EXPECTED_VERSION" });
      }
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const updated = await sql<{ version: number; updated_at: Date | string }>`
          update portfolio_config.settings
             set display_name = ${profile.displayName},
                 headline = ${profile.headline},
                 bio = ${profile.bio},
                 profile_media_asset_id = ${profile.mediaAssetId ?? null}::uuid,
                 version = version + 1,
                 updated_at = transaction_timestamp()
           where portfolio_id = ${scope.portfolioId}::uuid
             and owner_id = ${scope.ownerId}::uuid
             and version = ${expectedVersion}
          returning version, updated_at
        `.execute(executor);
        const row = updated.rows[0];
        if (row !== undefined) {
          const updatedAt = row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : new Date(row.updated_at).toISOString();
          if (!Number.isFinite(Date.parse(updatedAt))) throw new PostgresInfrastructureError();
          return { ok: true, value: { aggregateVersion: row.version, updatedAt } };
        }

        const existing = await sql<{ version: number }>`
          select version
            from portfolio_config.settings
           where portfolio_id = ${scope.portfolioId}::uuid
             and owner_id = ${scope.ownerId}::uuid
        `.execute(executor);
        const current = existing.rows[0];
        return current === undefined
          ? err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" })
          : err({
            kind: "precondition_failed",
            code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH",
            currentVersion: current.version,
          });
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async updateContactChannels(
      scope: PortfolioScope,
      channels: readonly ContactChannel[],
      expectedVersion: number,
      context: TransactionContext,
    ): Promise<Result<PortfolioAggregateUpdate, Rejection>> {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_EXPECTED_VERSION" });
      }
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const updated = await sql<{ version: number; updated_at: Date | string }>`
          update portfolio_config.settings
             set version = version + 1,
                 updated_at = transaction_timestamp()
           where portfolio_id = ${scope.portfolioId}::uuid
             and owner_id = ${scope.ownerId}::uuid
             and version = ${expectedVersion}
          returning version, updated_at
        `.execute(executor);
        const row = updated.rows[0];
        if (row === undefined) {
          const existing = await sql<{ version: number }>`
            select version
              from portfolio_config.settings
             where portfolio_id = ${scope.portfolioId}::uuid
               and owner_id = ${scope.ownerId}::uuid
          `.execute(executor);
          const current = existing.rows[0];
          return current === undefined
            ? err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" })
            : err({
              kind: "precondition_failed",
              code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH",
              currentVersion: current.version,
            });
        }

        await sql`
          delete from portfolio_config.contact_channels
           where portfolio_id = ${scope.portfolioId}::uuid
        `.execute(executor);
        for (const [position, channel] of channels.entries()) {
          await sql`
            insert into portfolio_config.contact_channels (
              portfolio_id, position, channel, label, destination, available_locales
            ) values (
              ${scope.portfolioId}::uuid, ${position}, ${channel.channel}, ${channel.label},
              ${channel.destination}, ${JSON.stringify(channel.availableLocales)}::jsonb
            )
          `.execute(executor);
        }

        const updatedAt = row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : new Date(row.updated_at).toISOString();
        if (!Number.isFinite(Date.parse(updatedAt))) throw new PostgresInfrastructureError();
        return { ok: true, value: { aggregateVersion: row.version, updatedAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },

    async updateGlobalCta(
      scope: PortfolioScope,
      globalCta: GlobalProjectCta,
      expectedVersion: number,
      context: TransactionContext,
    ): Promise<Result<PortfolioAggregateUpdate, Rejection>> {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return err({ kind: "validation", code: "INVALID_EXPECTED_VERSION" });
      }
      const executor = resolvePostgresTransaction(context);
      try {
        await setTrustedScope(context, scope);
        const updated = await sql<{ version: number; updated_at: Date | string }>`
          update portfolio_config.settings
             set global_cta_label = ${globalCta.label},
                 global_cta_destination = ${globalCta.destination},
                 global_cta_unavailable_fallback = ${globalCta.unavailableFallback},
                 version = version + 1,
                 updated_at = transaction_timestamp()
           where portfolio_id = ${scope.portfolioId}::uuid
             and owner_id = ${scope.ownerId}::uuid
             and version = ${expectedVersion}
          returning version, updated_at
        `.execute(executor);
        const row = updated.rows[0];
        if (row === undefined) {
          const existing = await sql<{ version: number }>`
            select version
              from portfolio_config.settings
             where portfolio_id = ${scope.portfolioId}::uuid
               and owner_id = ${scope.ownerId}::uuid
          `.execute(executor);
          const current = existing.rows[0];
          return current === undefined
            ? err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" })
            : err({
              kind: "precondition_failed",
              code: "PORTFOLIO_SETTINGS_VERSION_MISMATCH",
              currentVersion: current.version,
            });
        }
        const updatedAt = row.updated_at instanceof Date
          ? row.updated_at.toISOString()
          : new Date(row.updated_at).toISOString();
        if (!Number.isFinite(Date.parse(updatedAt))) throw new PostgresInfrastructureError();
        return { ok: true, value: { aggregateVersion: row.version, updatedAt } };
      } catch (error) {
        if (error instanceof PostgresInfrastructureError) throw error;
        throw new PostgresInfrastructureError();
      }
    },
  };
}
