import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStableId, err } from "../../src/shared/domain/index.js";
import {
  createPortfolioSettingsService,
  type PortfolioSettingsProvisioningValues,
} from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
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
             has_table_privilege(role_name, 'portfolio_config.settings', 'UPDATE') as can_update
        from unnest(array[
          'shipwithali_application', 'shipwithali_worker', 'shipwithali_backup', 'anon', 'authenticated'
        ]) as role_name
    `);
    const byRole = new Map(privileges.rows.map((row) => [row.role_name, row]));
    expect(byRole.get("shipwithali_application")).toMatchObject({ schema_usage: true, can_select: true, can_insert: true, can_update: false });
    for (const role of ["shipwithali_worker", "shipwithali_backup", "anon", "authenticated"]) {
      expect(byRole.get(role)).toMatchObject({ schema_usage: false, can_select: false, can_insert: false, can_update: false });
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
});
