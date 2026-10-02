import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStableId, err, ok } from "../../src/shared/domain/index.js";
import { decideAuthorization } from "../../src/modules/identity-access/index.js";
import { createOwnerConfigurationApplicationService } from "../../src/runtime/owner-configuration-service.js";
import { handleUpdateOwnerProfileConfiguration } from "../../src/runtime/http/owner-configuration.js";
import type { OwnerRequestSecurity } from "../../src/runtime/http/owner-security.js";
import { createPortfolioProfileCommandService } from "../../src/modules/portfolio-configuration/application/profile-command.js";
import {
  createPortfolioSettingsService,
  createPortfolioSettingsReader,
  type PortfolioSettingsProvisioningValues,
} from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";

const DATABASE_URL = process.env["PHASE4_SETTINGS_DATABASE_URL"];
if (process.env["PHASE4_REQUIRE_SETTINGS"] === "1" && !DATABASE_URL) {
  throw new Error("PORTFOLIO_SETTINGS_DATABASE_URL_REQUIRED");
}
const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;

const values: PortfolioSettingsProvisioningValues = {
  profile: {
    displayName: "Ali Sameh",
    headline: "AI product builder",
    bio: "Evidence-led work across applied AI and product engineering.",
  },
  contactChannels: [
    {
      channel: "linkedin",
      label: "LinkedIn",
      destination: "https://www.linkedin.com/in/ali",
      availableLocales: ["en", "ar"],
    },
    {
      channel: "email",
      label: "Email",
      destination: "mailto:ali@example.com",
      availableLocales: ["en"],
    },
  ],
  globalCta: {
    label: "Discuss a project",
    destination: "https://example.com/contact",
    unavailableFallback: "Contact details are currently unavailable.",
  },
};

function quoteIdentifier(value: string): string {
  if (!/^phase4_settings_[a-z0-9_]+$/.test(value)) throw new Error("PORTFOLIO_SETTINGS_TEST_ROLE_INVALID");
  return `"${value}"`;
}

describeDatabase("Portfolio Configuration production migration and restricted principal", () => {
  let admin: Client;
  let applicationUrl: string;
  let loginRole: string;
  let database: ReturnType<typeof createPostgresRuntimeDatabase>;
  const repository = createPostgresPortfolioSettingsRepository();

  beforeAll(async () => {
    admin = new Client({ connectionString: DATABASE_URL });
    await admin.connect();
    loginRole = `phase4_settings_${process.pid}_${randomBytes(4).toString("hex")}`;
    const password = randomBytes(32).toString("hex");
    await admin.query(`create role ${quoteIdentifier(loginRole)} login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query(`grant shipwithali_application to ${quoteIdentifier(loginRole)}`);
    const url = new URL(DATABASE_URL!);
    url.username = loginRole;
    url.password = password;
    applicationUrl = url.toString();
    database = createPostgresRuntimeDatabase(applicationUrl, { max: 5 });
  }, 30_000);

  afterAll(async () => {
    if (database !== undefined) await database.resource.close();
    if (admin !== undefined) {
      try {
        await admin.query(`drop role if exists ${quoteIdentifier(loginRole)}`);
      } finally {
        await admin.end();
      }
    }
  });

  it("provisions once and returns only committed Owner state and version", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const service = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    const result = await service.provision(values);
    expect(result).toEqual({ ok: true, value: { portfolioId: scope.portfolioId, ...values, version: 1 } });

    const read = await service.getSettings({
      actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "test-session" },
      portfolioId: scope.portfolioId,
    });
    expect(read).toEqual(result);
    expect(Object.keys(read.ok ? read.value : {})).toEqual([
      "portfolioId", "profile", "contactChannels", "globalCta", "version",
    ]);
    expect(read.ok ? JSON.stringify(read.value) : "").not.toContain(scope.ownerId);

    const repeated = await service.provision(values);
    expect(repeated).toEqual(err({ kind: "conflict", code: "PORTFOLIO_SETTINGS_ALREADY_PROVISIONED" }));
  });

  it("reports an absent configured aggregate without creating one", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const service = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    const result = await service.getSettings({
      actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "test-session" },
      portfolioId: scope.portfolioId,
    });

    expect(result).toEqual(err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" }));
    const row = await admin.query(
      "select count(*)::int as count from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    expect(row.rows[0].count).toBe(0);
  });

  it("enforces RLS scope and Owner authorization for configuration reads", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const service = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await service.provision(values);

    const anonymous = await service.getSettings({
      actor: { kind: "visitor", consent: "unknown" },
      portfolioId: scope.portfolioId,
    });
    expect(anonymous).toEqual(err({ kind: "forbidden", code: "OWNER_REQUIRED" }));

    const wrongOwner = await database.transactions.run((context) => repository.getSettings(
      { ...scope, ownerId: createStableId("Owner") }, context,
    ));
    expect(wrongOwner).toEqual(err({ kind: "not_found", code: "PORTFOLIO_SETTINGS_NOT_CONFIGURED" }));

    const unscoped = new Client({ connectionString: applicationUrl });
    await unscoped.connect();
    try {
      const rows = await unscoped.query("select count(*)::int as count from portfolio_config.settings");
      expect(rows.rows[0].count).toBe(0);
    } finally {
      await unscoped.end();
    }
  });

  it("allows one winning concurrent provision and never overwrites the existing aggregate", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const first = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    const second = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    const [left, right] = await Promise.all([first.provision(values), second.provision(values)]);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect([left, right].filter((result) => !result.ok)).toEqual([
      err({ kind: "conflict", code: "PORTFOLIO_SETTINGS_ALREADY_PROVISIONED" }),
    ]);
    const count = await admin.query(
      "select count(*)::int as count from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("rolls back the aggregate when an ordered channel insert fails", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    await admin.query(`
      create function public.phase4_settings_reject_channel() returns trigger
      language plpgsql as $$ begin raise exception 'synthetic channel failure'; end $$
    `);
    await admin.query(`
      create trigger phase4_settings_reject_channel before insert on portfolio_config.contact_channels
      for each row when (new.portfolio_id = '${scope.portfolioId}'::uuid)
      execute function public.phase4_settings_reject_channel()
    `);
    try {
      const service = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
      await expect(service.provision(values)).rejects.toMatchObject({ code: "POSTGRES_UNAVAILABLE" });
      const row = await admin.query(
        "select count(*)::int as count from portfolio_config.settings where portfolio_id = $1::uuid",
        [scope.portfolioId],
      );
      expect(row.rows[0].count).toBe(0);
    } finally {
      await admin.query("drop trigger if exists phase4_settings_reject_channel on portfolio_config.contact_channels");
      await admin.query("drop function if exists public.phase4_settings_reject_channel()");
    }
  });

  it("keeps application table access narrow and denies clients, workers, and backup", async () => {
    const privileges = await admin.query(`
      select role_name,
             has_schema_privilege(role_name, 'portfolio_config', 'USAGE') as schema_usage,
             has_table_privilege(role_name, 'portfolio_config.settings', 'SELECT') as can_select,
             has_table_privilege(role_name, 'portfolio_config.settings', 'INSERT') as can_insert,
             has_column_privilege(role_name, 'portfolio_config.settings', 'display_name', 'UPDATE') as can_update_profile,
             has_column_privilege(role_name, 'portfolio_config.settings', 'global_cta_label', 'UPDATE') as can_update_cta,
             has_column_privilege(role_name, 'portfolio_config.settings', 'portfolio_id', 'UPDATE') as can_update_identity
        from unnest(array[
          'shipwithali_application', 'shipwithali_worker', 'shipwithali_backup', 'anon', 'authenticated'
        ]) as role_name
    `);
    const byRole = new Map(privileges.rows.map((row) => [row.role_name, row]));
    expect(byRole.get("shipwithali_application")).toMatchObject({
      schema_usage: true, can_select: true, can_insert: true,
      can_update_profile: true, can_update_cta: false, can_update_identity: false,
    });
    for (const role of ["shipwithali_worker", "shipwithali_backup", "anon", "authenticated"]) {
      expect(byRole.get(role)).toMatchObject({
        schema_usage: false, can_select: false, can_insert: false,
        can_update_profile: false, can_update_cta: false, can_update_identity: false,
      });
    }
  });

  it("rolls back the profile policy and every column-level update grant", async () => {
    await admin.query("begin");
    try {
      await admin.query("drop policy portfolio_settings_application_update on portfolio_config.settings");
      await admin.query(`
        revoke update (display_name, headline, bio, version, updated_at)
          on portfolio_config.settings from shipwithali_application
      `);
      const privileges = await admin.query(`
        select has_column_privilege('shipwithali_application', 'portfolio_config.settings', column_name, 'UPDATE') as can_update
          from unnest(array['display_name', 'headline', 'bio', 'version', 'updated_at']) as column_name
      `);
      expect(privileges.rows).toEqual([
        { can_update: false }, { can_update: false }, { can_update: false },
        { can_update: false }, { can_update: false },
      ]);
    } finally {
      await admin.query("rollback");
    }
  });

  it("uses forced RLS on both settings tables and clears scope after transaction reuse", async () => {
    const rls = await admin.query(`
      select relname, relrowsecurity, relforcerowsecurity
        from pg_class
       where oid in ('portfolio_config.settings'::regclass, 'portfolio_config.contact_channels'::regclass)
       order by relname
    `);
    expect(rls.rows).toEqual([
      { relname: "contact_channels", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "settings", relrowsecurity: true, relforcerowsecurity: true },
    ]);

    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const singleConnection = createPostgresRuntimeDatabase(applicationUrl, { max: 1 });
    try {
      const service = createPortfolioSettingsService({ repository, transactions: singleConnection.transactions, scope });
      await service.provision({ ...values, contactChannels: [] });
      await service.getSettings({ actor: { kind: "owner", ownerId: scope.ownerId, sessionId: "test-session" }, portfolioId: scope.portfolioId });
      const committed = await sql<{ portfolio_id: string; owner_id: string }>`
        select current_setting('shipwithali.portfolio_id', true) as portfolio_id,
               current_setting('shipwithali.owner_id', true) as owner_id
      `.execute(singleConnection.database);
      expect(committed.rows[0]).toMatchObject({ portfolio_id: "", owner_id: "" });

      await expect(singleConnection.transactions.run(async (context) => {
        await repository.getSettings(scope, context);
        throw new Error("synthetic rollback");
      })).rejects.toMatchObject({ code: "POSTGRES_UNAVAILABLE" });
      const rolledBack = await sql<{ portfolio_id: string; owner_id: string }>`
        select current_setting('shipwithali.portfolio_id', true) as portfolio_id,
               current_setting('shipwithali.owner_id', true) as owner_id
      `.execute(singleConnection.database);
      expect(rolledBack.rows[0]).toMatchObject({ portfolio_id: "", owner_id: "" });
    } finally {
      await singleConnection.resource.close();
    }
  });

  it("executes the secured HTTP profile command atomically with replay, concurrency, audit, and the Owner query", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const provisioning = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await provisioning.provision(values);
    const operations = createPostgresOperationsPersistence(database.database);
    const commands = createPortfolioProfileCommandService({ repository, operations, scope });
    const service = createOwnerConfigurationApplicationService(commands, scope.portfolioId);
    const reader = createPortfolioSettingsReader({ repository, transactions: database.transactions, scope });
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "integration-session" };
    let authorized = true;
    let barrier: (() => Promise<void>) | undefined;
    const security: OwnerRequestSecurity = {
      appOrigin: "https://example.com",
      identity: {
        async resolveActorContext() { return ok(actor); },
        async authorizeOperation(query) {
          if (!authorized) return ok(false);
          await barrier?.();
          return decideAuthorization(query);
        },
      },
    };
    const makeRequest = (version: number, key: string, profile: PortfolioSettingsProvisioningValues["profile"]) =>
      new Request("https://example.com/api/owner/v1/configuration/profile", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "sw_owner_session=integration-session-token",
          origin: "https://example.com",
          "x-csrf-token": "integration-csrf-proof",
          "idempotency-key": key,
          "if-match": `"${version}"`,
        },
        body: JSON.stringify(profile),
      });
    const handler = (version: number, key: string, nextProfile: PortfolioSettingsProvisioningValues["profile"]) =>
      handleUpdateOwnerProfileConfiguration(makeRequest(version, key, nextProfile), { service, security });
    const read = () => reader.getSettings({ actor, portfolioId: scope.portfolioId });
    const eventCount = async () => {
      const result = await admin.query(
        "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'portfolio_configuration.profile_updated.v1'",
        [scope.portfolioId],
      );
      return result.rows[0].count as number;
    };
    const startBarrier = () => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      let count = 0;
      barrier = async () => {
        count += 1;
        if (count === 2) release();
        await waiting;
      };
    };

    const raceProfile = { displayName: "Ali Sameh", headline: "Racing update", bio: "Only one transaction can win." };
    startBarrier();
    const race = await Promise.all([
      handler(1, "profile-race-key-left", raceProfile),
      handler(1, "profile-race-key-right", raceProfile),
    ]);
    barrier = undefined;
    expect(race.map((response) => response.status).sort()).toEqual([200, 412]);
    const racedSettings = await read();
    expect(racedSettings.ok && racedSettings.value.version).toBe(2);
    expect(await eventCount()).toBe(1);

    const retryProfile = { ...raceProfile, headline: "Retry-safe update" };
    startBarrier();
    const concurrentRetries = await Promise.all([
      handler(2, "profile-retry-key", retryProfile),
      handler(2, "profile-retry-key", retryProfile),
    ]);
    barrier = undefined;
    const retryBodies = await Promise.all(concurrentRetries.map((response) => response.json()));
    expect(concurrentRetries.map((response) => response.status)).toEqual([200, 200]);
    expect(retryBodies[0]).toEqual(retryBodies[1]);
    expect(retryBodies[0]).toMatchObject({ aggregateVersion: 3, outcome: "configuration-updated" });
    expect(await eventCount()).toBe(2);

    const advance = await handler(3, "profile-advance-key", { ...retryProfile, bio: "Advanced to version four." });
    expect(advance.status).toBe(200);
    const replayAfterAdvance = await handler(2, "profile-retry-key", retryProfile);
    expect(replayAfterAdvance.status).toBe(200);
    expect(await replayAfterAdvance.json()).toEqual(retryBodies[0]);
    expect(await eventCount()).toBe(3);

    const changedHash = await handler(2, "profile-retry-key", { ...retryProfile, bio: "Changed body." });
    expect(changedHash.status).toBe(409);
    const stale = await handler(2, "profile-stale-key", { ...retryProfile, headline: "Stale attempt" });
    expect(stale.status).toBe(412);
    expect(await eventCount()).toBe(3);

    authorized = false;
    const removedAllowlist = await handler(2, "profile-retry-key", retryProfile);
    authorized = true;
    expect(removedAllowlist.status).toBe(403);
    expect(await eventCount()).toBe(3);
    const committed = await read();
    expect(committed).toMatchObject({
      ok: true,
      value: { portfolioId: scope.portfolioId, profile: { headline: "Retry-safe update", bio: "Advanced to version four." }, version: 4 },
    });
    if (committed.ok) {
      expect(committed.value.contactChannels).toEqual(values.contactChannels);
      expect(committed.value.globalCta).toEqual(values.globalCta);
    }
    expect(JSON.stringify(committed)).not.toContain(scope.ownerId);
    expect(JSON.stringify(committed)).not.toContain("integration-session");
  }, 30_000);

  it.each([
    ["settings", "update", "portfolio_config.settings", "new.portfolio_id"],
    ["ledger", "insert", "operations.idempotency_records", "new.operation_scope"],
    ["outbox", "insert", "operations.outbox_events", "new.event_type"],
  ] as const)("rolls back profile state, ledger, and outbox when the %s stage fails", async (stage, action, table, conditionColumn) => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const provisioning = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await provisioning.provision(values);
    const before = await admin.query(
      "select version, display_name, headline, bio from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    const eventCount = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid",
      [scope.portfolioId],
    );
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "failure-session" };
    const security: OwnerRequestSecurity = {
      appOrigin: "https://example.com",
      identity: {
        async resolveActorContext() { return ok(actor); },
        async authorizeOperation(query) { return decideAuthorization(query); },
      },
    };
    const operations = createPostgresOperationsPersistence(database.database);
    const commands = createPortfolioProfileCommandService({ repository, operations, scope });
    const service = createOwnerConfigurationApplicationService(commands, scope.portfolioId);
    const suffix = `${stage}_${process.pid}_${randomBytes(3).toString("hex")}`;
    const idempotencyKey = `failure-key-${stage}-${process.pid}`;
    const trigger = `phase4_profile_fail_${suffix}`;
    const functionName = `phase4_profile_fail_${suffix}`;
    const reference = conditionColumn === "new.portfolio_id"
      ? `new.portfolio_id = '${scope.portfolioId}'::uuid`
      : conditionColumn === "new.event_type"
        ? "new.event_type = 'portfolio_configuration.profile_updated.v1'"
        : "new.operation_scope = 'portfolio-configuration.update-owner-profile'";
    await admin.query(`create function public.${functionName}() returns trigger language plpgsql as $$ begin raise exception 'synthetic profile ${stage} failure'; end $$`);
    await admin.query(`create trigger ${trigger} before ${action} on ${table} for each row when (${reference}) execute function public.${functionName}()`);
    try {
      const response = await handleUpdateOwnerProfileConfiguration(
        new Request("https://example.com/api/owner/v1/configuration/profile", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "sw_owner_session=failure-session-token",
            origin: "https://example.com",
            "x-csrf-token": "failure-csrf-proof",
            "idempotency-key": idempotencyKey,
            "if-match": '"1"',
          },
          body: JSON.stringify({ ...values.profile, bio: `Profile update reaches ${stage}.` }),
        }),
        { service, security },
      );
      expect(response.status).toBe(500);
    } finally {
      await admin.query(`drop trigger if exists ${trigger} on ${table}`);
      await admin.query(`drop function if exists public.${functionName}()`);
    }
    const after = await admin.query(
      "select version, display_name, headline, bio from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    const eventsAfter = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid",
      [scope.portfolioId],
    );
    expect(after.rows).toEqual(before.rows);
    expect(eventsAfter.rows[0].count).toBe(eventCount.rows[0].count);
    const keyCount = await admin.query(
      "select count(*)::int as count from operations.idempotency_records where operation_scope = 'portfolio-configuration.update-owner-profile' and key_hash = $1",
      [createHash("sha256").update(idempotencyKey, "utf8").digest("hex")],
    );
    expect(keyCount.rows[0].count).toBe(0);
  }, 30_000);
});
