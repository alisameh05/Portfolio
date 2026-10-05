import { err } from "../../shared/domain/index.js";
import type { ContentAuthoringService } from "../../modules/content-publishing/application/authoring.js";

/** Fail-closed service used when PostgreSQL-backed application assembly is absent. */
export function createProductionContentAuthoringService(): ContentAuthoringService {
  const unavailable = err({ kind: "temporarily_unavailable" as const, code: "RUNTIME_NOT_IMPLEMENTED" });
  return {
    async createContent() { return unavailable; },
    async getOwnerContentAggregate() { return unavailable; },
    async saveRevision() { return unavailable; },
  };
}
