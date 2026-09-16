# Contract-first public HTTP interface

Status: accepted

ShipWithAli will design its five versioned public HTTP operations in OpenAPI 3.1 before implementing their Next.js Route Handler adapters. Sol is the named design role responsible for proposing the HTTP interface from the accepted domain model and architecture; the reviewed, committed OpenAPI source is the durable transport source of truth. Redocly validates and bundles the contract, and pinned generation produces TypeScript types and Zod validators. Domain module interfaces remain authoritative for business behavior and cannot depend on OpenAPI, generated transport artifacts, Zod, or Next.js.

Within `/api/v1`, changes are additive and backward compatible. A breaking request, response, security, or semantic change requires a new major route. Owner Server Actions and private handlers, in-process module interfaces, provider seams, and Lab entry behavior are excluded from the public contract.

**Consequences**: Generated files are committed but never manually edited; CI rejects lint, generation, or compatibility drift. Handwritten Route Handlers remain thin adapters that validate the transport input, construct domain commands, invoke one module interface, and translate typed rejections to RFC 9457 Problem Details. Redocly reference output is available only as a local or CI artifact.
