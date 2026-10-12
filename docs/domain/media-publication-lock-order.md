# Media publication locking

Content publication and restoration use one transaction for Media eligibility facts and Content writes. When a command references Media, it first obtains shared transaction-scoped Media locks in ascending stable Media ID order. Only after those locks are held may it lock the Content root and change the publication or lifecycle state. The lock timeout is three seconds; statement and transaction timeouts are five and ten seconds.

The shared Media locks remain held until Content commits or rolls back its route, public projection, history, receipt, and outbox changes. Media withdrawal uses the same order: take its exclusive Media lock, then read Content's currently visible references through the Content-owned usage interface in that transaction. The usage read follows the current `content.language_publications` pointers and published Content lifecycle, with the referenced immutable revision payload as the evidence source. It does not infer visibility from a delayed public or discovery projection.

The current Media set is the union of references from all currently published English and Arabic Project and Achievement revisions. Drafts, Hidden and Archived roots, superseded Revisions, and unaccepted Media facts do not create public delivery entitlement.

Owner rejection uses the exclusive Media lock before reading both current visible Content references and the Current CV pointer in the same transaction. Rejection is blocked while either use exists. An upload capability issued before rejection remains a bounded bearer capability until its provider-enforced expiry; a late write can only create or replace a private candidate object and cannot restore Media eligibility or public delivery.
