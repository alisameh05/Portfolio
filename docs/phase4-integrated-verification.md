# Phase 4 integrated verification (#89)

This verification traces the applicable stories in Spec #77 to observable
application-interface, HTTP, Auth, architecture, and PostgreSQL checks. The
primary settings seam is the three existing Owner HTTP operations backed by the
same `PortfolioSettings` aggregate and disposable loopback PostgreSQL database.
Auth and identity tests use local fixtures; the separate real-token check uses
only disposable local Supabase Auth. No live GitHub exchange or remote service
is part of validation.

## Story coverage

| Spec #77 stories | Observable coverage |
| --- | --- |
| 1–9: verified Owner sessions, authorization, CSRF, replay authorization, and fail-closed deferred operations | `tests/phase4/owner-session-auth.test.ts`, `tests/phase4/owner-request-security.test.ts`, `tests/phase4/owner-operation-policy.test.ts`, `tests/phase4/local-auth-token.integration.test.ts`; route inventory in `npm run runtime:boundary` |
| 10–17: public browsing, purpose-separated functional and Measurement identity, consent withdrawal, token purpose and rotation | `tests/phase4/pseudonymous-identity.test.ts`, `tests/phase4/functional-identity-orchestration.test.ts` |
| 18–30: profile, ordered channels, CTA fallback, input limits, optimistic concurrency, replay, and rollback | `tests/phase4/portfolio-profile-command.test.ts`, `tests/phase4/portfolio-contact-channels-command.test.ts`, `tests/phase4/portfolio-cta-command.test.ts`, `tests/database/portfolio-settings.integration.test.ts` |
| 31–33: committed Owner settings, localized public configuration, capability fallback, and safe audit events | `tests/phase4/portfolio-settings-service.test.ts`, `tests/database/portfolio-settings.integration.test.ts` |
| 34–35: restricted-principal RLS and clean/upgrade migration equivalence | `tests/database/role-rls-matrix.test.ts`, `tests/database/portfolio-settings.integration.test.ts`, `npm run phase4:focus:settings` |
| 36: provider/generated-code isolation and backend-only boundary | `npm run test:arch`, `npm run contract:verify`, `npm run runtime:boundary`, `npm run runtime:architecture` |
| 37: deterministic negative, privacy, concurrency, and rollback checks | Focused `tests/phase4` plus the required Auth and settings integration runners below |

The Phase 4 focus suite covers the declared authentication/authorization,
settings input and locale matrices, consent and identity rotation, provider
failure handling, and safe public/Owner views. Synthetic Auth provider errors
and identity subjects are checked in the stable Auth rejection and through the
Owner request guard's HTTP Problem Details and captured logs; session material
is also checked against HTTP Problem Details and captured logs. The PostgreSQL
scenario checks cookie, CSRF, and database fault strings against its response,
logs, views, and events. The route inventory remains five public and thirty-nine
Owner operations; only the profile, Contact channel, and Global project CTA
configuration services are activated.

## Cross-command PostgreSQL scenario

The integrated case in `tests/database/portfolio-settings.integration.test.ts`
exercises all three secured HTTP operations against one configured Portfolio.
It releases profile, channel, and CTA edits together at version one and requires
exactly one success and two stale-version rejections. It then reuses one
idempotency key once per operation, verifies sequential aggregate versions and
concurrently retries the same channel command to the original receipt without
another version or event. It verifies one versioned event per accepted command
and proves that a database failure leaves the Owner view, public view,
idempotency ledger, and event stream intact.
The same scenario rejects a different Owner and checks both allowlist removal
before a new mutation and before replay for each operation. Synthetic cookie,
CSRF, and database error secrets must not appear in the failure response,
settings views, events, or sanitized evidence.

Sanitized representative event excerpt (the Owner scope hash and private
configuration values are omitted):

```json
[
  {
    "event_type": "portfolio_configuration.profile_updated.v1",
    "aggregate_version": 2,
    "payload": {
      "type": "portfolio_configuration.profile_updated.v1",
      "version": 1,
      "value": { "changedFields": ["headline"], "ownerScope": "[redacted hash]" }
    }
  },
  {
    "event_type": "portfolio_configuration.channels_updated.v1",
    "aggregate_version": 3,
    "payload": {
      "type": "portfolio_configuration.channels_updated.v1",
      "version": 1,
      "value": { "channelCount": 1, "channelTypes": ["linkedin"], "ownerScope": "[redacted hash]" }
    }
  },
  {
    "event_type": "portfolio_configuration.cta_updated.v1",
    "aggregate_version": 4,
    "payload": {
      "type": "portfolio_configuration.cta_updated.v1",
      "version": 1,
      "value": { "changedFields": ["label"], "ownerScope": "[redacted hash]" }
    }
  }
]
```

This excerpt is a sanitized shape example, not a claim that the local Docker
integration run completed. The real event rows are asserted by the required
PostgreSQL CI job.

## Reproduction

Use the repository-pinned Node 24.21.0 and npm 11.19.0 after
`npm run setup:validation` and `npm run validation:ready`:

```text
npm run phase4:focus:context
npm run phase4:focus:local-auth
npm run phase4:focus:settings
npm run test:arch
npm run contract:verify
npm run runtime:boundary
npm run runtime:architecture
```

The Auth and settings integration commands create separate disposable projects
and loopback-only Docker networks, require zero skipped tests, and clean up only
their own resources. Missing Docker, incomplete reports, failed cleanup, or any
failed assertion is a failed check. CI runs the local Auth and real-PostgreSQL
checks in independent Docker-capable jobs on every pull request to `master`.
