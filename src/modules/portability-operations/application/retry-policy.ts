/** Maximum number of executions for one durable job identity. */
export const JOB_MAX_ATTEMPTS = 5;

const RETRY_BASE_MILLISECONDS = 30_000;
const RETRY_CAP_MILLISECONDS = 15 * 60_000;

/**
 * Compute the retry delay after a failed execution. Randomness is injected so
 * retry vectors are reproducible; persistence must add this delay to database
 * time while fencing the current lease token.
 */
export function calculateJobRetryDelayMilliseconds(
  failedAttempt: number,
  random: () => number,
): number {
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) {
    throw new RangeError("Failed attempt must be a positive safe integer.");
  }
  const sample = random();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("Retry randomness must be in [0, 1).");
  }
  const exponent = Math.min(failedAttempt - 1, 52);
  const base = Math.min(RETRY_BASE_MILLISECONDS * 2 ** exponent, RETRY_CAP_MILLISECONDS);
  const jitterMaximum = Math.floor(base * 0.25);
  const jitter = Math.floor(sample * (jitterMaximum + 1));
  return Math.floor(base) + jitter;
}
