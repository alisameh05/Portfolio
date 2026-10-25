# Moderation export artifact cleanup

PR #277 includes the ZIP-deletion repair originally assigned to #247, as
authorized by the maintainer. The remaining cross-scope/orphan and recovery
requirements of #247 remain a separate delivery.

The configured assembly worker performs one bounded cleanup page on each
`runOwnerExportAssembly` invocation, including idle ticks. It also exposes
`runOwnerExportCleanup` for an explicit cleanup tick. A page examines at most
25 artifacts by default (maximum 100); its cursor advances through eligible
and ineligible artifacts and resets after the last page. Restart resumes safely
from the beginning. The application cleanup service also accepts an explicit
cursor for a schedule adapter. Hosted schedule installation remains Phase 10.

Only requests selecting Moderation history with a durable candidate identity
are candidates. Current source eligibility is read through the Interactions
interface; no foreign tables are written. Source erasure/deletion, the captured
Feedback policy deadline, ready expiry, and terminal build failure revoke the
old artifact. Revocation changes ready to expired or building to failed and
commits `artifact_revoked_at` before calling Storage. Deletion failures leave
`artifact_deleted_at` absent for retry. Acknowledged deletion retains a safe
tombstone and dependency digest, without private text or reasons.

Uploads hold the same request-row lock as revocation and must still own the
queue lease and candidate. Cleanup waits for an in-flight upload, and a revoked
candidate cannot upload or finalize afterward. Storage deletion addresses only
`owner-exports/<portfolio>/<export>/<candidate>.zip` through the Storage API;
source objects, other exports, and currently eligible artifacts survive.

Download independently revalidates current eligibility throughout cleanup
outages. Assembly results expose only cleanup counts and incomplete progress.
The deletion service can restart after provider failure without recapture or
rewriting immutable ZIPs. This does not claim deletion from recovery copies.

Verification:

- `npm run phase8:focus:exports` uses real restricted-role PostgreSQL and a
  Storage seam for focused local diagnostics.
- `npm run phase8:focus:exports -- --with-storage` runs that acceptance suite
  against an isolated loopback Supabase Storage stack. PR validation uses this
  command and requires successful stack and native-cluster cleanup.

The tests cover ready and failed uploads/finalization, source retention and
earlier erasure, exact deadline boundaries, deletion outage/restart, and an
independent-connection upload/cleanup barrier. The migration adds only
Portability columns, a constraint, and a bounded-scan index; grants are unchanged.
