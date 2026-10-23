/**
 * owner-export-requests.test.ts — Phase 8 #238 unit acceptance.
 *
 * The provider-neutral Owner export request service with deterministic fakes:
 * scope canonicalization, canonical request hashing, replay semantics, and
 * durable-effect registration. No PostgreSQL involved; the disposable-cluster
 * acceptance lives in `owner-export-postgres.test.ts`.
 *
 * Criteria covered here:
 * - AC01: every nonempty unique subset of the seven declared scopes is
 *   accepted, and any permutation of one selection carries the identical
 *   canonical meaning — identical canonical array and identical canonical
 *   request hash inside the reservation.
 * - AC02: malformed, unknown, duplicated, and empty selections, malformed
 *   identities, and invalid idempotency keys are rejected before any durable
 *   effect (no receipt reservation, no export row, no assembly job).
 * - AC03/AC04 (service slice): exact retries replay the original receipt;
 *   changed meaning under the same key conflicts without durable effects.
 * - AC05 (service slice): the export reservation and the assembly job enqueue
 *   share one effect context, so caller-owned rollback discards both.
 * - AC07 (validator slice): only declared lifecycle edges with exactly their
 *   required metadata validate locally before the guarded store application.
 * - AC08 (mapping slice): uppercase persistence codes map explicitly to
 *   lowercase transport codes.
 */
import { describe, expect, it } from "vitest";

import {
  OWNER_EXPORT_SCOPES,
  createOwnerExportService,
  OWNER_EXPORT_RECEIPT_TTL_SECONDS,
  OWNER_EXPORT_SCHEMA_VERSION,
  parseSafeErrorCode,
  transportFailureCode,
  type IdempotentExecutionInput,
  type LeasedJobStorePort,
  type OperationsPersistencePorts,
  type OwnerExportServiceDependencies,
  type OwnerExportStorePort,
  type OwnerExportTransitionInput,
  type OwnerExportPackageManifest,
  type ExportScope,
} from "../../src/modules/portability-operations/index.js";
import {
  applyGuardedOwnerExportTransition,
  canonicalizeOwnerExportScopes,
  validateOwnerExportTransition,
  type OwnerExportReservationInput,
  type SafeResultEnvelope,
} from "../../src/modules/portability-operations/index.js";
import { hashCanonicalRequest } from "../../src/shared/application/idempotency.js";
import { createTestLogger, type TransactionRunner, type StableIdGenerator } from "../../src/runtime/ports.js";
import { parseIdempotencyKey, unsafeStableId, type OwnerActor } from "../../src/shared/domain/index.js";

const NOW = "2026-10-23T09:00:00.000Z";
const PORTFOLIO_ID = unsafeStableId<"Portfolio">("0196a1b2-7c3d-7e11-9f22-000000000010");
const OWNER_ID = unsafeStableId<"Owner">("0196a1b2-7c3d-7e11-9f22-000000000011");
const actor: OwnerActor = { kind: "owner", ownerId: OWNER_ID, sessionId: "phase8-owner-export-test-session" };
const SCOPES: readonly ExportScope[] = ["portfolio-content", "taxonomy"];

let idSequence = 0x30;
function ids(): StableIdGenerator {
  return {
    generate: () => {
      idSequence += 1;
      return `0196a1b2-7c3d-7e11-9f22-${(idSequence).toString(16).padStart(12, "0").slice(-12)}`;
    },
  };
}
function key(value: string) {
  const parsed = parseIdempotencyKey(value);
  if (!parsed.ok) throw new Error("IDEMPOTENCY_KEY_INVALID");
  return parsed.value;
}

interface RecordedJob {
  readonly jobId: string;
  readonly payload: { readonly type: string; readonly version: number; readonly value: Record<string, unknown> };
  readonly availableAt: string;
}

function createFakeOperations() {
  const idempotencyCalls: IdempotentExecutionInput[] = [];
  const enqueued: RecordedJob[] = [];
  const executed: SafeResultEnvelope[] = [];
  const reservations = new Map<string, { requestHash: string; result: SafeResultEnvelope }>();
  const idempotency = {
    async execute(input: IdempotentExecutionInput, effect: (context: { kind: "transaction" }) => Promise<SafeResultEnvelope>) {
      idempotencyCalls.push(input);
      const composite = `${input.operationScope}\u0000${input.actorScope}\u0000${input.key}`;
      const existing = reservations.get(composite);
      if (existing !== undefined) {
        return existing.requestHash !== input.requestHash
          ? { kind: "conflict" as const }
          : { kind: "replayed" as const, result: existing.result };
      }
      const result = await effect({ kind: "transaction" });
      reservations.set(composite, { requestHash: input.requestHash, result });
      executed.push(result);
      return { kind: "executed" as const, result };
    },
  } as OperationsPersistencePorts["idempotency"];
  const jobs = {
    async enqueue(_context: unknown, job: RecordedJob) {
      enqueued.push(job);
    },
  } as unknown as LeasedJobStorePort;
  const operations: OperationsPersistencePorts = {
    transactions: {
      async run(callback: (context: { kind: "transaction" }) => unknown) {
        return callback({ kind: "transaction" });
      },
    } as unknown as TransactionRunner,
    idempotency,
    outbox: { async append() {} } as unknown as OperationsPersistencePorts["outbox"],
    jobs,
  };
  return { operations, idempotencyCalls, enqueued, executed };
}

function createFakeExportStore() {
  const reservations: OwnerExportReservationInput[] = [];
  const store: OwnerExportStorePort = {
    async reserveOwnerExport(input) {
      reservations.push(input);
    },
    async findOwnerExport() {
      return null;
    },
    async applyOwnerExportTransition() {
      return { ok: true as const, value: { kind: "stale" as const } };
    },
  };
  return { store, reservations };
}

function makeService(overrides: {
  operations?: OperationsPersistencePorts;
  exports?: OwnerExportStorePort;
  ids?: StableIdGenerator;
} = {}) {
  const fakeOperations = createFakeOperations();
  const fakeStore = createFakeExportStore();
  const dependencies: OwnerExportServiceDependencies = {
    operations: overrides.operations ?? fakeOperations.operations,
    exports: overrides.exports ?? fakeStore.store,
    clock: { now: () => NOW },
    ids: overrides.ids ?? ids(),
  };
  return { service: createOwnerExportService(dependencies), fakeOperations, fakeStore };
}

function requestCommand(includedScopes: readonly ExportScope[], idempotencyKeyValue = "phase8-request-key-001") {
  return {
    actor,
    portfolioId: PORTFOLIO_ID,
    idempotencyKey: key(idempotencyKeyValue),
    includedScopes: [...includedScopes],
  };
}

/** Every permutation of one subset, lazily. */
function* permutations(values: readonly string[]): Generator<readonly string[]> {
  if (values.length <= 1) {
    yield values;
    return;
  }
  for (const [index, head] of values.entries()) {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)];
    for (const tail of permutations(rest)) {
      yield [head, ...tail];
    }
  }
}

function* subsets(values: readonly string[]): Generator<readonly string[]> {
  const total = 2 ** values.length;
  for (let mask = 1; mask < total; mask += 1) {
    yield values.filter((_, index) => (mask & (1 << index)) !== 0);
  }
}

describe("AC01: canonical Owner export scope selection and hashing", () => {
  it("accepts every nonempty subset in canonical declared order", () => {
    let counted = 0;
    for (const subset of subsets(OWNER_EXPORT_SCOPES)) {
      const canonical = canonicalizeOwnerExportScopes(subset);
      expect(canonical.ok, subset.join(",")).toBe(true);
      if (!canonical.ok) return;
      expect([...canonical.value])
        .toEqual(OWNER_EXPORT_SCOPES.filter((scope) => subset.includes(scope)));
      counted += 1;
    }
    expect(counted).toBe(127);
  });

  it("normalizes every permutation of one selection to identical canonical meaning", () => {
    for (const subset of subsets(OWNER_EXPORT_SCOPES)) {
      const canonical = canonicalizeOwnerExportScopes(subset);
      expect(canonical.ok).toBe(true);
      for (const permutation of permutations(subset)) {
        const canonicalized = canonicalizeOwnerExportScopes(permutation);
        expect(canonicalized.ok, permutation.join(",")).toBe(true);
        if (!canonical.ok || !canonicalized.ok) return;
        expect([...canonicalized.value]).toEqual([...canonical.value]);
      }
    }
  });

  it("hashes the canonical order, so permutations reuse the same reservation meaning", async () => {
    const { service, fakeOperations } = makeService();
    let subsetIndex = 0;
    for (const subset of subsets(OWNER_EXPORT_SCOPES)) {
      subsetIndex += 1;
      const expectedHash = await hashCanonicalRequest({
        operation: "owner-export-request",
        schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
        includedScopes: OWNER_EXPORT_SCOPES.filter((scope) => (subset as readonly string[]).includes(scope)) as ExportScope[],
      });
      const accepted = await service.requestOwnerExport(
        requestCommand(subset as ExportScope[], `phase8-hash-subset-${subsetIndex}`),
      );
      expect(accepted.ok, subset.join(",")).toBe(true);
      const recorded = fakeOperations.idempotencyCalls.at(-1);
      if (recorded === undefined) throw new Error("NO_RESERVATION_RECORDED");
      expect(recorded.requestHash).toBe(expectedHash);
    }
    // One settled two-scope selection replays identically under any permutation.
    const original = await service.requestOwnerExport(requestCommand(["taxonomy", "portfolio-content"] as ExportScope[], "phase8-permutation-key"));
    const replayed = await service.requestOwnerExport(requestCommand(["portfolio-content", "taxonomy"] as ExportScope[], "phase8-permutation-key"));
    expect(replayed).toEqual(original);
    expect(fakeOperations.executed).toHaveLength(128);
  });

  it("rejects the empty selection without durable effects", async () => {
    const { service, fakeStore, fakeOperations } = makeService();
    const rejected = await service.requestOwnerExport(requestCommand([]));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.code).toBe("OWNER_EXPORT_SCOPES_EMPTY");
    expect(fakeStore.reservations).toHaveLength(0);
    expect(fakeOperations.enqueued).toHaveLength(0);
    expect(fakeOperations.idempotencyCalls).toHaveLength(0);
  });
});

describe("AC02: input validation precedes every durable effect", () => {
  it.each([
    ["non-array selection", { includedScopes: "portfolio-content" as unknown }],
    ["duplicate scope", { includedScopes: ["taxonomy", "taxonomy"] as unknown }],
    ["unknown scope", { includedScopes: ["taxonomy", "portfolio-settings"] as unknown }],
    ["invalid member type", { includedScopes: ["taxonomy", 7] as unknown }],
    ["malformed portfolio identity", { portfolioId: "not-a-uuid" }],
    ["malformed owner identity", { ownerId: "also-not-a-uuid" }],
    ["empty idempotency key", { idempotencyKey: "" }],
    ["oversized idempotency key", { idempotencyKey: "k".repeat(200) }],
  ] as const)("rejects %s before any reservation", async (_label, override) => {
    const { service, fakeStore, fakeOperations } = makeService();
    const command = {
      actor: "ownerId" in override ? { kind: "owner" as const, ownerId: override.ownerId as unknown as typeof actor.ownerId } : actor,
      portfolioId: ("portfolioId" in override
        ? override.portfolioId
        : PORTFOLIO_ID) as unknown as typeof PORTFOLIO_ID,
      idempotencyKey: ("idempotencyKey" in override
        ? override.idempotencyKey
        : "phase8-invalid-key-001") as unknown as ReturnType<typeof key>,
      includedScopes: ("includedScopes" in override
        ? override.includedScopes
        : SCOPES) as unknown as readonly ExportScope[],
    };
    let rejected = true;
    try {
      const result = await service.requestOwnerExport(command as never);
      rejected = !result.ok;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(fakeStore.reservations).toHaveLength(0);
    expect(fakeOperations.enqueued).toHaveLength(0);
    expect(fakeOperations.idempotencyCalls).toHaveLength(0);
  });

  it("rejects non-owner actors as forbidden without durable effects", async () => {
    const { service, fakeStore, fakeOperations } = makeService();
    const rejected = await service.requestOwnerExport({
      actor: { kind: "visitor", ownerId: OWNER_ID } as never,
      portfolioId: PORTFOLIO_ID,
      idempotencyKey: key("phase8-visitor-key-001"),
      includedScopes: SCOPES,
    });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toMatchObject({ kind: "forbidden" });
    expect(fakeStore.reservations).toHaveLength(0);
    expect(fakeOperations.enqueued).toHaveLength(0);
    expect(fakeOperations.idempotencyCalls).toHaveLength(0);
  });
});

describe("AC03 (service slice): one receipt, one export, one assembly job", () => {
  it("reserves exactly one export row and one job for one accepted request", async () => {
    const { service, fakeStore, fakeOperations } = makeService();
    const result = await service.requestOwnerExport(requestCommand(SCOPES));
    expect(result.ok).toBe(true);
    const receipt = result.ok ? result.value : undefined;
    expect(receipt).toMatchObject({ outcome: "owner-export-requested", state: "requested" });
    expect(fakeStore.reservations).toHaveLength(1);
    const reservation = fakeStore.reservations[0];
    expect(reservation).toMatchObject({
      portfolioId: PORTFOLIO_ID,
      ownerId: OWNER_ID,
      includedScopes: SCOPES,
      schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
    });
    expect(fakeOperations.enqueued).toHaveLength(1);
    const job = fakeOperations.enqueued[0];
    if (job === undefined) throw new Error("NO_JOB_ENQUEUED");
    expect(job.payload["type"]).toBe("portability.owner-export-assembly.v1");
    expect(job.payload["version"]).toBe(1);
    expect(Object.keys(job.payload["value"]).sort())
      .toEqual(["exportId", "includedScopes", "ownerId", "portfolioId"]);
    expect(job.payload["value"]["exportId"]).toBe(receipt?.exportId);
    expect(job.payload["value"]["includedScopes"]).toEqual(SCOPES);
    expect(job.availableAt).toBe(NOW);
    const recorded = fakeOperations.idempotencyCalls[0];
    if (recorded === undefined) throw new Error("NO_RESERVATION_RECORDED");
    expect(recorded.operationScope).toBe(`portability.owner-export-request:${PORTFOLIO_ID}`);
    expect(recorded.expiresAt.endsWith("Z")).toBe(true);
    expect(Date.parse(recorded.expiresAt) - Date.parse(NOW)).toBe(OWNER_EXPORT_RECEIPT_TTL_SECONDS * 1000);
  });
});

describe("AC04 (service slice): replay and conflict semantics", () => {
  it("replays the original receipt exactly on exact retry and conflicts on changed meaning", async () => {
    const { service, fakeStore, fakeOperations } = makeService();
    const first = await service.requestOwnerExport(requestCommand(SCOPES, "phase8-replay-key-001"));
    expect(first.ok).toBe(true);
    const replay = await service.requestOwnerExport(requestCommand(SCOPES, "phase8-replay-key-001"));
    expect(replay).toEqual(first);
    const conflicted = await service.requestOwnerExport(requestCommand(["taxonomy"] as ExportScope[], "phase8-replay-key-001"));
    expect(conflicted.ok).toBe(false);
    if (conflicted.ok) return;
    expect(conflicted.error).toEqual({ kind: "conflict", code: "IDEMPOTENCY_PAYLOAD_CONFLICT" });
    expect(fakeStore.reservations).toHaveLength(1);
    expect(fakeOperations.enqueued).toHaveLength(1);
    expect(fakeOperations.idempotencyCalls).toHaveLength(3);
  });

  it("maps persistence faults to the fail-closed rejection", async () => {
    const failingStore: OwnerExportStorePort = {
      async reserveOwnerExport() {
        throw new Error("injected reservation failure");
      },
      async findOwnerExport() {
        return null;
      },
      async applyOwnerExportTransition() {
        return { ok: true as const, value: { kind: "stale" as const } };
      },
    };
    const { service } = makeService({ exports: failingStore });
    const rejected = await service.requestOwnerExport(requestCommand(SCOPES, "phase8-rollback-key-001"));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toEqual({ kind: "temporarily_unavailable", code: "OWNER_EXPORT_PERSISTENCE_UNAVAILABLE" });
  });
});

describe("AC05 (service slice): reservation members share one effect context", () => {
  it("hands the same effect context to the export reservation and the job enqueue", async () => {
    const contexts: unknown[] = [];
    const capturingStore: OwnerExportStorePort = {
      async reserveOwnerExport(_input, context) {
        contexts.push(context);
      },
      async findOwnerExport() {
        return null;
      },
      async applyOwnerExportTransition() {
        return { ok: true as const, value: { kind: "stale" as const } };
      },
    };
    const capturingJobs = {
      async enqueue(context: unknown) {
        contexts.push(context);
      },
    } as unknown as LeasedJobStorePort;
    const operations = createFakeOperations();
    await createOwnerExportService({
      operations: { ...operations.operations, jobs: capturingJobs },
      exports: capturingStore,
      clock: { now: () => NOW },
      ids: ids(),
    }).requestOwnerExport(requestCommand(SCOPES));
    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toEqual(contexts[1]);
    expect(contexts[0]).toMatchObject({ kind: "transaction" });
  });
});

describe("AC07 (validator slice): declared lifecycle edges with exact metadata", () => {
  const manifest: OwnerExportPackageManifest = {
    packageFormat: "shipwithali-owner-export" as const,
    schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
    createdAt: NOW,
    algorithm: "sha-256" as const,
    digest: "a".repeat(64),
    includedScopes: ["portfolio-content"] as ExportScope[],
    publicEventDataCoverage: { mode: "excluded" } as const,
    entries: [{
      path: "portfolio-content/projects.ndjson",
      scope: "portfolio-content" as const,
      mediaType: "application/x-ndjson" as const,
      recordSchema: "urn:shipwithali:owner-export-schema:portfolio-content:1.0" as const,
      schemaPath: "schemas/portfolio-content.schema.json" as const,
      schemaVersion: OWNER_EXPORT_SCHEMA_VERSION,
      digest: "b".repeat(64),
      recordCount: 3,
    }],
  };
  const base = {
    exportId: unsafeStableId<"OwnerExport">("0196a1b2-7c3d-7e11-9f22-000000000020"),
    expectedAggregateVersion: 1,
    transitionedAt: NOW,
    actingJobId: unsafeStableId<"Job">("0196a1b2-7c3d-7e11-9f22-000000000021"),
  };

  it("accepts exactly the declared edges and their required metadata", async () => {
    const staleStore: Pick<OwnerExportStorePort, "applyOwnerExportTransition"> = {
      async applyOwnerExportTransition() {
        return { ok: true as const, value: { kind: "stale" as const } };
      },
    };
    expect(await applyGuardedOwnerExportTransition(staleStore, { ...base, fromStatus: "requested", toStatus: "building" }))
      .toEqual({ ok: true, value: "stale" });
    expect(await applyGuardedOwnerExportTransition(staleStore, { ...base, fromStatus: "building", toStatus: "ready", integrityManifest: manifest, artifactId: unsafeStableId<"OwnerExportArtifact">("0196a1b2-7c3d-7e11-9f22-000000000022") }))
      .toEqual({ ok: true, value: "stale" });
    expect(await applyGuardedOwnerExportTransition(staleStore, { ...base, fromStatus: "building", toStatus: "failed", failureCode: parseSafeErrorCode("ASSEMBLY_FAILED") }))
      .toEqual({ ok: true, value: "stale" });
    expect(await applyGuardedOwnerExportTransition(staleStore, { ...base, fromStatus: "ready", toStatus: "expired", integrityManifest: manifest, artifactId: unsafeStableId<"OwnerExportArtifact">("0196a1b2-7c3d-7e11-9f22-000000000022") }))
      .toEqual({ ok: true, value: "stale" });
  });

  it.each([
    ["impossible edge", { fromStatus: "failed", toStatus: "building" }, "OWNER_EXPORT_TRANSITION_IMPOSSIBLE"],
    ["unknown state", { fromStatus: "paused", toStatus: "building" }, "OWNER_EXPORT_TRANSITION_UNKNOWN_STATE"],
    ["missing manifest on readiness", { fromStatus: "building", toStatus: "ready" }, "OWNER_EXPORT_TRANSITION_METADATA_MISSING"],
    ["artifact without manifest", { fromStatus: "requested", toStatus: "building", artifactId: unsafeStableId<"OwnerExportArtifact">("0196a1b2-7c3d-7e11-9f22-000000000023") }, "OWNER_EXPORT_TRANSITION_METADATA_UNEXPECTED"],
    ["invalid failure code shape", { fromStatus: "building", toStatus: "failed", failureCode: "assembly-failed" }, "OWNER_EXPORT_TRANSITION_FAILURE_CODE_INVALID"],
    ["malformed manifest", { fromStatus: "building", toStatus: "ready", integrityManifest: { packageFormat: "other" }, artifactId: unsafeStableId<"OwnerExportArtifact">("0196a1b2-7c3d-7e11-9f22-000000000024") }, "OWNER_EXPORT_TRANSITION_MANIFEST_INVALID"],
    ["stale aggregate version", { fromStatus: "requested", toStatus: "building", expectedAggregateVersion: 0 }, "OWNER_EXPORT_TRANSITION_VERSION_INVALID"],
  ] as const)("rejects %s locally", (_label, override, code) => {
    const invalid = { ...base, ...override } as unknown as OwnerExportTransitionInput;
    const result = validateOwnerExportTransition(invalid);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
  });
});

describe("AC08 (mapping slice): lowercase transport failure codes", () => {
  it("maps declared uppercase persistence codes to lowercase transport codes", () => {
    expect(transportFailureCode("ASSEMBLY_FAILED")).toBe("assembly_failed");
    expect(transportFailureCode("ASSEMBLY_EXPIRED")).toBe("assembly_expired");
    for (const unsafe of ["lowercase", "with-dash", `TOOLONG${"X".repeat(64)}`]) {
      expect(() => transportFailureCode(unsafe)).toThrow();
    }
  });
});
