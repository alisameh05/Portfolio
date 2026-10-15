# Measurement consent acceptance #189

Tested implementation: 38105aecd33980fe5307283c657f353c109fa305; actual source fingerprint 1b26159b30dcc2da8c30b328667e4b8a5aa9ed2a0a5d8f2808bdfe74c9939bc5; run 348efda7-91d4-4703-a7c4-d46404a4093b. [Machine report](phase7-consent-189.json) binds source, migration checksum, versions, roles, assertion results and hash-bound sanitized check logs.

Required real PostgreSQL/crypto: **16 passed, 0 failed, 0 skipped**, aggregate success true and 0 failed suites. Required HTTP transport/predecessor checks: **38 passed, 0 failed, 0 skipped**. Final broad suite: **1168 passed, 0 failed, 164 environment-gated skips**, aggregate success true and 0 failed suites. Broad skipped opt-in real-service cases do not certify acceptance; the 11 new PostgreSQL cases ran without skips in the required focused gate. All eight T02 criteria are complete locally.

| Criterion | Implementation and executed proof |
| --- | --- |
| T02-01 | Trusted in-process affirmative choice creates persisted consent and authenticated encrypted evidence. Real HTTP test verifies current evidence; missing cookie, arbitrary cookie value and body-only consentVersion cannot authorize dispatch. |
| T02-02 | Missing/forged/unknown/denied/wrong-purpose/expired/unsupported-notice/retired-key evidence rejects. Denied and unknown initial records have null subjects and no evidence. Invalid verification/notice choices add no history. Rejected HTTP intake never calls the event service. |
| T02-03 | Active/previous key rotation authenticates the original envelope and preserves the persisted Measurement subject for remaining lifetime. Retired keys, tampering and identity-envelope substitution reject. |
| T02-04 | Successful withdrawal records revision 2 and rejects revision-1 evidence before expiry. Renewal only preserves unexpired subjects; exact/after-expiry grants rotate. |
| T02-05 | Independent pooled PostgreSQL connections and an observed lock-wait barrier prove verification holds withdrawal until commit. Concurrent grant/withdraw at revision 1 commits one revision 2 and rejects the stale writer. Foreign Portfolio reads/mutations reject. |
| T02-06 | Independently configured Functional/Measurement keyrings and generated subjects cannot be swapped or derived. Shared active/previous material is rejected. Consent and identity envelopes use separate authenticated purposes. No functional subject field, join or derived salt enters owned consent state/history. |
| T02-07 | CLI-created timestamped migration and baseline execute on disposable PostgreSQL 18.3. Restricted login inherits only non-bypassing application grants; anonymous/non-Owner access is denied, history cannot be updated and worker deletion requires expiry. Fresh pool/service validates restart persistence; failed crypto issuance atomically rolls back consent/history. Generated measurement types verify against live schema. |
| T02-08 | Evidence lifetime is at most 30 UTC days and exact expiry rejects. Domain docs specify inactive consent/auxiliary cleanup horizon and bounded owned #204 cleanup handoff. Five public operations, contract compatibility, architecture and production build pass. |

## Standards

Independent Codex review of 38105aecd33980fe5307283c657f353c109fa305: 0 actionable findings. Authenticated purposes, RLS, migration safety, rollback, optional runtime composition and privacy boundaries reviewed.

## Spec

Independent Codex review of 38105aecd33980fe5307283c657f353c109fa305: 0 actionable findings. The prior expired-subject renewal finding was fixed and verified with a red then green real-service regression at one millisecond before/exactly/after expiry.

Standards: 0 findings; Spec: 0 findings. Human approval and hosted deterministic CI remain separate.

Reproduction: select Node 24.21.0/npm 11.19.0, run npm run setup:validation then npm run validation:ready and npm run phase7:focus:consent. PHASE7_POSTGRES_BIN selects an installed PostgreSQL binary directory (Windows defaults to PostgreSQL 18; Linux discovers pg_config). The runner initializes its own temporary loopback-only cluster, executes the existing database security baseline and owned consent migration, creates a restricted login, verifies generated types and requires all 16 tests/suites to pass with zero skips. --refresh-types is only for deliberate generation; final acceptance uses verification mode. The existing Runtime/typecheck/context CI job invokes this gate and uploads safe evidence. Full Phase 3-6 migration replay/combined equivalence is #208 scope.

Final required cluster cleanup succeeded. An earlier interrupted bootstrap cluster is stopped; automatic approval review rejected removal of its empty temporary directory with reason blocked by policy. The machine report identifies that path. No developer/production stack was reset or changed.

Trusted presentation invokes recordConsent in process. Configure MEASUREMENT_CONSENT_NOTICE_VERSIONS (comma-separated supported notices) and the existing purpose-separated keyrings to enable the optional runtime boundary. Missing/invalid optional configuration denies Measurement without adding a core readiness dependency. No new public endpoint/UI/storage integration is added. Event persistence and transactional intake recheck belong to #196; full raw/journey/contribution cleanup belongs to #204. Existing purpose-restricted 25/50/100-item cleanWithdrawnConsent contract defines bounded cleanup. Evidence/revocation horizon never exceeds 30 days; retention must run at least daily. Protected production scheduling and backup/export deletion remain Phase 8 handoffs.

Live prerequisite verification: #90/#125 are completed; PRs #105/#144 merged with all their hosted checks passed. #188/PR #210 is merged; its hosted jobs were billing-blocked, distinct from its accepted local contract evidence. This delivery certifies #189 acceptance, not Phase 7 completion or deployed readiness.
