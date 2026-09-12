# Transactional publication with an outbox

Status: accepted

Correctness-critical Owner operations use synchronous in-process module calls and one PostgreSQL transaction; asynchronous effects are recorded in a transactional outbox and processed by an idempotent PostgreSQL-backed job runner. A separate broker was rejected until measured throughput or isolation needs justify it because publication, routes, CV activation, taxonomy evolution, and Moderation require local atomicity while analytics, cache invalidation, notifications, exports, and alerts tolerate eventual consistency.

**Consequences**: Committing domain state and its outbox records is atomic, handlers must be retry-safe, and a later broker may replace the job adapter without changing domain events.
