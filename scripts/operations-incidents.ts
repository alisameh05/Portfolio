import { createSystemClock, createSystemIdGenerator } from "../src/runtime/ports.js";
import { parseStableId, type StableId } from "../src/shared/domain/index.js";
import { createOperationsSummaryService, OPERATIONS_SUMMARY_PURPOSE } from "../src/modules/portability-operations/application/operations-observability.js";
import { createOperationalIncidentPass } from "../src/modules/portability-operations/application/index.js";
import type { IncidentEnvironment } from "../src/modules/portability-operations/application/incident-lifecycle.js";
import { createIncidentLifecycleService } from "../src/modules/portability-operations/application/incident-lifecycle.js";
import { createPostgresOperationsSummaryReader } from "../src/modules/portability-operations/adapters/postgres-operations-summary.js";
import { createPostgresIncidentLifecycleStore } from "../src/modules/portability-operations/adapters/postgres-incident-lifecycle.js";
import { createPostgresRuntimeDatabase } from "../src/shared/adapters/postgres/runtime.js";

const shutdown = new AbortController();
const requestStop = () => shutdown.abort();
process.once("SIGINT", requestStop);
process.once("SIGTERM", requestStop);

const databaseUrl = process.env["DATABASE_URL"];
const sinkValue = process.env["OPERATIONS_INCIDENT_SINK_URL"];
const args = process.argv.slice(2);
const recoveryKind = args[2] === "--recover-job-id" ? "job" : args[2] === "--recover-outbox-id" ? "outbox" : null;
const recoveryId = recoveryKind === null ? null : parseStableId(recoveryKind === "job" ? "Job" : "DomainEvent", args[3] ?? "");
const validArgs = args.length === 2 || (args.length === 4 && recoveryId?.ok);
const portfolioId = validArgs && args[0] === "--portfolio-id" ? parseStableId("Portfolio", args[1] ?? "") : null;
const jobId = parseStableId("Job", createSystemIdGenerator().generate("Job"));
const sinkUrl = safeLoopbackSinkUrl(sinkValue);
const environment = process.env["OPERATIONS_ENVIRONMENT"] ?? "unknown";

if (!databaseUrl || !sinkUrl || !portfolioId?.ok || !jobId.ok || shutdown.signal.aborted ||
    !["unknown", "local", "test", "staging", "production"].includes(environment)) {
  process.stderr.write("OPERATIONS_INCIDENTS_CONTEXT_INVALID\n");
  process.exitCode = 2;
} else {
  const database = createPostgresRuntimeDatabase(databaseUrl, { max: 1, connectionTimeoutMs: 2_000,
    runtimeObservationSink: (observation) => { try { process.stderr.write(`${JSON.stringify(observation)}\n`); } catch { /* best effort */ } } });
  try {
    const clock = createSystemClock();
    const summaries = createOperationsSummaryService({ reader: createPostgresOperationsSummaryReader(database.database), clock });
    const store = createPostgresIncidentLifecycleStore(database.database);
    if (recoveryKind !== null && recoveryId?.ok) {
      const service = createIncidentLifecycleService({ store, sink: { async deliver() { throw new Error("RECOVERY_CANNOT_DELIVER"); } } });
      const recovered = await service.recoverWorkIncident({ kind: "system", purpose: "operations.incident.recover", jobId: jobId.value }, recoveryKind, recoveryId.value);
      if (!recovered.ok) throw new Error(recovered.error.code);
      process.stdout.write(`${JSON.stringify({ recovered: recovered.value })}\n`);
    } else {
    const ids = createSystemIdGenerator();
    const pass = createOperationalIncidentPass({
      readSummary: async () => {
        const result = await summaries.readOperationsSummary({
          actor: { kind: "system", jobId: jobId.value, purpose: OPERATIONS_SUMMARY_PURPOSE },
          portfolioId: portfolioId.value,
        });
        if (!result.ok) throw new Error(result.error.code);
        return result.value;
      },
      store,
      sink: {
        async deliver(payload, context) {
          const response = await fetch(sinkUrl, { method: "POST", signal: context.signal, redirect: "error",
            headers: { "content-type": "application/json", "idempotency-key": context.idempotencyKey },
            body: JSON.stringify(payload) });
          await response.body?.cancel();
          if (!response.ok) throw new Error("INCIDENT_SINK_REJECTED");
        },
      },
      newIncidentId: () => ids.generate("OperationsIncident") as StableId<"OperationsIncident">,
      now: () => clock.now(), deliveryTimeoutMs: 2_000, deliveryBudgetMs: 10_000,
      environment: environment as IncidentEnvironment,
    });
    process.stderr.write("OPERATIONS_INCIDENT_PASS_STARTED\n");
    const result = await pass.run(portfolioId.value, shutdown.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.incomplete) process.exitCode = 2;
    }
  } catch {
    process.stderr.write("OPERATIONS_INCIDENTS_UNAVAILABLE\n");
    process.exitCode = 1;
  } finally {
    await database.resource.close().catch(() => undefined);
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
  }
}

function safeLoopbackSinkUrl(value: string | undefined): string | null {
  if (value === undefined || value.length > 512) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === "http:" && (host === "127.0.0.1" || host === "localhost" || host === "[::1]") &&
      url.username === "" && url.password === "" && url.search === "" && url.hash === "" ? url.toString() : null;
  } catch { return null; }
}
