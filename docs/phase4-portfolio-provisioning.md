# Phase 4 Portfolio settings provisioning

Portfolio settings are created once by a controlled local or deployment
operator. There is no public create route. Provisioning uses the same
least-privilege application database principal as the server and inserts the
settings row plus its ordered Contact channels in one PostgreSQL transaction.
The configured Owner and Portfolio are supplied explicitly as canonical
UUIDv7 identities; the application service does not generate a replacement
Portfolio or infer an Owner from profile text.

Prepare a JSON file outside the repository with this shape:

```json
{
  "portfolioId": "<configured Portfolio UUIDv7>",
  "ownerId": "<configured Owner UUIDv7>",
  "profile": {
    "displayName": "Owner display name",
    "headline": "A meaningful professional headline",
    "bio": "A reviewed public profile biography."
  },
  "contactChannels": [],
  "globalCta": {
    "label": "Discuss a project",
    "destination": "https://example.com/contact",
    "unavailableFallback": "Contact details are currently unavailable."
  }
}
```

Set `DATABASE_URL` to the restricted application database URL and run:

```text
node scripts/provision-portfolio-settings.mjs <path-to-settings-json>
```

Provisioning validates the profile bounds, ordered channel count and locale
values, channel-specific safe destinations, and CTA fallback text. Empty
Contact channel lists are valid. A second or concurrent attempt returns a
conflict and preserves the existing aggregate. The program prints only a safe
result code; it never prints database credentials or the input values. Keep
the input file private and remove it after the controlled provisioning step.

## Reproduce the database acceptance checks

With the pinned Node/npm environment and Docker Desktop running, execute:

```text
npm run phase4:focus:settings
```

The runner starts a disposable Supabase project with the repository's
production migrations and a loopback-only Docker network on ports 57320–57329.
It verifies generated database types, runs provisioning and restricted-role
checks with no skipped tests, and stops/removes only resources created by that
run. It does not use or reset the normal development database.
