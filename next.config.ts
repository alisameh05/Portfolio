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
  // Keep standalone traces inside the active checkout when managed worktrees
  // live under the repository and Next.js sees a parent lockfile.
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  webpack(config) {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default nextConfig;
