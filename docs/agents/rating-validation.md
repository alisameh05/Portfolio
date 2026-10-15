# Rating acceptance (#191)

Use Node 24.21.0 and npm 11.19.0:

```text
npm run setup:validation
npm run validation:ready
npm run phase7:focus:ratings
```

The runner creates a disposable native PostgreSQL cluster on a dynamic loopback
port, applies all repository migrations, verifies generated Interaction types,
and runs Rating acceptance plus the complete #190 Reaction regression suite.
`PHASE7_POSTGRES_BIN` selects PostgreSQL binaries; Windows defaults to PostgreSQL
18. No developer database or normal Supabase stack is accessed. Actual AES-GCM
tokens, restricted runtime logins, independent pools, observed database locks,
real lifecycle commands and injected database failures exercise the approved
application and thin HTTP seams. Database inspection supplements these seams
for cardinality, atomicity, constraints, RLS and privacy.

Use `npm run phase7:focus:ratings -- --refresh-types` only during setup. Settle
source and rerun without that flag for final acceptance. Every required assertion
and suite must pass with zero skips, unchanged source fingerprint and successful
cleanup before `evidence/phase7-ratings-191.json` is published. Reports contain
safe titles/statuses and migration checksums, never tokens or database URLs.

Content root locks precede the operation-specific Rating pair and scoped replay
ledger. Ratings use an independent table and lock namespace from Reactions;
changing either preserves the other. Both share the recognized functional
subject across locales, but each operation authorizes the current Project.
The encrypted cookie is returned only after a successful validated response.
Lost initial identity has the same limitation documented for #190: a caller
without that cookie cannot claim the original actor's receipt. Measurement
consent/configuration has no dependency on functional interaction success.

Migration rollback: disable Rating composition, retain existing rows and repair
through a new expand-compatible migration. There is no production migration
execution, new route, Rating removal or Measurement consumer. Integrated
clean-versus-prior-release qualification remains #208; current public summaries
and Low-sample presentation remain #195.
