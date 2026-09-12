# ShipWithAli — Product Specification

> Personal portfolio and professional brand website for an AI/ML engineer who builds and ships real products.

Accepted decisions in [`docs/adr/`](./docs/adr/) govern where they refine or supersede this brief. The canonical vocabulary and behavioral model live in [`CONTEXT.md`](./CONTEXT.md) and [`docs/domain-model.md`](./docs/domain-model.md).

---

## Vision

More than a résumé-style portfolio — a living representation of what I build, what I've achieved, how I think, and how my skills evolve. The goal: a recruiter, engineer, founder, or collaborator should quickly understand who I am, what I've built, what I contributed, and how to reach me — while deeper exploration reveals the broader story of my journey.

---

## 1. Landing Page

- Immersive hero experience communicating the ShipWithAli brand
- Core philosophy: **Explore → Build → Engineer → Ship**
- Strong visual narrative and professional identity throughout

---

## 2. About Me

### Interactive Timeline
- Career and learning milestones
- Achievement highlights: project launches, competitions, certifications, academic achievements, professional milestones, open-source contributions, awards

### CV Access
- Visitors can view or download the current public CV
- CV managed as versioned content (see Admin section)

---

## 3. Project Gallery

### Browsing & Discovery
- Search bar
- Filters: category, AI/ML domain, technology area, project type, status
- Project status badges: `Shipped` · `Active` · `In Progress` · `Experimental` · `Research` · `Open Source` · *(extensible)*
- Public gallery order: newest-published first; the independent Featured flag provides editorial emphasis

### Project Media
- Cover images, screenshots, promotional visuals, product demos, short marketing videos

---

## 4. Project Case Study Pages

### Content
| Section | Details |
|---|---|
| Summary | What the project is |
| Problem | What it solves |
| Role & Contributions | My specific work |
| Outcomes | Key results |
| Lessons | What I learned |
| Media | Images, videos, demos |
| External Links | GitHub, live deploy, docs, research, etc. |

### Visitor Interaction
- **Like / Dislike**
- **Star rating** (1–5)
- **Written feedback** (name + paragraph) — moderated before public display
- Aggregated stats (avg rating, count, likes, dislikes) displayed publicly

### Testimonials
- Associated with a specific project or general profile
- From collaborators, supervisors, users, colleagues
- Managed via admin dashboard

### Related Projects
- Displayed at end of each case study
- Matched by area, category, technology, problem, or theme

### Contact CTA
- End-of-page call-to-action targeting recruiters, founders, clients, engineers, collaborators

---

## 5. Lab / Ship Log *(deferred from the first release)*

- Smaller experiments, incomplete ideas, research explorations, WIP projects
- Represents continuous learning and experimentation, not just finished products
- Retained as a future domain concept, with no first-release public navigation, publication workflow, or admin surface

---

## 6. Contact

Available in site footer (persistent across site):

| Channel | |
|---|---|
| WhatsApp | ✓ |
| Instagram | ✓ |
| Phone | ✓ |
| LinkedIn | ✓ |
| *(extensible)* | future channels |

---

## 7. Admin Dashboard

Central CMS — no manual code edits required.

### Project Management
- Create, update, delete, publish, hide, archive, feature, and categorize projects
- Assign statuses and categories
- Manage related-project relationships
- Upload and organize images and videos
- Maintain external links

### Lifecycle and Presentation
- Public lifecycle: `Draft` · `Published` · `Hidden` · `Archived`
- `Featured` is an independent presentation flag, not a lifecycle state or project status
- Project status describes maturity or work state and does not control public visibility

### Other Content
- Timeline and achievement entries
- Testimonials and recommendations
- Contact info and social profiles
- CV versions (upload, activate, track)

### Moderation
- Likes, dislikes, ratings
- Written feedback queue (approve / reject before public display)

### Search & Filtering
- Keeps content manageable as portfolio grows

---

## 8. CV Versioning

- Upload and activate new CV versions at any time
- Previous versions retained
- Current public CV clearly identified in admin
- Track view and download counts per version

---

## 9. Analytics

### Portfolio-Level
- Total visitors, returning visitors
- Traffic sources, geography, device breakdown
- Popular entry pages, engagement patterns, navigation behavior

### Project-Level
- Views, reading/engagement time
- Video interactions, media engagement
- GitHub clicks, live-demo clicks
- Ratings, rating distribution, likes, dislikes
- Feedback submissions, related-project navigation
- Contact actions generated per project

### Conversion Events
CV views · CV downloads · LinkedIn visits · GitHub visits · WhatsApp interactions · Instagram visits · Phone contacts · Live-project visits · Testimonial engagement

### Configurable Goals
Define what "successful visitor behavior" means. Examples:
- Download CV
- Visit a GitHub repo
- Open a live project
- Click LinkedIn
- Initiate WhatsApp
- Explore multiple projects
- Submit feedback
- Reach a project CTA

Dashboard surfaces which pages, projects, traffic sources, and journeys are most effective at producing these goals.

---

## Feature Summary

| Feature | Public | Admin |
|---|---|---|
| Project gallery + filters | ✓ | ✓ |
| Case study pages | ✓ | ✓ |
| Likes / ratings / feedback | ✓ (submit) | ✓ (moderate) |
| Testimonials | ✓ (view) | ✓ (manage) |
| Related projects | ✓ | ✓ |
| Contact CTA | ✓ | ✓ |
| Achievement timeline | ✓ | ✓ |
| CV download | ✓ | — |
| CV versioning | — | ✓ |
| Lab / Ship Log | — (post-v1) | — (post-v1) |
| Analytics | — | ✓ |
| Configurable goals | — | ✓ |
