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

For the database-enabled application runtime, set `PORTFOLIO_ID` and `OWNER_ID`
to the same UUIDv7 values used in the provisioning file. The Owner identity
resolved from each verified session must match `OWNER_ID`.

The profile command writes a minimal outbox fact. Identifiers and timestamps
below are placeholders; the Owner scope value is a one-way digest. Profile text,
raw Owner IDs, session IDs, and provider usernames are not copied into the event.

```json
{
  "eventId": "<stable UUIDv7 domain-event ID>",
  "eventType": "portfolio_configuration.profile_updated.v1",
  "aggregateId": "<configured Portfolio UUIDv7>",
  "aggregateVersion": 2,
  "payload": {
    "version": 1,
    "value": {
      "changedFields": ["headline"],
      "ownerScope": "<sha256 stable Owner scope>"
    }
  },
  "correlationId": "<request correlation ID>",
  "causationId": null,
  "occurredAt": "<transaction timestamp>",
  "availableAt": "<same transaction timestamp>"
}
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

The runner starts two disposable Supabase projects with loopback-only Docker
networks on ports 57320–57349. One applies all migrations from an empty reset;
the other applies the committed Phase 3 migration snapshot, records prior
operations rows, then upgrades through the Phase 4 migrations. It compares
normalized schema, constraints, grants, policies, object definitions, and
migration ledgers, verifies the Phase 3 rows survived, checks generated
database types, and runs provisioning and restricted-principal checks with no
skipped tests. The runner stops and removes only resources created by that
run. It does not use or reset the normal development database.

The checked Phase 3 migration names and normalized SHA-256 checksums are
recorded in `supabase/baselines/phase3.json`. The sanitized result is written to
`evidence/phase-4-database-integrity.json` and is required by `phase4:gate`.
