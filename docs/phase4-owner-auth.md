# Phase 4 Owner session verification (#80)

Ticket #80 resolves a verified session linked to an allowlisted immutable
GitHub subject into a stable provider-neutral Owner actor. Verification runs
in `src/modules/identity-access/adapters/supabase-auth.ts` behind the
existing `AuthProviderPort`; domain and application code only see
`OwnerIdentity` and the closed `Rejection` union.

## What is verified before an Owner actor exists

Signature, allowed algorithm and key, issuer, audience, expiry, and the
standard Supabase `sub` and `session_id` claims are all checked first. This
dedicated adapter binds the operation to `owner_session`; it does not require
custom `sid` or `purpose` JWT claims. ES256 uses trusted P-256 public keys supplied
as PEM by the provider consumer; HS256 fixtures use separately injected secrets.
Unknown keys, wrong curves and public-key/HMAC confusion fail closed. The adapter
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

The real-token runner enables Auth and its API gateway only in a disposable
project. The committed development configuration keeps both disabled.
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

Run `npm run phase4:focus:local-auth` for the separate real-token check. It starts
an isolated local Auth stack using the pinned CLI, provisions a disposable user,
obtains an actual access token via an admin-generated one-time link, checks its
standard claims through the real adapter, and verifies tampering, allowlist
removal and revocation rejection. Trusted GitHub identity/revocation lookups
remain controlled fixtures; this proves emitted token compatibility, not a live
GitHub OAuth exchange. Signup and anonymous sign-in restrictions stay disabled;
no password login is used. Credentials stay in memory and cleanup removes only
the disposable stack. See [validation setup](agents/validation-setup.md) for
Docker requirements and the required `Local Auth real-token` CI verdict.

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
