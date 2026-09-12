# Domain-oriented modular monolith

Status: accepted

ShipWithAli will begin as one Next.js deployment and one PostgreSQL database, organised as deep domain modules with explicit interfaces, owned write paths, and provider adapters. Microservices were rejected for the first release because the single-owner product needs transactional publication and modest portfolio-scale capacity more than independent deployment; a module may be extracted only after a documented load or team-ownership trigger is sustained.

**Consequences**: Modules may share infrastructure but cannot write through another module's implementation. An extracted module receives its own database and integrates through versioned events or a narrow interface rather than shared-table access.
