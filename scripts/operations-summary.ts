import { createSystemClock, createSystemIdGenerator } from "../src/runtime/ports.js";
import { parseStableId } from "../src/shared/domain/index.js";
import { parseOperationsSummaryArguments } from "./operations-summary-args.js";
import { createOperationsSummaryService, OPERATIONS_SUMMARY_PURPOSE } from "../src/modules/portability-operations/application/operations-observability.js";
import { createPostgresOperationsSummaryReader } from "../src/modules/portability-operations/adapters/postgres-operations-summary.js";
import { createPostgresRuntimeDatabase } from "../src/shared/adapters/postgres/runtime.js";

const databaseUrl = process.env["DATABASE_URL"];
const cliOptions = parseOperationsSummaryArguments(process.argv.slice(2), process.env["OPERATIONS_SUMMARY_PORTFOLIO_ID"]);
const jobId = parseStableId("Job", createSystemIdGenerator().generate("Job"));

if (!databaseUrl || !cliOptions || !jobId.ok) {
  console.error(!cliOptions ? "OPERATIONS_SUMMARY_ARGUMENTS_INVALID" : "OPERATIONS_SUMMARY_CONTEXT_INVALID");
  process.exitCode = 2;
} else {
  const database = createPostgresRuntimeDatabase(databaseUrl, {
    max: 1,
    connectionTimeoutMs: 2_000,
    runtimeObservationSink: (observation) => {
      try { process.stderr.write(`${JSON.stringify(observation)}\n`); } catch { /* telemetry must not affect the summary */ }
    },
  });
  try {
    const service = createOperationsSummaryService({
      reader: createPostgresOperationsSummaryReader(database.database),
      clock: createSystemClock(),
    });
    const result = await service.readOperationsSummary({
      actor: { kind: "system", jobId: jobId.value, purpose: OPERATIONS_SUMMARY_PURPOSE },
      portfolioId: cliOptions.portfolioId,
    });
    if (!result.ok) {
      console.error(result.error.code);
      process.exitCode = 1;
    } else {
      process.stdout.write(`${JSON.stringify(result.value)}\n`);
    }
  } catch {
    console.error("OPERATIONS_SUMMARY_UNAVAILABLE");
    process.exitCode = 1;
  } finally {
    try { await database.resource.close(); } catch { /* preserve the safe command result */ }
  }
}
