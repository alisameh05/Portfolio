# Phase 6 gate coverage

`npm run phase6:gate` composes the independent ticket runners and static checks
listed below. Every component report must come from the current gate run, bind
the exact source revision/tree, report positive execution with zero failures
and skips, and confirm cleanup. The gate report stores hashes for those files.

| Parent acceptance criteria | Executed evidence suites |
| --- | --- |
| AC-01–02 | Owner composition #161; integrated Media/CV #163 |
| AC-03–08 | Upload intents #148; Phase 6 service setup #146 |
| AC-09–13 | PDF #149, image #150, video #151 processing; integrated Media/CV #163 |
| AC-14–17 | Media acceptance #152; rejection #157; integrated Media/CV #163 |
| AC-18–23 | Media acceptance #152; publication #153; rejection #157; Media delivery #158; integrated Media/CV #163 |
| AC-24–25 | Service setup #146; Media delivery #158; migration/access #162; integrated Media/CV #163 |
| AC-26–35 | CV registration #154; acceptance #155; activation #156; Owner composition #161; integrated Media/CV #163 |
| AC-36–42 | CV registration #154; acceptance #155; activation #156; CV delivery/capabilities #159–160; integrated Media/CV #163 |
| AC-43–49 | Owner composition #161; migration/access #162; integrated Media/CV #163 |
| AC-50 | Service setup #146; integrated Media/CV #163 |
| AC-51 | Scenario 9: CV activation #156 and integrated #163. Scenario 12: Media acceptance #152, publication #153, and integrated #163. Scenario 13: public capabilities #160 and integrated #163. Scenario 15 Phase 6 portion: CV delivery #159 and integrated #163. |
| AC-52–56 | Gate runtime, required-check, rejection-case, source-fingerprint and coverage validation; fresh integrated evidence #163 |

`scripts/phase6-gate-support.mjs` expands this table into all 56 individual
AC entries, all 48 story entries linked to their supporting ACs, and the
mandatory real-service/security/migration/route/race/privacy matrices. The
same expanded mappings are copied into `evidence/phase6-gate-report.json`.
An item without a mapped suite, or whose suite artifact is absent, stale,
failed, skipped, malformed, or source-mismatched, fails the gate.

## Gate command checks

The gate verifies the exact runtime and installed lockfile, all focused Media
and CV acceptance runners, contract lint/bundle/generation/compatibility/drift,
tooling and gate rejection tests, architecture, route inventory, runtime
boundaries, lint, TypeScript, and production build. The ticket-specific
commands remain available independently for diagnosis and reproduction.

## Deliberate rejection cases

The gate evaluator's tests require failure for an absent real service, stale
source, failed constituent, missing scenario matrix, zero real processor
execution, fake-only evidence, a required skip, timeout, and failed cleanup.
Unit-only evidence cannot satisfy the real-service, private-policy,
independent-connection, scanner/processor, and cleanup requirements.

The scenario mapping follows the Phase 6 specification: scenario 9 proves
atomic Current CV replacement and retained history; scenario 12 proves
Project/Achievement publish and restore gates against current Media facts;
scenario 13 proves Arabic reuse of accepted English Media with no English
text fallback and unavailable Arabic CV; scenario 15 covers the Phase 6
degraded-dependency behavior while preserving committed state. Later
interaction, Measurement, frontend, deployment and operations portions remain
deferred.
