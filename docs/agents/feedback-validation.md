# Private Feedback submission (#192)

Feedback needs no functional or Measurement identity. Its strict application
command accepts a Published Project and the submitted published locale. Content
holds its root share lock before the Interaction insert and idempotency lock;
hide/archive/publication acquire the same root first. A replay rechecks current
eligibility before releasing the minimal pending receipt.

Name (1–100) and paragraph (1–2000) are checked before persistence, normalized to
NFC and trimmed without truncation. Blank text, C0/C1 controls and bidi override/
isolate controls reject; paragraph permits ordinary newline, carriage return and
tab. Markup is stored as plain data. Presentation must escape it. The row alone
contains private text. The outbox contains Feedback/Project IDs; the ledger keeps
the canonical hash and only ID/Project/pending receipt. Anonymous replay scope is
Portfolio/Project/operation/key; a key grants no read or identity recovery.
The receipt/hash expires after 90 days; retention execution belongs to #205/#206.

The existing HTTP adapter obtains `getFeedbackRuntimeServices()` from standard
PostgreSQL assembly. It consumes no identity/consent cookies and issues no cookie.
It bounds the actual streamed UTF-8 body at 16 KiB independently of Content-Length,
returns contracted 400 for oversized transport, and calls abuse control before
body parsing/persistence. A missing/failed limiter returns 503; exhausted budget
returns 429 and Retry-After. Default assembly enforces a process-local shared
Portfolio budget of 30 requests per 60 seconds. Configure
`FEEDBACK_RATE_LIMIT_MAX_REQUESTS` and `FEEDBACK_RATE_LIMIT_WINDOW_SECONDS` with
positive integers. This deliberately needs no persistent client/IP/fingerprint.
Multiple hosting processes have independent budgets; the hosting boundary can
inject a trusted shared limiter. Deployed fleet qualification remains Phase 9–10.

Migration `20261015003000_persist_private_feedback.sql` is expand-only and adds
no cross-module FK, elevated function or direct anonymous access. FORCE RLS and
INSERT-only runtime grants allow only scoped pending/version-1 rows. Owner
read/decision policies are the explicit #193 handoff. Disable submission assembly
to roll back behavior while preserving private rows, then forward-fix by migration.

Use pinned Node 24.21.0/npm 11.19.0:

```text
npm run setup:validation
npm run validation:ready
npm run phase7:focus:feedback -- --refresh-types
npm run phase7:focus:feedback
```

`--refresh-types` is schema setup; final acceptance verifies generated types and
rejects any source change during the run. PostgreSQL binaries are discovered at
`C:/Program Files/PostgreSQL/18/bin` on Windows or via `pg_config --bindir` on Linux;
override with `PHASE7_POSTGRES_BIN`. The runner creates a disposable loopback-only
cluster, applies all migrations, creates a non-superuser/non-bypassing runtime,
checks strict aggregate Vitest success with zero required skips and removes its
own cluster. No developer/production service is contacted. Integrated historical
upgrade qualification is #208; this slice proves its migration/type/RLS behavior.
