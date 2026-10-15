import { UUID } from "uuidv7";
import { Client } from "pg";

export function createDeterministicClock(startAt = Date.UTC(2026, 0, 1), stepMs = 1) {
  if (!Number.isSafeInteger(startAt) || startAt < 0 || !Number.isSafeInteger(stepMs) || stepMs < 0) throw new RangeError("invalid deterministic clock");
  let current = startAt;
  return Object.freeze({
    now: () => new Date(current),
    nowIso: () => new Date(current).toISOString(),
    advance: (deltaMs = stepMs) => {
      if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) throw new RangeError("invalid clock advance");
      current += deltaMs;
      return new Date(current);
    },
  });
}

export function createUuidV7Sequence(clock, { firstRandA = 1, firstRandBHi = 1, firstRandBLo = 1 } = {}) {
  let sequence = 0;
  return Object.freeze({
    next: () => {
      const timestamp = clock.now().getTime();
      const ordinal = sequence++;
      const randA = (firstRandA + ordinal) & 0xfff;
      const randBHi = (firstRandBHi + Math.floor(ordinal / 0x100000000)) & 0x3fffffff;
      const randBLo = (firstRandBLo + ordinal) >>> 0;
      return UUID.fromFieldsV7(timestamp, randA, randBHi, randBLo).toString();
    },
    count: () => sequence,
  });
}

export function createBarrier(parties) {
  if (!Number.isSafeInteger(parties) || parties < 1) throw new RangeError("barrier requires at least one party");
  let arrived = 0;
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  return Object.freeze({
    arrive: async () => {
      arrived += 1;
      if (arrived > parties) throw new Error("barrier received too many arrivals");
      if (arrived === parties) release();
      await released;
      return arrived;
    },
    arrived: () => arrived,
  });
}

export async function openIndependentPostgresConnections(connectionString, count) {
  if (typeof connectionString !== "string" || connectionString === "" || !Number.isSafeInteger(count) || count < 1) throw new TypeError("connection string and positive connection count are required");
  const clients = Array.from({ length: count }, () => new Client({ connectionString, connectionTimeoutMillis: 5_000 }));
  try {
    await Promise.all(clients.map((client) => client.connect()));
    const identities = await Promise.all(clients.map(async (client) => {
      const result = await client.query("select pg_backend_pid() as backend_pid");
      return result.rows[0].backend_pid;
    }));
    if (new Set(identities).size !== count) throw new Error("database connections are not independent");
    return clients;
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.end()));
    throw error;
  }
}
