# Phase 7 HTTP assembly acceptance (#207)

- Validation batch: `86e683a6-4edb-47d1-9abc-405040ffc7a9`
- Base commit: `60bfaac7824753648dca692c5af594c5a445587b`
- Source tree fingerprint: `23cd050176f16f6d708e79a8ecde9194cd31037983f2017e69bc33b2c9693753`
- Toolchain: Node 24.21.0, npm 11.19.0, PostgreSQL 18.3, Vitest 3.2.4
- All focused PostgreSQL acceptance used disposable loopback clusters, restricted runtime roles, and reported cleanup success. No required skips.

## Acceptance mapping

| Criterion | Evidence |
| --- | --- |
| T20-01 real standard composition and persistence | `phase7:focus:events` 72; `reactions` 16; `ratings` 33; `feedback` 57; `moderation` 80; `suppression` 93; `summaries` 132; `goal-versions` 77; `goal-conversions` 15; `feedback-retention` 12. Production composition without required database setup is also covered by `tests/runtime/phase7-runtime-fail-closed.test.ts` (3 tests), which proves each of the 11 operations returns 503 instead of fake success. |
| T20-02 contracted status/body/cookie and privacy | `test:runtime:http` (624 passed); `contract:verify` (strict response validation, deterministic generation, no drift, public/Owner compatibility); real public and Owner suites exercise success DTOs and privacy-safe receipts. |
| T20-03 malformed transport and no-dispatch rejection | `test:runtime:http`; `phase7:focus:events`, `reactions`, `ratings`, `feedback`, `moderation`, `suppression`, `goal-versions`; generated strict validators and operation tests cover malformed/missing headers, JSON, paths, and unknown fields. |
| T20-04 auth, scope, origin/CSRF, authorization | Owner request security and operation policy suites: 31 passed; real PostgreSQL scopes, owner moderation, feedback moderation, and goal suites above cover foreign scope and current authority. |
| T20-05 replay, conflicts, stale preconditions, no-op | Reaction, Rating, Feedback, moderation, suppression, and goal version/conversion PostgreSQL suites above cover persistence-backed replay and version/precondition behavior. |
| T20-06 typed failures and declared problem statuses | `test:runtime:http`; Owner security/policy suites (31); Phase 7 adapter and PostgreSQL suites exercise validation, auth, not-found, conflict, stale, rate limit, and unavailable mappings, including `Retry-After`. |
| T20-07 actual crypto, purpose, expiry, rotation, revision | `phase7:focus:events` (72), `reactions` (16), and `ratings` (33) use real purpose-bound signing/verification collaborators and PostgreSQL persistence. |
| T20-08 optional outages and required dependency loss | Event, Reaction, Rating, Owner moderation, suppression, and summary PostgreSQL suites test optional Measurement/worker absence and fail-safe required database loss. Event/Reaction/Rating/summary tests confirm safe core and functional workflows remain available without optional Measurement. |
| T20-09 boundary, compatibility, architecture | `route:inventory` confirms 5 public, 48 Owner, 2 operational probes and 0 product runtime routes; `runtime:architecture`, `test:arch`, `contract:verify`, and `typecheck` pass. |

## Focused real-service totals

| Command | Passed | Failed | Required skips | Cleanup |
| --- | ---: | ---: | ---: | --- |
| `phase7:focus:events` | 72 | 0 | 0 | true |
| `phase7:focus:reactions` | 16 | 0 | 0 | true |
| `phase7:focus:ratings` | 33 | 0 | 0 | true |
| `phase7:focus:feedback` | 57 | 0 | 0 | true |
| `phase7:focus:moderation` | 80 | 0 | 0 | true |
| `phase7:focus:suppression` | 93 | 0 | 0 | true |
| `phase7:focus:summaries` | 132 | 0 | 0 | true |
| `phase7:focus:goal-versions` | 77 | 0 | 0 | true |
| `phase7:focus:goal-conversions` | 15 | 0 | 0 | true |
| `phase7:focus:feedback-retention` | 12 | 0 | 0 | true |
| **Total** | **587** | **0** | **0** | **true** |

The broad HTTP runtime suite passed 624 tests with one environment-gated optional media tool test skipped. That skip is outside this ticket's required acceptance. Hosted PR validation run 38824834983 failed before any job steps because GitHub reported recent account payment failure or an exceeded spending limit. This is unresolved hosted CI evidence, separate from the passing local acceptance. Codex review, deterministic CI, and human approval remain separate states.
