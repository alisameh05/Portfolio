/**
 * validation-error.ts — Shared Domain Contract
 *
 * Defines the InputValidationError brand for adapter-boundary input
 * validation failures.
 *
 * INVARIANTS (from spec §Shared domain contracts):
 *   - An InputValidationError carries ONLY a constructed validation message.
 *     It never embeds SQL, connection data, provider payloads, or secrets,
 *     so infrastructure adapters may rethrow it without redaction.
 *   - It extends TypeError, so existing TypeError guards keep working.
 *   - Provider-thrown TypeErrors must NOT use this brand; the PostgreSQL
 *     adapter redacts every non-branded failure as infrastructure.
 *
 * This module imports NOTHING. It MUST NOT import Next.js, Supabase, Kysely,
 * Vercel, OpenAPI, or any other provider or framework type.
 */

/**
 * A locally-constructed input validation failure safe to surface unwrapped.
 *
 * Must be constructed only by shared validation helpers rejecting malformed
 * input before any provider call. Never wrap a provider error in this brand.
 */
export class InputValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "InputValidationError";
  }
}
