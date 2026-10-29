import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createPostgresRuntimeDatabase } from "../../src/shared/adapters/postgres/runtime.js";
import { createOperationsSummaryService, OPERATIONS_SUMMARY_PURPOSE } from "../../src/modules/portability-operations/application/operations-observability.js";
import { createPostgresOperationsSummaryReader } from "../../src/modules/portability-operations/adapters/postgres-operations-summary.js";
import { createOperationalIncidentPass } from "../../src/modules/portability-operations/application/incident-pass.js";
import { createPostgresIncidentLifecycleStore } from "../../src/modules/portability-operations/adapters/postgres-incident-lifecycle.js";
import { createStableId } from "../../src/shared/domain/index.js";

const adminUrl = process.env["OPERATIONS_INCIDENT_SCENARIO_ADMIN_URL"];
const workerUrl = process.env["OPERATIONS_INCIDENT_SCENARIO_WORKER_URL"];
function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("INCIDENT_SHUTDOWN_BARRIER_TIMEOUT")), milliseconds);
    promise.then((result) => { clearTimeout(timer); resolve(result); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

describe.runIf(Boolean(adminUrl && workerUrl))("incident shutdown PostgreSQL qualification", () => {
  it("#252 AC08 interrupts a blocked summary before incident work and records real Linux SIGTERM separately", async () => {
    const owner = new Client({ connectionString: adminUrl });
    const observer = new Client({ connectionString: adminUrl });
    await owner.connect(); await observer.connect();
    const url = new URL(workerUrl!);
    const applicationName = `incident-shutdown-${process.pid}`;
    url.searchParams.set("application_name", applicationName);
    const portfolioId = createStableId("Portfolio");
    const counts = async () => (await observer.query("select count(*)::int as total, coalesce(sum(delivery_attempts),0)::int as attempts from operations.incidents")).rows[0];
    const before = await counts();
    let child: ReturnType<typeof spawn> | undefined;
    let database: ReturnType<typeof createPostgresRuntimeDatabase> | undefined;
    const controller = new AbortController();
    try {
      await owner.query("begin; lock table operations.jobs in access exclusive mode");
      let completion: Promise<unknown>;
      if (process.platform === "linux") {
        child = spawn(process.execPath, ["node_modules/vite-node/vite-node.mjs", "--config", "vitest.config.ts", "scripts/operations-incidents.ts", "--portfolio-id", portfolioId], {
          cwd: process.cwd(), windowsHide: true, env: { ...process.env, DATABASE_URL: url.toString(),
            OPERATIONS_INCIDENT_SINK_URL: "http://127.0.0.1:49151/isolated-unused", OPERATIONS_ENVIRONMENT: "test" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "", stdout = "";
        const started = new Promise<void>((resolve, reject) => {
          child!.once("error", reject);
          child!.stderr!.on("data", (part: Buffer) => { stderr += part.toString(); if (stderr.includes("OPERATIONS_INCIDENT_PASS_STARTED")) resolve(); });
          child!.stdout!.on("data", (part: Buffer) => { stdout += part.toString(); });
        });
        completion = new Promise<void>((resolve, reject) => {
          child!.once("error", reject);
          child!.once("exit", (code, signal) => {
            try {
              expect(signal).toBeNull(); expect(code).toBe(2);
              const result = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1)!);
              expect(result).toMatchObject({ stopped: true, incomplete: true, openOrUpdated: null, delivery: null });
              expect(stderr).not.toMatch(/postgres:\/\/|PRIVATE|password|SQLSTATE|stack/iu);
              resolve();
            } catch (error) { reject(error); }
          });
        });
        // Attach rejection handling before admission/barrier work.
        void completion.catch(() => undefined);
        await bounded(started, 10_000);
      } else {
        database = createPostgresRuntimeDatabase(url.toString(), { max: 1 });
        const summaries = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(database.database), clock: { now: () => new Date().toISOString() } });
        const pass = createOperationalIncidentPass({ store: createPostgresIncidentLifecycleStore(database.database),
          readSummary: async () => {
            const result = await summaries.readOperationsSummary({ actor: { kind: "system", jobId: createStableId("Job"), purpose: OPERATIONS_SUMMARY_PURPOSE }, portfolioId });
            if (!result.ok) throw new Error(result.error.code);
            return result.value;
          }, sink: { async deliver() { throw new Error("UNEXPECTED_DELIVERY"); } },
          newIncidentId: () => createStableId("OperationsIncident"), now: () => new Date().toISOString() });
        completion = pass.run(portfolioId, controller.signal).then((result) => { expect(result).toMatchObject({ stopped: true, incomplete: true }); });
        void completion.catch(() => undefined);
      }
      // Observe the actual PostgreSQL lock wait through an independent connection.
      const until = Date.now() + 2_000;
      let observed = false;
      while (Date.now() < until) {
        const waiting = await observer.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'", [applicationName]);
        if (waiting.rowCount) { observed = true; break; }
      }
      expect(observed).toBe(true);
      const interruptedAt = Date.now();
      if (child) child.kill("SIGTERM"); else controller.abort();
      await bounded(completion, 3_000);
      if (database) await database.resource.close();
      expect(Date.now() - interruptedAt).toBeLessThan(3_000);
      expect(await counts()).toEqual(before);
      const path = process.env["OPERATIONS_INCIDENT_SHUTDOWN_PATH"];
      if (!path) throw new Error("INCIDENT_SHUTDOWN_ARTIFACT_REQUIRED");
      writeFileSync(path, JSON.stringify({ platform: process.platform, mode: child ? "os-sigterm" : "abort-controller",
        blockedQueryObserved: true, noIncidentWork: true, boundedExit: true }));
    } finally {
      controller.abort();
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await owner.query("rollback");
      if (database) await database.resource.close();
      await owner.end(); await observer.end();
    }
  }, 20_000);
});
