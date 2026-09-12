# Vercel and Supabase behind provider seams

Status: accepted

The first release will deploy the Next.js application on Vercel and use Supabase for PostgreSQL, Auth, and primary object storage. Domain interfaces remain independent of both providers, with adapters translating authentication, persistence, storage, scheduling, email, and monitoring behavior so hosting or storage can change without changing stable domain identities.

**Consequences**: GitHub OAuth is accepted as an Owner-workspace dependency, Supabase Storage is replaced or supplemented only through the object-storage seam, and free-tier limits are operational triggers rather than domain constraints.
