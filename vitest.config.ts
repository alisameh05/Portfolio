import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    /**
     * Use the threads pool with a single worker.
     *
     * This is a deterministic execution setting required on Windows where
     * process spawning may be restricted. It does not reduce coverage.
     * See: Phase 1 spec — Testing Decisions.
     */
    pool: "threads",
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    include: ["tests/**/*.test.ts"],
    /**
     * No external runtime, database, credentials, or network required.
     * Phase 1 tests are purely structural and type-level.
     */
    environment: "node",
    globals: false,
  },
  resolve: {
    alias: {
      "@shared/domain": new URL("./src/shared/domain/index.ts", import.meta.url)
        .pathname,
    },
  },
});
