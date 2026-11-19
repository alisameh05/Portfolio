import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, type StableId } from "../../src/shared/domain/index.js";
import { zPostProjectFeedbackResponse, zProblem } from "../../src/contracts/http/v1/generated/zod.gen.js";
import { createPostgresModerationRepository } from "../../src/modules/interaction-moderation/adapters/postgres-moderation.js";
import { createPostgresOperationsPersistence } from "../../src/modules/portability-operations/adapters/postgres-operations.js";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";

const baseUrls = JSON.parse(process.env["PHASE9_FEEDBACK_HTTP_URLS"] ?? "[]") as string[];
const adminUrl = process.env["PHASE9_FEEDBACK_HTTP_ADMIN_DATABASE_URL"];
const runtimeUrl = process.env["PHASE9_OWNER_HTTP_DATABASE_URL"];
const portfolioId = process.env["PORTFOLIO_ID"];
const ownerId = process.env["OWNER_ID"];
const admin = new Client({ connectionString: adminUrl });
const projectionDatabase = createPostgresRuntimeDatabase(runtimeUrl ?? "postgres://invalid");
const projectionOperations = createPostgresOperationsPersistence(projectionDatabase.database);
const publicFeedbackRepository = createPostgresModerationRepository();

describe.runIf(baseUrls.length === 2 && Boolean(adminUrl) && Boolean(runtimeUrl) && Boolean(portfolioId) && Boolean(ownerId))(
  "Phase 9 #305 production-built Feedback HTTP acceptance",
  () => {
    beforeAll(async () => {
      await admin.connect();
      await admin.query(
        "insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable') on conflict (portfolio_id) do nothing",
        [portfolioId, ownerId],
      );
    });
    afterAll(async () => { await admin.end(); await projectionDatabase.resource.close(); });

    async function seed(lifecycle: "published" | "hidden" = "published", targetPortfolio = portfolioId, reviewerId = ownerId): Promise<StableId<"Project">> {
      const projectId = createStableId("Project");
      const routeId = createStableId("PublicRoute");
      const now = new Date().toISOString();
      await admin.query(
        "insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project',$3)",
        [projectId, targetPortfolio, lifecycle],
      );
      if (lifecycle === "published") {
        const revisionId = createStableId("Revision");
        const reviewId = createStableId("ContentReview");
        const payload = { contentType: "project", locale: "en", title: "Feedback fixture", summary: "Safe summary", body: "Safe body" };
        await admin.query(
          "insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)",
          [routeId, projectId, targetPortfolio, `feedback-${projectId}`, now],
        );
        await admin.query(
          "insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project','en',1,1,'Feedback fixture','Safe summary','Safe body',$4,$5)",
          [revisionId, projectId, targetPortfolio, payload, now],
        );
        await admin.query(
          "insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,'en',1,$5,1,$6,'accepted',$7)",
          [reviewId, projectId, targetPortfolio, revisionId, "a".repeat(64), reviewerId, now],
        );
        await admin.query(
          "insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project','en',$3,$4,$5,1,$6)",
          [projectId, targetPortfolio, revisionId, reviewId, routeId, now],
        );
      }
      return projectId;
    }

    async function submit(input: {
      projectId: StableId<"Project">;
      key?: string;
      name?: string;
      paragraph?: string;
      locale?: "en" | "ar";
      server?: number;
    }): Promise<Response> {
      return fetch(`${baseUrls[input.server ?? 0]}/api/v1/projects/${input.projectId}/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": input.key ?? createStableId("Key") },
        body: JSON.stringify({ name: input.name ?? "Ada", paragraph: input.paragraph ?? "Helpful feedback.", locale: input.locale ?? "en" }),
      });
    }

    it("AC01-02 stores one pending row over built HTTP without issuing or requiring identity", async () => {
      const projectId = await seed();
      const privateName = "PRIVATE_FEEDBACK_NAME_SENTINEL_305";
      const privateParagraph = "PRIVATE_FEEDBACK_TEXT_SENTINEL_305";
      const response = await submit({ projectId, name: privateName, paragraph: privateParagraph });
      expect(response.status).toBe(201);
      const receipt = await response.json();
      expect(zPostProjectFeedbackResponse.safeParse(receipt).success).toBe(true);
      expect(receipt).toEqual({ feedbackId: expect.any(String), projectId, status: "pending" });
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(JSON.stringify(receipt)).not.toContain(privateName);
      expect(JSON.stringify(receipt)).not.toContain(privateParagraph);
      const rows = await admin.query(
        "select feedback_id::text,project_id::text,locale,author_name,paragraph,moderation_state,aggregate_version::text as aggregate_version,submitted_at from interaction.feedback where project_id=$1",
        [projectId],
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ feedback_id: receipt.feedbackId, project_id: projectId, locale: "en", author_name: privateName, paragraph: privateParagraph, moderation_state: "pending", aggregate_version: "1" });
      expect(rows.rows[0].submitted_at).toBeTruthy();
      expect((await admin.query("select count(*)::int as count from measurement.consents")).rows[0].count).toBe(0);
      const event = await admin.query("select payload::text as payload from operations.outbox_events where aggregate_id=$1", [receipt.feedbackId]);
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0].payload).not.toContain(privateName);
      expect(event.rows[0].payload).not.toContain(privateParagraph);
      const projection = await projectionOperations.transactions.run((tx) => publicFeedbackRepository.approved({
        portfolioId: portfolioId as StableId<"Portfolio">, projectId, locale: "en", limit: 25,
      }, tx));
      expect(projection.items).toEqual([]);
    });

    it("AC03 rejects malformed, unknown, oversized, blank, control, and unpublished-locale input", async () => {
      const projectId = await seed();
      const before = Number((await admin.query("select count(*)::int as count from interaction.feedback")).rows[0].count);
      const invalid = [
        "{not-json",
        JSON.stringify({ name: "Ada", paragraph: "Valid", locale: "en", extra: "PRIVATE_SENTINEL" }),
        JSON.stringify({ name: " ", paragraph: "Valid", locale: "en" }),
        JSON.stringify({ name: "Ada", paragraph: "bad\u0001text", locale: "en" }),
        JSON.stringify({ name: "Ada", paragraph: "x".repeat(17_000), locale: "en" }),
      ];
      for (const [index, body] of invalid.entries()) {
        const response = await fetch(`${baseUrls[0]}/api/v1/projects/${projectId}/feedback`, {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": `invalid-feedback-${index}` }, body,
        });
        expect([400, 404, 422]).toContain(response.status);
        expect(await response.text()).not.toContain("PRIVATE_SENTINEL");
      }
      const unavailableLocale = await submit({ projectId, locale: "ar" });
      expect(unavailableLocale.status).toBe(404);
      expect(Number((await admin.query("select count(*)::int as count from interaction.feedback")).rows[0].count)).toBe(before);
    });

    it("AC04-05 replays the original receipt across servers and rechecks Project lifecycle before replay", async () => {
      const projectId = await seed();
      const key = createStableId("Key");
      const [first, concurrent] = await Promise.all([
        submit({ projectId, key, server: 0 }),
        submit({ projectId, key, server: 1 }),
      ]);
      expect(first.status).toBe(201);
      expect(concurrent.status).toBe(201);
      const firstReceipt = await first.json();
      expect(await concurrent.json()).toEqual(firstReceipt);
      const changed = await submit({ projectId, key, paragraph: "Changed feedback." });
      expect(changed.status).toBe(409);
      expect(await admin.query("select count(*)::int as count from interaction.feedback where project_id=$1", [projectId])).toMatchObject({ rows: [{ count: 1 }] });
      await admin.query("update content.items set lifecycle='hidden' where content_id=$1", [projectId]);
      const replay = await submit({ projectId, key, server: 1 });
      expect(replay.status).toBe(404);
      expect(await admin.query("select count(*)::int as count from interaction.feedback where project_id=$1", [projectId])).toMatchObject({ rows: [{ count: 1 }] });

      const localeProject = await seed();
      const localeKey = createStableId("Key");
      expect((await submit({ projectId: localeProject, key: localeKey })).status).toBe(201);
      await admin.query("delete from content.language_publications where content_id=$1 and locale='en'", [localeProject]);
      expect((await submit({ projectId: localeProject, key: localeKey, server: 1 })).status).toBe(404);
      expect(await admin.query("select count(*)::int as count from interaction.feedback where project_id=$1", [localeProject])).toMatchObject({ rows: [{ count: 1 }] });
    });

    it("AC05 rejects unavailable and foreign Projects without effects", async () => {
      const foreignPortfolioId = createStableId("Portfolio");
      const foreignOwnerId = createStableId("Owner");
      await admin.query(
        "insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Foreign','Headline','Bio','Contact','https://example.com','Unavailable')",
        [foreignPortfolioId, foreignOwnerId],
      );
      const foreignProject = await seed("published", foreignPortfolioId, foreignOwnerId);
      const missingProject = createStableId("Project");
      for (const projectId of [foreignProject, missingProject]) {
        const response = await submit({ projectId });
        expect(response.status).toBe(404);
        expect(zProblem.safeParse(await response.json()).success).toBe(true);
      }
      expect((await admin.query("select count(*)::int as count from interaction.feedback where project_id in ($1,$2)", [foreignProject, missingProject])).rows[0].count).toBe(0);
    });
  },
);
