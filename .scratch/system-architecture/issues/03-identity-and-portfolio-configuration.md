# Identity, access, and Portfolio configuration

Status: ready-for-agent
Type: task
Blocked by: 01, 02

## Objective

Implement GitHub OAuth through Supabase Auth, immutable Owner allowlisting, scheduled-job authorization, separate purpose-limited Visitor identities, public profile settings, Contact channels, and Global project CTA behavior.

## Acceptance criteria

- Public signup grants no Owner-workspace access.
- Only an allowlisted immutable GitHub provider subject becomes the Owner; email and display name do not grant access.
- Functional and analytics identities have separate issuance, purpose, storage, and retention paths.
- Owner state changes are protected by server authorization, RLS, same-origin checks, and CSRF controls.
- Unavailable Contact or CTA destinations return a safe public fallback.
- E-03 and the applicable Q-04 evidence pass.

## Comments

Follow ADR-0013, ADR-0015, and the Identity and Access interface.
