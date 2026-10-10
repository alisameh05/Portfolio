import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { sql } from "kysely";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOperationsPersistence,
  getPhase5OwnerApplicationServices,
  getPublicDiscoveryApplicationService,
  initializeDatabaseRuntime,
  resetRuntimeForTests,
} from "../../src/bootstrap/composition-root.js";
import { createPortfolioSettingsService } from "../../src/modules/portfolio-configuration/application/settings-service.js";
import { createPostgresPortfolioSettingsRepository } from "../../src/modules/portfolio-configuration/adapters/postgres-settings.js";
import { createStableId, type IdempotencyKey, type StableId } from "../../src/shared/domain/index.js";
import { createPostgresRuntimeDatabase, resolvePostgresTransaction } from "../../src/shared/adapters/postgres/runtime.js";
import { getLifecycleCoordinator } from "../../src/runtime/lifecycle.js";
import { requestTransactionRollback } from "../../src/runtime/ports.js";

const DATABASE_URL = process.env["PHASE5_SECURITY_DATABASE_URL"];
if (process.env["PHASE5_REQUIRE_SECURITY_DATABASE"] === "1" && !DATABASE_URL) {
  throw new Error("PHASE5_SECURITY_DATABASE_URL_REQUIRED");
}
const describeDatabase = DATABASE_URL === undefined ? describe.skip : describe;
const secretDraftTitle = "Private Security Draft 594d1c";
const privateReviewFinding = "Private review proof 7a10e2";
const STAGE_PATH = process.env["PHASE5_SECURITY_STAGE_PATH"];

function roleIdentifier(name: string): string {
  if (!/^phase5_security_[a-z0-9_]+$/.test(name)) throw new Error("PHASE5_SECURITY_ROLE_INVALID");
  return `"${name}"`;
}

describeDatabase("Phase 5 restricted-principal and migration security against PostgreSQL", () => {
  let admin: Client;
  let applicationLogin: string;
  let applicationConnectionString: string;
  let runtimeReady = false;
  let standaloneRuntime: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
  const restrictedLogins = new Map<string, string>();
  const scope = { portfolioId: createStableId("Portfolio"), ownerId: createStableId("Owner") };
  const actor = { kind: "owner" as const, ownerId: scope.ownerId, sessionId: "phase5-security-owner" };
  const key = (value: string) => value as IdempotencyKey;
  let services: Awaited<ReturnType<typeof getPhase5OwnerApplicationServices>>;
  let privateContentId: StableId<string>;
  let privateRevisionId: StableId<"Revision">;
  let publishedContentId: StableId<string>;
  let publishedRevisionId: StableId<"Revision">;
  let publishedReviewId: StableId<"ContentReview">;
  let publishedRouteIdentity: StableId<"PublicRoute">;

  beforeAll(async () => {
    let stage = "reset-runtime";
    const markStage = (value: string) => {
      stage = value;
      if (STAGE_PATH !== undefined) writeFileSync(STAGE_PATH, value, "utf8");
    };
    try {
    resetRuntimeForTests();
    markStage("connect-admin");
    admin = new Client({ connectionString: DATABASE_URL! });
    await admin.connect();
    applicationLogin = `phase5_security_application_${process.pid}_${randomBytes(3).toString("hex")}`;
    const applicationPassword = randomBytes(32).toString("hex");
    await admin.query(`create role ${roleIdentifier(applicationLogin)} login password '${applicationPassword}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    await admin.query(`grant shipwithali_application to ${roleIdentifier(applicationLogin)}`);
    for (const role of ["anon", "authenticated", "shipwithali_worker", "shipwithali_backup", "shipwithali_migration"]) {
      const login = `phase5_security_${role.replaceAll("shipwithali_", "")}_${process.pid}_${randomBytes(3).toString("hex")}`;
      const password = randomBytes(32).toString("hex");
      await admin.query(`create role ${roleIdentifier(login)} login password '${password}' nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
      await admin.query(`grant ${role} to ${roleIdentifier(login)}`);
      const url = new URL(DATABASE_URL!);
      url.username = login;
      url.password = password;
      restrictedLogins.set(role, url.toString());
    }
    markStage("initialize-runtime");
    const applicationUrl = new URL(DATABASE_URL!);
    applicationUrl.username = applicationLogin;
    applicationUrl.password = applicationPassword;
    applicationConnectionString = applicationUrl.toString();
    await initializeDatabaseRuntime({
      NODE_ENV: "test",
      APP_BASE_URL: "https://example.com",
      DATABASE_URL: applicationConnectionString,
      PORTFOLIO_ID: scope.portfolioId,
      OWNER_ID: scope.ownerId,
    }, "application");
    runtimeReady = true;
    markStage("provision-portfolio");
    const settings = createPortfolioSettingsService({
      repository: createPostgresPortfolioSettingsRepository(),
      transactions: getOperationsPersistence().transactions,
      scope,
    });
    const configured = await settings.provision({
      profile: { displayName: "Security fixture", headline: "Private", bio: "Sanitized test fixture." },
      contactChannels: [],
      globalCta: { label: "Contact", destination: "https://example.com/contact", unavailableFallback: "Unavailable" },
    });
    if (!configured.ok) {
      markStage(`provision-portfolio-rejected-${configured.error.kind.replaceAll("_", "-")}-${configured.error.code.toLowerCase().replaceAll("_", "-")}`);
      throw new Error("PHASE5_SECURITY_PORTFOLIO_SETUP_FAILED");
    }
    markStage("resolve-owner-services");
    services = await getPhase5OwnerApplicationServices();

    markStage("create-private-content");
    const created = await services.contentAuthoring.createContent({
      actor,
      idempotencyKey: key("phase5-security-private-create"),
      correlationId: "phase5-security-private-create",
      payload: {
        contentType: "project", locale: "en", title: secretDraftTitle,
        summary: "Private draft summary.", body: "Private draft body and proof remain private.",
        candidateSlug: "private-security-draft",
        caseStudy: { problem: "Private problem.", ownerRole: "Private role.", contributions: ["Private contribution."], outcomes: ["Private outcome."], lessons: "Private lesson." },
        evidence: { claims: [], artifacts: [] }, externalLinks: [],
      },
    });
    if (!created.ok) throw new Error("PHASE5_SECURITY_PRIVATE_CONTENT_SETUP_FAILED");
    privateContentId = created.value.contentId;
    privateRevisionId = created.value.revisionId;

    markStage("create-public-content");
    const publicArtifactId = createStableId("SupportingArtifact");
    const publicDraft = await services.contentAuthoring.createContent({
      actor,
      idempotencyKey: key("phase5-security-published-create"),
      correlationId: "phase5-security-published-create",
      payload: {
        contentType: "project", locale: "en", title: "Approved public project",
        summary: "Public projection summary.", body: "Only approved public content is returned.",
        candidateSlug: "approved-public-security-project",
        caseStudy: { problem: "A real public problem.", ownerRole: "Owner role.", contributions: ["Contribution."], outcomes: ["Outcome."], lessons: "Lesson." },
        evidence: {
          claims: [{ claimId: createStableId("EvidenceClaim"), text: "The supporting demonstration shows the published workflow.", artifactIds: [publicArtifactId] }],
          artifacts: [{ id: publicArtifactId, title: "Public workflow demonstration", destinationUrl: "https://example.com/security-demo" }],
        },
        externalLinks: [],
      },
    });
    if (!publicDraft.ok) throw new Error("PHASE5_SECURITY_PUBLIC_CONTENT_SETUP_FAILED");
    publishedContentId = publicDraft.value.contentId;
    markStage("preview-public-content");
    const preview = await services.contentAuthoring.previewRevision({ actor, contentId: publicDraft.value.contentId, revisionId: publicDraft.value.revisionId });
    if (!preview.ok) throw new Error("PHASE5_SECURITY_PUBLIC_PREVIEW_SETUP_FAILED");
    publishedRevisionId = publicDraft.value.revisionId;
    markStage("review-public-content");
    const reviewed = await services.contentAuthoring.reviewRevision({
      actor, contentId: publicDraft.value.contentId, revisionId: publicDraft.value.revisionId,
      expectedVersion: publicDraft.value.aggregateVersion, idempotencyKey: key("phase5-security-public-review"),
      correlationId: "phase5-security-public-review", locale: "en", snapshotHash: preview.value.snapshotHash,
      evidenceVersion: preview.value.evidenceVersion, decision: "accepted", findings: [privateReviewFinding],
    });
    if (!reviewed.ok) throw new Error("PHASE5_SECURITY_PUBLIC_REVIEW_SETUP_FAILED");
    publishedReviewId = reviewed.value.reviewId;
    markStage("publish-public-content");
    const published = await services.contentAuthoring.publishLanguageVersion({
      actor, contentId: publicDraft.value.contentId, revisionId: publicDraft.value.revisionId,
      expectedVersion: reviewed.value.aggregateVersion, idempotencyKey: key("phase5-security-public-publish"),
      correlationId: "phase5-security-public-publish", locale: "en",
    });
    markStage("publish-public-content-returned");
    if (!published.ok) {
      markStage(`publish-rejected-${published.error.kind.replaceAll("_", "-")}-${published.error.code.toLowerCase().replaceAll("_", "-")}`);
      throw new Error(`PHASE5_SECURITY_PUBLICATION_SETUP_FAILED:${published.error.kind}:${published.error.code}`);
    }
    markStage("publish-succeeded");
    if (published.value.routeIdentity == null) {
      markStage("publish-no-route");
      throw new Error("PHASE5_SECURITY_PUBLIC_ROUTE_SETUP_FAILED");
    }
    publishedRouteIdentity = published.value.routeIdentity;
    markStage("setup-complete");
    } catch (error) {
      const safePublicationCode = error instanceof Error && /^PHASE5_SECURITY_PUBLICATION_SETUP_FAILED:[a-z_]+:[A-Z0-9_]+$/u.test(error.message)
        ? `:${error.message}`
        : "";
      throw new Error(`PHASE5_SECURITY_SETUP_FAILED:${stage}${safePublicationCode}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (runtimeReady) await getLifecycleCoordinator().shutdown();
    if (standaloneRuntime !== undefined) await standaloneRuntime.resource.close();
    resetRuntimeForTests();
    if (admin !== undefined) {
      let cleanupFailed = false;
      for (const login of [applicationLogin, ...[...restrictedLogins.values()].map((url) => new URL(url).username)]) {
        try { await admin.query(`alter role ${roleIdentifier(login)} nologin`); } catch { cleanupFailed = true; }
        try { await admin.query(`drop role if exists ${roleIdentifier(login)}`); } catch { cleanupFailed = true; }
      }
      await admin.end();
      if (cleanupFailed) throw new Error("PHASE5_SECURITY_ROLE_CLEANUP_FAILED");
    }
  });

  it("keeps private content private while the in-process discovery query returns only published approved projections", async () => {
    const ownerView = await services.contentAuthoring.getOwnerContentAggregate({ actor, contentId: privateContentId });
    expect(ownerView).toMatchObject({ ok: true, value: { lifecycle: "draft" } });
    const foreignOwner = await services.contentAuthoring.getOwnerContentAggregate({
      actor: { kind: "owner", ownerId: createStableId("Owner"), sessionId: "wrong-owner" }, contentId: privateContentId,
    });
    expect(foreignOwner).toMatchObject({ ok: false, error: { kind: "forbidden", code: "OWNER_REQUIRED" } });
    const publicDiscovery = await getPublicDiscoveryApplicationService();
    const page = await publicDiscovery.getPublicDiscovery({ locale: "en", limit: 100 });
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.entries.map((entry) => entry.projectId)).toContain(publishedContentId);
    expect(page.value.entries.map((entry) => entry.projectId)).not.toContain(privateContentId);
    const safeProjection = JSON.stringify(page.value);
    expect(safeProjection).toContain("Approved public project");
    expect(safeProjection).not.toContain(secretDraftTitle);
    expect(safeProjection).not.toContain(privateReviewFinding);
    expect(safeProjection).not.toContain("Private draft body");
  });

  it("enforces immutable revisions and reviews plus same-locale publication pointers in PostgreSQL", async () => {
    await expect(admin.query("update content.revisions set body = 'tampered' where revision_id = $1", [privateRevisionId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(admin.query("update content.revision_reviews set findings = '[]'::jsonb where review_id = $1", [publishedReviewId]))
      .rejects.toMatchObject({ code: "55000" });
    await expect(admin.query(`
      insert into content.language_publications (
        content_id, portfolio_id, content_type, locale, revision_id, review_id,
        route_identity, publication_sequence, published_at
      ) values ($1, $2, 'project', 'ar', $3, $4, $5, 1, transaction_timestamp())
    `, [publishedContentId, scope.portfolioId, publishedRevisionId, publishedReviewId, publishedRouteIdentity]))
      .rejects.toMatchObject({ code: "23503" });
    await expect(admin.query(`
      insert into content.language_publications (
        content_id, portfolio_id, content_type, locale, revision_id, review_id,
        route_identity, publication_sequence, published_at
      ) select content_id, portfolio_id, content_type, locale, revision_id, review_id,
               route_identity, publication_sequence, published_at
          from content.language_publications where content_id = $1 and locale = 'en'
    `, [publishedContentId])).rejects.toMatchObject({ code: "23505" });
  });

  it("denies actual public, authenticated, worker, and backup logins direct access to private Phase 5 rows", async () => {
    for (const role of ["anon", "authenticated", "shipwithali_worker", "shipwithali_backup"]) {
      const probe = new Client({ connectionString: restrictedLogins.get(role)! });
      await probe.connect();
      try {
        await expect(probe.query("select content_id from content.items")).rejects.toMatchObject({ code: "42501" });
        await expect(probe.query("select revision_id from content.revisions")).rejects.toMatchObject({ code: "42501" });
        await expect(probe.query("select review_id from content.revision_reviews")).rejects.toMatchObject({ code: "42501" });
        await expect(probe.query("select content_id from content.public_project_locales")).rejects.toMatchObject({ code: "42501" });
        await expect(probe.query("select content_id from taxonomy.project_discovery_locales")).rejects.toMatchObject({ code: "42501" });
        await expect(probe.query("insert into content.items(content_id, portfolio_id, content_type) values ($1, $2, 'project')", [privateContentId, scope.portfolioId]))
          .rejects.toMatchObject({ code: "42501" });
      } finally {
        await probe.end();
      }
    }
    const views = await admin.query(`select viewname from pg_views where schemaname = 'public_read' order by viewname`);
    expect(views.rows).toEqual([]);
    const grants = await admin.query(`
      select grantee, table_name, privilege_type
        from information_schema.role_table_grants
       where table_schema in ('content', 'taxonomy')
         and grantee in ('PUBLIC', 'anon', 'authenticated', 'shipwithali_worker', 'shipwithali_backup')
       order by grantee, table_name, privilege_type
    `);
    expect(grants.rows).toEqual([]);
  });

  it("limits the application login to its configured Owner and Portfolio and keeps migration access off runtime credentials", async () => {
    const applicationLoginState = await admin.query(`
      select login.rolsuper, login.rolbypassrls,
             bool_or(granted.rolname = 'shipwithali_application') as application_member,
             bool_or(granted.rolname = 'shipwithali_migration') as migration_member
        from pg_roles login
        left join pg_auth_members membership on membership.member = login.oid
        left join pg_roles granted on granted.oid = membership.roleid
       where login.rolname = $1 group by login.rolname, login.rolsuper, login.rolbypassrls
    `, [applicationLogin]);
    expect(applicationLoginState.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false, application_member: true, migration_member: false });
    const migrationRole = await admin.query("select rolcanlogin, rolsuper, rolbypassrls from pg_roles where rolname = 'shipwithali_migration'");
    expect(migrationRole.rows[0]).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });

    const appProbe = new Client({ connectionString: applicationConnectionString });
    await appProbe.connect();
    try {
      await appProbe.query("begin");
      await appProbe.query("select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true)", [scope.portfolioId, scope.ownerId]);
      const configuredRows = await appProbe.query("select count(*)::int as count from content.items where portfolio_id = $1::uuid", [scope.portfolioId]);
      expect(configuredRows.rows[0].count).toBeGreaterThanOrEqual(2);
      await appProbe.query("select set_config('shipwithali.owner_id', $1, true)", [createStableId("Owner")]);
      const wrongOwnerRows = await appProbe.query("select count(*)::int as count from content.items where portfolio_id = $1::uuid", [scope.portfolioId]);
      expect(wrongOwnerRows.rows[0].count).toBe(0);
      await appProbe.query("select set_config('shipwithali.portfolio_id', $1, true), set_config('shipwithali.owner_id', $2, true)", [createStableId("Portfolio"), scope.ownerId]);
      const foreignPortfolioRows = await appProbe.query("select count(*)::int as count from content.items where portfolio_id = $1::uuid", [scope.portfolioId]);
      expect(foreignPortfolioRows.rows[0].count).toBe(0);
      await appProbe.query("rollback");
    } finally {
      await appProbe.end();
    }
    const migrationProbe = new Client({ connectionString: restrictedLogins.get("shipwithali_migration")! });
    await migrationProbe.connect();
    try {
      await migrationProbe.query("set role shipwithali_migration");
      const migrationIdentity = await migrationProbe.query("select current_user");
      expect(migrationIdentity.rows[0].current_user).toBe("shipwithali_migration");
    } finally {
      await migrationProbe.end();
    }
  });

  it("resets transaction-local claims after success, expected rejection, rollback, and a database fault on a reused pool connection", async () => {
    // Use the same one-connection pool for every outcome so the next operation reuses the same session.
    standaloneRuntime = createPostgresRuntimeDatabase(applicationConnectionString, { max: 1 });
    const checkNoClaims = async () => {
      const state = await sql<{ portfolio: string | null; owner: string | null }>`
        select nullif(current_setting('shipwithali.portfolio_id', true), '') as portfolio,
               nullif(current_setting('shipwithali.owner_id', true), '') as owner
      `.execute(standaloneRuntime!.database);
      expect(state.rows[0]).toEqual({ portfolio: null, owner: null });
    };
    const outcome = async (kind: "success" | "rejection" | "rollback" | "fault") => {
      const run = standaloneRuntime!.transactions.run(async (context) => {
        const executor = resolvePostgresTransaction(context);
        await sql`select set_config('shipwithali.portfolio_id', ${scope.portfolioId}, true),
                         set_config('shipwithali.owner_id', ${scope.ownerId}, true)`.execute(executor);
        const current = await sql<{ portfolio: string; owner: string }>`
          select current_setting('shipwithali.portfolio_id', true) as portfolio,
                 current_setting('shipwithali.owner_id', true) as owner
        `.execute(executor);
        expect(current.rows[0]).toEqual({ portfolio: scope.portfolioId, owner: scope.ownerId });
        if (kind === "rejection") return { ok: false, code: "EXPECTED_REJECTION" };
        if (kind === "rollback") return requestTransactionRollback({ ok: false, code: "ROLLED_BACK" });
        if (kind === "fault") throw new Error("synthetic transaction fault");
        return { ok: true };
      });
      if (kind === "fault") await expect(run).rejects.toMatchObject({ code: "POSTGRES_UNAVAILABLE", message: "PostgreSQL operation failed." });
      else if (kind === "rollback") await expect(run).resolves.toEqual({ ok: false, code: "ROLLED_BACK" });
      else if (kind === "rejection") await expect(run).resolves.toEqual({ ok: false, code: "EXPECTED_REJECTION" });
      else await expect(run).resolves.toEqual({ ok: true });
      await checkNoClaims();
    };
    await outcome("success");
    await outcome("rejection");
    await outcome("rollback");
    await outcome("fault");
  });
});
