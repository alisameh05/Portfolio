import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/phase8/operations-observability.test.ts",
      "tests/phase8/actionable-incidents.test.ts",
      "tests/phase8/operations-observability-postgres.gate.ts",
      "tests/phase8/optional-outages-postgres.gate.ts",
      "tests/phase8/incident-shutdown-postgres.gate.ts",
      "tests/phase8/operations-observability-runner.test.ts",
      "tests/phase8/operations-observability-retention-producer.test.ts",
      "tests/phase8/resumable-retention-passes.test.ts",
      "tests/runtime/owner-content-authoring.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
  environment: "node",
  globals: false,
  resolve: {
    alias: {
      "@shared/domain": new URL("./src/shared/domain/index.ts", import.meta.url).pathname,
    },
  },
});
