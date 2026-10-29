const scope206 = "All repository migrations on disposable native PostgreSQL; two independent worker connections, restricted worker role, bounded five-attempt retry policy with seeded vectors, database-clock-only not-before eligibility and lease-expiry fences including rejection before reclaim, stale-token denial, retry/dead-letter incident atomicity, final-attempt crash recovery, and idempotent post-effect replay.";
const scope237 = `${scope206} The #237 path also adds forced domain rollback with no outbox/job/receipt residue, post-commit optional export-failure preservation of committed core state, fresh-request recovery after failed export, and immediate invalid-payload terminalization without a retry.`;
const scope248 = "All repository migrations on disposable native PostgreSQL; durable Portfolio/type/UTC-period deduplication under concurrent enqueue, independent-worker day-rollover retention barriers with held, retry-delayed, and dead keys, serialized Owner admission across a stale status snapshot and concurrent horizon advance, PostgreSQL-current-day horizon/admission fencing with a lagging worker clock, database-clock not-before enforcement for job and outbox retries plus a worker-clock-ahead UTC policy rollover, expired-before-reclaim job/outbox transition fencing with checkpoint resume, bounded contiguous catch-up and historical redrive, successful checkpoint retry-streak reset with fifth-failure/crash terminalization preserved, five existing versioned handlers, ten-job Owner assembly backlog reporting and restart, loopback Storage-adapter effects, truthful completion and coverage status, bounded indexed history queries, in-place upgrade row preservation, and legacy queue compatibility after application rollback.";
const scope249 = `${scope248} The #249 suites add protected GET/Bearer security, fixed host authority, bounded memory/time/claim controls, sanitized incomplete and dependency responses, Owner dependency failure propagation with durable retention and retry, overlapping authenticated triggers on the real queue, zero-claim Owner cleanup against an expired real PostgreSQL artifact, startup-budget accounting, exclusive gate-mode attestation, and Linux OS-SIGTERM qualification during compilation, worker startup, and a real PostgreSQL lock-barrier batch.`;

const requiredDueWorkAssertions206 = Object.freeze([
  "completes retention before scheduling aggregates and dispatches the existing Owner export service",
  "fails the protected trigger safely on an Owner dependency error and resumes after retry",
  "does not admit aggregation when a durable retention key is delayed or dead",
  "rejects an invalid worker identity before queue access",
  "catches up real retention work before admitting dependent daily aggregation",
  "proves concurrent lease exclusion, expiry recovery, stale-token denial, and idempotent post-effect replay",
  "recovers a claimed cleanup job that crashes before its first effect",
  "rejects expired job transitions before reclaim and resumes the existing checkpoint on a new token",
  "rejects Visitor, Owner, wrong-purpose System, and foreign-Portfolio commands at both module boundaries",
  "rolls back a failed retention batch and persists a delayed safe retry",
  "terminalizes the fifth failed claim and a crashed fifth claim with one durable incident",
  "rejects expired outbox transitions and terminalizes the fifth delivery with one incident",
  "uses PostgreSQL time for job not-before and preserves retry attempts until available",
  "uses PostgreSQL time for outbox not-before and preserves retry attempts until available",
  "re-drives an authorized current-policy dead job once and retains its audit and terminal source",
]);

const requiredRollbackRecoveryAssertions237 = Object.freeze([
  "forces a domain rollback that yields no outbox event, job, or durable receipt",
  "keeps committed core state valid when optional post-commit export work fails",
  "puts failed export recovery on a fresh request instead of a replayed or reused artifact",
  "terminalizes a mismatched payload version immediately with one incident instead of a retry",
]);
const requiredRetryRecoveryAssertions237 = Object.freeze([
  ...requiredDueWorkAssertions206,
  ...requiredRollbackRecoveryAssertions237,
]);

const requiredRetentionPassAssertions248 = Object.freeze([
  "deduplicates concurrent triggers by Portfolio/type/due-period and retains truthful scoped status",
  "keeps unscheduled legacy producers and consumers valid for application rollback",
  "does not dispatch Owner assembly or schedule aggregates when shutdown arrives after retention is complete",
  "observes shutdown raised by the final retention effect before dependent Owner or aggregate work",
  "holds aggregation and Owner export dispatch behind a withdrawal transaction leased by another worker",
  "runs the composed Portability cleanup and assembly only after the real retention barrier commits",
  "serializes Owner cleanup and assembly admission with a concurrently advanced retention horizon",
  "reopens the retention barrier at day rollover with an older aggregate hole and a held by another worker withdrawal",
  "reopens the retention barrier at day rollover with an older aggregate hole and a retry-delayed withdrawal",
  "reopens the retention barrier at day rollover with an older aggregate hole and a dead withdrawal",
  "reopens the retention horizon when PostgreSQL advances beyond the worker clock and holds dependent work until current-day retention completes",
  "resumes more than five successful retention checkpoint batches across a bounded restart",
  "reports the saturated ten-job Owner assembly pass and drains the eleventh export on restart",
  "keeps aggregate admission closed for a delayed retry barrier",
  "keeps aggregate admission closed for a dead retention job barrier",
  "catches up a twenty-day outage in ordered slices of at most fifteen policy periods",
  "holds contiguous completion before an older aggregate hole, then audited redrive closes it once",
  "keeps legacy redrive reads and writes free of Phase 8 scheduling columns",
  "uses the semantic-period covering index for recent status reads over old queue history",
  "keeps a future UTC policy period incomplete until database not-before",
  "forces RLS and keeps the cursor table unavailable to application and public roles",
  "publishes daily and catch-up invocations as UTC handoffs that remain uninstalled",
  "deduplicates the same Portfolio/type/due-period across restarts and bounds catch-up",
  "resumes a bounded owner-module checkpoint with the same job identity and UTC anchor before aggregates",
  "keeps policy completion incomplete when a durable aggregate reports coverage gaps",
  "reports shutdown before work as incomplete without scheduling or claiming a backlog",
  "drains a twenty-day outage in contiguous bounded slices without losing the older completion watermark",
  ...requiredDueWorkAssertions206,
]);

const requiredProtectedTriggerAssertions249 = Object.freeze([
  "accepts the configured Bearer credential and runs only the host-registered bounded worker",
  "rejects missing, wrong, and empty Bearer credentials before queue effects",
  "does not treat spoofed Vercel scheduler headers as authority",
  "rejects Owner cookies even when present beside a valid server-to-server credential",
  "rejects query credentials, request bodies, unsupported methods, and malformed length headers",
  "rejects oversized headers before authorization or queue effects",
  "maps dependency errors to fixed responses without echoing exception or secret markers",
  "returns HTTP 200 for a truthful authenticated incomplete pass and rejects malformed totals safely",
  "fails closed for invalid host budgets or unregistered worker identity",
  "enforces memory and monotonic deadline observations before additional claims",
  "maps host clock and stop-observation failures to the fixed response before worker dispatch",
  "fails closed for invalid memory and monotonic observations",
  "counts compilation against the invocation and rejects a tiny remaining worker window",
  "shares sanitized totals with the portable worker and keeps schedule handoffs uninstalled",
  "overlapping protected requests deduplicate schedule keys in PostgreSQL and claim disjoint fenced work",
  "returns HTTP 200 with incomplete totals and retains durable backlog across a restart",
  "preserves completed retention and skips aggregates after Owner assembly fails",
  "composes the actual bounded worker through the restricted PostgreSQL runtime",
  "stops the real CLI after its active PostgreSQL batch commits at a lock barrier",
  "runs expired Owner artifact cleanup with zero assembly claims and retains queued work",
  "selects one exact ticket mode and rejects conflicting flags before gate setup",
]);

function freezeMode(value) {
  for (const name of ["acceptanceFiles", "assertionTitles", "criteria", "databaseRoles"]) {
    Object.freeze(value[name]);
  }
  return Object.freeze(value);
}

function makeMode(ticket, platform) {
  const linux = platform === "linux";
  const shared = {
    ticket,
    acceptanceFiles: ["tests/phase7/due-work.test.ts", "tests/phase7/due-work-postgres.test.ts"],
    assertionTitles: requiredDueWorkAssertions206,
    reportPath: "artifacts/phase7-jobs-vitest.json",
    roleReportPath: undefined,
    evidencePath: "evidence/phase7-due-work-206.json",
    databaseRoles: ["due_work_worker_runtime", "shipwithali_worker", "anon", "authenticated"],
    criteria: ["T19-01", "T19-02", "T19-03", "T19-04", "T19-05", "T19-06", "T19-07", "T19-08", "T19-09"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase7:focus:jobs",
    scope: scope206,
    roleMatrix: false,
    routeInventory: false,
    migrationProof: false,
    usesApplicationRuntime: false,
    usesLegacyDatabase: false,
    phase3Database: false,
  };
  if (ticket === 206) return freezeMode(shared);
  if (ticket === 237) return freezeMode({
    ...shared,
    acceptanceFiles: [...shared.acceptanceFiles, "tests/phase7/rollback-recovery-postgres.test.ts"],
    assertionTitles: requiredRetryRecoveryAssertions237,
    reportPath: "artifacts/phase8-retry-recovery-vitest.json",
    roleReportPath: "artifacts/phase8-retry-recovery-rls-vitest.json",
    evidencePath: "evidence/phase8-retry-recovery-237.json",
    databaseRoles: ["due_work_application_runtime", "shipwithali_application", "due_work_worker_runtime",
      "shipwithali_worker", "anon", "authenticated"],
    criteria: ["P8-40", "P8-41", "P8-42", "P8-43", "P8-44", "P8-08", "P8-38", "P8-39", "P8-54"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:retry-recovery",
    scope: scope237,
    roleMatrix: true,
    usesApplicationRuntime: true,
    phase3Database: true,
  });
  if (ticket === 248) return freezeMode({
    ...shared,
    acceptanceFiles: [...shared.acceptanceFiles, "tests/phase8/resumable-retention-passes.test.ts",
      "tests/phase8/resumable-retention-passes-postgres.test.ts"],
    assertionTitles: requiredRetentionPassAssertions248,
    reportPath: "artifacts/phase8-retention-passes-vitest.json",
    evidencePath: "evidence/phase8-retention-passes-248.json",
    databaseRoles: ["due_work_application_runtime", "shipwithali_application", "due_work_worker_runtime",
      "shipwithali_worker", "anon", "authenticated"],
    criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:retention-passes",
    scope: scope248,
    usesApplicationRuntime: true,
    usesLegacyDatabase: true,
    migrationProof: true,
  });
  return freezeMode({
    ...shared,
    acceptanceFiles: [...shared.acceptanceFiles, "tests/phase8/resumable-retention-passes.test.ts",
      "tests/phase8/resumable-retention-passes-postgres.test.ts", "tests/phase8/protected-trigger.test.ts",
      "tests/phase8/protected-trigger-postgres.test.ts"],
    assertionTitles: [...requiredRetentionPassAssertions248, ...requiredProtectedTriggerAssertions249,
      ...(linux ? ["forwards an actual Linux OS SIGTERM during compilation before database work",
        "keeps the spawned worker behind admission until its signal handler is ready"] : [])],
    reportPath: "artifacts/phase8-protected-trigger-vitest.json",
    evidencePath: "evidence/phase8-protected-trigger-249.json",
    databaseRoles: ["due_work_application_runtime", "shipwithali_application", "due_work_worker_runtime",
      "shipwithali_worker", "anon", "authenticated"],
    criteria: ["AC01", "AC02", "AC03", "AC04", "AC05", "AC06", "AC07", "AC08"],
    reproduction: "npm run setup:validation; npm run validation:ready; npm run phase8:focus:protected-trigger",
    scope: scope249,
    routeInventory: true,
    migrationProof: true,
    usesApplicationRuntime: true,
    usesLegacyDatabase: true,
  });
}

/** Resolves the complete acceptance contract before a runner can touch DBs or artifacts. */
export function selectPhase7JobsMode(args, platform = process.platform) {
  const ticketByFlag = new Map([["--ticket-206", 206], ["--ticket-237", 237],
    ["--ticket-248", 248], ["--ticket-249", 249]]);
  const allowedArguments = new Set([...ticketByFlag.keys(), "--refresh-types"]);
  if (args.some((arg) => !allowedArguments.has(arg))) {
    return Object.freeze({ ok: false, code: "PHASE7_JOBS_ARGUMENT_UNSUPPORTED" });
  }
  const suppliedTicketFlags = args.filter((arg) => ticketByFlag.has(arg));
  if (suppliedTicketFlags.length > 1) return Object.freeze({ ok: false, code: "PHASE7_JOBS_TICKET_FLAGS_CONFLICT" });
  const ticket = suppliedTicketFlags.length === 0 ? 206 : ticketByFlag.get(suppliedTicketFlags[0]);
  return Object.freeze({ ok: true, mode: makeMode(ticket, platform) });
}
