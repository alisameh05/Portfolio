import { describe, expect, it } from "vitest";
import { cleanupOwnedOperationsRun, isOwnedOperationsRunPath, operationsRunRoot, operationsTempBase, parsePostmasterPidFile,
  postgresCommandLineOwnsDataDirectory, resolvePostgresBinaryDirectory, validRepositoryIdentity, resolveAcceptanceEvidence,
  OPERATIONS_ACCEPTANCE_EVIDENCE_PLAN } from "../../scripts/phase8-operations-observability.mjs";

describe("Phase 8 observability gate portability", () => {
  it("uses the short process temp root on Windows and the native temporary root on POSIX", () => {
    expect(operationsTempBase({ platform: "win32", env: {}, tmpdir: "C:\\Users\\operator\\AppData\\Local\\Temp" })).toBe("C:\\t");
    expect(operationsTempBase({ platform: "win32", env: { PHASE8_TEMP_ROOT: "D:/codex-temp" }, tmpdir: "C:\\Temp" })).toBe("D:\\codex-temp");
    expect(operationsTempBase({ platform: "linux", env: {}, tmpdir: "/tmp" })).toBe("/tmp");
    expect(operationsRunRoot({ platform: "win32", tempBase: "C:\\t", runId: "run-id" }))
      .toBe("C:\\t\\phase8-operations-observability-run-id");
    expect(operationsRunRoot({ platform: "linux", tempBase: "/tmp", runId: "run-id" }))
      .toBe("/tmp/phase8-operations-observability-run-id");
  });

  it("discovers native PostgreSQL binaries from Windows and POSIX paths without a pinned install", () => {
    const winDirectory = "C:\\Program Files\\PostgreSQL\\18\\bin";
    const winFiles = new Set(["postgres.exe", "initdb.exe", "pg_ctl.exe"].map((name) => `${winDirectory}\\${name}`.toLowerCase()));
    expect(resolvePostgresBinaryDirectory({ platform: "win32", env: { PHASE7_POSTGRES_BIN: "C:/Program Files/PostgreSQL/18/bin" },
      exists: (file) => winFiles.has(String(file).toLowerCase()) })).toBe(winDirectory);

    const posixDirectory = "/usr/lib/postgresql/17/bin";
    const posixFiles = new Set(["postgres", "initdb", "pg_ctl"].map((name) => `${posixDirectory}/${name}`));
    expect(resolvePostgresBinaryDirectory({ platform: "linux", env: {}, pathValue: "/usr/bin:/usr/lib/postgresql/17/bin",
      exists: (file) => posixFiles.has(String(file)) })).toBe(posixDirectory);
    expect(resolvePostgresBinaryDirectory({ platform: "linux", env: { PHASE7_POSTGRES_BIN: "/missing/pg" },
      exists: () => false })).toBeNull();
  });

  it("removes only a gate-owned direct child and accepts branch or detached HEAD identity", () => {
    const runId = "0196a1b2-7c3d-7e11-9f22-000000000008";
    const runName = `phase8-operations-observability-${runId}`;
    expect(isOwnedOperationsRunPath(`C:\\t\\${runName}`, "C:\\t", "win32", runId)).toBe(true);
    expect(isOwnedOperationsRunPath(`/tmp/${runName}`, "/tmp", "linux", runId)).toBe(true);
    expect(isOwnedOperationsRunPath("C:\\t\\other-run", "C:\\t", "win32", runId)).toBe(false);
    expect(isOwnedOperationsRunPath(`/tmp/../outside/${runName}`, "/tmp", "linux", runId)).toBe(false);
    expect(isOwnedOperationsRunPath(`C:\\t\\${runName}`, "C:\\t", "win32")).toBe(false);
    const identity = { head: "abcdef0123456789abcdef0123456789abcdef01", branch: "review/changed-head" };
    expect(validRepositoryIdentity(identity.head, identity.branch)).toBe(true);
    expect(validRepositoryIdentity(identity.head, "")).toBe(true);
    expect(validRepositoryIdentity("invalid", "")).toBe(false);
  });

  it("stops a PostgreSQL process created by an ambiguous start before removing its exact run directory", async () => {
    const runId = "0196a1b2-7c3d-7e11-9f22-000000000009";
    const tempBase = "C:\\t";
    const runRoot = operationsRunRoot({ platform: "win32", tempBase, runId });
    const dataRoot = `${runRoot}\\data`;
    const ownerRecord = { version: 1, runId, dataDirectoryRelative: "data", startupAttempted: true };
    let inspections = 0;
    let stops = 0;
    let removals = 0;
    const result = await cleanupOwnedOperationsRun({ runRoot, tempBase, dataRoot, runId, platform: "win32", ownerRecord,
      startupAttempted: true,
      async inspect() { return ++inspections === 1 ? { state: "owned", pid: 4210 } : { state: "absent", pid: 4210 }; },
      async stop(pid: number) { expect(pid).toBe(4210); stops++; }, async remove() { removals++; },
    });
    expect(result).toEqual({ ok: true, stage: "cleanup-complete", stopAttempted: true });
    expect({ inspections, stops, removals }).toEqual({ inspections: 2, stops: 1, removals: 1 });
  });

  it("retains the run directory when PostgreSQL remains live after cleanup", async () => {
    const runId = "0196a1b2-7c3d-7e11-9f22-00000000000a";
    const tempBase = "/tmp";
    const runRoot = operationsRunRoot({ platform: "linux", tempBase, runId });
    let removals = 0;
    const result = await cleanupOwnedOperationsRun({ runRoot, tempBase, dataRoot: `${runRoot}/data`, runId, platform: "linux",
      ownerRecord: { version: 1, runId, dataDirectoryRelative: "data", startupAttempted: true }, startupAttempted: true,
      async inspect() { return { state: "owned", pid: 4211 }; }, async stop() {}, async remove() { removals++; },
    });
    expect(result).toEqual({ ok: false, stage: "cleanup-postgres-still-live-or-unknown", stopAttempted: true });
    expect(removals).toBe(0);
  });

  it("matches a postmaster PID file and process command line to the exact data directory", () => {
    expect(parsePostmasterPidFile("3210\r\nC:\\t\\phase8\\data\r\n", "C:\\t\\phase8\\data", "win32"))
      .toEqual({ pid: 3210, dataRoot: "c:\\t\\phase8\\data" });
    expect(parsePostmasterPidFile("3210\nC:\\t\\other\n", "C:\\t\\phase8\\data", "win32")).toBeNull();
    expect(postgresCommandLineOwnsDataDirectory('"C:\\Program Files\\PostgreSQL\\18\\bin\\postgres.exe" -D "C:\\t\\phase8\\data"',
      "C:\\t\\phase8\\data", "win32")).toBe(true);
    expect(postgresCommandLineOwnsDataDirectory('"C:/Program Files/PostgreSQL/18/bin/postgres.exe" -D "C:/t/phase8/data"',
      "C:\\t\\phase8\\data", "win32")).toBe(true);
    expect(postgresCommandLineOwnsDataDirectory('postgres -D /tmp/phase8-other', "/tmp/phase8/data", "linux")).toBe(false);
  });

  it("maps all eight acceptance criteria to executable test or artifact references", () => {
    const criteria = [
      "Every parent-required signal has documented units/meaning/source/access/window and a bounded executable observation/query definition.",
      "Application/queue/export/privacy producers emit actual safe observations; backup/recovery producer obligations are explicit and cannot be reported complete from fake data.",
      "Metrics label cardinality is bounded; unknown provider limits/uninstalled signals remain unknown rather than zero/healthy.",
      "Dashboard definitions show oldest eligible outbox, dead/retry/lease state, retention last-complete/backlog and export/storage health with correct inclusion rules.",
      "Private marker tests prove no Feedback/CV/Visitor/credential/signed-URL/provider exception leakage in responses/logs/metrics/evidence.",
      "Restricted operational summaries deny unapproved access and never create a product/public metrics interface.",
      "Instrumentation failure does not undo committed domain state or expose sensitive fallback errors.",
      "Representative observation/query plans are bounded and do not perform backup/restore, unbounded scans or source mutations.",
    ];
    expect(OPERATIONS_ACCEPTANCE_EVIDENCE_PLAN.map(({ id, criterion }) => [id, criterion])).toEqual(
      criteria.map((criterion, index) => [`AC0${index + 1}`, criterion]));

    const namesFor = (id: string) => OPERATIONS_ACCEPTANCE_EVIDENCE_PLAN.find((criterion) => criterion.id === id)!
      .evidence.filter((reference) => reference.kind === "test").map((reference) => reference.name);
    expect(namesFor("AC05")).toEqual(expect.arrayContaining([
      "Phase 8 operations observability records consent rejection separately from HTTP status without leaking request markers",
      "Phase 8 operations observability observes the existing private Owner export status route without recording URL or session markers",
      "Phase 8 operations observability evaluates bounded dashboard definitions over serialized safe producer records and rejects field drift and inherited metric IDs",
      "Phase 8 operations observability records one failed Owner export download read without provider or identity details",
      "operations summary PostgreSQL qualification records one safe authorization failure when PostgreSQL outbox RLS is wrapped inside a transaction",
    ]));
    expect(namesFor("AC06")).toEqual(expect.arrayContaining([
      "Phase 8 operations observability requires the fixed system purpose and returns durable zero, watermark, and explicit unknown values",
      "operations summary PostgreSQL qualification enforces purpose and role denial and uses bounded indexes over completed history",
      "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes",
      "Phase 8 operations observability accepts only the documented Portfolio CLI flag and rejects missing, extra, conflicting, and oversized scope",
    ]));
    expect(namesFor("AC06").filter((name) => name.includes("EXPLAIN ANALYZE"))).toEqual([]);
    expect(namesFor("AC07")).toEqual(expect.arrayContaining([
      "Phase 8 operations observability records actual due-work completion after a sink failure without changing the committed checkpoint",
      "Phase 8 operations observability records unavailable, committed acceptance, and indeterminate commit acknowledgement as distinct outcomes",
      "Phase 8 operations observability ignores sink failures and rejects out-of-contract observations without throwing",
      "Phase 8 operations observability keeps a successful adapter response when its telemetry logger throws",
    ]));
    expect(namesFor("AC07").some((name) => name.includes("migration64"))).toBe(false);
    expect(namesFor("AC08")).toEqual(expect.arrayContaining([
      "operations summary PostgreSQL qualification EXPLAIN ANALYZE bounds oldest-eligible traversal over a large pending and future queue",
      "operations summary PostgreSQL qualification EXPLAIN ANALYZE bounds current export states and recent transition windows across old requests",
      "operations summary PostgreSQL qualification EXPLAIN ANALYZE bounds active lease-age reads after a large expired-lease prefix",
      "operations summary PostgreSQL qualification reads a bounded one-Portfolio summary under worker RLS, preserves unknown values, and performs no writes",
      "Phase 8 operations observability documents every operational signal with a bounded source, query, and explicit unknown rule",
      "Phase 8 operations observability evaluates bounded dashboard definitions over serialized safe producer records and rejects field drift and inherited metric IDs",
    ]));
    for (const criterion of OPERATIONS_ACCEPTANCE_EVIDENCE_PLAN) {
      expect(criterion.evidence.length).toBeGreaterThan(0);
      expect(criterion.evidence.every((reference) => reference.kind === "test" || reference.kind === "artifact")).toBe(true);
    }
  });

  it("resolves mapped acceptance references only against passing named checks and populated artifacts", () => {
    const plan = [{ id: "AC01", criterion: "Every parent-required signal has documented units/meaning/source/access/window and a bounded executable observation/query definition.", evidence: [
      { kind: "test", suite: "tests/example.test.ts", name: "a named check" },
      { kind: "artifact", path: "migration.rollback", check: "equals", value: "reapplied" },
    ] }];
    const evidence = { testInventory: [{ suite: "tests/example.test.ts", name: "a named check", status: "passed" }],
      migration: { rollback: "reapplied" } };
    expect(resolveAcceptanceEvidence(plan, evidence)).toEqual([{ id: "AC01", criterion: plan[0]!.criterion, evidence: [
      { kind: "test", suite: "tests/example.test.ts", name: "a named check", status: "passed" },
      { kind: "artifact", path: "migration.rollback", status: "resolved" },
    ] }]);
  });

  it("rejects missing, failed, skipped, or planned acceptance references", () => {
    const testPlan = [{ id: "AC01", criterion: "Every parent-required signal has documented units/meaning/source/access/window and a bounded executable observation/query definition.",
      evidence: [{ kind: "test", suite: "tests/example.test.ts", name: "a named check" }] }];
    for (const status of ["failed", "skipped", "pending"]) {
      expect(() => resolveAcceptanceEvidence(testPlan, {
        testInventory: [{ suite: "tests/example.test.ts", name: "a named check", status }],
      })).toThrow("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
    }
    expect(() => resolveAcceptanceEvidence(testPlan, { testInventory: [] })).toThrow("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
    expect(() => resolveAcceptanceEvidence([{ id: "AC01", criterion: "Every parent-required signal has documented units/meaning/source/access/window and a bounded executable observation/query definition.",
      evidence: ["a planned sentence"] }], {
      testInventory: [],
    })).toThrow("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
    expect(() => resolveAcceptanceEvidence([{ id: "AC01", evidence: [{ kind: "test", suite: "tests/example.test.ts", name: "a named check" }] }], {
      testInventory: [{ suite: "tests/example.test.ts", name: "a named check", status: "passed" }],
    })).toThrow("GATE_ACCEPTANCE_EVIDENCE_UNRESOLVED");
  });
});
