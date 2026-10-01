# Phase 4 Owner session verification (#80)

Ticket #80 resolves a verified session linked to an allowlisted immutable
GitHub subject into a stable provider-neutral Owner actor. Verification runs
in `src/modules/identity-access/adapters/supabase-auth.ts` behind the
existing `AuthProviderPort`; domain and application code only see
`OwnerIdentity` and the closed `Rejection` union.

## What is verified before an Owner actor exists

Signature, allowed algorithm and key, issuer, audience, expiry, and the
required subject/session/purpose claims are all checked first. The adapter
then consults the trusted provider identity record (GitHub provider with a
matching immutable subject) and rechecks the current `OWNER_GITHUB_SUBJECTS`
allowlist. Mutable username/email, user-editable metadata, and
caller-supplied Owner IDs are never read for authority.

Outcome mapping preserves declared transport semantics: missing or invalid
sessions are `unauthenticated`, verified non-Owners and non-GitHub identities
are `forbidden`, and provider timeout or outage is
`temporarily_unavailable`. Rejection payloads carry only stable codes.

## Refresh, expiry, and revocation

- Sessions are short-lived (`exp` bounded; `jwt_expiry = 3600` locally).
  Refresh mints a new session; an expired token is never extended.
- Revocation is authoritative: a revoked session identifier denies even with
  an otherwise valid signature. Parsing a token alone never overrides the
  revocation policy, and sensitive sessions revalidate before use.
- Allowlist removal denies continued access on the next resolution and on
  idempotency replay authorization, not just at login.

## Local Auth services and provisioning

Only the Auth service required for local verification is enabled in isolation.
Password, anonymous-account, and unrestricted signup flows stay disabled, and
no product authentication routes are added.

Controlled sole-Owner provisioning:

1. Create the GitHub OAuth app for local development only.
2. Inject the client ID and secret solely into the provider consumer via
   `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` and
   `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` (never committed).
3. Set the exact OAuth callback and redirect destinations to the configured
   `site_url` plus `additional_redirect_urls`
   (`https://127.0.0.1:3000` locally).
4. Add the immutable GitHub subject to `OWNER_GITHUB_SUBJECTS`.
5. Verify with `tests/phase4/owner-session-auth.test.ts`, which uses
   deterministic HMAC fixtures and needs no live GitHub exchange,
   production secret, or remote Auth change.

## Configuration

`createOwnerAuthConfig` activates only `SUPABASE_URL`,
`SUPABASE_JWT_ISSUER`, `SUPABASE_JWT_AUDIENCE`, and
`OWNER_GITHUB_SUBJECTS`. Provisioning-only privileged credentials and OAuth
secrets are never read there. Diagnostics name the variable and rule without
echoing values.

## Persistence

`supabase/migrations/20261001220000_create_identity_access_owner_links.sql`
holds the narrowly necessary private mapping from immutable GitHub subject to
stable Owner. It carries restrictive grants, enabled and forced row-level
security, and no session material or provider payloads. Stable Owner identity
survives session and provider-record changes.
