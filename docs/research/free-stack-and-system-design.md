# ShipWithAli: free-first technology and system design research

**Research date:** 2026-09-12  
**Scope:** first-release public portfolio, owner CMS, publishing workflow, moderation, CV/media, bilingual UI, privacy-preserving analytics, and portability.

## Executive recommendation

Use a modular monolith:

- **Next.js App Router + TypeScript** for the public site and admin UI.
- **Supabase Postgres** for relational data, migrations, Auth, and Row Level Security.
- **Supabase Storage initially** for images, videos, and CV files; move high-volume media to **Cloudflare R2** later without changing the media domain model.
- **Vercel Hobby** for the simplest deployment path, or Cloudflare Pages/Workers if keeping the whole deployment on Cloudflare matters more than Next.js runtime compatibility.
- **Resend** only for transactional owner notifications/contact delivery.
- **PostHog** only for product analytics if the built-in privacy-preserving event pipeline is insufficient; do not make it the source of truth for business analytics.
- **Sentry** for error monitoring, with privacy scrubbing enabled.
- **GitHub Actions** for tests, linting, type checking, migrations checks, and deployment automation.

This keeps the first release to one application, one database, one file store, and optional integrations. It avoids microservices, a separate CMS product, a search cluster, and an identity-heavy analytics vendor.

Free tiers are not permanent guarantees. Re-check current limits before launch, set alerts/spend caps where available, and document an exit path for every hosted dependency.

## Recommended stack

| Concern | Recommendation | Why it fits | Free-tier caveat |
|---|---|---|---|
| UI and server | Next.js App Router, React, TypeScript | Server-render public pages, keep admin mutations server-side, and share one codebase | Framework is free; hosting limits still apply |
| Styling | Tailwind CSS plus a small local design-token layer | Fast responsive implementation and explicit RTL/LTR control | Free/open source |
| Validation | Zod at request boundaries | Validates admin forms, webhooks, imports, and public submissions | Free/open source |
| Database | Supabase Postgres | Relational model suits revisions, taxonomies, moderation, redirects, and analytics aggregates | Free plan is 500 MB DB; inactive projects may pause |
| Auth | Supabase Auth, owner-only account | JWT-based auth integrates with Postgres RLS and supports magic links/passwords | Email delivery and provider limits apply |
| File storage | Supabase Storage first | Same project as Postgres, RLS policies, public/private buckets, image/file handling | Free plan storage/egress quotas apply |
| Large media option | Cloudflare R2 | S3-compatible and free egress; useful for video and public assets | Free allowance is 10 GB-month, 1M Class A, 10M Class B; overages are billable |
| Hosting | Vercel Hobby | Native Next.js workflow, preview deployments, HTTPS, simple environment management | Hobby pauses at included limits; not intended for commercial/team Git organizations |
| Alternative hosting | Cloudflare Pages + Workers | Free Pages builds and globally distributed static assets; useful if Cloudflare/R2 is preferred | Next.js dynamic/runtime compatibility must be tested for the chosen adapter |
| Email | Resend | Simple API for moderation/contact/operational notifications | Free: 3,000/month and 100/day; domain DNS setup is required for reliable sending |
| Analytics | First-party Postgres event ledger; optional PostHog | Preserves ADR-0004 and makes exports/retention controllable | PostHog free tier is 1M events/month; avoid sending sensitive text or raw identifiers |
| Error monitoring | Sentry | Captures actionable failures without building an alerting system | Free limits and retention change; scrub personal data |
| CI/CD | GitHub Actions | Public repositories get free standard runner usage | Private repositories have plan quotas |
| Search | Postgres full-text/trigram indexes first | Enough for a portfolio-sized project and avoids a paid search service | Revisit only if content volume/search relevance demands it |
| Testing | Vitest, Playwright, Testing Library, axe checks | Covers domain rules, browser journeys, and accessibility | Free/open source |
| SEO | Next.js Metadata API, sitemap/robots, JSON-LD, Google Search Console | Supports recruiter discovery and durable public identities | Search Console is free but external to the app |

Evidence: [Next.js App Router](https://nextjs.org/docs/app), [Supabase pricing](https://supabase.com/pricing), [Supabase Auth](https://supabase.com/docs/guides/auth), [Supabase Storage](https://supabase.com/docs/guides/storage), [Vercel plans](https://vercel.com/docs/plans), [Vercel limits](https://vercel.com/docs/limits), [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/), [Resend pricing](https://resend.com/pricing), [PostHog pricing](https://posthog.com/pricing), [GitHub Actions billing](https://docs.github.com/en/actions/concepts/billing-and-usage), and [Google Search documentation](https://developers.google.com/search/docs).

## Architecture

```text
Visitor browser
  -> CDN / hosting (Vercel or Cloudflare)
  -> Next.js public routes
       -> cached published-content queries
       -> public interaction API: reactions, ratings, feedback
       -> event intake (privacy-filtered, rate-limited)

Owner browser
  -> Next.js admin routes
       -> Supabase Auth session
       -> server-side authorization + Postgres RLS
       -> domain services / transactions
            -> Postgres (content, revisions, taxonomy, moderation, analytics)
            -> Storage (media and CV objects)
            -> Resend (notifications, best-effort)

Scheduled/operational jobs
  -> aggregate events, retention/anonymization, export, broken-link checks
  -> GitHub Actions or a hosting cron invocation

Monitoring
  -> Sentry for failures
  -> operational alerts only for actionable states
```

### Application boundaries

Organize the code by domain rather than by vendor:

```text
src/
  app/
    (public)/en/...       # English public routes
    (public)/ar/...       # Arabic public routes, RTL layout
    admin/...             # owner CMS
    api/...               # narrow public/admin endpoints and webhooks
  domains/
    content/              # projects, lab entries, achievements, testimonials
    publishing/           # revisions, evidence, publish/hidden/archive, redirects
    taxonomy/             # controlled vocabularies, retirement, merge/migration
    media/                # object metadata, accessibility metadata, variants
    moderation/           # feedback queue and decisions
    cv/                   # versions, current CV, views/downloads
    analytics/             # event schema, goals, aggregates, retention
    identity/              # owner authorization and visitor pseudonymous signal
  infrastructure/
    db/ storage/ email/ analytics/ monitoring/
```

Keep domain rules independent of Supabase and Next.js. Adapters should translate database rows and provider errors into domain results. This is the main portability protection required by ADR-0011.

Next.js App Router components are Server Components by default; use Client Components only for browser interaction such as filters, rating controls, upload progress, charts, and rich editing. The Context7 Next.js documentation confirms this server/client boundary and recommends keeping runtime-only work behind the boundary. Source: [Next.js server/client boundary](https://github.com/vercel/next.js/blob/canary/docs/01-app/02-guides/server-and-client-boundary.mdx).

## Core data model

Use UUID primary keys plus immutable public identity fields where needed.

- `profiles`, `owner_settings`
- `projects`, `project_revisions`, `project_publications`
- `lab_entries`, `achievements`, `testimonials`
- `taxonomies`, `taxonomy_values`, `taxonomy_value_aliases`
- `project_taxonomy_values`, `project_relations`
- `external_links`, `redirects`
- `media_assets`, `media_variants`, `media_accessibility`
- `cv_versions`
- `feedback`, `feedback_moderation_events`
- `reactions`, `ratings`
- `analytics_events`, `analytics_daily`, `analytics_goals`, `analytics_goal_versions`
- `exports`, `operational_alerts`, `audit_events`

Important invariants:

1. Only explicitly published revisions are public.
2. There is exactly one current public CV.
3. A visitor has at most one reaction and one rating per project; writes are idempotent where possible.
4. Taxonomy retirement does not erase historical assignments.
5. Slug/title changes create durable redirects and canonical metadata.
6. Feedback is never public before moderation approval.
7. Raw analytics events are minimized, retained briefly, and aggregated before dashboard use.

## Request and publishing flows

### Public read

1. Resolve locale and route identity.
2. Read only published content through a public read model/query.
3. Render static or cached HTML for landing, gallery, timeline, and case studies.
4. Load non-critical interaction and analytics code after the core content.
5. If analytics, email, or an external link fails, preserve the public journey and record an operational event.

### Owner publish

1. Authenticate with Supabase Auth.
2. Authorize owner access in server code and RLS.
3. Validate the draft revision and required evidence/accessibility metadata.
4. In one database transaction, mark the revision published and create/update redirect/canonical records.
5. Invalidate affected Next.js cache tags.
6. Send a best-effort operational notification; publication must not depend on email success.

### Feedback moderation

1. Accept a rate-limited, validated submission with honeypot/CAPTCHA only if abuse requires it.
2. Store it as pending; never render pending content publicly.
3. Notify the owner through Resend if configured.
4. Approve/reject/retain with an immutable moderation event.
5. Public queries include approved feedback only.

## Security and privacy baseline

- Keep Supabase service-role keys server-only; browser clients receive only the public anon key.
- Apply RLS to every exposed table; public reads use explicit published predicates.
- Treat all rich text and external URLs as untrusted input; sanitize HTML and restrict protocols.
- Validate upload MIME type, size, extension, and object ownership; serve private CV/admin assets with signed URLs.
- Rate-limit feedback, ratings, reactions, login, and analytics intake by IP-derived short-lived signal plus project/action key.
- Never put names, feedback text, CV contents, access tokens, or raw IPs into analytics events.
- Use coarse geography/device/language dimensions, suppress small samples, honor opt-out/consent requirements, and implement retention/anonymization jobs.
- Configure CSP, HSTS, secure cookies, CSRF protection for mutations, and security headers.
- Create exports as versioned JSON/CSV/ZIP packages and test restoring them.

## Delivery plan

### Phase 1: foundation

Next.js shell, locale routing, design system, Supabase local migrations, Auth, owner guard, project/revision/publication model, basic media metadata, CI, and accessibility/performance gates.

### Phase 2: public portfolio

Landing, gallery/search/filtering, case studies, timeline, CV download, external links, durable redirects, metadata/sitemap, responsive RTL Arabic experience, and degraded-dependency behavior.

### Phase 3: CMS and moderation

Project editor, media upload, taxonomy management, publish workflow, testimonials, feedback queue, reactions/ratings, current CV management, and owner exports.

### Phase 4: measurement and operations

First-party event ledger, aggregate reports, configurable goals, retention jobs, broken-link checks, Sentry, optional PostHog, and operational alerts.

Defer Lab / Ship Log until the first-release boundary in ADR-0007 is intentionally revisited.

## What not to add initially

- No microservices, Kubernetes, Redis, Elasticsearch/Algolia, GraphQL gateway, or separate headless CMS.
- No visitor accounts for reactions, ratings, or feedback.
- No session replay by default; it conflicts with the privacy posture unless explicitly justified and consented.
- No AI translation auto-publish; Arabic and English language versions remain independently reviewed as required by the context.
- No provider-specific data model. Store provider IDs and URLs as infrastructure metadata around domain records.

## Decisions to record before implementation

1. Choose Vercel Hobby or Cloudflare Pages/Workers after a small deployment proof of concept.
2. Confirm whether the repository can be public; this changes the GitHub Actions free allowance.
3. Decide whether media volume fits Supabase Storage's free quota; use R2 for large video if not.
4. Define retention durations and the exact visitor opt-out/consent behavior.
5. Define export schemas and a restore test before storing meaningful owner content.
6. Add ADRs for the selected hosting/storage combination and the analytics event contract.
