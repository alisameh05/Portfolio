import type { StableId, Result, Rejection } from "@shared/domain";
import { err, ok } from "@shared/domain";
import type {
  MeasurementRepositoryPort,
  ClockPort,
  HashPort,
} from "../ports/index.js";
import type {
  ConsentRecord,
  PublicEventData,
  AnalyticsGoalVersion,
  DailyAggregate,
} from "../domain/index.js";

export { createPostgresDailyAggregateRepository } from "./postgres-daily-aggregates.js";
export { createPostgresMeasurementRetentionRepository } from "./postgres-retention.js";

export { createPostgresOwnerAnalyticsGoalRepository } from "./postgres-goals.js";
export { createPostgresAnalyticsGoalScopeFacts } from "./postgres-goal-scope-facts.js";

/**
 * Stub adapters for Phase 1 skeleton.
 * Business implementation and persistence are deferred to later phases.
 */
export class StubMeasurementRepository implements MeasurementRepositoryPort {
  async saveConsentRecord(
    _record: ConsentRecord,
  ): Promise<Result<ConsentRecord, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getConsentRecord(
    _visitorId: StableId<"MeasurementVisitor">,
  ): Promise<Result<ConsentRecord, Rejection>> {
    return err({ kind: "not_found", code: "CONSENT_RECORD_NOT_FOUND" });
  }

  async savePublicEvent(
    _event: PublicEventData,
  ): Promise<Result<PublicEventData, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getActiveGoalVersion(
    _goalId: StableId<"AnalyticsGoal">,
  ): Promise<Result<AnalyticsGoalVersion, Rejection>> {
    return err({ kind: "not_found", code: "GOAL_VERSION_NOT_FOUND" });
  }

  async saveGoalVersion(
    _goalVersion: AnalyticsGoalVersion,
  ): Promise<Result<AnalyticsGoalVersion, Rejection>> {
    return err({ kind: "temporarily_unavailable", code: "PERSISTENCE_NOT_IMPLEMENTED" });
  }

  async getDailyAggregates(
    _metricName: string,
    _startDate: string,
    _endDate: string,
  ): Promise<Result<readonly DailyAggregate[], Rejection>> {
    return ok([]);
  }

  async expireDetailEvents(
    _olderThanTimestamp: string,
  ): Promise<Result<number, Rejection>> {
    return ok(0);
  }
}

export class SystemClockAdapter implements ClockPort {
  now(): string {
    return new Date().toISOString();
  }

  nowMs(): number {
    return Date.now();
  }
}

export class StubHashAdapter implements HashPort {
  sha256(input: string): string {
    // Stub implementation without external dependencies
    return `hash_${input.length}`;
  }

  pseudonymize(input: string, salt: string): string {
    return `pseudo_${input.length}_${salt.length}`;
  }
}
