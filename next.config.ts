import type { NextConfig } from "next";

/**
 * next.config.ts — Phase 2 #25 backend-only runtime shell.
 *
 * No pages, layouts, components, JSX/TSX, CSS, browser state, or SEO surface
 * is introduced. Only Route Handlers under src/app (operational probes in
 * this ticket; product adapters in later Phase 2 tickets) are served.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
