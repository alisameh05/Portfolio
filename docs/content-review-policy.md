# Content Revision review policy

Each review is an append-only decision for one immutable Revision. The record binds the content identity and type, locale, Revision identity, SHA-256 snapshot hash, evidence snapshot version, verified Owner, decision, private findings, UTC timestamp, and a per-Revision `review_sequence`.

The current decision for a Revision is the record with the greatest `review_sequence`. The Content module assigns that sequence while holding the content aggregate version through the expected-version update. Review timestamps are audit facts and do not determine ordering. A later accepted or rejected review supersedes the prior decision for that exact Revision; it does not affect another Revision or locale.

The Owner preview supplies the canonical snapshot hash and evidence version. A review command must echo both with the locale. Content recalculates the hash from the immutable Revision and rejects any mismatch. Saving a new Revision creates a new unreviewed snapshot. It never inherits an earlier decision.

Publication must select the current review for the exact Revision and require an accepted decision whose snapshot hash and evidence version still match that Revision. Missing, rejected, or mismatched review facts fail closed. Publishing must not infer approval from a boolean on the Revision or from a review of another locale.

Editorial findings are private Owner data. They appear only in authenticated preview/history views as allowed by their contracts and never enter public projections, domain events, or diagnostic logs.
