import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { phase8DueWorkInvocationBudgetFromEnvironment, remainingDueWorkRunBudgetMs } from "../../scripts/phase8-due-work-launcher.mjs";
import { selectPhase7JobsMode } from "../../scripts/phase7-jobs-config.mjs";
import { getPhase8DueWorkBudgetFromEnvironment } from "../../src/bootstrap/composition-root.js";
import { createProtectedDueWorkTrigger, PHASE8_PROTECTED_DUE_WORK_HANDOFF } from "../../src/runtime/protected-due-work-trigger.js";
import { createDueWorkStopCheck, DEFAULT_PROTECTED_DUE_WORK_BUDGET } from "../../src/runtime/phase8-due-work-control.js";
import { safeDueWorkTotals } from "../../src/runtime/phase8-due-work-summary.js";
import type { DueWorkRunCommand, DueWorkRunResult } from "../../src/runtime/phase7-due-work.js";
import type { Rejection, Result } from "../../src/shared/domain/index.js";

const url = "https://portfolio.example.test/internal/operations/phase7-due-work";
const secret = "private-marker-cron-secret-249";
const sampleResult: DueWorkRunResult = {
  scheduled: 60, deduplicated: 0, claimed: 2, completed: 2, released: 0, failed: 0, staleLeases: 0,
  processedCount: 4, incompleteBacklog: true, incompleteCoverage: false, incompleteOwnerExports: false,
  incomplete: true, lastCompletePolicyPeriod: null, oldestOverduePeriod: "2026-10-27", ownerExportAssembly: null,
};

const request = (headers: HeadersInit = {}) => new Request(url, { method: "GET", headers });

function dependencies(overrides: Partial<Parameters<typeof createProtectedDueWorkTrigger>[0]> = {}) {
  const runDueWork = vi.fn(async (_command: DueWorkRunCommand): Promise<Result<DueWorkRunResult, Rejection>> => ({
    ok: true, value: sampleResult,
  }));
  const trigger = createProtectedDueWorkTrigger({
    cronTriggerSecret: secret,
    workerId: "phase8-cron-registered-worker",
    runDueWork,
    observations: { monotonicNowMs: () => 100, memoryUsageBytes: () => 128 * 1024 * 1024 },
    ...overrides,
  });
  return { trigger, runDueWork };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe("protected Phase 8 due-work trigger", () => {
  it("selects one exact ticket mode and rejects conflicting flags before gate setup", () => {
    const contracts = [
      { args: [], ticket: 206, report: "artifacts/phase7-jobs-vitest.json", evidence: "evidence/phase7-due-work-206.json",
        files: ["tests/phase7/due-work.test.ts", "tests/phase7/due-work-postgres.test.ts"],
        criteria: ["T19-01", "T19-02", "T19-03", "T19-04", "T19-05", "T19-06", "T19-07", "T19-08", "T19-09"],
        count: 15, fingerprint: "30fb877ff7631df37ba6729400e28ad2da7a0fa2d27777270c7481cca424a651" },
      { args: ["--ticket-237"], ticket: 237, report: "artifacts/phase8-retry-recovery-vitest.json",
        evidence: "evidence/phase8-retry-recovery-237.json",
        files: ["tests/phase7/due-work.test.ts", "tests/phase7/due-work-postgres.test.ts",
          "tests/phase7/rollback-recovery-postgres.test.ts"],
        criteria: ["P8-40", "P8-41", "P8-42", "P8-43", "P8-44", "P8-08", "P8-38", "P8-39", "P8-54"],
        count: 19, fingerprint: "6d6dc3d595f9d3afcd7cc2b53bfb6ddf2bfd024ba233b856e30868700da1df0d" },
      { args: ["--ticket-248"], ticket: 248, report: "artifacts/phase8-retention-passes-vitest.json",
        evidence: "evidence/phase8-retention-passes-248.json",
        files: ["tests/phase7/due-work.test.ts", "tests/phase7/due-work-postgres.test.ts",
          "tests/phase8/resumable-retention-passes.test.ts", "tests/phase8/resumable-retention-passes-postgres.test.ts"],
        criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
        count: 42, fingerprint: "7f140679e5af8e51b5abc4005e926ab1af5e70e4b4ff8ea4a21414bf6662723d" },
      { args: ["--ticket-249"], ticket: 249, report: "artifacts/phase8-protected-trigger-vitest.json",
        evidence: "evidence/phase8-protected-trigger-249.json",
        files: ["tests/phase7/due-work.test.ts", "tests/phase7/due-work-postgres.test.ts",
          "tests/phase8/resumable-retention-passes.test.ts", "tests/phase8/resumable-retention-passes-postgres.test.ts",
          "tests/phase8/protected-trigger.test.ts", "tests/phase8/protected-trigger-postgres.test.ts"],
        criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
        count: 65, fingerprint: "0fae5b071d2361a99febeb9cc58f0a349d47386b70f86edf44cbd2d7a21e528b" },
    ];
    for (const contract of contracts) {
      const selected = selectPhase7JobsMode(contract.args, "linux");
      expect(selected.ok).toBe(true);
      if (!selected.ok) throw new Error("PHASE7_JOBS_MODE_SELECTION_FAILED");
      const { mode } = selected;
      expect(mode.ticket).toBe(contract.ticket);
      expect(mode.acceptanceFiles).toEqual(contract.files);
      expect(mode.reportPath).toBe(contract.report);
      expect(mode.evidencePath).toBe(contract.evidence);
      expect(mode.criteria).toEqual(contract.criteria);
      expect(mode.assertionTitles).toHaveLength(contract.count);
      const fingerprint = createHash("sha256").update(JSON.stringify({ ticket: mode.ticket,
        acceptanceFiles: mode.acceptanceFiles, assertionTitles: mode.assertionTitles, reportPath: mode.reportPath,
        evidencePath: mode.evidencePath, criteria: mode.criteria })).digest("hex");
      expect(fingerprint).toBe(contract.fingerprint);
    }
    expect(selectPhase7JobsMode(["--refresh-types"], "linux")).toEqual(selectPhase7JobsMode([], "linux"));
    expect(selectPhase7JobsMode(["--ticket-206"], "linux")).toEqual(selectPhase7JobsMode([], "linux"));
    expect(selectPhase7JobsMode(["--refresh-types", "--ticket-206"], "linux"))
      .toEqual(selectPhase7JobsMode([], "linux"));
    for (const args of [
      ["--ticket-206", "--ticket-249"],
      ["--ticket-249", "--ticket-249"],
      ["--ticket-237", "--ticket-248"], ["--ticket-237", "--ticket-249"],
      ["--ticket-248", "--ticket-249"], ["--ticket-237", "--ticket-248", "--ticket-249"],
    ]) {
      expect(selectPhase7JobsMode(args, "linux")).toEqual({ ok: false, code: "PHASE7_JOBS_TICKET_FLAGS_CONFLICT" });
    }
    const unsupportedArguments = ["--ticket", "--ticket=249", "--ticket_249", "--ticket-249x",
      "--ticket-294", "unexpected-positional"];
    for (const arg of unsupportedArguments) {
      expect(selectPhase7JobsMode([arg], "linux"))
        .toEqual({ ok: false, code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" });
    }
    for (const rejected of [
      { args: ["--ticket-237", "--ticket-249"], code: "PHASE7_JOBS_TICKET_FLAGS_CONFLICT" },
      { args: ["--ticket-206", "--ticket-249"], code: "PHASE7_JOBS_TICKET_FLAGS_CONFLICT" },
      { args: ["--ticket-294"], code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" },
      { args: ["--ticket"], code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" },
      { args: ["--ticket=249"], code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" },
      { args: ["--ticket_249"], code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" },
      { args: ["--ticket-249x"], code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" },
      { args: ["unexpected-positional"], code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" },
    ]) {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "phase7-jobs-rejected-mode-"));
      try {
        const command = spawnSync(process.execPath, [resolve("scripts/phase7-jobs.mjs"), ...rejected.args], {
          cwd: fixtureRoot, encoding: "utf8", timeout: 5_000, windowsHide: true,
        });
        expect(command.error).toBeUndefined();
        expect(command.status).toBe(2);
        expect(command.stdout).toBe("");
        expect(command.stderr).toBe(`${rejected.code}\n`);
        expect(readdirSync(fixtureRoot)).toEqual([]);
      } finally {
        const tempRoot = resolve(tmpdir());
        const ownedPrefix = `${tempRoot}${process.platform === "win32" ? "\\" : "/"}phase7-jobs-rejected-mode-`;
        if (resolve(fixtureRoot).startsWith(ownedPrefix)) rmSync(fixtureRoot, { recursive: true, force: true });
      }
    }
    expect(selectPhase7JobsMode(["--ticket-249"], "win32").ok).toBe(true);
    const nonLinuxProtected = selectPhase7JobsMode(["--ticket-249"], "win32");
    expect(nonLinuxProtected.ok && nonLinuxProtected.mode.assertionTitles).toHaveLength(63);
    if (nonLinuxProtected.ok) {
      const fingerprint = createHash("sha256").update(JSON.stringify({ ticket: nonLinuxProtected.mode.ticket,
        acceptanceFiles: nonLinuxProtected.mode.acceptanceFiles, assertionTitles: nonLinuxProtected.mode.assertionTitles,
        reportPath: nonLinuxProtected.mode.reportPath, evidencePath: nonLinuxProtected.mode.evidencePath,
        criteria: nonLinuxProtected.mode.criteria })).digest("hex");
      expect(fingerprint).toBe("1d23536030376c1bc1ddeb3df67829702007f9d1c7c5067bd2aa6b31785c46bc");
    }
  });

  it("accepts the configured Bearer credential and runs only the host-registered bounded worker", async () => {
    const { trigger, runDueWork } = dependencies();
    const response = await trigger.handle(request({ authorization: `Bearer ${secret}`,
      "user-agent": "vercel-cron/1.0", "x-vercel-cron-schedule": "untrusted-schedule" }));
    const payload = await body(response);
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: true, incomplete: true, totals: { claimed: 2, completed: 2, incompleteBacklog: true } });
    expect(payload["totals"]).toEqual(safeDueWorkTotals(sampleResult));
    expect(runDueWork).toHaveBeenCalledTimes(1);
    expect(runDueWork.mock.calls[0]?.[0]).toMatchObject({ workerId: "phase8-cron-registered-worker",
      maxClaimsPerPhase: DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxClaimsPerPhase,
      maxWorkBatchSize: DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxWorkBatchSize,
      maxOwnerExportClaims: DEFAULT_PROTECTED_DUE_WORK_BUDGET.maxOwnerExportClaims });
    expect(JSON.stringify(payload)).not.toContain(secret);
  });

  it("rejects missing, wrong, and empty Bearer credentials before queue effects", async () => {
    for (const headers of [{}, { authorization: "Bearer wrong-marker" }, { authorization: "Bearer " }]) {
      const { trigger, runDueWork } = dependencies();
      const response = await trigger.handle(request(headers));
      expect(response.status).toBe(401);
      expect(await body(response)).toEqual({ ok: false, code: "unauthorized" });
      expect(runDueWork).not.toHaveBeenCalled();
    }
    const missingConfiguration = dependencies({ cronTriggerSecret: "" });
    expect((await missingConfiguration.trigger.handle(request({ authorization: `Bearer ${secret}` }))).status).toBe(503);
    expect(missingConfiguration.runDueWork).not.toHaveBeenCalled();
  });

  it("does not treat spoofed Vercel scheduler headers as authority", async () => {
    const { trigger, runDueWork } = dependencies();
    const response = await trigger.handle(request({
      "user-agent": "vercel-cron/1.0",
      "x-vercel-cron-schedule": "0 0 * * *",
    }));
    expect(response.status).toBe(401);
    expect(runDueWork).not.toHaveBeenCalled();
  });

  it("rejects Owner cookies even when present beside a valid server-to-server credential", async () => {
    const { trigger, runDueWork } = dependencies();
    const response = await trigger.handle(request({ authorization: `Bearer ${secret}`, cookie: "sid=owner-cookie-marker" }));
    expect(response.status).toBe(401);
    expect(runDueWork).not.toHaveBeenCalled();
    expect((await response.text())).not.toContain("owner-cookie-marker");
  });

  it("rejects query credentials, request bodies, unsupported methods, and malformed length headers", async () => {
    const { trigger, runDueWork } = dependencies();
    const query = await trigger.handle(new Request(`${url}?token=${encodeURIComponent(secret)}`, {
      method: "GET", headers: { authorization: `Bearer ${secret}` },
    }));
    const bodyRequest = await trigger.handle(new Request(url, { method: "POST", body: secret,
      headers: { authorization: `Bearer ${secret}` } }));
    const malformedLength = await trigger.handle(request({ authorization: `Bearer ${secret}`, "content-length": "1x" }));
    const oversizedLength = await trigger.handle(request({ authorization: `Bearer ${secret}`, "content-length": "16385" }));
    expect(query.status).toBe(400);
    expect(bodyRequest.status).toBe(405);
    expect(bodyRequest.headers.get("allow")).toBe("GET");
    expect(malformedLength.status).toBe(400);
    expect(oversizedLength.status).toBe(413);
    expect(runDueWork).not.toHaveBeenCalled();
    expect(await query.text()).not.toContain(secret);
  });

  it("rejects oversized headers before authorization or queue effects", async () => {
    const { trigger, runDueWork } = dependencies();
    const large = new Request(url, { method: "GET", headers: {
      authorization: `Bearer ${secret}`, "x-oversized-marker": "x".repeat(8_200),
    } });
    const response = await trigger.handle(large);
    expect(response.status).toBe(413);
    expect(runDueWork).not.toHaveBeenCalled();
  });

  it("maps dependency errors to fixed responses without echoing exception or secret markers", async () => {
    const failure = dependencies({ runDueWork: async () => {
      throw new Error(`${secret} postgres://private-host/internal/private-marker`);
    } });
    const response = await failure.trigger.handle(request({ authorization: `Bearer ${secret}` }));
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(text).toBe('{"ok":false,"code":"due_work_unavailable"}');
    expect(text).not.toContain(secret);
    expect(text).not.toContain("private-host");
  });

  it("maps host clock and stop-observation failures to the fixed response before worker dispatch", async () => {
    const clockFailure = dependencies({ observations: {
      monotonicNowMs: () => { throw new Error(`${secret} private-clock-marker`); },
      memoryUsageBytes: () => 128 * 1024 * 1024,
    } });
    const clockResponse = await clockFailure.trigger.handle(request({ authorization: `Bearer ${secret}` }));
    expect(clockResponse.status).toBe(503);
    expect(await clockResponse.text()).toBe('{"ok":false,"code":"due_work_unavailable"}');
    expect(clockFailure.runDueWork).not.toHaveBeenCalled();

    const stopFailure = dependencies({ isStopping: () => { throw new Error(`${secret} private-stop-marker`); } });
    const stopResponse = await stopFailure.trigger.handle(request({ authorization: `Bearer ${secret}` }));
    expect(stopResponse.status).toBe(503);
    expect(await stopResponse.text()).toBe('{"ok":false,"code":"due_work_unavailable"}');
    expect(stopFailure.runDueWork).not.toHaveBeenCalled();
  });

  it("returns HTTP 200 for a truthful authenticated incomplete pass and rejects malformed totals safely", async () => {
    const incomplete = dependencies();
    const response = await incomplete.trigger.handle(request({ authorization: `Bearer ${secret}` }));
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ ok: true, incomplete: true,
      totals: { claimed: 2, processedCount: 4, incompleteBacklog: true } });
    const malformed = dependencies({ runDueWork: async () => ({ ok: true,
      value: { ...sampleResult, claimed: Number.NaN } }) as never });
    const rejected = await malformed.trigger.handle(request({ authorization: `Bearer ${secret}` }));
    expect(rejected.status).toBe(503);
    expect(await rejected.text()).toBe('{"ok":false,"code":"due_work_unavailable"}');
  });

  it("fails closed for invalid host budgets or unregistered worker identity", async () => {
    const invalidBudget = dependencies({ budget: { ...DEFAULT_PROTECTED_DUE_WORK_BUDGET, maxRunDurationMs: 300_000 } });
    expect((await invalidBudget.trigger.handle(request({ authorization: `Bearer ${secret}` }))).status).toBe(503);
    expect(invalidBudget.runDueWork).not.toHaveBeenCalled();
    const invalidWorker = dependencies({ workerId: "private-worker-id from request" });
    expect((await invalidWorker.trigger.handle(request({ authorization: `Bearer ${secret}` }))).status).toBe(503);
    expect(invalidWorker.runDueWork).not.toHaveBeenCalled();
  });

  it("enforces memory and monotonic deadline observations before additional claims", async () => {
    let monotonic = 100;
    let memory = 128;
    const budget = { ...DEFAULT_PROTECTED_DUE_WORK_BUDGET, maxMemoryBytes: 64 * 1024 * 1024,
      maxRunDurationMs: 1_000, shutdownGraceMs: 100 };
    const shouldStop = createDueWorkStopCheck({ budget,
      observations: { monotonicNowMs: () => monotonic, memoryUsageBytes: () => memory } });
    expect(shouldStop()).toBe(false);
    memory = budget.maxMemoryBytes;
    expect(shouldStop()).toBe(true);
    memory = 1;
    monotonic = 1_000;
    expect(shouldStop()).toBe(true);
  });

  it("fails closed for invalid memory and monotonic observations", () => {
    const budget = { ...DEFAULT_PROTECTED_DUE_WORK_BUDGET, maxRunDurationMs: 1_000, shutdownGraceMs: 100 };
    const invalidClock = createDueWorkStopCheck({ budget,
      observations: { monotonicNowMs: () => Number.NaN, memoryUsageBytes: () => 1 } });
    expect(invalidClock()).toBe(true);
    const invalidMemory = createDueWorkStopCheck({ budget,
      observations: { monotonicNowMs: () => 100, memoryUsageBytes: () => Number.NaN } });
    expect(invalidMemory()).toBe(true);
  });

  it("counts compilation against the invocation and rejects a tiny remaining worker window", () => {
    expect(phase8DueWorkInvocationBudgetFromEnvironment({})).toEqual({ maxRunDurationMs: 30_000, shutdownGraceMs: 400 });
    expect(phase8DueWorkInvocationBudgetFromEnvironment({ PHASE8_DUE_WORK_MAX_RUN_MS: "120000" }))
      .toEqual({ maxRunDurationMs: 120_000, shutdownGraceMs: 400 });
    expect(phase8DueWorkInvocationBudgetFromEnvironment({ PHASE8_DUE_WORK_MAX_RUN_MS: "299601" })).toBeUndefined();
    expect(phase8DueWorkInvocationBudgetFromEnvironment({ PHASE8_DUE_WORK_MAX_RUN_MS: "not-a-number" })).toBeUndefined();
    expect(getPhase8DueWorkBudgetFromEnvironment(120_000, {})).toMatchObject({ maxRunDurationMs: 120_000,
      shutdownGraceMs: 400 });
    expect(getPhase8DueWorkBudgetFromEnvironment(299_601, {})).toBeUndefined();
    expect(remainingDueWorkRunBudgetMs({ maxRunDurationMs: 30_000, startedAtMs: 10_000, nowMs: 25_000 })).toBe(14_900);
    expect(remainingDueWorkRunBudgetMs({ maxRunDurationMs: 30_000, startedAtMs: 10_000, nowMs: 38_500 })).toBeUndefined();
  });

  it("shares sanitized totals with the portable worker and keeps schedule handoffs uninstalled", () => {
    const totals = safeDueWorkTotals(sampleResult);
    expect(totals).toMatchObject({ claimed: 2, processedCount: 4, incomplete: true });
    expect(JSON.stringify(totals)).not.toContain("lastCompletePolicyPeriod");
    expect(PHASE8_PROTECTED_DUE_WORK_HANDOFF).toMatchObject({ providerSecretName: "CRON_SECRET",
      applicationSecretName: "CRON_TRIGGER_SECRET", installed: false, routeRegistrationPhase: 9,
      scheduleInstallationPhase: 10 });
    expect(PHASE8_PROTECTED_DUE_WORK_HANDOFF.schedules).toHaveLength(2);
    expect(PHASE8_PROTECTED_DUE_WORK_HANDOFF.schedules.every((schedule) => !schedule.routeRegistered && !schedule.scheduleInstalled)).toBe(true);
  });

});
