# Media and CV Portfolio

Status: ready-for-agent
Type: task
Blocked by: 01, 02, 03

## Objective

Implement private Media upload grants, validation and acceptance, accessibility metadata, provider-independent object references, variants, CV versions, atomic Current CV activation, and signed public resolution.

## Acceptance criteria

- Upload candidates remain private and grants are short-lived, bound, and size-limited.
- Acceptance verifies MIME declaration, extension, content signature, safety, ownership, suitability, and required accessibility metadata.
- Public resolution exposes accepted variants only and survives rich-media failure with a functional fallback.
- Exactly one accepted English CV is Current after activation; Arabic returns a truthful unavailable result.
- Media identity and references do not change when the object-storage adapter changes.
- D-09, D-12, D-13, E-05, and relevant Q-03/Q-04 evidence pass.

## Comments

Supabase Storage is primary; reaching 70% of configured storage or egress opens the R2 assessment rather than changing domain behavior.
