# Phase 9 Owner Configuration HTTP (#294)

The three versioned Owner configuration operations are served by handwritten
Next.js Route Handlers. Each route marks its canonical OpenAPI operation and
delegates one Request to the existing Owner Configuration HTTP adapter. The
adapter validates the bounded JSON body, required `Idempotency-Key` and quoted
`If-Match`, establishes correlation, and dispatches exactly one configured
Portfolio Configuration command. Domain transactions and replay remain in the
existing module-owned PostgreSQL services.

## Security and privacy

- Supabase ES256 signing keys come from its bounded, five-minute cached JWKS
  endpoint; an unknown key triggers one refresh. The HTTP boundary verifies
  issuer, audience, expiry, signature, Owner purpose, live Auth session,
  GitHub provider identity, configured immutable-subject allowlist, and the
  stable Owner mapping on every request.
- Exact configured origin and a separate 8–256 character CSRF proof are
  required. Forwarded host values are rejected. The configuration commands do
  not accept session values as CSRF proof or add a deployment bypass.
- The three Owner Configuration operations share a PostgreSQL fixed-window
  policy of **30 accepted requests per verified Owner and operation per 60
  seconds**. PostgreSQL time and an atomic unique-key upsert make the limit
  consistent across independent connections and application instances. The
  Owner identity is SHA-256 hashed before persistence; raw Owner IDs, sessions,
  cookies, and client addresses are not stored. Expired windows are removed in
  batches of at most 64 after 24 hours. Exhaustion returns a positive bounded
  `Retry-After`; limiter failure returns 503 before command dispatch.
- Runtime readiness requires Auth, PostgreSQL, the Owner configuration
  service, the verified-session functions, and the configuration limiter
  function. Owner success, rejection, and bootstrap failure responses carry
  `Cache-Control: private, no-store` and `X-Robots-Tag: noindex, nofollow`.
- Bodies are limited to 65,536 actual bytes and must use `application/json`.
  Request text, cookies, and session material are not included in logs or
  responses.

## Focused verification

Run `npm run phase9:focus:owner-configuration-http` after `npm run build`.
The command creates a disposable loopback Supabase project, applies the current
migrations, provisions a restricted application login and a real Supabase Auth
Owner session linked to a synthetic GitHub subject, starts two instances of the
production Next server, and exercises their network routes against the same
PostgreSQL instance. It requires passing assertions with zero skips, checks
resource cleanup, and writes the sanitized
`evidence/phase9-owner-configuration-http-294.json` artifact.

PR validation builds the app once, then runs this focused integration and
security suite once on the current source. It includes the HTTP adapter,
verified-session and shared guard regression tests as well as the built-server
lane. `npm run test:phase9:owner-configuration-http` remains available for a
fast seam-only run and does not substitute for the focused acceptance command.
