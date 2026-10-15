import { err, parseStableId, type Rejection, type Result, type StableId } from "@shared/domain";
import type { BoundedWorkResult } from "@shared/application";
import type { TransactionRunner } from "../../../runtime/ports.js";
import type { MeasurementRetentionRepositoryPort, MeasurementRetentionKind } from "../ports/retention.js";
import type { MeasurementWorkCommand, MeasurementWorkService } from "./work.js";

export interface MeasurementRetentionWorkDependencies {
  readonly portfolioId: StableId<"Portfolio">;
  readonly transactions: Pick<TransactionRunner, "run">;
  readonly repository: MeasurementRetentionRepositoryPort;
}

const unavailable = () => err<Rejection>({ kind: "temporarily_unavailable", code: "MEASUREMENT_RETENTION_UNAVAILABLE" });
const invalid = () => err<Rejection>({ kind: "validation", code: "MEASUREMENT_RETENTION_COMMAND_INVALID" });
const denied = () => err<Rejection>({ kind: "forbidden", code: "MEASUREMENT_RETENTION_NOT_PERMITTED" });
const DAY_MS = 86_400_000;

function validNow(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function measurementDetailExpiryAt(acceptedAt: string): string {
  const accepted = Date.parse(acceptedAt);
  if (!Number.isFinite(accepted)) throw new Error("MEASUREMENT_RETENTION_INSTANT_INVALID");
  return new Date(accepted + 14 * DAY_MS).toISOString();
}

export function measurementAggregateExpiryAt(utcDay: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(utcDay)) throw new Error("MEASUREMENT_RETENTION_DAY_INVALID");
  const [year, month, day] = utcDay.split("-").map(Number);
  const original = new Date(Date.UTC(year!, month! - 1, day!));
  if (!Number.isFinite(original.valueOf()) || original.toISOString().slice(0, 10) !== utcDay) {
    throw new Error("MEASUREMENT_RETENTION_DAY_INVALID");
  }
  const targetMonth = month! - 1 + 13;
  const targetYear = year! + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;
  const lastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, normalizedMonth, Math.min(day!, lastDay))).toISOString();
}

function validCommand(command: MeasurementWorkCommand, portfolioId: StableId<"Portfolio">,
  purpose: "measurement.retention" | "measurement.withdrawal"): boolean {
  return command.scope.kind === "portfolio" && command.scope.portfolioId === portfolioId &&
    command.actor.kind === "system" && command.actor.purpose === purpose &&
    parseStableId("Job", command.actor.jobId).ok && [25, 50, 100].includes(command.batchSize) &&
    validNow(command.now) && typeof command.correlationId === "string" &&
    command.correlationId.length > 0 && command.correlationId.length <= 200;
}

export function createMeasurementRetentionWorkService(deps: MeasurementRetentionWorkDependencies):
  Pick<MeasurementWorkService, "expireDetail" | "expireAggregates" | "cleanWithdrawnConsent"> {
  async function run(kind: MeasurementRetentionKind, command: MeasurementWorkCommand,
    purpose: "measurement.retention" | "measurement.withdrawal"): Promise<Result<BoundedWorkResult, Rejection>> {
    if (command.scope.kind !== "portfolio" || command.scope.portfolioId !== deps.portfolioId) return denied();
    if (command.actor.kind !== "system" || command.actor.purpose !== purpose) return denied();
    if (!validCommand(command, deps.portfolioId, purpose)) return invalid();
    try {
      return await deps.transactions.run(async transaction => ({ ok: true, value: await deps.repository.processBatch({
        kind, portfolioId: deps.portfolioId, jobId: command.actor.jobId, now: command.now,
        batchSize: command.batchSize,
      }, transaction) }));
    } catch {
      return unavailable();
    }
  }

  return {
    expireDetail: command => run("detail", command, "measurement.retention"),
    expireAggregates: command => run("aggregates", command, "measurement.retention"),
    cleanWithdrawnConsent: command => run("withdrawal", command, "measurement.withdrawal"),
  };
}
