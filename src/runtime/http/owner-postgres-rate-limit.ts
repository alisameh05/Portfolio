import { createHash } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../shared/adapters/postgres/database.generated.js";
import type { OwnerRateLimitCheck } from "./owner-security.js";

const OWNER_CONFIGURATION_OPERATIONS = new Set([
  "updateOwnerProfileConfiguration",
  "updateOwnerContactChannels",
  "updateOwnerGlobalProjectCta",
]);
const OWNER_SCOPE_PATTERN = /^owner_session:([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([A-Za-z]+)$/i;

/** Shared fixed-window policy: 30 requests per Owner and operation each 60 seconds. */
export function createPostgresOwnerConfigurationRateLimit(database: Kysely<DB>): OwnerRateLimitCheck {
  return {
    async check(subject: string) {
      const match = OWNER_SCOPE_PATTERN.exec(subject);
      const ownerId = match?.[1]?.toLowerCase();
      const operation = match?.[2];
      if (ownerId === undefined || operation === undefined || !OWNER_CONFIGURATION_OPERATIONS.has(operation)) {
        throw new Error("OWNER_RATE_LIMIT_SCOPE_INVALID");
      }
      const subjectHash = createHash("sha256").update(ownerId, "utf8").digest("hex");
      const result = await sql<{ readonly allowed: boolean; readonly retry_after_seconds: number }>`
        select allowed, retry_after_seconds
        from identity_access.check_owner_configuration_rate_limit(${subjectHash}, ${operation})
      `.execute(database);
      const verdict = result.rows[0];
      if (verdict === undefined || typeof verdict.allowed !== "boolean" ||
          !Number.isSafeInteger(verdict.retry_after_seconds) || verdict.retry_after_seconds < 1) {
        throw new Error("OWNER_RATE_LIMIT_RESULT_INVALID");
      }
      return { allowed: verdict.allowed, retryAfterSeconds: verdict.retry_after_seconds };
    },
  };
}
