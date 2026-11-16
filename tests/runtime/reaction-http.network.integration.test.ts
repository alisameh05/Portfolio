import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createStableId, type StableId } from "../../src/shared/domain/index.js";
import { zPutProjectReactionResponse, zProblem } from "../../src/contracts/http/v1/generated/zod.gen.js";

const baseUrls = JSON.parse(process.env["PHASE9_REACTION_HTTP_URLS"] ?? "[]") as string[];
const adminUrl = process.env["PHASE9_REACTION_HTTP_ADMIN_DATABASE_URL"];
const portfolioId = process.env["PORTFOLIO_ID"];
const ownerId = process.env["OWNER_ID"];
const admin = new Client({ connectionString: adminUrl });

describe.runIf(baseUrls.length === 2 && Boolean(adminUrl) && Boolean(portfolioId) && Boolean(ownerId))(
  "Phase 9 #303 production-built Reaction HTTP acceptance",
  () => {
    beforeAll(async () => {
      await admin.connect();
      await admin.query(
        "insert into portfolio_config.settings (portfolio_id,owner_id,display_name,headline,bio,global_cta_label,global_cta_destination,global_cta_unavailable_fallback) values ($1,$2,'Owner','Headline','Bio','Contact','https://example.com','Unavailable') on conflict (portfolio_id) do nothing",
        [portfolioId, ownerId],
      );
    });
    afterAll(async () => { await admin.end(); });

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
        const payload = { contentType: "project", locale: "en", title: "Reaction fixture", summary: "Safe summary", body: "Safe body" };
        await admin.query(
          "insert into content.public_routes (route_identity,content_id,portfolio_id,content_type,current_slug,first_published_at) values ($1,$2,$3,'project',$4,$5)",
          [routeId, projectId, portfolioId, `reaction-${projectId}`, now],
        );
        await admin.query(
          "insert into content.revisions (revision_id,content_id,portfolio_id,content_type,locale,stream_sequence,aggregate_version,title,summary,body,payload,saved_at) values ($1,$2,$3,'project','en',1,1,'Reaction fixture','Safe summary','Safe body',$4,$5)",
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

    async function put(input: {
      readonly projectId: StableId<"Project">;
      readonly reaction?: string;
      readonly key?: string;
      readonly cookie?: string;
      readonly ip?: string;
      readonly server?: number;
    }) {
      const headers = new Headers({
        "content-type": "application/json",
        "idempotency-key": input.key ?? createStableId("Key"),
        "x-vercel-forwarded-for": input.ip ?? "198.51.100.31",
      });
      if (input.cookie) headers.set("cookie", input.cookie);
      return fetch(`${baseUrls[input.server ?? 0]}/api/v1/projects/${input.projectId}/reaction`, {
        method: "PUT", headers, body: JSON.stringify({ reaction: input.reaction ?? "like" }),
      });
    }

    async function currentLimiterWindow() {
      const result = await admin.query("select floor(extract(epoch from clock_timestamp()) / 60)::bigint::text as window");
      return result.rows[0]?.window as string;
    }

    it("AC01 returns a schema-valid personalized receipt and secure functional cookie over the built route", async () => {
      const projectId = await seed();
      const response = await put({ projectId });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(zPutProjectReactionResponse.safeParse(payload).success).toBe(true);
      expect(payload).toEqual({ projectId, reaction: "like" });
      const cookie = response.headers.get("set-cookie") ?? "";
      expect(cookie).toContain("visitor_functional=");
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("Secure; HttpOnly; SameSite=Lax");
      expect(cookie).not.toMatch(/;\s*Domain=/iu);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    });

    it("AC02-03 shares one language-independent subject and preserves replay and current-row semantics across servers", async () => {
      const projectId = await seed();
      const firstKey = createStableId("Key");
      const first = await put({ projectId, key: firstKey });
      const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
      const changeKey = createStableId("Key");
      const changed = await put({ projectId, reaction: "dislike", key: changeKey, cookie, server: 1 });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("set-cookie")).toBeNull();

      const replay = await put({ projectId, key: firstKey, cookie, server: 1 });
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({ projectId, reaction: "like" });
      const conflict = await put({ projectId, reaction: "dislike", key: firstKey, cookie });
      expect(conflict.status).toBe(409);
      const sameCurrent = await put({ projectId, reaction: "dislike", cookie });
      expect(sameCurrent.status).toBe(200);
      const rows = await admin.query("select kind, count(*)::int as count from interaction.reactions where project_id=$1 group by kind", [projectId]);
      const facts = await admin.query("select count(*)::int as count from operations.outbox_events where aggregate_id=$1 and event_type='interaction.reaction_changed.v1'", [projectId]);
      expect(rows.rows).toEqual([{ kind: "dislike", count: 1 }]);
      expect(facts.rows[0]?.count).toBe(2);
    });

    it("AC04 rejects malformed keys and bodies before the limiter, identity, or mutation", async () => {
      const projectId = await seed();
      const beforeLimits = await admin.query("select count(*)::int as count from identity_access.public_rate_limit_windows");
      const missingKey = await fetch(`${baseUrls[0]}/api/v1/projects/${projectId}/reaction`, {
        method: "PUT", headers: { "content-type": "application/json", "x-vercel-forwarded-for": "198.51.100.41" }, body: '{"reaction":"like"}',
      });
      const malformedKey = await put({ projectId, key: "bad", ip: "198.51.100.42" });
      const badChoice = await put({ projectId, reaction: "love", ip: "198.51.100.43" });
      expect(missingKey.status).toBe(400);
      expect(malformedKey.status).toBe(400);
      expect(badChoice.status).toBe(400);
      expect(zProblem.safeParse(await badChoice.json()).success).toBe(true);
      expect(missingKey.headers.get("set-cookie")).toBeNull();
      expect(malformedKey.headers.get("set-cookie")).toBeNull();
      expect(badChoice.headers.get("set-cookie")).toBeNull();
      expect((await admin.query("select count(*)::int as count from interaction.reactions where project_id=$1", [projectId])).rows[0]?.count).toBe(0);
      expect((await admin.query("select count(*)::int as count from identity_access.public_rate_limit_windows")).rows[0]?.count)
        .toBe(beforeLimits.rows[0]?.count);
    });

    it("AC05 denies hidden, archived, and missing Projects before cookie issuance", async () => {
      const hiddenId = await seed("hidden");
      const archivedId = await seed("archived");
      for (const projectId of [hiddenId, archivedId, createStableId("Project")]) {
        const response = await put({ projectId });
        expect(response.status).toBe(404);
        expect(response.headers.get("set-cookie")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      }
    });

    it("AC06 permits functional Reaction without Measurement consent or event writes", async () => {
      const projectId = await seed();
      const before = await admin.query("select count(*)::int as count from measurement.public_events");
      const response = await put({ projectId });
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("visitor_functional=");
      expect((await admin.query("select count(*)::int as count from measurement.public_events")).rows[0]?.count)
        .toBe(before.rows[0]?.count);
    });

    it("AC07 enforces the shared 30-per-minute PostgreSQL budget and fails closed on limiter outage", async () => {
      const projectId = await seed();
      const initial = await put({ projectId });
      const cookie = (initial.headers.get("set-cookie") ?? "").split(";")[0]!;
      let containedSequence: { readonly responses: readonly Response[]; readonly limited: Response } | undefined;
      for (let retry = 0; retry < 5 && !containedSequence; retry++) {
        const ip = `198.51.100.${50 + retry}`;
        const startingWindow = await currentLimiterWindow();
        const responses: Response[] = [];
        for (let attempt = 0; attempt < 30; attempt++) {
          responses.push(await put({ projectId, cookie, ip, server: attempt % 2 }));
        }
        const limited = await put({ projectId, cookie, ip, server: 1 });
        if (startingWindow === await currentLimiterWindow()) containedSequence = { responses, limited };
      }
      expect(containedSequence).toBeDefined();
      expect(containedSequence!.responses.map((response) => response.status)).toEqual(Array.from({ length: 30 }, () => 200));
      expect(containedSequence!.limited.status).toBe(429);
      expect(Number(containedSequence!.limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(containedSequence!.limited.headers.get("set-cookie")).toBeNull();

      await admin.query("revoke execute on function identity_access.check_public_reaction_rate_limit(text,text) from shipwithali_application");
      try {
        const unavailable = await put({ projectId, cookie, ip: "198.51.100.46" });
        expect(unavailable.status).toBe(503);
        expect(unavailable.headers.get("set-cookie")).toBeNull();
        expect(zProblem.safeParse(await unavailable.json()).success).toBe(true);
      } finally {
        await admin.query("grant execute on function identity_access.check_public_reaction_rate_limit(text,text) to shipwithali_application");
      }
    });
  },
);
