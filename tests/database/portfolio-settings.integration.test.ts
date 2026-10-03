import { createHash, createHmac, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStableId, err, ok } from "../../src/shared/domain/index.js";
import { createIdentityAccessService, decideAuthorization } from "../../src/modules/identity-access/index.js";
import type { CryptoPort } from "../../src/modules/identity-access/index.js";
import { SupabaseOwnerSessionAdapter } from "../../src/modules/identity-access/adapters/supabase-auth.js";
import { createOwnerConfigurationApplicationService } from "../../src/runtime/owner-configuration-service.js";
import { handleUpdateOwnerContactChannels, handleUpdateOwnerGlobalProjectCta, handleUpdateOwnerProfileConfiguration } from "../../src/runtime/http/owner-configuration.js";
import type { OwnerRequestSecurity } from "../../src/runtime/http/owner-security.js";
import { createPortfolioProfileCommandService } from "../../src/modules/portfolio-configuration/application/profile-command.js";
import { createPortfolioContactChannelsCommandService } from "../../src/modules/portfolio-configuration/application/contact-channels-command.js";
import { createPortfolioGlobalCtaCommandService } from "../../src/modules/portfolio-configuration/application/cta-command.js";
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
  const restrictedLogins = new Map<string, string>();
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
    for (const role of ["anon", "authenticated", "shipwithali_worker", "shipwithali_backup"] as const) {
      const restrictedLogin = `phase4_settings_${role}_${process.pid}_${randomBytes(3).toString("hex")}`;
      const restrictedPassword = randomBytes(32).toString("hex");
      await admin.query(`create role ${quoteIdentifier(restrictedLogin)} login password '${restrictedPassword}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
      const restrictedUrl = new URL(DATABASE_URL!);
      restrictedUrl.username = restrictedLogin;
      restrictedUrl.password = restrictedPassword;
      restrictedLogins.set(role, restrictedUrl.toString());
      await admin.query(`grant ${role} to ${quoteIdentifier(restrictedLogin)}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (database !== undefined) await database.resource.close();
    if (admin !== undefined) {
      let cleanupFailed = false;
      try {
        for (const [role, url] of restrictedLogins) {
          const login = new URL(url).username;
          try { await admin.query(`alter role ${quoteIdentifier(login)} nologin`); } catch { cleanupFailed = true; }
          try { await admin.query(`drop role if exists ${quoteIdentifier(login)}`); } catch { cleanupFailed = true; }
        }
        try { await admin.query(`drop role if exists ${quoteIdentifier(loginRole)}`); } catch { cleanupFailed = true; }
      } finally {
        await admin.end();
      }
      if (cleanupFailed) throw new Error("PORTFOLIO_SETTINGS_RESTRICTED_ROLE_CLEANUP_FAILED");
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
             has_table_privilege(role_name, 'portfolio_config.contact_channels', 'DELETE') as can_delete_channels,
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
      can_delete_channels: true,
      can_update_profile: true, can_update_cta: true, can_update_identity: false,
    });
    for (const role of ["shipwithali_worker", "shipwithali_backup", "anon", "authenticated"]) {
      expect(byRole.get(role)).toMatchObject({
        schema_usage: false, can_select: false, can_insert: false,
        can_delete_channels: false,
        can_update_profile: false, can_update_cta: false, can_update_identity: false,
      });
    }
  });

  it("proves only the restricted application login can reach configured settings and private identity mappings", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const service = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await service.provision(values);
    const claims = JSON.stringify({ role: "authenticated", sub: createStableId("Owner") });
    const privilege = await admin.query(`
      select login.rolname, login.rolsuper, login.rolbypassrls,
             array_remove(array_agg(granted.rolname::text order by granted.rolname::text), null::text) as memberships
        from pg_roles login
        left join pg_auth_members membership on membership.member = login.oid
        left join pg_roles granted on granted.oid = membership.roleid
       where login.rolname = any($1::text[])
       group by login.rolname, login.rolsuper, login.rolbypassrls
       order by login.rolname
    `, [[...restrictedLogins.values()].map((url) => new URL(url).username).concat(loginRole)]);
    expect(privilege.rows).toHaveLength(restrictedLogins.size + 1);
    expect(privilege.rows.every((row) => row.rolsuper === false && row.rolbypassrls === false)).toBe(true);
    const expectedMemberships = new Map([
      [loginRole, ["shipwithali_application"]],
      ...[...restrictedLogins].map(([role, url]) => [new URL(url).username, [role]] as const),
    ]);
    for (const row of privilege.rows) expect(row.memberships).toEqual(expectedMemberships.get(row.rolname));

    const allowedIdentityRead = new Client({ connectionString: applicationUrl });
    await allowedIdentityRead.connect();
    try {
      await allowedIdentityRead.query(
        "insert into identity_access.owner_links (github_subject, owner_id) values ($1, $2::uuid)",
        ["phase4-restricted-principal-probe", scope.ownerId],
      );
      const mapping = await allowedIdentityRead.query(
        "select owner_id::text from identity_access.owner_links where github_subject = $1",
        ["phase4-restricted-principal-probe"],
      );
      expect(mapping.rows).toEqual([{ owner_id: scope.ownerId }]);
      const identity = await allowedIdentityRead.query("select session_user, current_user");
      expect(identity.rows[0]).toEqual({ session_user: loginRole, current_user: loginRole });
    } finally {
      await allowedIdentityRead.end();
    }

    for (const role of ["anon", "authenticated", "shipwithali_worker"] as const) {
      const untrusted = new Client({ connectionString: restrictedLogins.get(role)! });
      await untrusted.connect();
      try {
        await untrusted.query("select set_config('shipwithali.portfolio_id', $1, false), set_config('shipwithali.owner_id', $2, false), set_config('request.jwt.claims', $3, false)", [scope.portfolioId, scope.ownerId, claims]);
        await expect(untrusted.query("select count(*) from portfolio_config.settings")).rejects.toBeDefined();
        await expect(untrusted.query("select count(*) from identity_access.owner_links")).rejects.toBeDefined();
      } finally {
        await untrusted.end();
      }
    }

    const otherScope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    await createPortfolioSettingsService({ repository, transactions: database.transactions, scope: otherScope }).provision(values);
    const configuredRows = await admin.query(
      "select portfolio_id::text from portfolio_config.settings where portfolio_id = any($1::uuid[]) order by portfolio_id",
      [[scope.portfolioId, otherScope.portfolioId]],
    );
    expect(configuredRows.rows).toHaveLength(2);

    const isolated = new Client({ connectionString: applicationUrl });
    await isolated.connect();
    try {
      await isolated.query("begin");
      await isolated.query(
        "select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true)",
        [scope.portfolioId, scope.ownerId],
      );
      const visibleRows = await isolated.query("select portfolio_id::text from portfolio_config.settings order by portfolio_id");
      expect(visibleRows.rows).toEqual([{ portfolio_id: scope.portfolioId }]);
    } finally {
      await isolated.query("rollback");
      await isolated.end();
    }

    const operations = createPostgresOperationsPersistence(database.database);
    const profileCommands = createPortfolioProfileCommandService({ repository, operations, scope });
    const contactCommands = createPortfolioContactChannelsCommandService({ repository, operations, scope });
    const ctaCommands = createPortfolioGlobalCtaCommandService({ repository, operations, scope });
    const configurationService = createOwnerConfigurationApplicationService(profileCommands, contactCommands, ctaCommands, scope.portfolioId);
    const signingKey = "phase4-test-signing-key-with-at-least-32-characters";
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", kid: "phase4-test" });
    const payload = encode({
      iss: "https://identity.example.test/auth/v1",
      aud: "authenticated",
      sub: "attacker-not-on-allowlist",
      session_id: "forged-claims-session",
      exp: Math.floor(Date.now() / 1000) + 300,
      role: "owner",
      user_metadata: { role: "owner", ownerId: scope.ownerId, portfolioId: scope.portfolioId },
      app_metadata: { ownerId: scope.ownerId, portfolioId: scope.portfolioId },
    });
    const unsignedToken = `${header}.${payload}`;
    const forgedSession = `${unsignedToken}.${createHmac("sha256", signingKey).update(unsignedToken).digest("base64url")}`;
    const auth = new SupabaseOwnerSessionAdapter({
      issuer: "https://identity.example.test/auth/v1",
      audience: "authenticated",
      allowedAlgorithms: ["HS256"],
      signingKeys: new Map([["phase4-test", signingKey]]),
      ownerAllowlist: ["known-github-owner"],
      stableOwnerId: scope.ownerId,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      resolveProviderIdentity: async (subject) => ({ provider: "github", subject }),
      isSessionRevoked: async () => false,
    });
    const unusedCrypto = {} as CryptoPort;
    const security: OwnerRequestSecurity = {
      appOrigin: "https://example.com",
      identity: createIdentityAccessService({ auth, crypto: unusedCrypto }),
    };
    const beforeSpoof = await admin.query(
      "select display_name, version from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    const beforeEvents = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid",
      [scope.portfolioId],
    );
    const spoofResponse = await handleUpdateOwnerProfileConfiguration(
      new Request("https://example.com/api/owner/v1/configuration/profile", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: `sw_owner_session=${forgedSession}`,
          origin: "https://example.com",
          "x-csrf-token": "valid-test-csrf-proof",
          "idempotency-key": "forged-claims-idempotency-key",
          "if-match": '"1"',
          "x-owner-id": scope.ownerId,
          "x-portfolio-id": scope.portfolioId,
        },
        body: JSON.stringify({ displayName: "Forged Owner", headline: "Must be denied", bio: "Untrusted claims." }),
      }),
      { service: configurationService, security },
    );
    expect(spoofResponse.status).toBe(403);
    const afterSpoof = await admin.query(
      "select display_name, version from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    const afterEvents = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid",
      [scope.portfolioId],
    );
    expect(afterSpoof.rows).toEqual(beforeSpoof.rows);
    expect(afterEvents.rows).toEqual(beforeEvents.rows);
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
    const contactChannelsCommands = createPortfolioContactChannelsCommandService({ repository, operations, scope });
    const ctaCommands = createPortfolioGlobalCtaCommandService({ repository, operations, scope });
    const service = createOwnerConfigurationApplicationService(commands, contactChannelsCommands, ctaCommands, scope.portfolioId);
    const reader = createPortfolioSettingsReader({ repository, transactions: database.transactions, scope });
    const publicReader = createPortfolioSettingsReader({
      repository,
      transactions: database.transactions,
      scope,
      capabilityReader: {
        async getFacts() {
          return {
            currentCv: "available",
            externalLinks: "available",
            globalProjectCta: "unavailable",
          } as const;
        },
      },
    });
    const arabicPublicSettings = await publicReader.getPublicConfiguration({ locale: "ar" });
    expect(arabicPublicSettings).toMatchObject({
      ok: true,
      value: {
        locale: "ar",
        profile: values.profile,
        contactChannels: [values.contactChannels[0]],
        globalCta: {
          availability: "unavailable",
          label: values.globalCta.label,
          unavailableFallback: values.globalCta.unavailableFallback,
        },
        capabilities: { currentCvAvailable: false, externalLinksAvailable: false },
      },
    });
    expect(JSON.stringify(arabicPublicSettings)).not.toContain(String(scope.ownerId));
    expect(JSON.stringify(arabicPublicSettings)).not.toContain(String(scope.portfolioId));
    expect(JSON.stringify(arabicPublicSettings)).not.toContain(values.globalCta.destination);
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
    const publicSettingsAfterCommand = await publicReader.getPublicConfiguration({ locale: "en" });
    expect(publicSettingsAfterCommand).toMatchObject({
      ok: true,
      value: { profile: { ...retryProfile, bio: "Advanced to version four." } },
    });
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

  it("executes secured Contact channel replacement with ordering, atomic versioning, replay, concurrency, and a minimal audit", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const provisioning = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await provisioning.provision(values);
    const operations = createPostgresOperationsPersistence(database.database);
    const commands = createPortfolioContactChannelsCommandService({ repository, operations, scope });
    const ctaCommands = createPortfolioGlobalCtaCommandService({ repository, operations, scope });
    const service = createOwnerConfigurationApplicationService(
      createPortfolioProfileCommandService({ repository, operations, scope }),
      commands,
      ctaCommands,
      scope.portfolioId,
    );
    const reader = createPortfolioSettingsReader({ repository, transactions: database.transactions, scope });
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "channels-integration-session" };
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
    const makeRequest = (version: number, key: string, nextChannels: readonly unknown[]) =>
      new Request("https://example.com/api/owner/v1/configuration/contact-channels", {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie: "sw_owner_session=channels-integration-token",
          origin: "https://example.com",
          "x-csrf-token": "channels-integration-csrf",
          "idempotency-key": key,
          "if-match": `"${version}"`,
        },
        body: JSON.stringify({ channels: nextChannels }),
      });
    const handler = (version: number, key: string, nextChannels: readonly unknown[]) =>
      handleUpdateOwnerContactChannels(makeRequest(version, key, nextChannels), { service, security });
    const read = () => reader.getSettings({ actor, portfolioId: scope.portfolioId });
    const eventCount = async () => {
      const result = await admin.query(
        "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'portfolio_configuration.channels_updated.v1'",
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
    const orderedChannels = [
      { channel: "linkedin", label: "LinkedIn", destination: "https://www.linkedin.com/in/ali", availableLocales: ["ar", "en"] },
      { channel: "whatsapp", label: "WhatsApp", destination: "https://wa.me/201234567890", availableLocales: ["ar", "en"] },
      { channel: "instagram", label: "Instagram", destination: "https://www.instagram.com/ali", availableLocales: ["en"] },
      { channel: "phone", label: "Phone", destination: "tel:+201234567890", availableLocales: ["ar"] },
      { channel: "email", label: "Email", destination: "mailto:ali@example.com", availableLocales: ["en"] },
      { channel: "other", label: "Website", destination: "https://example.org/contact", availableLocales: ["ar"] },
    ];
    const maximumChannels = Array.from({ length: 20 }, (_, index) => ({
      ...orderedChannels[index % orderedChannels.length]!,
      label: `Channel ${index + 1}`,
    }));

    const first = await handler(1, "channels-replace-key", orderedChannels);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ aggregateId: scope.portfolioId, aggregateVersion: 2, outcome: "configuration-updated" });
    let committed = await read();
    expect(committed).toMatchObject({ ok: true, value: { contactChannels: orderedChannels, version: 2 } });
    if (committed.ok) {
      expect(committed.value.profile).toEqual(values.profile);
      expect(committed.value.globalCta).toEqual(values.globalCta);
    }

    const maximum = await handler(2, "channels-maximum-key", maximumChannels);
    expect(maximum.status).toBe(200);
    expect(await maximum.json()).toMatchObject({ aggregateVersion: 3, outcome: "configuration-updated" });
    committed = await read();
    expect(committed).toMatchObject({ ok: true, value: { contactChannels: maximumChannels, version: 3 } });

    const oversized = await handler(3, "channels-oversized-key", [...maximumChannels, maximumChannels[0]]);
    expect(oversized.status).toBe(400);
    for (const [key, channel, destination] of [
      ["channels-unsafe-scheme-key", "linkedin", "javascript:alert(1)"],
      ["channels-credentials-key", "linkedin", "https://user:password@www.linkedin.com/in/ali"],
      ["channels-malformed-mailto-key", "email", "mailto:ali@bad..com"],
      ["channels-lookalike-host-key", "linkedin", "https://linkedin.com.attacker.example/ali"],
      ["channels-mail-protocol-mismatch-key", "email", "https://example.org/contact"],
      ["channels-phone-protocol-mismatch-key", "phone", "mailto:ali@example.com"],
    ] as const) {
      const rejected = await handler(3, key, [{ ...orderedChannels[0]!, channel, destination }]);
      expect(rejected.status).toBe(422);
    }
    expect(await eventCount()).toBe(2);
    committed = await read();
    expect(committed).toMatchObject({ ok: true, value: { contactChannels: maximumChannels, version: 3 } });

    const empty = await handler(3, "channels-empty-key", []);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ aggregateVersion: 4, outcome: "configuration-updated" });
    const replay = await handler(1, "channels-replace-key", orderedChannels);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ aggregateVersion: 2, outcome: "configuration-updated" });
    const changedHash = await handler(1, "channels-replace-key", [...orderedChannels].reverse());
    expect(changedHash.status).toBe(409);
    const stale = await handler(3, "channels-stale-key", orderedChannels);
    expect(stale.status).toBe(412);
    authorized = false;
    const removedAllowlist = await handler(1, "channels-replace-key", orderedChannels);
    authorized = true;
    expect(removedAllowlist.status).toBe(403);
    expect(await eventCount()).toBe(3);
    committed = await read();
    expect(committed).toMatchObject({ ok: true, value: { contactChannels: [], version: 4 } });

    const audit = await admin.query(
      "select payload, aggregate_version from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'portfolio_configuration.channels_updated.v1' order by aggregate_version",
      [scope.portfolioId],
    );
    expect(audit.rows).toHaveLength(3);
    expect(audit.rows[0]).toMatchObject({
      aggregate_version: 2,
      payload: { channelCount: 6, channelTypes: ["email", "instagram", "linkedin", "other", "phone", "whatsapp"], ownerScope: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(JSON.stringify(audit.rows)).not.toContain("mailto:ali@example.com");
    expect(JSON.stringify(audit.rows)).not.toContain("wa.me");

    startBarrier();
    const race = await Promise.all([
      handler(4, "channels-race-left", orderedChannels.slice(0, 1)),
      handler(4, "channels-race-right", orderedChannels.slice(1)),
    ]);
    barrier = undefined;
    expect(race.map((response) => response.status).sort()).toEqual([200, 412]);
    expect(await eventCount()).toBe(4);
    committed = await read();
    expect(committed.ok && committed.value.version).toBe(5);
    if (committed.ok) expect([orderedChannels.slice(0, 1), orderedChannels.slice(1)]).toContainEqual(committed.value.contactChannels);
    expect(JSON.stringify(committed)).not.toContain(scope.ownerId);
    expect(JSON.stringify(committed)).not.toContain("channels-integration-session");
  }, 30_000);

  it.each([
    ["aggregate", "update", "portfolio_config.settings", "new.portfolio_id = '${portfolioId}'::uuid"],
    ["channel delete", "delete", "portfolio_config.contact_channels", "old.portfolio_id = '${portfolioId}'::uuid"],
    ["channel insert", "insert", "portfolio_config.contact_channels", "new.portfolio_id = '${portfolioId}'::uuid"],
    ["ledger", "insert", "operations.idempotency_records", "new.operation_scope = 'portfolio-configuration.update-owner-contact-channels'"],
    ["outbox", "insert", "operations.outbox_events", "new.event_type = 'portfolio_configuration.channels_updated.v1'"],
  ] as const)("rolls back channel state, ledger, and outbox when the %s stage fails", async (stage, action, table, rawCondition) => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const provisioning = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await provisioning.provision(values);
    const beforeSettings = await admin.query(
      "select version, display_name, headline, bio from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    const beforeChannels = await admin.query(
      "select position, channel, label, destination, available_locales from portfolio_config.contact_channels where portfolio_id = $1::uuid order by position",
      [scope.portfolioId],
    );
    const beforeEvents = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid",
      [scope.portfolioId],
    );
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "channel-failure-session" };
    const security: OwnerRequestSecurity = {
      appOrigin: "https://example.com",
      identity: {
        async resolveActorContext() { return ok(actor); },
        async authorizeOperation(query) { return decideAuthorization(query); },
      },
    };
    const operations = createPostgresOperationsPersistence(database.database);
    const commands = createPortfolioContactChannelsCommandService({ repository, operations, scope });
    const ctaCommands = createPortfolioGlobalCtaCommandService({ repository, operations, scope });
    const service = createOwnerConfigurationApplicationService(
      createPortfolioProfileCommandService({ repository, operations, scope }), commands, ctaCommands, scope.portfolioId,
    );
    const key = `channels-failure-${stage.replaceAll(" ", "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
    const suffix = `${stage.replaceAll(" ", "_")}_${process.pid}_${randomBytes(3).toString("hex")}`;
    const trigger = `phase4_channels_fail_${suffix}`;
    const functionName = `phase4_channels_fail_${suffix}`;
    const condition = rawCondition.replaceAll("${portfolioId}", scope.portfolioId);
    await admin.query(`create function public.${functionName}() returns trigger language plpgsql as $$ begin raise exception 'synthetic channel ${stage} failure'; end $$`);
    await admin.query(`create trigger ${trigger} before ${action} on ${table} for each row when (${condition}) execute function public.${functionName}()`);
    try {
      const response = await handleUpdateOwnerContactChannels(
        new Request("https://example.com/api/owner/v1/configuration/contact-channels", {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            cookie: "sw_owner_session=channel-failure-token",
            origin: "https://example.com",
            "x-csrf-token": "channel-failure-csrf",
            "idempotency-key": key,
            "if-match": '"1"',
          },
          body: JSON.stringify({ channels: [{
            channel: "email", label: "Replacement", destination: "mailto:replacement@example.com", availableLocales: ["en"],
          }] }),
        }),
        { service, security },
      );
      expect(response.status).toBe(500);
    } finally {
      await admin.query(`drop trigger if exists ${trigger} on ${table}`);
      await admin.query(`drop function if exists public.${functionName}()`);
    }
    const afterSettings = await admin.query(
      "select version, display_name, headline, bio from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    const afterChannels = await admin.query(
      "select position, channel, label, destination, available_locales from portfolio_config.contact_channels where portfolio_id = $1::uuid order by position",
      [scope.portfolioId],
    );
    const afterEvents = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid",
      [scope.portfolioId],
    );
    const keyCount = await admin.query(
      "select count(*)::int as count from operations.idempotency_records where operation_scope = 'portfolio-configuration.update-owner-contact-channels' and key_hash = $1",
      [createHash("sha256").update(key, "utf8").digest("hex")],
    );
    expect(afterSettings.rows).toEqual(beforeSettings.rows);
    expect(afterChannels.rows).toEqual(beforeChannels.rows);
    expect(afterEvents.rows[0].count).toBe(beforeEvents.rows[0].count);
    expect(keyCount.rows[0].count).toBe(0);
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
    const contactChannelsCommands = createPortfolioContactChannelsCommandService({ repository, operations, scope });
    const ctaCommands = createPortfolioGlobalCtaCommandService({ repository, operations, scope });
    const service = createOwnerConfigurationApplicationService(commands, contactChannelsCommands, ctaCommands, scope.portfolioId);
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

  it("executes the secured HTTP CTA update with concurrency, exact replay, operation isolation, and fallback preservation", async () => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const provisioning = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await provisioning.provision(values);
    const operations = createPostgresOperationsPersistence(database.database);
    const commands = createPortfolioProfileCommandService({ repository, operations, scope });
    const contactChannelsCommands = createPortfolioContactChannelsCommandService({ repository, operations, scope });
    const ctaCommands = createPortfolioGlobalCtaCommandService({ repository, operations, scope });
    const service = createOwnerConfigurationApplicationService(commands, contactChannelsCommands, ctaCommands, scope.portfolioId);
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "cta-owner-session" };
    let barrier: (() => Promise<void>) | undefined;
    const security: OwnerRequestSecurity = {
      appOrigin: "https://example.com",
      identity: {
        async resolveActorContext() { return ok(actor); },
        async authorizeOperation(query) {
          await barrier?.();
          return decideAuthorization(query);
        },
      },
    };
    const makeRequest = (version: number, key: string, globalCta: unknown) =>
      new Request("https://example.com/api/owner/v1/configuration/project-cta", {
        method: "PUT",
        headers: {
          "content-type": "application/json", cookie: "sw_owner_session=cta-session-token",
          origin: "https://example.com", "x-csrf-token": "cta-csrf-proof",
          "idempotency-key": key, "if-match": `"${version}"`,
        },
        body: JSON.stringify(globalCta),
      });
    const update = (version: number, key: string, nextCta: unknown) =>
      handleUpdateOwnerGlobalProjectCta(makeRequest(version, key, nextCta), { service, security });
    const invalidUpdates = [
      [{ ...values.globalCta, destination: "http://example.com/contact" }, 422],
      [{ ...values.globalCta, label: "" }, 400],
      [{ ...values.globalCta, label: " " }, 422],
      [{ ...values.globalCta, label: "x".repeat(81) }, 400],
      [{ ...values.globalCta, unavailableFallback: " " }, 422],
      [{ ...values.globalCta, unavailableFallback: "x".repeat(161) }, 400],
    ] as const;
    for (const [index, [invalidCta, status]] of invalidUpdates.entries()) {
      const response = await update(1, `cta-invalid-${process.pid}-${index}`, invalidCta);
      expect(response.status).toBe(status);
    }
    const unchanged = await createPortfolioSettingsReader({ repository, transactions: database.transactions, scope })
      .getSettings({ actor, portfolioId: scope.portfolioId });
    expect(unchanged).toMatchObject({ ok: true, value: { version: 1, globalCta: values.globalCta } });
    const nextLeft = { ...values.globalCta, label: "Start a project", unavailableFallback: "Please contact me by email." };
    const nextRight = { ...values.globalCta, label: "Discuss a project", unavailableFallback: "Please use the contact details." };
    const startBarrier = () => {
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      let count = 0;
      barrier = async () => { if (++count === 2) release(); await waiting; };
    };
    startBarrier();
    const race = await Promise.all([
      update(1, `cta-left-${process.pid}`, nextLeft),
      update(1, `cta-right-${process.pid}`, nextRight),
    ]);
    barrier = undefined;
    expect(race.map((response) => response.status).sort()).toEqual([200, 412]);
    const reader = createPortfolioSettingsReader({ repository, transactions: database.transactions, scope });
    const read = () => reader.getSettings({ actor, portfolioId: scope.portfolioId });
    const committed = await read();
    if (!committed.ok) throw new Error("CTA settings did not commit.");
    expect(committed.value.version).toBe(2);
    expect([nextLeft.label, nextRight.label]).toContain(committed.value.globalCta.label);
    const winning = committed.value.globalCta.label === nextLeft.label
      ? { key: `cta-left-${process.pid}`, value: nextLeft }
      : { key: `cta-right-${process.pid}`, value: nextRight };
    startBarrier();
    const retries = await Promise.all([
      update(1, winning.key, winning.value),
      update(1, winning.key, winning.value),
    ]);
    barrier = undefined;
    const retryBodies = await Promise.all(retries.map((response) => response.json()));
    expect(retries.map((response) => response.status)).toEqual([200, 200]);
    expect(retryBodies[0]).toEqual(retryBodies[1]);
    expect(retryBodies[0]).toMatchObject({ aggregateVersion: 2, outcome: "configuration-updated" });
    expect((await update(1, winning.key, { ...winning.value, unavailableFallback: "Different fallback." })).status).toBe(409);
    expect((await update(1, `cta-stale-${process.pid}`, { ...winning.value, label: "Stale update" })).status).toBe(412);
    const profileResponse = await handleUpdateOwnerProfileConfiguration(
      new Request("https://example.com/api/owner/v1/configuration/profile", {
        method: "PUT",
        headers: {
          "content-type": "application/json", cookie: "sw_owner_session=cta-session-token",
          origin: "https://example.com", "x-csrf-token": "cta-csrf-proof",
          "idempotency-key": winning.key, "if-match": '"2"',
        },
        body: JSON.stringify({ ...values.profile, headline: "An unrelated profile change." }),
      }),
      { service, security },
    );
    expect(profileResponse.status).toBe(200);
    expect((await update(1, winning.key, winning.value)).status).toBe(200);
    const final = await read();
    expect(final).toMatchObject({ ok: true, value: {
      globalCta: winning.value, version: 3,
      profile: { headline: "An unrelated profile change." },
      contactChannels: values.contactChannels,
    } });
    expect(JSON.stringify(final)).not.toContain(scope.ownerId);
    expect(JSON.stringify(final)).not.toContain("cta-session-token");
  }, 30_000);

  it.each([
    ["settings", "update", "portfolio_config.settings", "new.portfolio_id"],
    ["ledger", "insert", "operations.idempotency_records", "new.operation_scope"],
    ["outbox", "insert", "operations.outbox_events", "new.event_type"],
  ] as const)("rolls back CTA state, ledger, and outbox when the %s stage fails", async (stage, action, table, conditionColumn) => {
    const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
    const provisioning = createPortfolioSettingsService({ repository, transactions: database.transactions, scope });
    await provisioning.provision(values);
    const before = await admin.query(
      "select version, global_cta_label, global_cta_destination, global_cta_unavailable_fallback from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    const eventCount = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'portfolio_configuration.cta_updated.v1'",
      [scope.portfolioId],
    );
    const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "cta-failure-session" };
    const security: OwnerRequestSecurity = {
      appOrigin: "https://example.com",
      identity: {
        async resolveActorContext() { return ok(actor); },
        async authorizeOperation(query) { return decideAuthorization(query); },
      },
    };
    const operations = createPostgresOperationsPersistence(database.database);
    const service = createOwnerConfigurationApplicationService(
      createPortfolioProfileCommandService({ repository, operations, scope }),
      createPortfolioContactChannelsCommandService({ repository, operations, scope }),
      createPortfolioGlobalCtaCommandService({ repository, operations, scope }),
      scope.portfolioId,
    );
    const suffix = `${stage}_${process.pid}_${randomBytes(3).toString("hex")}`;
    const idempotencyKey = `cta-failure-${stage}-${suffix}`;
    const trigger = `phase4_cta_fail_${suffix}`;
    const functionName = `phase4_cta_fail_${suffix}`;
    const condition = conditionColumn === "new.portfolio_id"
      ? `new.portfolio_id = '${scope.portfolioId}'::uuid`
      : conditionColumn === "new.event_type"
        ? "new.event_type = 'portfolio_configuration.cta_updated.v1'"
        : "new.operation_scope = 'portfolio-configuration.update-owner-global-project-cta'";
    await admin.query(`create function public.${functionName}() returns trigger language plpgsql as $$ begin raise exception 'synthetic CTA ${stage} failure'; end $$`);
    await admin.query(`create trigger ${trigger} before ${action} on ${table} for each row when (${condition}) execute function public.${functionName}()`);
    try {
      const response = await handleUpdateOwnerGlobalProjectCta(
        new Request("https://example.com/api/owner/v1/configuration/project-cta", {
          method: "PUT",
          headers: {
            "content-type": "application/json", cookie: "sw_owner_session=cta-failure-token",
            origin: "https://example.com", "x-csrf-token": "cta-failure-csrf",
            "idempotency-key": idempotencyKey, "if-match": '"1"',
          },
          body: JSON.stringify({ ...values.globalCta, label: `CTA update reaches ${stage}.` }),
        }),
        { service, security },
      );
      expect(response.status).toBe(500);
    } finally {
      await admin.query(`drop trigger if exists ${trigger} on ${table}`);
      await admin.query(`drop function if exists public.${functionName}()`);
    }
    const after = await admin.query(
      "select version, global_cta_label, global_cta_destination, global_cta_unavailable_fallback from portfolio_config.settings where portfolio_id = $1::uuid",
      [scope.portfolioId],
    );
    expect(after.rows).toEqual(before.rows);
    const eventsAfter = await admin.query(
      "select count(*)::int as count from operations.outbox_events where aggregate_id = $1::uuid and event_type = 'portfolio_configuration.cta_updated.v1'",
      [scope.portfolioId],
    );
    expect(eventsAfter.rows[0].count).toBe(eventCount.rows[0].count);
    const ledger = await admin.query(
      "select count(*)::int as count from operations.idempotency_records where operation_scope = 'portfolio-configuration.update-owner-global-project-cta' and key_hash = $1",
      [createHash("sha256").update(idempotencyKey, "utf8").digest("hex")],
    );
    expect(ledger.rows[0].count).toBe(0);
  }, 30_000);
});
