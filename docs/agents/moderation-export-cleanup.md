# Owner export artifact expiry and cleanup (#247)

PR #277 introduced the durable ZIP-deletion fence for Moderation exports.
Issue #247 generalizes that lifecycle to every registered Owner export scope
and adds all-scope package reconciliation.

The configured assembly worker performs one bounded cleanup page on each
`runOwnerExportAssembly` invocation, including idle ticks. It also exposes
`runOwnerExportCleanup` for an explicit cleanup tick. A page examines at most
25 artifacts by default (maximum 100); its cursor advances through eligible
and ineligible artifacts and resets after the last page. Restart resumes safely
from the beginning. The application cleanup service also accepts an explicit
cursor for a schedule adapter. Hosted schedule installation remains Phase 10.

Every request with a durable candidate identity is a cleanup candidate. Ready
exports expire exactly seven days after the database completion instant, or
at the earlier captured policy deadline. Current Media/CV and Moderation
eligibility is checked through the owning module interfaces; no foreign tables
are written. Expiry, source-policy invalidation, and terminal build failure
revoke the artifact before Storage deletion. Revocation changes ready to
expired or building to failed and commits `artifact_revoked_at` plus the fixed
safe `artifact_revocation_code` (`expired`, `privacy_invalid`, or
`build_failed`). Deletion failures leave `artifact_deleted_at` absent for
retry. Acknowledged deletion retains a minimal invalidation ledger with
portfolio/export/artifact identities, safe timestamps and a fixed reason code.
The worker can read and append ledger entries and update only the deletion
acknowledgement; the backup role can read the ledger, while application,
anonymous and authenticated roles cannot. Recovery quarantine must compare
this protected current ledger before restored data or objects leave quarantine.

Uploads hold the same request-row lock as revocation and must still own the
queue lease and candidate. Cleanup waits for an in-flight upload, and a revoked
candidate cannot upload or finalize afterward. Storage deletion addresses only
`owner-exports/<portfolio>/<export>/<candidate>.zip` through the Storage API;
source objects, other exports, and currently eligible artifacts survive.

Download independently revalidates current eligibility and checks the
database-clock expiry throughout cleanup outages. Assembly results expose only
cleanup counts and incomplete progress. The deletion service can restart after
provider failure without recapture or rewriting immutable ZIPs. Ledger fields
contain only portfolio/export/artifact identities, timestamps, and fixed reason codes;
they and operational signals contain no Visitor identities, Feedback text, or
decision reasons. Recovery tooling must reconcile this protected current ledger
before a restored copy leaves quarantine. Recovery-copy lifetime remains
configured by the operator, and this cleanup does not claim deletion from a
recovery copy.

Verification:

- `npm run phase8:focus:exports` exercises restricted-role PostgreSQL and the
  Storage seam for focused diagnostics.
- `npm run phase8:focus:exports -- --with-storage` runs acceptance against an
  isolated loopback Supabase Storage stack. PR validation uses this command
  and requires successful stack and native-cluster cleanup.

The tests cover all seven single scopes, cross-group and full-selection
packages, ready and failed uploads/finalization, source retention and earlier
erasure, seven-day and policy-deadline boundaries, deletion outage/restart, and
an independent-connection upload/cleanup barrier. The migration adds a safe
revocation cause, a minimal protected invalidation ledger with narrowly scoped
worker and backup policies, and a broader bounded-scan index. It adds no grants
to application, anonymous or authenticated roles.
