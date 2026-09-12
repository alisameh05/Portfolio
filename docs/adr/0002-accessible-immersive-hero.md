# Accessible immersive hero with functional fallback

Status: accepted

The landing page uses an immersive hero as its primary visual identity, but the hero is not allowed to be a functional dependency. A static equivalent must preserve the core message and navigation when animation, WebGL, rich media, reduced-motion preferences, assistive technology, or device capability prevents the immersive experience from running. Accessibility and core navigation take precedence over visual treatment.

**Consequences**: Accessibility is a launch requirement, and visual failure states are designed product states rather than exceptional implementation details.
