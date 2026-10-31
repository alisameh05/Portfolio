/** Provider-neutral rate-limit port for authenticated Owner configuration mutations. */
export interface OwnerRateLimitCheck {
  check(subject: string): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds?: number }>;
}
