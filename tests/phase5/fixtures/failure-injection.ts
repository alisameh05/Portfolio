import { createHash } from "node:crypto";

export type FailurePoint = "transaction" | "projection" | "outbox" | "receipt";

export function createDeterministicFixture(seed: string, fixedTime = "2026-01-01T00:00:00.000Z") {
  if (seed.trim() === "" || !Number.isFinite(Date.parse(fixedTime))) throw new Error("PHASE5_FIXTURE_CONFIGURATION_INVALID");
  let sequence = 0;
  return Object.freeze({
    now: () => new Date(fixedTime),
    nextId: (kind: string) => {
      if (!/^[a-z][a-z0-9_-]*$/i.test(kind)) throw new Error("PHASE5_FIXTURE_ID_KIND_INVALID");
      sequence += 1;
      const suffix = createHash("sha256").update(`${seed}:${kind}:${sequence}`).digest("hex").slice(0, 24);
      return `${kind}_${suffix}`;
    },
  });
}

export function createBarrier(parties: number) {
  if (!Number.isSafeInteger(parties) || parties < 2) throw new Error("PHASE5_BARRIER_PARTIES_INVALID");
  let arrivals = 0;
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return Object.freeze({
    async wait() {
      arrivals += 1;
      if (arrivals > parties) throw new Error("PHASE5_BARRIER_OVERFLOW");
      if (arrivals === parties) release();
      await opened;
    },
  });
}

export async function createIndependentConnections<T>(createConnection: () => Promise<T>, count = 2): Promise<T[]> {
  if (!Number.isSafeInteger(count) || count < 2) throw new Error("PHASE5_CONNECTION_COUNT_INVALID");
  const connections = await Promise.all(Array.from({ length: count }, () => createConnection()));
  if (new Set(connections).size !== count) throw new Error("PHASE5_CONNECTIONS_NOT_INDEPENDENT");
  return connections;
}

export function createFailureInjector(failAt: FailurePoint) {
  return Object.freeze({
    hit(point: FailurePoint) {
      if (point === failAt) throw new Error(`INJECTED_${point.toUpperCase()}_FAILURE`);
    },
  });
}

export const mediaAcceptanceFacts = Object.freeze([
  Object.freeze({ status: "accepted" as const }),
  Object.freeze({ status: "rejected" as const, reason: "unsafe" as const }),
  Object.freeze({ status: "unavailable" as const }),
]);
