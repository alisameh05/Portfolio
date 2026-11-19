import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, type StableId } from "../../src/shared/domain/index.js";
import { zPutProjectRatingResponse, zProblem } from "../../src/contracts/http/v1/generated/zod.gen.js";

const baseUrls = JSON.parse(process.env["PHASE9_RATING_HTTP_URLS"] ?? "[]") as string[];
const adminUrl = process.env["PHASE9_RATING_HTTP_ADMIN_DATABASE_URL"];
const runtimeUrl = process.env["PHASE9_OWNER_HTTP_DATABASE_URL"];
const portfolioId = process.env["PORTFOLIO_ID"];
const ownerId = process.env["OWNER_ID"];
const admin = new Client({ connectionString: adminUrl });
const runtime = new Client({ connectionString: runtimeUrl });

describe.runIf(baseUrls.length === 2 && Boolean(adminUrl) && Boolean(runtimeUrl) && Boolean(portfolioId) && Boolean(ownerId))(
  "Phase 9 #304 production-built Rating HTTP acceptance",
  () => {
    beforeAll(async () => {
      await admin.connect();
      await runtime.connect();
      await admin.query(
        "insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable') on conflict (portfolio_id) do nothing",
        [portfolioId, ownerId],
      );
    });
    afterAll(async () => { await runtime.end(); await admin.end(); });

    async function seed(lifecycle: "published" | "hidden" | "archived" = "published") {
      const projectId = createStableId("Project");
      const routeId = createStableId("PublicRoute");
      const now = new Date().toISOString();
      await admin.query(
        "insert into content.items (content_id,portfolio_id,content_type,lifecycle) values ($1,$2,'project',$3)",
        [projectId, portfolioId, lifecycle],
      );
      if (lifecycle === "published") {
        const revisionId = createStableId("Revision");
        const reviewId = createStableId("ContentReview");
        const payload = { contentType: "project", locale: "en", title: "Rating fixture", summary: "Safe summary", body: "Safe body" };
        await admin.query(
          "insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)",
          [routeId, projectId, portfolioId, `rating-${projectId}`, now],
        );
        await admin.query(
          "insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project','en',1,1,'Rating fixture','Safe summary','Safe body',$4,$5)",
          [revisionId, projectId, portfolioId, payload, now],
        );
        await admin.query(
          "insert into content.revision_reviews (review_id,content_id,portfolio_id,content_type,revision_id,locale,review_sequence,snapshot_hash,evidence_version,reviewer_id,decision,reviewed_at) values ($1,$2,$3,'project',$4,'en',1,$5,1,$6,'accepted',$7)",
          [reviewId, projectId, portfolioId, revisionId, "a".repeat(64), ownerId, now],
        );
        await admin.query(
          "insert into content.language_publications (content_id,portfolio_id,content_type,locale,revision_id,review_id,route_identity,publication_sequence,published_at) values ($1,$2,'project','en',$3,$4,$5,1,$6)",
          [projectId, portfolioId, revisionId, reviewId, routeId, now],
        );
      }
      return projectId;
    }

    async function currentLimiterWindow() {
      const result = await admin.query("select floor(extract(epoch from clock_timestamp()) / 60)::bigint::text as window");
      return result.rows[0]?.window as string;
    }

    async function put(input: {
      readonly projectId: StableId<"Project">;
      readonly rating?: number;
      readonly key?: string;
      readonly cookie?: string;
      readonly ip?: string;
      readonly server?: number;
      readonly language?: "en" | "ar";
    }) {
      const headers = new Headers({
        "content-type": "application/json",
        "idempotency-key": input.key ?? createStableId("Key"),
        "x-vercel-forwarded-for": input.ip ?? "198.51.100.81",
        ...(input.language === undefined ? {} : { "accept-language": input.language }),
      });
      if (input.cookie) headers.set("cookie", input.cookie);
      return fetch(`${baseUrls[input.server ?? 0]}/api/v1/projects/${input.projectId}/rating`, {
        method: "PUT", headers, body: JSON.stringify({ rating: input.rating ?? 5 }),
      });
    }

    it("AC01 returns a schema-valid current Rating receipt and shared secure functional cookie", async () => {
      const projectId = await seed();
      const response = await put({ projectId });
      expect(response.status).toBe(200);
      expect(zPutProjectRatingResponse.safeParse(await response.json()).success).toBe(true);
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("visitor_functional=");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Secure; HttpOnly; SameSite=Lax");
      expect(cookie).not.toMatch(/;\s*Domain=/iu);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });

    it("AC02 changes one current row and one aggregate contribution instead of adding a rater", async () => {
      const projectId = await seed();
      const first = await put({ projectId, rating: 2 });
      const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect((await put({ projectId, rating: 4, cookie, server: 1 })).status).toBe(200);
      const rows = await admin.query("select value, count(*)::int as count from interaction.ratings where project_id=$1 group by value order by value", [projectId]);
      const facts = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id=$1 and event_type='interaction.rating_changed.v1'", [projectId]);
      expect(rows.rows).toEqual([{ value: 4, count: 1 }]);
      expect(facts.rows[0]?.count).toBe(2);
      await runtime.query("begin");
      try {
        await runtime.query("select set_config('shipwithali.portfolio_id',$1,true),set_config('shipwithali.owner_id',$2,true),set_config('shipwithali.summary_project_id',$3,true),set_config('shipwithali.summary_locale','en',true)", [portfolioId, ownerId, projectId]);
        expect((await runtime.query("select raters, average from interaction.current_rating_summary")).rows)
          .toEqual([{ raters: "1", average: null }]);
      } finally { await runtime.query("rollback"); }
    });

    it("AC03 preserves original safe receipts for concurrent exact retry and conflicts on changed-key reuse", async () => {
      const projectId = await seed();
      const initial = await put({ projectId, rating: 3 });
      const cookie = (initial.headers.get("set-cookie") ?? "").split(";")[0]!;
      const key = createStableId("Key");
      const [left, right] = await Promise.all([
        put({ projectId, rating: 3, key, cookie }),
        put({ projectId, rating: 3, key, cookie, server: 1 }),
      ]);
      expect(left.status).toBe(200);
      expect(right.status).toBe(200);
      expect(await left.json()).toEqual({ projectId, rating: 3 });
      expect(await right.json()).toEqual({ projectId, rating: 3 });
      const conflict = await put({ projectId, rating: 4, key, cookie });
      expect(conflict.status).toBe(409);
      expect(zProblem.safeParse(await conflict.json()).success).toBe(true);
      expect((await admin.query("select value, count(*)::int as count from interaction.ratings where project_id=$1 group by value", [projectId])).rows)
        .toEqual([{ value: 3, count: 1 }]);
      expect((await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id=$1 and event_type='interaction.rating_changed.v1'", [projectId])).rows[0]?.count)
        .toBe(1);
    });

    it("AC04 keeps a functional Rating across language requests without Measurement identity or event joins", async () => {
      const projectId = await seed();
      const beforeEvents = (await admin.query("select count(*)::int as count from measurement.public_events")).rows[0]?.count;
      const first = await put({ projectId, rating: 2, language: "en" });
      const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
      expect((await put({ projectId, rating: 5, cookie, language: "ar", server: 1 })).status).toBe(200);
      expect((await admin.query("select count(*)::int as count from interaction.ratings where project_id=$1", [projectId])).rows[0]?.count).toBe(1);
      expect((await admin.query("select count(*)::int as count from measurement.public_events")).rows[0]?.count).toBe(beforeEvents);
      const event = (await admin.query("select payload::text from operations.outbox_events where aggregate_id=$1 and event_type='interaction.rating_changed.v1'", [projectId])).rows[0]?.payload as string;
      expect(event).not.toContain("visitor_id");
    });

    it("AC05 rejects invalid cookie, transport, and ineligible Projects before Rating state or cookie issuance", async () => {
      const projectId = await seed();
      const hiddenId = await seed("hidden");
      const archivedId = await seed("archived");
      const malformed = await put({ projectId, rating: 1.5 });
      expect(malformed.status).toBe(400);
      expect(malformed.headers.get("set-cookie")).toBeNull();
      const missingKey = await fetch(`${baseUrls[0]}/api/v1/projects/${projectId}/rating`, {
        method: "PUT", headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.88" }, body: '{"rating":4}',
      });
      expect(missingKey.status).toBe(400);
      expect(missingKey.headers.get("set-cookie")).toBeNull();
      const invalidCookie = await put({ projectId, cookie: "visitor_functional=not-a-token" });
      expect(invalidCookie.status).toBeGreaterThanOrEqual(400);
      expect(invalidCookie.status).toBeLessThan(500);
      expect(invalidCookie.headers.get("set-cookie")).toBeNull();
      for (const unavailable of [hiddenId, archivedId, createStableId("Project")]) {
        const denied = await put({ projectId: unavailable });
        expect(denied.status).toBe(404);
        expect(denied.headers.get("set-cookie")).toBeNull();
      }
      expect((await admin.query("select count(*)::int as count from interaction.ratings where project_id=$1", [projectId])).rows[0]?.count).toBe(0);
    });

    it("AC06 applies the shared per-operation limiter, fails closed on outage, and preserves the lost-first-cookie limit", async () => {
      const projectId = await seed();
      const firstKey = createStableId("Key");
      const initial = await put({ projectId, rating: 4, key: firstKey, ip: "198.51.100.89" });
      const cookie = (initial.headers.get("set-cookie") ?? "").split(";")[0]!;
      const noCookieRetry = await put({ projectId, rating: 4, key: firstKey, ip: "198.51.100.89" });
      expect(noCookieRetry.status).toBe(200);
      expect((await admin.query("select count(*)::int as count from interaction.ratings where project_id=$1", [projectId])).rows[0]?.count).toBe(2);
      expect(cookie).not.toContain("Domain=");

      const limitedProject = await seed();
      const limitedCookieResponse = await put({ projectId: limitedProject, ip: "198.51.100.90" });
      const limitedCookie = (limitedCookieResponse.headers.get("set-cookie") ?? "").split(";")[0]!;
      let containedSequence: { readonly allowed: readonly Response[]; readonly limited: Response } | undefined;
      for (let retry = 0; retry < 5 && !containedSequence; retry++) {
        const ip = `198.51.100.${91 + retry}`;
        const startingWindow = await currentLimiterWindow();
        const allowed: Response[] = [];
        for (let index = 0; index < 30; index++) {
          allowed.push(await put({ projectId: limitedProject, cookie: limitedCookie, ip, server: index % 2 }));
        }
        const limited = await put({ projectId: limitedProject, cookie: limitedCookie, ip, server: 1 });
        if (startingWindow === await currentLimiterWindow()) containedSequence = { allowed, limited };
      }
      expect(containedSequence).toBeDefined();
      expect(containedSequence!.allowed.every(response => response.status === 200)).toBe(true);
      const limited = containedSequence!.limited;
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(limited.headers.get("set-cookie")).toBeNull();

      await admin.query("revoke execute on function identity_access.check_public_reaction_rate_limit(text,text) from shipwithali_application");
      try {
        const unavailable = await put({ projectId: limitedProject, cookie: limitedCookie, ip: "198.51.100.91" });
        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get("set-cookie")).toBeNull();
        expect(zProblem.safeParse(await unavailable.json()).success).toBe(true);
      } finally {
        await admin.query("grant execute on function identity_access.check_public_reaction_rate_limit(text,text) to shipwithali_application");
      }
      const leakedSubject = (await admin.query("select visitor_id from interaction.ratings where project_id=$1 limit 1", [projectId])).rows[0]?.visitor_id;
      const serialized = JSON.stringify({ cookie, event: (await admin.query("select payload from operations.outbox_events where aggregate_id=$1 and event_type='interaction.rating_changed.v1'", [projectId])).rows });
      expect(serialized).not.toContain(leakedSubject);
    });
  },
);
