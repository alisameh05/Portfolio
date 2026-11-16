import { createHmac } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { DB } from "../../../shared/adapters/postgres/database.generated.js";
import type { PublicRateLimitCheck } from "../ports/public-rate-limit.js";

const REACTION_OPERATION = "putProjectReaction";

/** Shared fixed-window policy: 30 Reaction requests per trusted client and minute. */
export function createPostgresReactionRateLimit(input: {
  readonly database: Kysely<DB>;
  readonly portfolioId: string;
  readonly hashKey: string;
}): PublicRateLimitCheck {
  if (input.hashKey.trim() === "" || input.portfolioId.trim() === "") {
    throw new TypeError("Reaction rate-limit configuration is incomplete.");
  }
  return {
    async check(clientAddress) {
      const address = clientAddress.trim();
      if (address === "") throw new TypeError("Reaction rate-limit subject is unavailable.");
      const subjectHash = createHmac("sha256", input.hashKey)
        .update("shipwithali:public-rate-limit:v1\0", "utf8")
        .update(input.portfolioId, "utf8")
        .update("\0", "utf8")
        .update(address, "utf8")
        .digest("hex");
      const result = await sql<{ readonly allowed: boolean; readonly retry_after_seconds: number }>`
        select allowed, retry_after_seconds
        from identity_access.check_public_reaction_rate_limit(${subjectHash}, ${REACTION_OPERATION})
      `.execute(input.database);
      const verdict = result.rows[0];
      if (verdict === undefined || typeof verdict.allowed !== "boolean" ||
          !Number.isSafeInteger(verdict.retry_after_seconds) || verdict.retry_after_seconds < 1) {
        throw new Error("PUBLIC_REACTION_RATE_LIMIT_RESULT_INVALID");
      }
      return { allowed: verdict.allowed, retryAfterSeconds: verdict.retry_after_seconds };
    },
  };
}
