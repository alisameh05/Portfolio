import { expect, it } from "vitest";
import type { OperationsSignalObservation } from "../../src/modules/portability-operations/index.js";
import { makeFixture, portfolioId } from "./resumable-retention-passes.fixture.js";

it("Phase 8 operations observability records actual due-work completion after a sink failure without changing the committed checkpoint", async () => {
  const observations: OperationsSignalObservation[] = [];
  const fixture = makeFixture({ observations: { async recordSignal(observation) {
    observations.push(observation);
    throw new Error("PRIVATE_OBSERVATION_SINK_MARKER");
  } } });

  const result = await fixture.makeService(portfolioId).runDueWork({ workerId: "observed-retention", maxClaimsPerPhase: 1 });
  await Promise.resolve();

  expect(result).toMatchObject({ ok: true, value: { claimed: 1, completed: 1, incomplete: true } });
  expect(observations).toContainEqual({ kind: "retention-work", domain: "measurement", outcome: "completed", processed: 1 });
  expect(JSON.stringify(observations)).not.toMatch(/marker|portfolioId|jobId|cursor|exception/i);
  expect(fixture.rows.size).toBe(60);
});