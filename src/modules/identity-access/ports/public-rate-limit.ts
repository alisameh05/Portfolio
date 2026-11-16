/** Shared abuse-control port for authenticated and public HTTP requests. */
export interface PublicRateLimitCheck {
  check(subject: string): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds?: number }>;
}
